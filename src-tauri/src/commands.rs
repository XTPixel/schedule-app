//! 全部后端 IPC 命令（Sprint 0 API + Phase 1 / Phase 2 扩展）。
//!
//! 前端只做 UI，业务/存储/候选计算/自然语言解析/搜索/统计/通知全部在后端。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{Datelike, Duration};
use schedule_core::{
    apply_template, compute_candidates, compute_review, compute_stats, dispatch_hook, expand_events,
    list_hooks, new_template, new_template_item, parse_natural_language, preview_template, timeutil,
    ArchiveDay, ArchiveEntry, ArchiveFile, ArchiveSource, AppData, CalendarData, CalendarRoutineWindow,
    CandidatesResult, Config, Event, HookInfo, HookRunResult, ItemStatus, NlpEvent, ReviewResult, Routine,
    SearchQuery, SearchResult, StatsResult, Storage, Task, Template, TemplateApplyResult, TemplateKind,
    TemplatePreview,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

use crate::state::AppState;

fn lock_err() -> String {
    "存储锁获取失败".to_string()
}

/// 钩子安全开关开启时，向数据目录 `hooks/*.js` 分发一次生命周期事件（只读入参，导出类场景）。
fn dispatch_hook_if_enabled(enabled: bool, data_dir: &Path, name: &str, payload: &impl Serialize) {
    if !enabled {
        return;
    }
    if let Ok(json) = serde_json::to_string(payload) {
        let _ = dispatch_hook(data_dir, name, &json);
    }
}

/// 绝对时刻：入站接受任意 ISO 时区，落盘统一归一化为 UTC `Z`（§5.8）。
/// 全天事件的 start/end 为纯日期，原样保留。
fn normalize_absolute(s: &str, all_day: bool) -> Result<String, String> {
    if all_day {
        Ok(s.to_string())
    } else {
        timeutil::normalize_to_utc(s).map_err(|e| e.to_string())
    }
}

fn month_of(date: &str) -> String {
    date.split('-').take(2).collect::<Vec<_>>().join("-")
}

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

/// `load_all_data()`：加载并校验全部 JSON。
#[tauri::command]
pub fn load_all_data(state: State<AppState>) -> Result<AppData, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let data = storage.load_all().map_err(|e| e.to_string())?;
    if let Ok(mut cfg) = state.config.lock() {
        *cfg = data.config.clone();
    }
    Ok(data)
}

/// `get_now_candidates(now)`：返回候选（事件/日常/浮动事项）+ 今日时间轴 + 提醒。
#[tauri::command]
pub fn get_now_candidates(now: String, state: State<AppState>) -> Result<CandidatesResult, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let data = storage.load_all().map_err(|e| e.to_string())?;
    let result = compute_candidates(&data, &now, &data.config).map_err(|e| e.to_string())?;
    let hooks_enabled = state.config.lock().map(|c| c.hooks.enabled).unwrap_or(false);
    dispatch_hook_if_enabled(hooks_enabled, storage.data_dir(), "on_candidate_refresh", &result);
    Ok(result)
}

// ---------------------------------------------------------------------------
// 事件 CRUD（软删除）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn save_event(event: Event, state: State<AppState>) -> Result<Event, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let mut events = storage.read_events().map_err(|e| e.to_string())?;
    let mut ev = event;
    if ev.id.is_empty() {
        ev.id = schedule_core::id::new_id("e");
    }
    let now = timeutil::now_utc_string();
    if ev.created_at.is_empty() {
        ev.created_at = now.clone();
    }
    ev.updated_at = now;
    ev.start = normalize_absolute(&ev.start, ev.all_day)?;
    if let Some(end) = &ev.end {
        ev.end = Some(normalize_absolute(end, ev.all_day)?);
    }
    match events.iter_mut().find(|e| e.id == ev.id) {
        Some(existing) => *existing = ev.clone(),
        None => events.push(ev.clone()),
    }
    storage.save_events(&events).map_err(|e| e.to_string())?;
    let hooks_enabled = state.config.lock().map(|c| c.hooks.enabled).unwrap_or(false);
    dispatch_hook_if_enabled(hooks_enabled, storage.data_dir(), "on_event_saved", &ev);
    Ok(ev)
}

#[tauri::command]
pub fn delete_event(id: String, state: State<AppState>) -> Result<(), String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let mut events = storage.read_events().map_err(|e| e.to_string())?;
    let now = timeutil::now_utc_string();
    for e in events.iter_mut() {
        if e.id == id {
            e.deleted_at = Some(now.clone());
            e.updated_at = now.clone();
        }
    }
    storage.save_events(&events).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 日常 CRUD（软删除）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn save_routine(routine: Routine, state: State<AppState>) -> Result<Routine, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let mut routines = storage.read_routines().map_err(|e| e.to_string())?;
    let mut r = routine;
    if r.id.is_empty() {
        r.id = schedule_core::id::new_id("r");
    }
    let now = timeutil::now_utc_string();
    if r.created_at.is_empty() {
        r.created_at = now.clone();
    }
    r.updated_at = now;
    match routines.iter_mut().find(|x| x.id == r.id) {
        Some(existing) => *existing = r.clone(),
        None => routines.push(r.clone()),
    }
    storage.save_routines(&routines).map_err(|e| e.to_string())?;
    Ok(r)
}

