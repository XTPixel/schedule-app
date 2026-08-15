//! 插件/脚本接口（导出钩子，§9 Phase 3）。
//!
//! 方案：读取用户数据目录下 `hooks/*.js`，每个脚本可声明一个或多个
//! 生命周期钩子函数；后端在对应生命周期事件发生时调用之。
//!
//! 支持的钩子（只读入参，导出类场景）：
//! - `on_event_saved(payloadJson)`：事件保存后触发。
//! - `on_archive_entry_add(payloadJson)`：归档条目写入后触发。
//! - `on_candidate_refresh(payloadJson)`：候选刷新（`get_now_candidates`）后触发。
//!
//! 安全约定：
//! - 默认关闭，须用户在界面手动开启（`config.hooks.enabled`）。
//! - 脚本通过 `boa_engine`（受限 JS 解释器，无文件系统/网络/进程能力）执行，
//!   **无法修改内部数据文件**；入参为只读 JSON 字符串，返回值仅回传展示，不落盘。
//! - 不做复杂沙箱，脚本风险（任意用户脚本在本机解释器内执行）由文档与界面明示。

use std::fs;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use boa_engine::{Context, JsString, JsValue, Source};
use serde::{Deserialize, Serialize};

/// 全部受支持的生命周期钩子名称。
pub const HOOK_NAMES: &[&str] = &["on_archive_entry_add", "on_candidate_refresh", "on_event_saved"];

/// V3.1：脚本执行超时上限（秒）。超时/死循环脚本不再卡死 IPC 与界面。
const HOOK_TIMEOUT: Duration = Duration::from_secs(2);
/// V3.1：boa 解释器循环迭代上限（防死循环在解释器内耗尽 CPU）。
const HOOK_LOOP_ITERATION_LIMIT: u64 = 1_000_000;
/// V3.1：boa 解释器递归深度上限。
const HOOK_RECURSION_LIMIT: usize = 256;

/// 单个脚本的加载/检查结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInfo {
    /// 脚本文件名（不含目录）。
    pub file: String,
    /// 该脚本中声明且可调用的钩子函数名。
    pub functions: Vec<String>,
    /// 脚本语法错误等信息（无错误为 null）。
    pub error: Option<String>,
}

/// 单次钩子分发结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookRunResult {
    pub file: String,
    pub hook: String,
    /// 脚本返回值（字符串化）；脚本抛错时为 null。
    pub output: Option<String>,
    pub error: Option<String>,
}

fn hooks_dir(dir: &Path) -> std::path::PathBuf {
    dir.join("hooks")
}

/// 枚举数据目录下的全部 `*.js` 脚本文件路径。
fn list_script_paths(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(hooks_dir(dir)) else { return out };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) == Some("js") {
            out.push(p);
        }
    }
    out.sort();
    out
}

fn file_name(p: &Path) -> String {
    p.file_name().and_then(|s| s.to_str()).unwrap_or("").to_string()
}

/// 受限执行上下文（V3.1）：限制循环迭代与递归深度，避免死循环脚本挂起解释器。
fn new_context() -> Context {
    let mut ctx = Context::default();
    let mut limits = ctx.runtime_limits();
    limits.set_loop_iteration_limit(HOOK_LOOP_ITERATION_LIMIT);
    limits.set_recursion_limit(HOOK_RECURSION_LIMIT);
    ctx.set_runtime_limits(limits);
    ctx
}

/// 在受控线程中运行一段脚本操作，2 秒超时（V3.1）。
fn run_with_timeout<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(HOOK_TIMEOUT).ok()
}

/// 将 boa 执行错误转成面向用户的超时提示（循环限制/超时统一为「执行超时」）。
fn normalize_eval_error(e: &str) -> String {
    if e.to_lowercase().contains("loop") || e.to_lowercase().contains("iteration") {
        "执行超时：脚本循环超出限制".to_string()
    } else {
        e.to_string()
    }
}

/// 加载脚本源码并返回（源码 + 可用的 HookInfo）。
fn load_script(path: &Path) -> HookInfo {
    let file = file_name(path);
    match fs::read_to_string(path) {
        Ok(src) => {
            let file_for_closure = file.clone();
            let result = run_with_timeout(move || {
                let mut ctx = new_context();
                match ctx.eval(Source::from_bytes(src.as_bytes())) {
                    Ok(_) => {
                        let global = ctx.global_object();
                        let mut functions = Vec::new();
                        for name in HOOK_NAMES {
                            let Ok(v) = global.get(JsString::from(*name), &mut ctx) else { continue };
                            if let Some(obj) = v.as_object() {
                                if obj.is_callable() {
                                    functions.push((*name).to_string());
                                }
                            }
                        }
                        HookInfo { file: file_for_closure, functions, error: None }
                    }
                    Err(e) => HookInfo {
                        file: file_for_closure,
                        functions: vec![],
                        error: Some(normalize_eval_error(&e.to_string())),
                    },
                }
            });
            result.unwrap_or_else(|| HookInfo {
                file,
                functions: vec![],
                error: Some("执行超时（2 秒）".to_string()),
            })
        }
        Err(e) => HookInfo { file, functions: vec![], error: Some(e.to_string()) },
    }
}