#[tauri::command]
pub fn delete_routine(id: String, state: State<AppState>) -> Result<(), String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let mut routines = storage.read_routines().map_err(|e| e.to_string())?;
    let now = timeutil::now_utc_string();
    for r in routines.iter_mut() {
        if r.id == id {
            r.deleted_at = Some(now.clone());
            r.updated_at = now.clone();
        }
    }
    storage.save_routines(&routines).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 浮动事项 CRUD（软删除）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn save_task(task: Task, state: State<AppState>) -> Result<Task, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let mut tasks = storage.read_tasks().map_err(|e| e.to_string())?;
    let mut t = task;
    if t.id.is_empty() {
        t.id = schedule_core::id::new_id("t");
    }
    let now = timeutil::now_utc_string();
    if t.created_at.is_empty() {
        t.created_at = now.clone();
    }
    t.updated_at = now;
    if let Some(dl) = &t.deadline {
        t.deadline = Some(timeutil::normalize_to_utc(dl).map_err(|e| e.to_string())?);
    }
    match tasks.iter_mut().find(|x| x.id == t.id) {
        Some(existing) => *existing = t.clone(),
        None => tasks.push(t.clone()),
    }
    storage.save_tasks(&tasks).map_err(|e| e.to_string())?;
    Ok(t)
}

#[tauri::command]
pub fn delete_task(id: String, state: State<AppState>) -> Result<(), String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let mut tasks = storage.read_tasks().map_err(|e| e.to_string())?;
    let now = timeutil::now_utc_string();
    for t in tasks.iter_mut() {
        if t.id == id {
            t.deleted_at = Some(now.clone());
            t.updated_at = now.clone();
        }
    }
    storage.save_tasks(&tasks).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 归档
// ---------------------------------------------------------------------------

/// 写入一条归档（按 doneAt 归属到具体天），返回已保存条目。供 archive_entry / complete_candidate 复用。
fn persist_archive(storage: &mut Storage, entry: ArchiveEntry) -> Result<ArchiveEntry, String> {
    let config = storage.read_config().map_err(|e| e.to_string())?;
    let mut e = entry;
    if e.id.is_empty() {
        e.id = schedule_core::id::new_id("a");
    }
    if e.done_at.is_empty() {
        e.done_at = timeutil::now_utc_string();
    }
    let done_utc = timeutil::parse_utc(&e.done_at).map_err(|err| err.to_string())?;
    if e.time.is_empty() {
        e.time = timeutil::fmt_local_time(&done_utc, &config.timezone);
    }
    let date = timeutil::fmt_local_date(&done_utc, &config.timezone);
    let month = month_of(&date);
    let mut archive = storage.load_archive_month(&month).map_err(|err| err.to_string())?;
    let day = archive.days.entry(date.clone()).or_insert_with(|| ArchiveDay {
        entries: vec![],
        summary: None,
        updated_at: timeutil::now_utc_string(),
    });
    day.entries.retain(|x| x.id != e.id);
    // V3.0 B5：当日同源去重（非手动来源 + 有 sourceId 时幂等返回已有条目），
    // 防止「日常窗口内重复完成」在时间轴/归档产生多条同源记录。
    if e.source != ArchiveSource::Manual {
        if let Some(sid) = &e.source_id {
            if let Some(existing) = day
                .entries
                .iter()
                .find(|x| x.source == e.source && x.source_id.as_deref() == Some(sid.as_str()))
            {
                return Ok(existing.clone());
            }
        }
    }
    day.entries.push(e.clone());
    day.entries.sort_by(|a, b| a.done_at.cmp(&b.done_at));
    day.updated_at = timeutil::now_utc_string();
    storage.save_archive_month(&archive).map_err(|err| err.to_string())?;
    Ok(e)
}

/// `archive_entry(entry)`：写入一条归档，返回已保存的条目。
#[tauri::command]
pub fn archive_entry(entry: ArchiveEntry, state: State<AppState>) -> Result<ArchiveEntry, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let saved = persist_archive(&mut storage, entry)?;
    let hooks_enabled = state.config.lock().map(|c| c.hooks.enabled).unwrap_or(false);
    dispatch_hook_if_enabled(hooks_enabled, storage.data_dir(), "on_archive_entry_add", &saved);
    Ok(saved)
}

/// 完成候选：写入归档；对非重复来源标记完成；重复实例仅归档本次（§4.4）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteCandidateInput {
    pub source_type: String,
    pub source_id: String,
    pub series_id: Option<String>,
    pub title: String,
    pub suggested_duration_minutes: Option<i64>,
    /// V3.0 F1：前端计时器传来的实际耗时（分钟）；未传则回退 suggestedDurationMinutes。
    #[serde(default)]
    pub duration_minutes_override: Option<i64>,
}

#[tauri::command]
pub fn complete_candidate(input: CompleteCandidateInput, state: State<AppState>) -> Result<ArchiveEntry, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let config = storage.read_config().map_err(|e| e.to_string())?;
    let now = timeutil::now_utc_string();
    let source = match input.source_type.as_str() {
        "event" => ArchiveSource::Event,
        "routine" => ArchiveSource::Routine,
        "task" => ArchiveSource::Task,
        _ => ArchiveSource::Manual,
    };
    let done_utc = timeutil::parse_utc(&now).map_err(|e| e.to_string())?;
    let entry = ArchiveEntry {
        id: String::new(),
        time: timeutil::fmt_local_time(&done_utc, &config.timezone),
        title: input.title.clone(),
        source,
        source_id: Some(input.source_id.clone()),
        note: None,
        duration_minutes: input
            .duration_minutes_override
            .or(input.suggested_duration_minutes),
        done_at: now.clone(),
    };
    let saved = persist_archive(&mut storage, entry)?;
    let hooks_enabled = state.config.lock().map(|c| c.hooks.enabled).unwrap_or(false);
    dispatch_hook_if_enabled(hooks_enabled, storage.data_dir(), "on_archive_entry_add", &saved);

    // 非重复实例：标记来源完成；重复实例（seriesId 非空）不改序列。
    if input.series_id.is_none() {
        match source {
            ArchiveSource::Event => {
                let mut events = storage.read_events().map_err(|e| e.to_string())?;
                for ev in events.iter_mut() {
                    if ev.id == input.source_id {
                        ev.status = ItemStatus::Completed;
                        ev.completed_at = Some(now.clone());
                        ev.updated_at = now.clone();
                    }
                }
                storage.save_events(&events).map_err(|e| e.to_string())?;
            }
            ArchiveSource::Task => {
                let mut tasks = storage.read_tasks().map_err(|e| e.to_string())?;
                for t in tasks.iter_mut() {
                    if t.id == input.source_id {
                        t.status = ItemStatus::Completed;
                        t.completed_at = Some(now.clone());
                        t.updated_at = now.clone();
                    }
                }
                storage.save_tasks(&tasks).map_err(|e| e.to_string())?;
            }
            _ => {}
        }
    }
    Ok(saved)
}

/// `update_archive_day(date, payload)`：覆盖某天的归档内容。
#[tauri::command]
pub fn update_archive_day(
    date: String,
    payload: ArchiveDay,
    state: State<AppState>,
) -> Result<ArchiveDay, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let month = month_of(&date);
    let mut archive = storage.load_archive_month(&month).map_err(|e| e.to_string())?;
    let mut day = payload;
    day.updated_at = timeutil::now_utc_string();
    archive.days.insert(date.clone(), day.clone());
    storage.save_archive_month(&archive).map_err(|e| e.to_string())?;
    Ok(day)
}

/// 读取指定月份归档（归档页翻月用）。
#[tauri::command]
pub fn get_archive_month(month: String, state: State<AppState>) -> Result<ArchiveFile, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    storage.load_archive_month(&month).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_config(state: State<AppState>) -> Result<Config, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    storage.read_config().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_config(
    mut config: Config,
    _app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<Config, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    config.version = schedule_core::CURRENT_VERSION;
    storage.save_config(&config).map_err(|e| e.to_string())?;
    if let Ok(mut cfg) = state.config.lock() {
        *cfg = config.clone();
    }
    // V3.1 T4：仅落盘 + 递增 generation；单一 config_applier 线程串行收敛
    // 热键 / 移动端服务 / Git 自动提交，快速连续保存不会并发重启。
    state.config_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    Ok(config)
}

// ---------------------------------------------------------------------------
// 通知
// ---------------------------------------------------------------------------

/// `notify(title, body)`：发送系统通知（尊重全局开关；免打扰由调用方/提醒引擎控制）。
#[tauri::command]
pub fn notify(
    title: String,
    body: String,
    app: tauri::AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    let config = state.config.lock().map_err(|_| lock_err())?;
    if !config.notifications.enabled {
        return Ok(());
    }
    let mut builder = app.notification().builder().title(title).body(body);
    // V3.1 T6：提示音开关接入通知（支持的系统使用默认提示音）。
    if config.notifications.sound {
        builder = builder.sound("Default");
    }
    builder.show().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Phase 1：自然语言解析 / 日历 / 搜索
// ---------------------------------------------------------------------------

/// `parse_nl(text)`：自然语言时间解析；`matched=false` 时前端降级表单。
#[tauri::command]
pub fn parse_nl(text: String, state: State<AppState>) -> Result<NlpEvent, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let config = storage.read_config().map_err(|e| e.to_string())?;
    let now = timeutil::now_utc();
    Ok(parse_natural_language(&text, &config.timezone, &now))
}