/// 列出全部脚本及其声明的钩子（供配置界面展示；会执行脚本以探测函数）。
/// V3.1：每个脚本在受控线程 + 2 秒超时内执行，死循环不再卡死界面。
pub fn list_hooks(dir: &Path) -> Vec<HookInfo> {
    list_script_paths(dir).iter().map(|p| load_script(p)).collect()
}

/// 向某个脚本分发一次钩子事件（返回执行结果；脚本抛错不向上传播）。
fn dispatch_one(path: &Path, src: &str, hook: &str, payload_json: &str) -> HookRunResult {
    let file = file_name(path);
    let mut ctx = new_context();
    if let Err(e) = ctx.eval(Source::from_bytes(src.as_bytes())) {
        return HookRunResult {
            file,
            hook: hook.to_string(),
            output: None,
            error: Some(normalize_eval_error(&e.to_string())),
        };
    }
    let global = ctx.global_object();
    let Ok(v) = global.get(JsString::from(hook), &mut ctx) else {
        return HookRunResult {
            file,
            hook: hook.to_string(),
            output: None,
            error: Some(format!("读取钩子 `{hook}` 失败")),
        };
    };
    let Some(obj) = v.as_object() else {
        // 该脚本未声明此钩子，静默跳过。
        return HookRunResult { file, hook: hook.to_string(), output: None, error: None };
    };
    if !obj.is_callable() {
        return HookRunResult {
            file,
            hook: hook.to_string(),
            output: None,
            error: Some(format!("`{hook}` 不是函数")),
        };
    }
    let arg = JsValue::from(JsString::from(payload_json));
    match obj.call(&JsValue::undefined(), &[arg], &mut ctx) {
        Ok(ret) => HookRunResult {
            file,
            hook: hook.to_string(),
            output: Some(js_value_to_string(&ret)),
            error: None,
        },
        Err(e) => HookRunResult {
            file,
            hook: hook.to_string(),
            output: None,
            error: Some(normalize_eval_error(&e.to_string())),
        },
    }
}

/// JsValue → 可展示字符串（基础类型取原值，复杂对象退化调试格式）。
fn js_value_to_string(v: &JsValue) -> String {
    match v {
        JsValue::String(s) => s.to_std_string_escaped(),
        JsValue::Boolean(b) => b.to_string(),
        JsValue::Integer(i) => i.to_string(),
        JsValue::Rational(f) => f.to_string(),
        JsValue::Null => "null".to_string(),
        JsValue::Undefined => "undefined".to_string(),
        _ => "[object]".to_string(),
    }
}

/// 向数据目录下的全部脚本分发一次钩子事件。
///
/// `payload_json` 为只读入参（JSON 字符串）。脚本返回值/错误仅收集返回，不落盘、不写回内部数据。
/// V3.1：每个脚本在受控线程 + 2 秒超时内执行，死循环返回「执行超时」而不挂起调用方。
pub fn dispatch(dir: &Path, hook: &str, payload_json: &str) -> Vec<HookRunResult> {
    let mut results = Vec::new();
    for path in list_script_paths(dir) {
        let file = file_name(&path);
        let Ok(src) = fs::read_to_string(&path) else { continue };
        let result = run_with_timeout({
            let src = src.clone();
            let hook = hook.to_string();
            let payload_json = payload_json.to_string();
            move || dispatch_one(&path, &src, &hook, &payload_json)
        });
        let r = result.unwrap_or_else(|| HookRunResult {
            file: file.clone(),
            hook: hook.to_string(),
            output: None,
            error: Some("执行超时（2 秒）".to_string()),
        });
        if r.error.is_some() || r.output.is_some() {
            results.push(r);
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_infinite_loop_script_returns_timeout_error() {
        let dir = std::env::temp_dir().join(format!(
            "schedule-core-hooks-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_millis()
        ));
        fs::create_dir_all(dir.join("hooks")).unwrap();
        fs::write(dir.join("hooks").join("loop.js"), "function on_event_saved(p){ while(true){} }").unwrap();

        // 死循环脚本必须快速返回「执行超时」而不是挂起调用方。
        let started = std::time::Instant::now();
        let results = dispatch(&dir, "on_event_saved", "{}");
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(results.len(), 1);
        assert!(results[0].error.as_deref().unwrap_or("").contains("执行超时"));
    }
}