/// `get_calendar(start, end)`：区间内事件实例（含重复展开）+ 日常窗口。
#[tauri::command]
pub fn get_calendar(start: String, end: String, state: State<AppState>) -> Result<CalendarData, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let data = storage.load_all().map_err(|e| e.to_string())?;
    let from = timeutil::parse_date(&start).map_err(|e| e.to_string())?;
    let to = timeutil::parse_date(&end).map_err(|e| e.to_string())?;
    let occurrences = expand_events(&data.events, from, to, &data.config.timezone);

    let mut routine_windows = Vec::new();
    let mut d = from;
    while d <= to {
        let weekday = d.weekday().number_from_monday();
        for rt in &data.routines {
            if !rt.enabled || rt.deleted_at.is_some() {
                continue;
            }
            for w in &rt.time_windows {
                if w.days_of_week.is_empty() || w.days_of_week.contains(&weekday) {
                    routine_windows.push(CalendarRoutineWindow {
                        date: timeutil::fmt_date(&d),
                        routine_id: rt.id.clone(),
                        title: rt.title.clone(),
                        start: w.start.clone(),
                        end: w.end.clone(),
                        priority: rt.priority,
                        tags: rt.tags.clone(),
                    });
                }
            }
        }
        d = match d.succ_opt() {
            Some(x) => x,
            None => break,
        };
    }

    Ok(CalendarData { occurrences, routine_windows })
}

/// `search(query)`：标题/标签/日期范围组合筛选。
#[tauri::command]
pub fn search_data(query: SearchQuery, state: State<AppState>) -> Result<SearchResult, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let data = storage.load_all().map_err(|e| e.to_string())?;
    Ok(schedule_core::search(&data, &query))
}

// ---------------------------------------------------------------------------
// Phase 2：统计 / 复盘 / 标签
// ---------------------------------------------------------------------------

/// `get_stats(days)`：完成趋势 + 标签耗时 + 日常完成率。
#[tauri::command]
pub fn get_stats(days: i64, state: State<AppState>) -> Result<StatsResult, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let data = storage.load_all().map_err(|e| e.to_string())?;
    let tz = &data.config.timezone;
    let to = timeutil::parse_date(&timeutil::today_string(tz)).map_err(|e| e.to_string())?;
    let from = to - Duration::days((days.max(1) - 1).min(3660));
    let archive = storage
        .load_archive_range(&month_of(&timeutil::fmt_date(&from)), &month_of(&timeutil::fmt_date(&to)))
        .map_err(|e| e.to_string())?;
    Ok(compute_stats(&archive, &data.routines, &data.events, &data.tasks, from, to))
}

/// `get_review(from, to)`：日/周复盘视图。
#[tauri::command]
pub fn get_review(from: String, to: String, state: State<AppState>) -> Result<ReviewResult, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let data = storage.load_all().map_err(|e| e.to_string())?;
    let f = timeutil::parse_date(&from).map_err(|e| e.to_string())?;
    let t = timeutil::parse_date(&to).map_err(|e| e.to_string())?;
    let archive = storage
        .load_archive_range(&month_of(&from), &month_of(&to))
        .map_err(|e| e.to_string())?;
    Ok(compute_review(&archive, &data.routines, &data.events, &data.tasks, f, t))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub tag: String,
    pub count: i64,
    /// V3.1：该标签的颜色 token（未设置时为 null）。
    pub color: Option<String>,
}

/// `list_tags()`：全部标签（去重、按名称排序）+ 每个标签的使用计数与颜色。
#[tauri::command]
pub fn list_tags(state: State<AppState>) -> Result<Vec<TagInfo>, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let data = storage.load_all().map_err(|e| e.to_string())?;
    let mut map: BTreeMap<String, i64> = BTreeMap::new();
    for e in &data.events {
        if e.deleted_at.is_none() {
            for t in &e.tags {
                *map.entry(t.clone()).or_insert(0) += 1;
            }
        }
    }
    for r in &data.routines {
        if r.deleted_at.is_none() {
            for t in &r.tags {
                *map.entry(t.clone()).or_insert(0) += 1;
            }
        }
    }
    for t in &data.tasks {
        if t.deleted_at.is_none() {
            for tag in &t.tags {
                *map.entry(tag.clone()).or_insert(0) += 1;
            }
        }
    }
    Ok(map
        .into_iter()
        .map(|(tag, count)| TagInfo {
            color: data.config.tag_colors.get(&tag).cloned(),
            tag,
            count,
        })
        .collect())
}

/// V3.1 U4：标签重命名时同步迁移颜色映射键；返回是否发生变更。
fn rename_tag_color(colors: &mut BTreeMap<String, String>, old: &str, new: &str) -> bool {
    if old == new {
        return false;
    }
    match colors.remove(old) {
        Some(color) => {
            colors.insert(new.to_string(), color);
            true
        }
        None => false,
    }
}

/// V3.1 U4：删除标签时同步清理颜色映射键；返回是否发生变更。
fn delete_tag_color(colors: &mut BTreeMap<String, String>, tag: &str) -> bool {
    colors.remove(tag).is_some()
}

/// `rename_tag(old, new)`：跨事件/日常/浮动事项重命名标签；同步迁移颜色映射（V3.1 U4）。
#[tauri::command]
pub fn rename_tag(old: String, new: String, state: State<AppState>) -> Result<(), String> {
    let new = new.trim().to_string();
    if new.is_empty() {
        return Err("新标签名不能为空".to_string());
    }
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;

    let mut config = storage.read_config().map_err(|e| e.to_string())?;
    if rename_tag_color(&mut config.tag_colors, &old, &new) {
        storage.save_config(&config).map_err(|e| e.to_string())?;
        if let Ok(mut cfg) = state.config.lock() {
            *cfg = config;
        }
    }

    let mut events = storage.read_events().map_err(|e| e.to_string())?;
    let mut e_changed = false;
    for e in events.iter_mut() {
        for t in e.tags.iter_mut() {
            if *t == old {
                *t = new.clone();
                e_changed = true;
            }
        }
    }
    if e_changed {
        storage.save_events(&events).map_err(|e| e.to_string())?;
    }

    let mut routines = storage.read_routines().map_err(|e| e.to_string())?;
    let mut r_changed = false;
    for r in routines.iter_mut() {
        for t in r.tags.iter_mut() {
            if *t == old {
                *t = new.clone();
                r_changed = true;
            }
        }
    }
    if r_changed {
        storage.save_routines(&routines).map_err(|e| e.to_string())?;
    }

    let mut tasks = storage.read_tasks().map_err(|e| e.to_string())?;
    let mut t_changed = false;
    for t in tasks.iter_mut() {
        for tag in t.tags.iter_mut() {
            if *tag == old {
                *tag = new.clone();
                t_changed = true;
            }
        }
    }
    if t_changed {
        storage.save_tasks(&tasks).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// `delete_tag(tag)`：跨事件/日常/浮动事项移除标签；同步删除颜色映射（V3.1 U4）。
#[tauri::command]
pub fn delete_tag(tag: String, state: State<AppState>) -> Result<(), String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;

    let mut config = storage.read_config().map_err(|e| e.to_string())?;
    if delete_tag_color(&mut config.tag_colors, &tag) {
        storage.save_config(&config).map_err(|e| e.to_string())?;
        if let Ok(mut cfg) = state.config.lock() {
            *cfg = config;
        }
    }

    let mut events = storage.read_events().map_err(|e| e.to_string())?;
    let mut e_changed = false;
    for e in events.iter_mut() {
        let before = e.tags.len();
        e.tags.retain(|t| t != &tag);
        if e.tags.len() != before {
            e_changed = true;
        }
    }
    if e_changed {
        storage.save_events(&events).map_err(|e| e.to_string())?;
    }

    let mut routines = storage.read_routines().map_err(|e| e.to_string())?;
    let mut r_changed = false;
    for r in routines.iter_mut() {
        let before = r.tags.len();
        r.tags.retain(|t| t != &tag);
        if r.tags.len() != before {
            r_changed = true;
        }
    }
    if r_changed {
        storage.save_routines(&routines).map_err(|e| e.to_string())?;
    }

    let mut tasks = storage.read_tasks().map_err(|e| e.to_string())?;
    let mut t_changed = false;
    for t in tasks.iter_mut() {
        let before = t.tags.len();
        t.tags.retain(|x| x != &tag);
        if t.tags.len() != before {
            t_changed = true;
        }
    }
    if t_changed {
        storage.save_tasks(&tasks).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Phase 1：自定义数据目录 / 导入导出
// ---------------------------------------------------------------------------

const DATA_FILES: [&str; 5] = ["events.json", "routines.json", "tasks.json", "templates.json", "config.json"];

/// `pick_directory()`：原生文件夹选择（用于导入/导出/自定义数据目录）。
#[tauri::command]
pub fn pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string()))
}

/// `set_data_dir(path)`：切换自定义数据目录（把现有数据迁移过去，写入指针文件）。
/// `path = "auto"` 时恢复默认用户数据目录。
#[tauri::command]
pub fn set_data_dir(path: String, state: State<AppState>) -> Result<Config, String> {
    let base = state.base_dir.clone();
    let target = if path == "auto" {
        base.clone()
    } else {
        let p = PathBuf::from(&path);
        if !p.is_absolute() {
            return Err("数据目录必须是绝对路径".to_string());
        }
        p
    };
    let src = {
        let storage = state.storage.lock().map_err(|_| lock_err())?;
        storage.data_dir().to_path_buf()
    };
    fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    fs::create_dir_all(target.join("archive")).map_err(|e| e.to_string())?;

    // 目标为空（无 config.json）时才复制现有数据，避免覆盖已有数据。
    if target != src && !target.join("config.json").exists() {
        copy_data_files(&src, &target);
    }

    // 切换存储，并把 dataDir 写入新目录的 config。
    let mut new_storage = Storage::new(target.clone());
    new_storage.ensure().map_err(|e| e.to_string())?;
    let mut config = new_storage.read_config().unwrap_or_default();
    config.data_dir = path.clone();
    new_storage.save_config(&config).map_err(|e| e.to_string())?;

    {
        let mut storage = state.storage.lock().map_err(|_| lock_err())?;
        *storage = new_storage;
    }
    if let Ok(mut cfg) = state.config.lock() {
        *cfg = config.clone();
    }
    // 数据目录切换后，让移动端服务 / Git 自动提交收敛到新目录。
    state.config_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    // 指针文件：自定义目录时写入，恢复默认时删除。
    if path == "auto" {
        let _ = fs::remove_file(base.join("data_dir.txt"));
    } else {
        let _ = fs::write(base.join("data_dir.txt"), path.as_bytes());
    }
    Ok(config)
}

/// `export_data(dest_dir)`：导出全部 JSON 到目标目录（生成 schedule-export 子目录）。
#[tauri::command]
pub fn export_data(dest_dir: String, state: State<AppState>) -> Result<Vec<String>, String> {
    let dest = PathBuf::from(dest_dir).join("schedule-export");
    let src = {
        let storage = state.storage.lock().map_err(|_| lock_err())?;
        storage.data_dir().to_path_buf()
    };
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for f in DATA_FILES {
        let s = src.join(f);
        if s.exists() {
            fs::copy(&s, dest.join(f)).map_err(|e| e.to_string())?;
            files.push(f.to_string());
        }
    }
    let arc_src = src.join("archive");
    if arc_src.exists() {
        let arc_dst = dest.join("archive");
        fs::create_dir_all(&arc_dst).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(&arc_src).map_err(|e| e.to_string())? {
            let p = entry.map_err(|e| e.to_string())?.path();
            if p.extension().and_then(|x| x.to_str()) == Some("json") {
                if let Some(name) = p.file_name().and_then(|x| x.to_str()) {
                    fs::copy(&p, arc_dst.join(name)).map_err(|e| e.to_string())?;
                    files.push(format!("archive/{name}"));
                }
            }
        }
    }
    Ok(files)
}

/// `import_data(src_dir)`：从目录导入全部 JSON（校验后覆盖，配置保留当前 dataDir）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub events: usize,
    pub routines: usize,
    pub tasks: usize,
    pub archive_months: usize,
}

#[tauri::command]
pub fn import_data(src_dir: String, state: State<AppState>) -> Result<ImportResult, String> {
    let src = PathBuf::from(src_dir);
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;

    // 先校验源目录数据（含迁移）。
    let mut src_storage = Storage::new(src.clone());
    let src_data = src_storage.load_all().map_err(|e| e.to_string())?;

    let cur_data_dir = storage.read_config().map_err(|e| e.to_string())?.data_dir.clone();
    let mut config = src_data.config.clone();
    config.data_dir = cur_data_dir;
    config.version = schedule_core::CURRENT_VERSION;

    storage.save_events(&src_data.events).map_err(|e| e.to_string())?;
    storage.save_routines(&src_data.routines).map_err(|e| e.to_string())?;
    storage.save_tasks(&src_data.tasks).map_err(|e| e.to_string())?;
    let templates = src_storage.read_templates().map_err(|e| e.to_string())?;
    storage.save_templates(&templates).map_err(|e| e.to_string())?;
    storage.save_config(&config).map_err(|e| e.to_string())?;

    // 归档：复制全部月份。
    let mut months = 0usize;
    let arc_src = src.join("archive");
    if arc_src.exists() {
        for entry in fs::read_dir(&arc_src).map_err(|e| e.to_string())? {
            let p = entry.map_err(|e| e.to_string())?.path();
            if p.extension().and_then(|x| x.to_str()) == Some("json") {
                if let Some(name) = p.file_name().and_then(|x| x.to_str()) {
                    let month = name.trim_end_matches(".json").to_string();
                    let af = src_storage.load_archive_month(&month).map_err(|e| e.to_string())?;
                    storage.save_archive_month(&af).map_err(|e| e.to_string())?;
                    months += 1;
                }
            }
        }
    }

    if let Ok(mut cfg) = state.config.lock() {
        *cfg = config;
    }
    Ok(ImportResult {
        events: src_data.events.len(),
        routines: src_data.routines.len(),
        tasks: src_data.tasks.len(),
        archive_months: months,
    })
}

/// best-effort 复制数据文件（用于切换自定义目录时迁移）。
fn copy_data_files(src: &Path, dst: &Path) {
    for f in DATA_FILES {
        let s = src.join(f);
        if s.exists() {
            let _ = fs::copy(&s, dst.join(f));
        }
    }
    let arc_src = src.join("archive");
    if arc_src.exists() {
        let _ = fs::create_dir_all(dst.join("archive"));
        if let Ok(entries) = fs::read_dir(&arc_src) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|x| x.to_str()) == Some("json") {
                    if let Some(name) = p.file_name().and_then(|x| x.to_str()) {
                        let _ = fs::copy(&p, dst.join("archive").join(name));
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Phase 3：事项模板（§9）
// ---------------------------------------------------------------------------

/// `list_templates()`：全部模板（含软删除，前端过滤）。
#[tauri::command]
pub fn list_templates(state: State<AppState>) -> Result<Vec<Template>, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    storage.read_templates().map_err(|e| e.to_string())
}

/// `make_template_default(kind)`：返回带一条默认条目的新模板草稿（不落盘）。
#[tauri::command]
pub fn make_template_default(kind: String) -> Result<Template, String> {
    let k = match kind.as_str() {
        "workday" => TemplateKind::Workday,
        "weekend" => TemplateKind::Weekend,
        _ => TemplateKind::Custom,
    };
    let mut t = new_template("", k);
    t.items = vec![new_template_item()];
    Ok(t)
}

/// `save_template(template)`：模板 CRUD（软删除由 delete_template 处理）。
#[tauri::command]
pub fn save_template(template: Template, state: State<AppState>) -> Result<Template, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let mut templates = storage.read_templates().map_err(|e| e.to_string())?;
    let mut t = template;
    if t.id.is_empty() {
        t.id = schedule_core::id::new_id("tp");
    }
    let now = timeutil::now_utc_string();
    if t.created_at.is_empty() {
        t.created_at = now.clone();
    }
    t.updated_at = now;
    match templates.iter_mut().find(|x| x.id == t.id) {
        Some(existing) => *existing = t.clone(),
        None => templates.push(t.clone()),
    }
    storage.save_templates(&templates).map_err(|e| e.to_string())?;
    Ok(t)
}

/// `delete_template(id)`：软删除模板。
#[tauri::command]
pub fn delete_template(id: String, state: State<AppState>) -> Result<(), String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let mut templates = storage.read_templates().map_err(|e| e.to_string())?;
    let now = timeutil::now_utc_string();
    for t in templates.iter_mut() {
        if t.id == id {
            t.deleted_at = Some(now.clone());
            t.updated_at = now.clone();
        }
    }
    storage.save_templates(&templates).map_err(|e| e.to_string())?;
    Ok(())
}

/// `preview_template(templateId, date)`：预览应用模板将生成的事件/日常（不落盘）。
#[tauri::command]
pub fn preview_template_cmd(
    template_id: String,
    date: String,
    state: State<AppState>,
) -> Result<TemplatePreview, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let config = storage.read_config().map_err(|e| e.to_string())?;
    let templates = storage.read_templates().map_err(|e| e.to_string())?;
    let t = templates
        .iter()
        .find(|t| t.id == template_id && t.deleted_at.is_none())
        .ok_or_else(|| "模板不存在".to_string())?;
    preview_template(t, &date, &config.timezone).map_err(|e| e.to_string())
}

/// `apply_template(templateId, date)`：批量生成事件/日常并写入存储（与模板解绑定）。
#[tauri::command]
pub fn apply_template_cmd(
    template_id: String,
    date: String,
    state: State<AppState>,
) -> Result<TemplateApplyResult, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let config = storage.read_config().map_err(|e| e.to_string())?;
    let templates = storage.read_templates().map_err(|e| e.to_string())?;
    let t = templates
        .iter()
        .find(|t| t.id == template_id && t.deleted_at.is_none())
        .cloned()
        .ok_or_else(|| "模板不存在".to_string())?;
    apply_template(&mut storage, &t, &date, &config.timezone).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Phase 3：脚本钩子（§9，导出钩子）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HooksStatus {
    pub enabled: bool,
    pub directory: String,
    pub scripts: Vec<HookInfo>,
    pub supported_hooks: Vec<String>,
}

/// `hooks_status()`：钩子开关、目录与脚本探测结果。
#[tauri::command]
pub fn hooks_status_cmd(state: State<AppState>) -> Result<HooksStatus, String> {
    let (enabled, dir) = {
        let storage = state.storage.lock().map_err(|_| lock_err())?;
        let enabled = state.config.lock().map(|c| c.hooks.enabled).unwrap_or(false);
        (enabled, storage.data_dir().to_path_buf())
    };
    let scripts = list_hooks(&dir);
    Ok(HooksStatus {
        enabled,
        directory: dir.display().to_string(),
        scripts,
        supported_hooks: schedule_core::hooks::HOOK_NAMES.iter().map(|s| s.to_string()).collect(),
    })
}

/// `run_hook_test(hook, payload)`：手动触发一次钩子，返回各脚本执行结果（用于验证/导出输出）。
#[tauri::command]
pub fn run_hook_test(hook: String, payload: String, state: State<AppState>) -> Result<Vec<HookRunResult>, String> {
    let enabled = state.config.lock().map(|c| c.hooks.enabled).unwrap_or(false);
    if !enabled {
        return Err("脚本钩子未启用，请先在「脚本钩子」页开启".to_string());
    }
    let dir = {
        let storage = state.storage.lock().map_err(|_| lock_err())?;
        storage.data_dir().to_path_buf()
    };
    Ok(dispatch_hook(&dir, &hook, &payload))
}

// ---------------------------------------------------------------------------
// V3.1：外部修改冲突处理
// ---------------------------------------------------------------------------

/// V3.1 T3：外部修改冲突的用户选择。
/// - `reload`：丢弃本地编辑，前端随后 `refresh()` 重载并重建 mtime 基线；
/// - `overwrite`：允许下一次写命令覆盖外部改动（写入成功后自动复位）。
#[tauri::command]
pub fn resolve_external_change(choice: String, state: State<AppState>) -> Result<(), String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    match choice.as_str() {
        "overwrite" => {
            storage.set_force_overwrite(true);
            Ok(())
        }
        "reload" => {
            storage.set_force_overwrite(false);
            Ok(())
        }
        _ => Err("无效的冲突处理选择".to_string()),
    }
}

// ---------------------------------------------------------------------------
// V3.0：打开数据目录
// ---------------------------------------------------------------------------

/// `open_data_dir()`：用系统文件管理器打开当前数据目录（V3.0 F6）。
#[tauri::command]
pub fn open_data_dir(state: State<AppState>) -> Result<(), String> {
    let dir = {
        let storage = state.storage.lock().map_err(|_| lock_err())?;
        storage.data_dir().to_path_buf()
    };
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开目录失败：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开目录失败：{e}"))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开目录失败：{e}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use schedule_core::id::new_id;
    use std::time::SystemTime;

    fn tmp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("schedule-app-test-{name}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// T1：手动补记的 `doneAt` 必须归入其本地日期所在月份/天。
    #[test]
    fn test_persist_archive_uses_done_at_local_date() {
        let dir = tmp_dir("persist-archive");
        let mut storage = Storage::new(dir.clone());
        storage.ensure().unwrap();

        // 2025-01-15T22:00:00Z 在 Asia/Shanghai 为 2025-01-16 06:00。
        let entry = ArchiveEntry {
            id: new_id("a"),
            time: "06:00".to_string(),
            title: "补记".to_string(),
            source: ArchiveSource::Manual,
            source_id: None,
            note: None,
            duration_minutes: None,
            done_at: "2025-01-15T22:00:00Z".to_string(),
        };
        let saved = persist_archive(&mut storage, entry).unwrap();
        let month = storage.load_archive_month("2025-01").unwrap();
        assert!(month.days.contains_key("2025-01-16"));
        assert_eq!(month.days["2025-01-16"].entries[0].id, saved.id);
    }

    /// T1：非法 `doneAt` 必须返回可读错误，而不是静默吞掉。
    #[test]
    fn test_persist_archive_rejects_invalid_done_at() {
        let dir = tmp_dir("persist-invalid");
        let mut storage = Storage::new(dir);
        storage.ensure().unwrap();
        let entry = ArchiveEntry {
            id: String::new(),
            time: "12:00".to_string(),
            title: "非法".to_string(),
            source: ArchiveSource::Manual,
            source_id: None,
            note: None,
            duration_minutes: None,
            done_at: "14:30T12:00:00".to_string(), // T1 修复前前端产生的非法值。
        };
        let err = persist_archive(&mut storage, entry).unwrap_err();
        assert!(err.contains("解析"), "错误应可读：{err}");
    }

    /// U4：重命名标签时颜色映射键同步迁移。
    #[test]
    fn test_rename_tag_color_migrates_mapping() {
        let mut colors = BTreeMap::new();
        colors.insert("工作".to_string(), "red".to_string());
        assert!(rename_tag_color(&mut colors, "工作", "办公"));
        assert_eq!(colors.get("办公").map(String::as_str), Some("red"));
        assert!(!colors.contains_key("工作"));
        assert!(!rename_tag_color(&mut colors, "不存在", "新"));
    }

    /// U4：删除标签时颜色映射键同步清理。
    #[test]
    fn test_delete_tag_color_removes_mapping() {
        let mut colors = BTreeMap::new();
        colors.insert("工作".to_string(), "blue".to_string());
        assert!(delete_tag_color(&mut colors, "工作"));
        assert!(colors.is_empty());
        assert!(!delete_tag_color(&mut colors, "工作"));
    }
}
