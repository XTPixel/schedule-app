//! 全部后端 IPC 命令（Sprint 0 API + Phase 1 / Phase 2 扩展）。
//!
//! 前端只做 UI，业务/存储/候选计算/自然语言解析/搜索/统计/通知全部在后端。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Duration;
use schedule_core::{
    apply_template, compute_candidates, compute_review, compute_stats, dispatch_hook,
    expand_events, list_hooks, new_template, new_template_item, parse_natural_language,
    preview_template, time_window_matches_date, timeutil, AppData, ArchiveDay, ArchiveEntry,
    ArchiveFile, ArchiveSource, CalendarData, CalendarRoutineWindow, CandidatesResult, Config,
    Event, HookInfo, HookRunResult, ItemStatus, LongTask, LongTaskSession, LongTaskStatus,
    NlpEvent, ReviewResult, Routine, SearchQuery, SearchResult, StatsResult, Storage, Task,
    Template, TemplateApplyResult, TemplateKind, TemplatePreview,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;
use tauri_plugin_notification::NotificationExt;

use crate::state::AppState;
use crate::sync::{InitialSyncChoiceInput, SyncConfigInput, SyncService, SyncStatus};

fn lock_err() -> String {
    "存储锁获取失败".to_string()
}

fn sync_service(state: &AppState) -> SyncService {
    SyncService::new(state.base_dir.clone()).with_runtime(
        state.sync_control.clone(),
        state.recovery_error.lock().ok().and_then(|e| e.clone()),
    )
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
/// 全天事件的 start/end 为纯日期，原样保留但必须通过日期格式校验（BUG-22）。
fn normalize_absolute(s: &str, all_day: bool) -> Result<String, String> {
    if all_day {
        timeutil::parse_date(s).map_err(|e| format!("全天事件日期无效：{e}"))?;
        Ok(s.to_string())
    } else {
        timeutil::normalize_to_utc(s).map_err(|e| e.to_string())
    }
}

fn month_of(date: &str) -> String {
    date.split('-').take(2).collect::<Vec<_>>().join("-")
}

/// Validate semantic data before replacing any live snapshot file.
pub(crate) fn validate_snapshot_data(data: &AppData) -> Result<(), String> {
    fn unique<'a>(ids: impl Iterator<Item = &'a str>) -> Result<(), String> {
        let mut seen = std::collections::HashSet::new();
        for id in ids {
            if id.is_empty() || !seen.insert(id) {
                return Err("备份包含空或重复事项 ID".into());
            }
        }
        Ok(())
    }
    unique(data.events.iter().map(|x| x.id.as_str()))?;
    unique(data.routines.iter().map(|x| x.id.as_str()))?;
    unique(data.tasks.iter().map(|x| x.id.as_str()))?;
    unique(data.long_tasks.iter().map(|x| x.id.as_str()))?;
    for event in &data.events {
        let start = normalize_absolute(&event.start, event.all_day)?;
        if let Some(end) = event.end.as_ref() {
            let end = normalize_absolute(end, event.all_day)?;
            if (event.all_day && end < start) || (!event.all_day && end <= start) {
                return Err("备份事件结束时间无效".into());
            }
        }
    }
    for routine in &data.routines {
        validate_routine(routine)?;
    }
    for task in &data.tasks {
        if let Some(deadline) = task.deadline.as_ref() {
            timeutil::parse_utc(deadline).map_err(|e| e.to_string())?;
        }
    }
    for task in &data.long_tasks {
        validate_long_task(task)?;
        unique(task.sessions.iter().map(|s| s.id.as_str()))?;
        for session in &task.sessions {
            let start = timeutil::parse_utc(&session.started_at).map_err(|e| e.to_string())?;
            let end = timeutil::parse_utc(&session.ended_at).map_err(|e| e.to_string())?;
            if end < start
                || session.duration_ms < 0
                || session.duration_ms > (end - start).num_milliseconds()
                || session.duration_ms > 7 * 24 * 60 * 60 * 1000
            {
                return Err("备份长期任务会话时长无效".into());
            }
        }
    }
    Ok(())
}

/// `YYYY-MM` 且月份合法（BUG-27：拒绝路径穿越 / 垃圾月份参数）。
fn is_valid_month(s: &str) -> bool {
    let mut parts = s.split('-');
    let (Some(y), Some(m), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    y.len() == 4
        && y.chars().all(|c| c.is_ascii_digit())
        && m.len() == 2
        && m.chars().all(|c| c.is_ascii_digit())
        && (1..=12).contains(&m.parse::<u32>().unwrap_or(0))
}

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

/// `load_all_data()`：加载并校验全部 JSON；随后幂等回填长期任务归档聚合条目。
#[tauri::command]
pub fn load_all_data(state: State<AppState>) -> Result<AppData, String> {
    if let Some(error) = state
        .recovery_error
        .lock()
        .map_err(|_| lock_err())?
        .as_ref()
    {
        return Err(format!("需要恢复数据：{error}"));
    }
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let mut data = storage.load_all().map_err(|e| e.to_string())?;
    // V1.2.1：升级前历史会话 / 归档缺漏回填（只补齐缺失，不覆盖已有条目）。
    if sync_service(&state).status().editable {
        backfill_long_task_archives_guarded(&mut storage, &data, || {
            sync_service(&state).prepare_write()
        })
        .map_err(|e| format!("长期任务归档对账失败：{e}"))?;
    }
    // 回填可能修改当前月份归档：重新加载一次，保证返回的 archive 与磁盘一致。
    data = storage.load_all().map_err(|e| e.to_string())?;
    if let Ok(mut cfg) = state.config.lock() {
        *cfg = data.config.clone();
    }
    Ok(data)
}

/// `get_now_candidates(now)`：返回候选（事件/日常/浮动事项）+ 今日时间轴 + 提醒。
#[tauri::command]
pub async fn get_now_candidates(now: String, app: AppHandle) -> Result<CandidatesResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let (data, dir) = {
            let mut storage = state.storage.lock().map_err(|_| lock_err())?;
            (
                storage.load_all().map_err(|e| e.to_string())?,
                storage.data_dir().to_path_buf(),
            )
        };
        let result = compute_candidates(&data, &now, &data.config).map_err(|e| e.to_string())?;
        #[cfg(target_os = "android")]
        if let Err(error) = crate::mobile_reminders::refresh(&app) {
            eprintln!("Android reminder plan: {error}");
        }
        dispatch_hook_if_enabled(
            data.config.hooks.enabled,
            &dir,
            "on_candidate_refresh",
            &result,
        );
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// 事件 CRUD（软删除）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn save_event(event: Event, state: State<AppState>) -> Result<Event, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
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
        // V1.2.2 BUG-12：结束必须晚于开始。
        let start_key = if ev.all_day {
            timeutil::parse_date(&ev.start)
                .map_err(|e| e.to_string())?
                .format("%Y-%m-%d")
                .to_string()
        } else {
            timeutil::normalize_to_utc(&ev.start).map_err(|e| e.to_string())?
        };
        let end_key = if ev.all_day {
            timeutil::parse_date(&ev.end.as_deref().unwrap_or_default())
                .map_err(|e| e.to_string())?
                .format("%Y-%m-%d")
                .to_string()
        } else {
            timeutil::normalize_to_utc(ev.end.as_deref().unwrap_or_default())
                .map_err(|e| e.to_string())?
        };
        if ev.all_day {
            if end_key < start_key {
                return Err("全天事件结束日期不能早于开始日期".to_string());
            }
        } else if end_key <= start_key {
            return Err("结束时间不能早于或等于开始时间".to_string());
        }
    }
    match events.iter_mut().find(|e| e.id == ev.id) {
        Some(existing) => *existing = ev.clone(),
        None => events.push(ev.clone()),
    }
    storage.save_events(&events).map_err(|e| e.to_string())?;
    let hooks_enabled = state
        .config
        .lock()
        .map(|c| c.hooks.enabled)
        .unwrap_or(false);
    dispatch_hook_if_enabled(hooks_enabled, storage.data_dir(), "on_event_saved", &ev);
    Ok(ev)
}

#[tauri::command]
pub fn delete_event(id: String, state: State<AppState>) -> Result<(), String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
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

/// V1.2.1：日常窗口校验（模式互斥 / N 范围 / 锚点合法 / 时间区间）。
fn validate_routine(r: &Routine) -> Result<(), String> {
    for w in &r.time_windows {
        let (Ok(start), Ok(end)) = (timeutil::parse_hhmm(&w.start), timeutil::parse_hhmm(&w.end))
        else {
            return Err(format!("时间窗口「{}–{}」格式无效", w.start, w.end));
        };
        // V1.2.2 BUG-10：允许跨午夜窗口（如 22:00–02:00），仅拒绝零时长窗口。
        if end == start {
            return Err(format!("时间窗口「{}–{}」不能为同一时刻", w.start, w.end));
        }
        match w.every_days {
            Some(n) => {
                if !(1..=365).contains(&n) {
                    return Err("每隔 N 天的 N 必须在 1–365 之间".to_string());
                }
                let Some(anchor) = w.anchor_date.as_deref() else {
                    return Err("每隔 N 天模式必须填写锚点日期".to_string());
                };
                if timeutil::parse_date(anchor).is_err() {
                    return Err(format!("锚点日期无效：{anchor}"));
                }
            }
            None => {
                if w.anchor_date.is_some() {
                    return Err("按星期模式不应有锚点日期".to_string());
                }
                if w.days_of_week.iter().any(|d| !(1..=7).contains(d)) {
                    return Err("星期取值必须在 1–7 之间".to_string());
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn save_routine(routine: Routine, state: State<AppState>) -> Result<Routine, String> {
    let mut r = routine;
    // 保存时清理互斥字段，避免歧义；再统一校验。
    for w in r.time_windows.iter_mut() {
        if w.every_days.is_some() {
            w.days_of_week.clear();
        } else {
            w.anchor_date = None;
        }
    }
    validate_routine(&r)?;

    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
    let mut routines = storage.read_routines().map_err(|e| e.to_string())?;
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
    storage
        .save_routines(&routines)
        .map_err(|e| e.to_string())?;
    Ok(r)
}

#[tauri::command]
pub fn delete_routine(id: String, state: State<AppState>) -> Result<(), String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
    let mut routines = storage.read_routines().map_err(|e| e.to_string())?;
    let now = timeutil::now_utc_string();
    for r in routines.iter_mut() {
        if r.id == id {
            r.deleted_at = Some(now.clone());
            r.updated_at = now.clone();
        }
    }
    storage
        .save_routines(&routines)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 浮动事项 CRUD（软删除）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn save_task(task: Task, state: State<AppState>) -> Result<Task, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
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
    sync_service(&state).prepare_write()?;
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
// 长期任务 CRUD / 会话（V1.2）
// ---------------------------------------------------------------------------

/// 校验长期任务：标题非空；startDate / dueDate 为合法本地日期且 dueDate ≥ startDate。
fn validate_long_task(t: &LongTask) -> Result<(), String> {
    if t.title.trim().is_empty() {
        return Err("标题不能为空".to_string());
    }
    let start = timeutil::parse_date(&t.start_date).map_err(|e| format!("开始日期无效：{e}"))?;
    let due = timeutil::parse_date(&t.due_date).map_err(|e| format!("截止日期无效：{e}"))?;
    if due < start {
        return Err("截止日期不能早于开始日期".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn save_long_task(task: LongTask, state: State<AppState>) -> Result<LongTask, String> {
    validate_long_task(&task)?;
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
    let mut tasks = storage.read_long_tasks().map_err(|e| e.to_string())?;
    let mut t = task;
    if t.id.is_empty() {
        t.id = schedule_core::id::new_id("lt");
    }
    let now = timeutil::now_utc_string();
    if t.created_at.is_empty() {
        t.created_at = now.clone();
    }
    t.updated_at = now.clone();
    // 手动结束落 endedAt；active 的未结束任务不保留 endedAt。
    match t.status {
        LongTaskStatus::Ended => {
            if t.ended_at.is_none() {
                t.ended_at = Some(now.clone());
            }
        }
        LongTaskStatus::Active => t.ended_at = None,
    }
    match tasks.iter_mut().find(|x| x.id == t.id) {
        Some(existing) => *existing = t.clone(),
        None => tasks.push(t.clone()),
    }
    storage.save_long_tasks(&tasks).map_err(|e| e.to_string())?;
    Ok(t)
}

#[tauri::command]
pub fn delete_long_task(id: String, state: State<AppState>) -> Result<(), String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
    let mut tasks = storage.read_long_tasks().map_err(|e| e.to_string())?;
    let now = timeutil::now_utc_string();
    for t in tasks.iter_mut() {
        if t.id == id {
            t.deleted_at = Some(now.clone());
            t.updated_at = now.clone();
        }
    }
    storage.save_long_tasks(&tasks).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// V1.2.1：长期任务会话 ↔ 归档聚合同步
// ---------------------------------------------------------------------------

/// 会话归属日期 = `endedAt` 的本地日期（与归档 doneAt 口径一致，V1.2.1 修订 D7）。
fn long_task_session_date(s: &LongTaskSession, tz: &str) -> Result<String, String> {
    let ended = timeutil::parse_utc(&s.ended_at).map_err(|e| e.to_string())?;
    Ok(timeutil::fmt_local_date(&ended, tz))
}

/// 按 §3.2 规则构建某天某长期任务的聚合归档条目；无有效会话返回 None。
fn build_long_task_archive_entry(
    task: &LongTask,
    sessions: &[&LongTaskSession],
    tz: &str,
    existing_id: Option<String>,
) -> Result<Option<ArchiveEntry>, String> {
    if sessions.is_empty() {
        return Ok(None);
    }
    // time / doneAt：当天首次有效会话的结束时刻。
    let mut by_end: Vec<&LongTaskSession> = sessions.to_vec();
    by_end.sort_by(|a, b| a.ended_at.cmp(&b.ended_at));
    let first = by_end[0];
    let done_utc = timeutil::parse_utc(&first.ended_at).map_err(|e| e.to_string())?;
    let time = timeutil::fmt_local_time(&done_utc, tz);

    // note：按会话开始时间升序，每行 `HH:mm 收获`；无收获的会话不占行。
    let mut noted: Vec<&LongTaskSession> = sessions
        .iter()
        .copied()
        .filter(|s| {
            s.note
                .as_deref()
                .map(|n| !n.trim().is_empty())
                .unwrap_or(false)
        })
        .collect();
    noted.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    let note_lines: Vec<String> = noted
        .iter()
        .filter_map(|s| {
            let started = timeutil::parse_utc(&s.started_at).ok()?;
            let hm = timeutil::fmt_local_time(&started, tz);
            Some(format!(
                "{hm} {}",
                s.note.as_deref().unwrap_or_default().trim()
            ))
        })
        .collect();
    let note = if note_lines.is_empty() {
        None
    } else {
        Some(note_lines.join("\n"))
    };

    let total_ms: i64 = sessions.iter().map(|s| s.duration_ms.max(0)).sum();
    let duration_minutes = (((total_ms as f64) / 60_000.0).round() as i64).max(1);

    Ok(Some(ArchiveEntry {
        id: existing_id.unwrap_or_else(|| schedule_core::id::new_id("a")),
        time,
        title: task.title.clone(),
        source: ArchiveSource::LongTask,
        source_id: Some(task.id.clone()),
        note,
        duration_minutes: Some(duration_minutes),
        done_at: first.ended_at.clone(),
    }))
}

/// 重建式聚合：删除该任务在某天的既有 longtask 条目，再按剩余有效会话重建。
fn sync_long_task_archive_day(
    storage: &mut Storage,
    task: &LongTask,
    date: &str,
) -> Result<(), String> {
    let tz = storage
        .read_config()
        .map_err(|e| e.to_string())?
        .timezone
        .clone();
    let month = month_of(date);
    let mut archive = storage
        .load_archive_month(&month)
        .map_err(|e| e.to_string())?;
    let day = archive
        .days
        .entry(date.to_string())
        .or_insert_with(|| ArchiveDay {
            entries: vec![],
            summary: None,
            updated_at: timeutil::now_utc_string(),
        });

    let existing_id = day
        .entries
        .iter()
        .find(|e| {
            e.source == ArchiveSource::LongTask && e.source_id.as_deref() == Some(task.id.as_str())
        })
        .map(|e| e.id.clone());
    day.entries.retain(|e| {
        !(e.source == ArchiveSource::LongTask && e.source_id.as_deref() == Some(task.id.as_str()))
    });

    let sessions: Vec<&LongTaskSession> = task
        .sessions
        .iter()
        .filter(|s| s.deleted_at.is_none())
        .filter(|s| long_task_session_date(s, &tz).ok().as_deref() == Some(date))
        .collect();

    if let Some(entry) = build_long_task_archive_entry(task, &sessions, &tz, existing_id)? {
        day.entries.push(entry);
    }
    day.entries.sort_by(|a, b| a.done_at.cmp(&b.done_at));
    day.updated_at = timeutil::now_utc_string();
    storage
        .save_archive_month(&archive)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 启动 / 加载时幂等回填：只补齐缺失的 longtask 聚合条目，不覆盖已存在条目。
#[cfg(test)]
fn backfill_long_task_archives(storage: &mut Storage, data: &AppData) -> Result<usize, String> {
    backfill_long_task_archives_guarded(storage, data, || Ok(()))
}
fn backfill_long_task_archives_guarded(
    storage: &mut Storage,
    data: &AppData,
    before_write: impl Fn() -> Result<(), String>,
) -> Result<usize, String> {
    let tz = &data.config.timezone;
    // (task index, task id, date) -> 该天全部有效会话。
    let mut grouped: BTreeMap<(usize, String, String), Vec<&LongTaskSession>> = BTreeMap::new();
    for (idx, task) in data.long_tasks.iter().enumerate() {
        for s in &task.sessions {
            if s.deleted_at.is_some() {
                continue;
            }
            let Ok(date) = long_task_session_date(s, tz) else {
                continue;
            };
            grouped
                .entry((idx, task.id.clone(), date))
                .or_default()
                .push(s);
        }
    }

    let mut created = 0usize;
    for ((idx, _task_id, date), sessions) in grouped {
        let task = &data.long_tasks[idx];
        let month = month_of(&date);
        let mut archive = storage
            .load_archive_month(&month)
            .map_err(|e| e.to_string())?;
        let day = archive
            .days
            .entry(date.clone())
            .or_insert_with(|| ArchiveDay {
                entries: vec![],
                summary: None,
                updated_at: timeutil::now_utc_string(),
            });
        let missing = !day.entries.iter().any(|e| {
            e.source == ArchiveSource::LongTask && e.source_id.as_deref() == Some(task.id.as_str())
        });
        if missing {
            if let Some(entry) = build_long_task_archive_entry(task, &sessions, tz, None)? {
                before_write()?;
                day.entries.push(entry);
                day.entries.sort_by(|a, b| a.done_at.cmp(&b.done_at));
                day.updated_at = timeutil::now_utc_string();
                storage
                    .save_archive_month(&archive)
                    .map_err(|e| e.to_string())?;
                created += 1;
            }
        }
    }
    Ok(created)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddLongTaskSessionInput {
    pub task_id: String,
    pub started_at: String,
    pub ended_at: String,
    #[serde(default)]
    pub duration_ms: i64,
    #[serde(default)]
    pub note: Option<String>,
    /// V1.2.1：前端生成的幂等键；重试 / 补偿时不会重复写入会话。
    pub session_id: String,
}

#[tauri::command]
pub fn add_long_task_session(
    input: AddLongTaskSessionInput,
    state: State<AppState>,
) -> Result<LongTaskSession, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
    let config = storage.read_config().map_err(|e| e.to_string())?;
    let tz = config.timezone.clone();
    let mut tasks = storage.read_long_tasks().map_err(|e| e.to_string())?;
    let idx = tasks
        .iter()
        .position(|t| t.id == input.task_id && t.deleted_at.is_none())
        .ok_or_else(|| "长期任务不存在或已删除".to_string())?;

    // 幂等：同 sessionId（含软删除）已存在时直接返回，并补偿归档对账。
    if let Some(existing) = tasks[idx]
        .sessions
        .iter()
        .find(|s| s.id == input.session_id)
    {
        let out = existing.clone();
        let date = long_task_session_date(existing, &tz)?;
        let task = tasks[idx].clone();
        sync_long_task_archive_day(&mut storage, &task, &date)?;
        return Ok(out);
    }

    let started = timeutil::normalize_to_utc(&input.started_at).map_err(|e| e.to_string())?;
    let ended = timeutil::normalize_to_utc(&input.ended_at).map_err(|e| e.to_string())?;
    let started_utc = timeutil::parse_utc(&started).map_err(|e| e.to_string())?;
    let ended_utc = timeutil::parse_utc(&ended).map_err(|e| e.to_string())?;
    if ended_utc < started_utc {
        return Err("结束时间不能早于开始时间".to_string());
    }
    // V1.2.2 BUG-03：durationMs 是前端累计的「有效投入时长」（已扣除暂停/应用关闭期间），
    // 作为权威值落库；endedAt-startedAt 仅用于校验时间先后，不再用于覆盖时长。
    let duration_ms = input.duration_ms;
    if duration_ms <= 0 {
        return Err("本次用时过短，未记录会话".to_string());
    }
    if duration_ms > 7 * 24 * 60 * 60 * 1000 {
        return Err("单次会话时长异常（超过 7 天），未记录".to_string());
    }

    let now = timeutil::now_utc_string();
    let session = LongTaskSession {
        id: input.session_id.clone(),
        started_at: started,
        ended_at: ended,
        duration_ms,
        note: input.note.filter(|n| !n.trim().is_empty()),
        created_at: now.clone(),
        updated_at: now.clone(),
        deleted_at: None,
    };
    tasks[idx].sessions.push(session.clone());
    tasks[idx].updated_at = now;
    let task = tasks[idx].clone();
    // 先写会话，再同步归档；归档失败返回错误，前端保留计时可重试（幂等键防重复）。
    storage.save_long_tasks(&tasks).map_err(|e| e.to_string())?;
    let date = long_task_session_date(&session, &tz)?;
    sync_long_task_archive_day(&mut storage, &task, &date)?;
    Ok(session)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLongTaskSessionNoteInput {
    pub task_id: String,
    pub session_id: String,
    #[serde(default)]
    pub note: Option<String>,
}

#[tauri::command]
pub fn update_long_task_session_note(
    input: UpdateLongTaskSessionNoteInput,
    state: State<AppState>,
) -> Result<LongTaskSession, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
    let config = storage.read_config().map_err(|e| e.to_string())?;
    let tz = config.timezone.clone();
    let mut tasks = storage.read_long_tasks().map_err(|e| e.to_string())?;
    let idx = tasks
        .iter()
        .position(|t| t.id == input.task_id && t.deleted_at.is_none())
        .ok_or_else(|| "长期任务不存在或已删除".to_string())?;
    let updated = timeutil::now_utc_string();
    let (date, out) = {
        let task = &mut tasks[idx];
        let session = task
            .sessions
            .iter_mut()
            .find(|s| s.id == input.session_id && s.deleted_at.is_none())
            .ok_or_else(|| "会话记录不存在或已删除".to_string())?;
        session.note = input.note.filter(|n| !n.trim().is_empty());
        session.updated_at = updated.clone();
        let date = long_task_session_date(session, &tz)?;
        let out = session.clone();
        task.updated_at = updated;
        (date, out)
    };
    let task = tasks[idx].clone();
    storage.save_long_tasks(&tasks).map_err(|e| e.to_string())?;
    sync_long_task_archive_day(&mut storage, &task, &date)?;
    Ok(out)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongTaskSessionRef {
    pub task_id: String,
    pub session_id: String,
}

#[tauri::command]
pub fn delete_long_task_session(
    input: LongTaskSessionRef,
    state: State<AppState>,
) -> Result<(), String> {
    set_long_task_session_deleted(input, true, state)
}

#[tauri::command]
pub fn undelete_long_task_session(
    input: LongTaskSessionRef,
    state: State<AppState>,
) -> Result<(), String> {
    set_long_task_session_deleted(input, false, state)
}

fn set_long_task_session_deleted(
    input: LongTaskSessionRef,
    deleted: bool,
    state: State<AppState>,
) -> Result<(), String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
    let config = storage.read_config().map_err(|e| e.to_string())?;
    let tz = config.timezone.clone();
    let mut tasks = storage.read_long_tasks().map_err(|e| e.to_string())?;
    let idx = tasks
        .iter()
        .position(|t| t.id == input.task_id && t.deleted_at.is_none())
        .ok_or_else(|| "长期任务不存在或已删除".to_string())?;
    let session = tasks[idx]
        .sessions
        .iter_mut()
        .find(|s| s.id == input.session_id)
        .ok_or_else(|| "会话记录不存在".to_string())?;
    let date = long_task_session_date(session, &tz)?;
    let now = timeutil::now_utc_string();
    session.deleted_at = if deleted { Some(now.clone()) } else { None };
    session.updated_at = now.clone();
    tasks[idx].updated_at = now;
    let task = tasks[idx].clone();
    storage.save_long_tasks(&tasks).map_err(|e| e.to_string())?;
    sync_long_task_archive_day(&mut storage, &task, &date)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// V1.2.2：归档页删除长期任务聚合条目（同步软删除当天会话，统计随之更新）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLongTaskArchiveDayInput {
    pub task_id: String,
    /// 归档条目所属本地日期 YYYY-MM-DD。
    pub date: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLongTaskArchiveDayResult {
    pub deleted_session_ids: Vec<String>,
}

#[tauri::command]
pub fn delete_long_task_archive_day(
    input: DeleteLongTaskArchiveDayInput,
    state: State<AppState>,
) -> Result<DeleteLongTaskArchiveDayResult, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
    let config = storage.read_config().map_err(|e| e.to_string())?;
    let tz = config.timezone.clone();
    let mut tasks = storage.read_long_tasks().map_err(|e| e.to_string())?;
    let idx = tasks
        .iter()
        .position(|t| t.id == input.task_id)
        .ok_or_else(|| "长期任务不存在".to_string())?;

    let now = timeutil::now_utc_string();
    let mut deleted_session_ids = Vec::new();
    for s in tasks[idx].sessions.iter_mut() {
        if s.deleted_at.is_none()
            && long_task_session_date(s, &tz).ok().as_deref() == Some(input.date.as_str())
        {
            s.deleted_at = Some(now.clone());
            s.updated_at = now.clone();
            deleted_session_ids.push(s.id.clone());
        }
    }
    tasks[idx].updated_at = now;
    let task = tasks[idx].clone();
    storage.save_long_tasks(&tasks).map_err(|e| e.to_string())?;
    sync_long_task_archive_day(&mut storage, &task, &input.date)?;
    Ok(DeleteLongTaskArchiveDayResult {
        deleted_session_ids,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndeleteLongTaskArchiveDayInput {
    pub task_id: String,
    pub date: String,
    pub session_ids: Vec<String>,
}

#[tauri::command]
pub fn undelete_long_task_archive_day(
    input: UndeleteLongTaskArchiveDayInput,
    state: State<AppState>,
) -> Result<(), String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
    let mut tasks = storage.read_long_tasks().map_err(|e| e.to_string())?;
    let idx = tasks
        .iter()
        .position(|t| t.id == input.task_id)
        .ok_or_else(|| "长期任务不存在".to_string())?;
    let now = timeutil::now_utc_string();
    for s in tasks[idx].sessions.iter_mut() {
        if input.session_ids.contains(&s.id) && s.deleted_at.is_some() {
            s.deleted_at = None;
            s.updated_at = now.clone();
        }
    }
    tasks[idx].updated_at = now;
    let task = tasks[idx].clone();
    storage.save_long_tasks(&tasks).map_err(|e| e.to_string())?;
    sync_long_task_archive_day(&mut storage, &task, &input.date)?;
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
    let mut archive = storage
        .load_archive_month(&month)
        .map_err(|err| err.to_string())?;
    let day = archive
        .days
        .entry(date.clone())
        .or_insert_with(|| ArchiveDay {
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
    storage
        .save_archive_month(&archive)
        .map_err(|err| err.to_string())?;
    Ok(e)
}

/// `archive_entry(entry)`：写入一条归档，返回已保存的条目。
#[tauri::command]
pub fn archive_entry(entry: ArchiveEntry, state: State<AppState>) -> Result<ArchiveEntry, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
    let saved = persist_archive(&mut storage, entry)?;
    let hooks_enabled = state
        .config
        .lock()
        .map(|c| c.hooks.enabled)
        .unwrap_or(false);
    dispatch_hook_if_enabled(
        hooks_enabled,
        storage.data_dir(),
        "on_archive_entry_add",
        &saved,
    );
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
pub fn complete_candidate(
    input: CompleteCandidateInput,
    state: State<AppState>,
) -> Result<ArchiveEntry, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
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
    let hooks_enabled = state
        .config
        .lock()
        .map(|c| c.hooks.enabled)
        .unwrap_or(false);
    dispatch_hook_if_enabled(
        hooks_enabled,
        storage.data_dir(),
        "on_archive_entry_add",
        &saved,
    );

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
    // BUG-27：校验日期 key，拒绝写入垃圾 day key。
    timeutil::parse_date(&date).map_err(|e| e.to_string())?;
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
    let month = month_of(&date);
    let mut archive = storage
        .load_archive_month(&month)
        .map_err(|e| e.to_string())?;
    let mut day = payload;
    day.updated_at = timeutil::now_utc_string();
    archive.days.insert(date.clone(), day.clone());
    storage
        .save_archive_month(&archive)
        .map_err(|e| e.to_string())?;
    Ok(day)
}

/// 读取指定月份归档（归档页翻月用）。
#[tauri::command]
pub fn get_archive_month(month: String, state: State<AppState>) -> Result<ArchiveFile, String> {
    // BUG-27：白名单校验月份格式，拒绝路径穿越类参数。
    if !is_valid_month(&month) {
        return Err("月份参数无效".to_string());
    }
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    storage
        .load_archive_month(&month)
        .map_err(|e| e.to_string())
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
    if let Some(error) = state
        .recovery_error
        .lock()
        .map_err(|_| lock_err())?
        .as_ref()
    {
        return Err(format!("需要恢复数据：{error}"));
    }
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let previous = storage.read_config().map_err(|e| e.to_string())?;
    if previous.tag_colors != config.tag_colors
        || previous.candidate.missed_routine_grace_hours
            != config.candidate.missed_routine_grace_hours
    {
        sync_service(&state).prepare_write()?;
    }
    config.version = schedule_core::CURRENT_VERSION;
    storage.save_config(&config).map_err(|e| e.to_string())?;
    if let Ok(mut cfg) = state.config.lock() {
        *cfg = config.clone();
    }
    // V3.1 T4：仅落盘 + 递增 generation；单一 config_applier 线程串行收敛
    // 热键 / 移动端服务 / Git 自动提交，快速连续保存不会并发重启。
    state
        .config_generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
pub fn get_calendar(
    start: String,
    end: String,
    state: State<AppState>,
) -> Result<CalendarData, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let data = storage.load_all().map_err(|e| e.to_string())?;
    let from = timeutil::parse_date(&start).map_err(|e| e.to_string())?;
    let to = timeutil::parse_date(&end).map_err(|e| e.to_string())?;
    let occurrences = expand_events(&data.events, from, to, &data.config.timezone);

    let mut routine_windows = Vec::new();
    let mut d = from;
    while d <= to {
        for rt in &data.routines {
            if !rt.enabled || rt.deleted_at.is_some() {
                continue;
            }
            for w in &rt.time_windows {
                // V1.2.1：统一窗口命中（按星期 / 每隔 N 天）。
                if time_window_matches_date(w, d) {
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

    Ok(CalendarData {
        occurrences,
        routine_windows,
    })
}

/// `search(query)`：标题/标签/日期范围组合筛选。
#[tauri::command]
pub fn search_data(query: SearchQuery, state: State<AppState>) -> Result<SearchResult, String> {
    // BUG-23：日期范围倒置给出明确错误，而不是静默返回空结果。
    if let (Some(f), Some(t)) = (query.date_from.as_deref(), query.date_to.as_deref()) {
        let from = timeutil::parse_date(f).map_err(|e| e.to_string())?;
        let to = timeutil::parse_date(t).map_err(|e| e.to_string())?;
        if from > to {
            return Err("开始日期不能晚于结束日期".to_string());
        }
    }
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
        .load_archive_range(
            &month_of(&timeutil::fmt_date(&from)),
            &month_of(&timeutil::fmt_date(&to)),
        )
        .map_err(|e| e.to_string())?;
    Ok(compute_stats(
        &archive,
        &data.routines,
        &data.events,
        &data.tasks,
        &data.long_tasks,
        from,
        to,
    ))
}

/// `get_review(from, to)`：日/周复盘视图。
#[tauri::command]
pub fn get_review(
    from: String,
    to: String,
    state: State<AppState>,
) -> Result<ReviewResult, String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let data = storage.load_all().map_err(|e| e.to_string())?;
    let f = timeutil::parse_date(&from).map_err(|e| e.to_string())?;
    let t = timeutil::parse_date(&to).map_err(|e| e.to_string())?;
    let archive = storage
        .load_archive_range(&month_of(&from), &month_of(&to))
        .map_err(|e| e.to_string())?;
    Ok(compute_review(
        &archive,
        &data.routines,
        &data.events,
        &data.tasks,
        &data.long_tasks,
        f,
        t,
    ))
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
    for lt in &data.long_tasks {
        if lt.deleted_at.is_none() {
            for tag in &lt.tags {
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

/// `rename_tag(old, new)`：跨事件/日常/浮动/长期任务重命名标签；同步迁移颜色映射（V3.1 U4）。
/// BUG-16：任一文件写失败由命令层整体回滚。
fn rename_tag_impl(storage: &mut Storage, old: &str, new: &str) -> Result<bool, String> {
    let mut config = storage.read_config().map_err(|e| e.to_string())?;
    let color_changed = rename_tag_color(&mut config.tag_colors, old, new);
    if color_changed {
        storage.save_config(&config).map_err(|e| e.to_string())?;
    }

    let mut events = storage.read_events().map_err(|e| e.to_string())?;
    let mut e_changed = false;
    for e in events.iter_mut() {
        for t in e.tags.iter_mut() {
            if *t == old {
                *t = new.to_string();
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
                *t = new.to_string();
                r_changed = true;
            }
        }
    }
    if r_changed {
        storage
            .save_routines(&routines)
            .map_err(|e| e.to_string())?;
    }

    let mut tasks = storage.read_tasks().map_err(|e| e.to_string())?;
    let mut t_changed = false;
    for t in tasks.iter_mut() {
        for tag in t.tags.iter_mut() {
            if *tag == old {
                *tag = new.to_string();
                t_changed = true;
            }
        }
    }
    if t_changed {
        storage.save_tasks(&tasks).map_err(|e| e.to_string())?;
    }

    let mut long_tasks = storage.read_long_tasks().map_err(|e| e.to_string())?;
    let mut lt_changed = false;
    for lt in long_tasks.iter_mut() {
        for tag in lt.tags.iter_mut() {
            if *tag == old {
                *tag = new.to_string();
                lt_changed = true;
            }
        }
    }
    if lt_changed {
        storage
            .save_long_tasks(&long_tasks)
            .map_err(|e| e.to_string())?;
    }
    Ok(color_changed)
}

#[tauri::command]
pub fn rename_tag(old: String, new: String, state: State<AppState>) -> Result<(), String> {
    let new = new.trim().to_string();
    if new.is_empty() {
        return Err("新标签名不能为空".to_string());
    }
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
    let color_changed = crate::sync_snapshot::edit(&mut storage, |staged| rename_tag_impl(staged, &old, &new))?;
    if color_changed {
        let config = storage.read_config().map_err(|e| e.to_string())?;
        if let Ok(mut cfg) = state.config.lock() { *cfg = config; }
    }
    Ok(())
}

/// `delete_tag(tag)`：跨事件/日常/浮动/长期任务移除标签；同步删除颜色映射（V3.1 U4）。
/// BUG-16：任一文件写失败由命令层整体回滚。
fn delete_tag_impl(storage: &mut Storage, tag: &str) -> Result<bool, String> {
    let mut config = storage.read_config().map_err(|e| e.to_string())?;
    let color_changed = delete_tag_color(&mut config.tag_colors, tag);
    if color_changed {
        storage.save_config(&config).map_err(|e| e.to_string())?;
    }

    let mut events = storage.read_events().map_err(|e| e.to_string())?;
    let mut e_changed = false;
    for e in events.iter_mut() {
        let before = e.tags.len();
        e.tags.retain(|t| t != tag);
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
        r.tags.retain(|t| t != tag);
        if r.tags.len() != before {
            r_changed = true;
        }
    }
    if r_changed {
        storage
            .save_routines(&routines)
            .map_err(|e| e.to_string())?;
    }

    let mut tasks = storage.read_tasks().map_err(|e| e.to_string())?;
    let mut t_changed = false;
    for t in tasks.iter_mut() {
        let before = t.tags.len();
        t.tags.retain(|x| x != tag);
        if t.tags.len() != before {
            t_changed = true;
        }
    }
    if t_changed {
        storage.save_tasks(&tasks).map_err(|e| e.to_string())?;
    }

    let mut long_tasks = storage.read_long_tasks().map_err(|e| e.to_string())?;
    let mut lt_changed = false;
    for lt in long_tasks.iter_mut() {
        let before = lt.tags.len();
        lt.tags.retain(|x| x != tag);
        if lt.tags.len() != before {
            lt_changed = true;
        }
    }
    if lt_changed {
        storage
            .save_long_tasks(&long_tasks)
            .map_err(|e| e.to_string())?;
    }
    Ok(color_changed)
}

#[tauri::command]
pub fn delete_tag(tag: String, state: State<AppState>) -> Result<(), String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
    let color_changed = crate::sync_snapshot::edit(&mut storage, |staged| delete_tag_impl(staged, &tag))?;
    if color_changed {
        let config = storage.read_config().map_err(|e| e.to_string())?;
        if let Ok(mut cfg) = state.config.lock() { *cfg = config; }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Phase 1：自定义数据目录 / 导入导出
// ---------------------------------------------------------------------------

const DATA_FILES: [&str; 6] = [
    "events.json",
    "routines.json",
    "tasks.json",
    "templates.json",
    "config.json",
    "long_tasks.json",
];

/// `pick_directory()`：原生文件夹选择（用于导入/导出/自定义数据目录）。
#[tauri::command]
#[cfg(desktop)]
pub fn pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string()))
}

/// 移动端没有桌面文件夹选择器；数据目录由系统应用沙盒管理。
#[tauri::command]
#[cfg(mobile)]
pub fn pick_directory(_app: tauri::AppHandle) -> Result<Option<String>, String> {
    Err("Android 不支持选择本机数据目录".to_string())
}

/// `set_data_dir(path)`：切换自定义数据目录（把现有数据迁移过去，写入指针文件）。
/// `path = "auto"` 时恢复默认用户数据目录。
#[tauri::command]
pub fn set_data_dir(path: String, state: State<AppState>) -> Result<Config, String> {
    #[cfg(target_os = "android")]
    {
        let _ = (path, state);
        return Err("Android 使用应用沙盒，不支持切换数据目录".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _operation = state
            .sync_gate
            .try_lock()
            .map_err(|_| "同步正在进行，请稍后切换目录".to_string())?;
        let mut storage = state.storage.lock().map_err(|_| lock_err())?;
        sync_service(&state).prepare_write()?;
        let base = state.base_dir.clone();
        let target = if path == "auto" {
            base.clone()
        } else {
            let p = PathBuf::from(&path);
            if !p.is_absolute() {
                return Err("数据目录必须是绝对路径".into());
            }
            p
        };
        let source = storage.data_dir().to_path_buf();
        let mut next = Storage::new(target.clone());
        next.ensure().map_err(|e| e.to_string())?;
        if source != target
            && target
                .canonicalize()
                .map_err(|e| e.to_string())?
                .starts_with(source.canonicalize().map_err(|e| e.to_string())?)
        {
            return Err("新目录不能位于当前数据目录内部".into());
        }
        let has_files = DATA_FILES.iter().any(|name| target.join(name).exists())
            || fs::read_dir(target.join("archive"))
                .map(|mut entries| entries.next().is_some())
                .unwrap_or(false);
        let mut config = if source != target && !has_files {
            let payload = crate::sync::build_payload(&mut storage)?;
            let mut config = storage.read_config().map_err(|e| e.to_string())?;
            config.data_dir = path.clone();
            crate::sync_snapshot::apply_with_config(&mut next, &payload, Some(config.clone()))?;
            config
        } else {
            crate::sync_snapshot::recover(&target)?;
            let data = next.load_all().map_err(|e| e.to_string())?;
            validate_snapshot_data(&data)?;
            data.config
        };
        config.data_dir = path.clone();
        next.save_config(&config).map_err(|e| e.to_string())?;
        let pointer = base.join("data_dir.txt");
        if path == "auto" {
            match fs::remove_file(&pointer) {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(format!("更新数据目录指针失败：{e}")),
            }
        } else {
            crate::sync::atomic_write(&pointer, target.to_string_lossy().as_bytes())?;
        }
        *storage = next;
        if let Ok(mut cached) = state.config.lock() {
            *cached = config.clone();
        }
        state
            .config_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(config)
    }
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
    pub long_tasks: usize,
    pub archive_months: usize,
}

#[tauri::command]
pub fn import_data(src_dir: String, state: State<AppState>) -> Result<ImportResult, String> {
    let _operation = state
        .sync_gate
        .try_lock()
        .map_err(|_| "同步正在进行，请稍后导入".to_string())?;
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
    let mut source = Storage::new(PathBuf::from(src_dir));
    let payload = crate::sync::build_payload(&mut source)?;
    let current_dir = storage.read_config().map_err(|e| e.to_string())?.data_dir;
    let mut config = source.read_config().map_err(|e| e.to_string())?;
    config.data_dir = current_dir;
    crate::sync_snapshot::apply_with_config(&mut storage, &payload, Some(config))?;
    let imported = storage.load_all().map_err(|e| e.to_string())?;
    if let Ok(mut cached) = state.config.lock() {
        *cached = imported.config.clone();
    }
    Ok(ImportResult {
        events: imported.events.len(),
        routines: imported.routines.len(),
        tasks: imported.tasks.len(),
        long_tasks: imported.long_tasks.len(),
        archive_months: payload
            .files
            .keys()
            .filter(|n| n.starts_with("archive/"))
            .count(),
    })
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
    sync_service(&state).prepare_write()?;
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
    storage
        .save_templates(&templates)
        .map_err(|e| e.to_string())?;
    Ok(t)
}

/// `delete_template(id)`：软删除模板。
#[tauri::command]
pub fn delete_template(id: String, state: State<AppState>) -> Result<(), String> {
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    sync_service(&state).prepare_write()?;
    let mut templates = storage.read_templates().map_err(|e| e.to_string())?;
    let now = timeutil::now_utc_string();
    for t in templates.iter_mut() {
        if t.id == id {
            t.deleted_at = Some(now.clone());
            t.updated_at = now.clone();
        }
    }
    storage
        .save_templates(&templates)
        .map_err(|e| e.to_string())?;
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
    sync_service(&state).prepare_write()?;
    let config = storage.read_config().map_err(|e| e.to_string())?;
    let templates = storage.read_templates().map_err(|e| e.to_string())?;
    let t = templates
        .iter()
        .find(|t| t.id == template_id && t.deleted_at.is_none())
        .cloned()
        .ok_or_else(|| "模板不存在".to_string())?;

    crate::sync_snapshot::edit(&mut storage, |staged| {
        apply_template(staged, &t, &date, &config.timezone).map_err(|e| e.to_string())
    })
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
        let enabled = state
            .config
            .lock()
            .map(|c| c.hooks.enabled)
            .unwrap_or(false);
        (enabled, storage.data_dir().to_path_buf())
    };
    let scripts = list_hooks(&dir);
    Ok(HooksStatus {
        enabled,
        directory: dir.display().to_string(),
        scripts,
        supported_hooks: schedule_core::hooks::HOOK_NAMES
            .iter()
            .map(|s| s.to_string())
            .collect(),
    })
}

/// `run_hook_test(hook, payload)`：手动触发一次钩子，返回各脚本执行结果（用于验证/导出输出）。
#[tauri::command]
pub fn run_hook_test(
    hook: String,
    payload: String,
    state: State<AppState>,
) -> Result<Vec<HookRunResult>, String> {
    let enabled = state
        .config
        .lock()
        .map(|c| c.hooks.enabled)
        .unwrap_or(false);
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
    sync_service(&state).prepare_write()?;
    match choice.as_str() {
        "overwrite" => {
            storage.set_force_overwrite(true);
            Ok(())
        }
        "reload" => {
            storage.accept_external_changes();
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
#[cfg(not(target_os = "android"))]
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

/// Android 数据目录位于应用沙盒内，不提供桌面文件管理器打开操作。
#[tauri::command]
#[cfg(target_os = "android")]
pub fn open_data_dir(_state: State<AppState>) -> Result<(), String> {
    Err("Android 不支持直接打开应用数据目录".to_string())
}

// ---------------------------------------------------------------------------
// V2.0 Lite：七牛单设备互斥快照同步
// ---------------------------------------------------------------------------

/// System document pickers support Android content:// URIs without storage permissions.
#[tauri::command]
pub fn recovery_points(state: State<AppState>) -> Result<Vec<String>, String> {
    let storage = state.storage.lock().map_err(|_| lock_err())?;
    crate::sync_snapshot::recovery_points(storage.data_dir())
}
#[tauri::command]
pub fn recovery_details(
    state: State<AppState>,
) -> Result<Vec<crate::sync_snapshot::RecoveryDetails>, String> {
    let storage = state.storage.lock().map_err(|_| lock_err())?;
    crate::sync_snapshot::recovery_details(storage.data_dir())
}
#[tauri::command]
pub async fn export_sync_diagnostics(app: AppHandle) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        let raw = serde_json::to_vec_pretty(&sync_service(&app.state::<AppState>()).diagnostics())
            .map_err(|e| e.to_string())?;
        let Some(path) = app
            .dialog()
            .file()
            .set_file_name("moment-diagnostics.json")
            .add_filter("JSON", &["json"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let mut options = tauri_plugin_fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        let mut file = app.fs().open(path, options).map_err(|e| e.to_string())?;
        file.write_all(&raw).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn restore_recovery_point(id: String, state: State<AppState>) -> Result<(), String> {
    let _operation = state
        .sync_gate
        .try_lock()
        .map_err(|_| "同步正在进行，请稍后恢复".to_string())?;
    let mut storage = state.storage.lock().map_err(|_| lock_err())?;
    let blocked = state
        .recovery_error
        .lock()
        .map_err(|_| lock_err())?
        .is_some();
    if blocked {
        crate::sync_snapshot::restore_blocked(&mut storage, &id)?;
    } else {
        sync_service(&state).prepare_write()?;
        crate::sync_snapshot::restore_point(&mut storage, &id)?;
    }
    *state.recovery_error.lock().map_err(|_| lock_err())? = None;
    let config = storage.read_config().map_err(|e| e.to_string())?;
    if let Ok(mut cache) = state.config.lock() {
        *cache = config;
    }
    state.config_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    error: Option<String>,
    points: Vec<String>,
}
#[tauri::command]
pub fn recovery_status(state: State<AppState>) -> Result<RecoveryStatus, String> {
    let storage = state.storage.lock().map_err(|_| lock_err())?;
    Ok(RecoveryStatus {
        error: state.recovery_error.lock().map_err(|_| lock_err())?.clone(),
        points: crate::sync_snapshot::recovery_points(storage.data_dir())?,
    })
}

#[tauri::command]
pub async fn notification_permission(app: AppHandle, request: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let current = app.notification().permission_state().map_err(|e| e.to_string())?;
        // The Android plugin does not resolve requestPermissions when the
        // permission is already granted. Checking first also avoids a dialog.
        let result = if request && current != tauri::plugin::PermissionState::Granted {
            app.notification().request_permission()
        } else {
            Ok(current)
        }
        .map_err(|e| e.to_string())?;
        crate::check_and_notify(&app);
        Ok(format!("{result:?}").to_lowercase())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn notification_reminder_status(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "android")]
        { crate::mobile_reminders::status(&app).and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())) }
        #[cfg(not(target_os = "android"))]
        { let _ = app; Ok(serde_json::json!({"exact":true})) }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn notification_open_settings(app: AppHandle, exact: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "android")]
        { crate::mobile_reminders::open_settings(&app, exact) }
        #[cfg(not(target_os = "android"))]
        { let _ = (app, exact); Ok(()) }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn notification_pending_count(app: AppHandle) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "android")]
        {
            app.notification()
                .pending()
                .map(|items| items.len())
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = app;
            Ok(0)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn export_backup_document(
    app: AppHandle,
    passphrase: Option<String>,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Write;
        let state = app.state::<AppState>();
        let raw = {
            let mut storage = state.storage.lock().map_err(|_| lock_err())?;
            let payload = crate::sync::build_payload(&mut storage)?;
            match passphrase.as_deref().filter(|p| !p.is_empty()) {
                Some(password) if password.chars().count() < 8 => {
                    return Err("备份口令至少需要 8 个字符".into())
                }
                Some(password) => crate::sync::encrypt(&payload, password)?,
                None => serde_json::to_vec_pretty(&payload).map_err(|e| e.to_string())?,
            }
        };
        let name = format!(
            "moment-backup-{}.json",
            chrono::Utc::now().format("%Y%m%d-%H%M%S")
        );
        let Some(path) = app
            .dialog()
            .file()
            .set_file_name(name)
            .add_filter("MOMENT备份", &["json"])
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let mut options = tauri_plugin_fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        let mut file = app.fs().open(path, options).map_err(|e| e.to_string())?;
        file.write_all(&raw).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_backup_document(
    app: AppHandle,
    passphrase: Option<String>,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("MOMENT备份", &["json"])
            .blocking_pick_file()
        else {
            return Ok(false);
        };
        let mut options = tauri_plugin_fs::OpenOptions::new();
        options.read(true);
        let file = app.fs().open(path, options).map_err(|e| e.to_string())?;
        let limit = crate::sync_snapshot::MAX_BYTES;
        let mut raw = Vec::new();
        file.take(limit as u64 + 1)
            .read_to_end(&mut raw)
            .map_err(|e| e.to_string())?;
        if raw.len() > limit {
            return Err("备份文件过大".into());
        }
        let json: serde_json::Value = serde_json::from_slice(&raw)
            .map_err(|_| "备份格式无效，请选择 MOMENT 日程备份 JSON".to_string())?;
        let payload: crate::sync::SnapshotPayload = if json.get("format").is_some() {
            crate::sync::decrypt(
                &raw,
                passphrase
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .ok_or("此备份已加密，请先填写备份口令")?,
            )?
        } else {
            serde_json::from_value(json).map_err(|_| "备份格式无效".to_string())?
        };
        let state = app.state::<AppState>();
        let _operation = state.sync_gate.lock().map_err(|_| lock_err())?;
        let mut storage = state.storage.lock().map_err(|_| lock_err())?;
        let blocked = state.recovery_error.lock().map_err(|_| lock_err())?.is_some();
        if blocked {
            let config = storage.read_config().unwrap_or_else(|_| state.config.lock().map(|c| c.clone()).unwrap_or_default());
            crate::sync_snapshot::restore_payload_blocked(&mut storage, &payload, config)?;
            *state.recovery_error.lock().map_err(|_| lock_err())? = None;
        } else {
            sync_service(&state).prepare_write()?;
            crate::sync_snapshot::apply(&mut storage, &payload)?;
        }
        let config = storage.read_config().map_err(|e| e.to_string())?;
        *state.config.lock().map_err(|_| lock_err())? = config;
        state.config_generation.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn sync_get_status(state: State<AppState>) -> Result<SyncStatus, String> {
    Ok(sync_service(&state).status())
}

async fn run_sync(
    app: AppHandle,
    work: impl FnOnce(SyncService, &std::sync::Mutex<Storage>) -> Result<SyncStatus, String>
        + Send
        + 'static,
) -> Result<SyncStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _operation = state
            .sync_gate
            .try_lock()
            .map_err(|_| "同步正在进行，请稍后重试".to_string())?;
        state
            .sync_control
            .cancel
            .store(false, std::sync::atomic::Ordering::SeqCst);
        state
            .sync_control
            .busy
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let service = sync_service(&state);
        let _network_scope=crate::sync::network_scope(state.sync_control.clone());
        let _ = app.emit("sync-status-changed", service.status());
        let result = work(sync_service(&state), &state.storage);
        state.sync_control.completed(result.is_ok());
        let mut storage = state.storage.lock().map_err(|_| lock_err())?;
        if let Err(error) = &result {
            service.record_error(error);
        }
        if state
            .recovery_error
            .lock()
            .map_err(|_| lock_err())?
            .is_none()
        {
            if let Ok(config) = storage.read_config() {
                if let Ok(mut cache) = state.config.lock() {
                    *cache = config;
                }
            }
        }
        let _ = app.emit("sync-status-changed", service.status());
        result.map(|_| service.status())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn sync_configure(input: SyncConfigInput, app: AppHandle) -> Result<SyncStatus, String> {
    run_sync(app, move |s, storage| {
        let _local = storage.lock().map_err(|_| lock_err())?;
        s.configure(input)
    })
    .await
}
#[tauri::command]
pub async fn sync_test_connection(app: AppHandle) -> Result<SyncStatus, String> {
    run_sync(app, |s, _| s.test_connection()).await
}
#[tauri::command]
pub async fn sync_now(app: AppHandle) -> Result<SyncStatus, String> {
    run_sync(app, |s, storage| s.sync(storage, false)).await
}
#[tauri::command]
pub async fn sync_tick(app: AppHandle) -> Result<SyncStatus, String> {
    {
        let state = app.state::<AppState>();
        if state
            .sync_control
            .busy
            .load(std::sync::atomic::Ordering::SeqCst)
            || !state.sync_control.retry_due()
        {
            return Ok(sync_service(&state).status());
        }
    }
    run_sync(app, |s, storage| s.tick(storage)).await
}
#[tauri::command]
pub fn sync_cancel(app: AppHandle) -> Result<SyncStatus, String> {
    let state = app.state::<AppState>();
    if state
        .sync_control
        .busy
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        state
            .sync_control
            .cancel
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
    Ok(sync_service(&state).status())
}
#[tauri::command]
pub async fn sync_resolve_initial(
    input: InitialSyncChoiceInput,
    app: AppHandle,
) -> Result<SyncStatus, String> {
    run_sync(app, move |s, storage| s.resolve_initial(storage, input)).await
}
#[tauri::command]
pub async fn sync_takeover_expired(app: AppHandle) -> Result<SyncStatus, String> {
    run_sync(app, |s, storage| s.sync(storage, true)).await
}
#[tauri::command]
pub async fn sync_disconnect(app: AppHandle) -> Result<(), String> {
    run_sync(app, |s, storage| {
        s.disconnect(storage)?;
        Ok(s.status())
    })
    .await
    .map(|_| ())
}
#[tauri::command]
pub async fn sync_exit(app: AppHandle) -> Result<(), String> {
    run_sync(app.clone(), |s, storage| {
        if s.status().configured {
            s.sync(storage, false)?;
            s.release(storage)?;
        }
        Ok(s.status())
    })
    .await?;
    app.exit(0);
    Ok(())
}
#[tauri::command]
pub async fn sync_force_exit(app: AppHandle) -> Result<(), String> {
    // Do not release a lease while local edits remain unuploaded. Its expiry
    // protects the pending local copy until the user explicitly takes over.
    app.exit(0);
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
        let dir = std::env::temp_dir().join(format!(
            "schedule-app-test-{name}-{}-{nanos}",
            std::process::id()
        ));
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

    /// V1.2：长期任务日期区间校验。
    #[test]
    fn test_validate_long_task_rejects_invalid_dates() {
        let base = LongTask {
            id: "lt1".to_string(),
            title: "备考".to_string(),
            description: None,
            start_date: "2025-03-01".to_string(),
            due_date: "2025-03-31".to_string(),
            status: LongTaskStatus::Active,
            ended_at: None,
            tags: vec![],
            priority: schedule_core::Priority::Normal,
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: None,
            sessions: vec![],
        };
        assert!(validate_long_task(&base).is_ok());
        let mut inverted = base.clone();
        inverted.due_date = "2025-02-01".to_string();
        assert!(validate_long_task(&inverted)
            .unwrap_err()
            .contains("截止日期"));
        let mut empty_title = base;
        empty_title.title = "  ".to_string();
        assert!(validate_long_task(&empty_title)
            .unwrap_err()
            .contains("标题"));
    }

    fn lt_task(sessions: Vec<LongTaskSession>) -> LongTask {
        LongTask {
            id: "lt1".to_string(),
            title: "备考".to_string(),
            description: None,
            start_date: "2025-01-01".to_string(),
            due_date: "2025-12-31".to_string(),
            status: LongTaskStatus::Active,
            ended_at: None,
            tags: vec!["学习".to_string()],
            priority: schedule_core::Priority::Normal,
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: None,
            sessions,
        }
    }

    fn lt_session(
        id: &str,
        started: &str,
        ended: &str,
        ms: i64,
        note: Option<&str>,
        deleted: bool,
    ) -> LongTaskSession {
        LongTaskSession {
            id: id.to_string(),
            started_at: started.to_string(),
            ended_at: ended.to_string(),
            duration_ms: ms,
            note: note.map(|s| s.to_string()),
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: deleted.then(|| "2025-01-15T12:00:00Z".to_string()),
        }
    }

    fn storage_with_utc(name: &str) -> (Storage, PathBuf) {
        let dir = tmp_dir(name);
        let mut storage = Storage::new(dir.clone());
        storage.ensure().unwrap();
        let mut config = Config::default();
        config.timezone = "UTC".to_string();
        storage.save_config(&config).unwrap();
        (storage, dir)
    }

    #[test]
    fn test_build_long_task_archive_entry_aggregates_sessions() {
        let task = lt_task(vec![
            lt_session(
                "s1",
                "2025-01-15T09:00:00Z",
                "2025-01-15T09:20:00Z",
                1_200_000,
                Some("A"),
                false,
            ),
            lt_session(
                "s2",
                "2025-01-15T10:00:00Z",
                "2025-01-15T10:10:00Z",
                600_000,
                Some("B"),
                false,
            ),
        ]);
        let refs: Vec<&LongTaskSession> = task.sessions.iter().collect();
        let entry = build_long_task_archive_entry(&task, &refs, "UTC", None)
            .unwrap()
            .unwrap();
        assert_eq!(entry.source, ArchiveSource::LongTask);
        assert_eq!(entry.source_id.as_deref(), Some("lt1"));
        assert_eq!(entry.duration_minutes, Some(30));
        // time / doneAt = 当天首次会话结束时刻。
        assert_eq!(entry.time, "09:20");
        assert_eq!(entry.done_at, "2025-01-15T09:20:00Z");
        // note 按开始时间升序拼接。
        assert_eq!(entry.note.as_deref(), Some("09:00 A\n10:00 B"));
    }

    #[test]
    fn test_sync_long_task_archive_day_rebuilds_merges_and_removes() {
        let (mut storage, _dir) = storage_with_utc("lt-archive-sync");
        let mut task = lt_task(vec![
            lt_session(
                "s1",
                "2025-01-15T09:00:00Z",
                "2025-01-15T09:20:00Z",
                1_200_000,
                None,
                false,
            ),
            lt_session(
                "s2",
                "2025-01-15T10:00:00Z",
                "2025-01-15T10:10:00Z",
                600_000,
                None,
                false,
            ),
        ]);
        sync_long_task_archive_day(&mut storage, &task, "2025-01-15").unwrap();
        let month = storage.load_archive_month("2025-01").unwrap();
        let entries = &month.days["2025-01-15"].entries;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].duration_minutes, Some(30));
        let id = entries[0].id.clone();
        let time = entries[0].time.clone();

        // 增加一条会话 → 条目 id / time 保持，时长重算。
        task.sessions.push(lt_session(
            "s3",
            "2025-01-15T11:00:00Z",
            "2025-01-15T11:15:00Z",
            900_000,
            None,
            false,
        ));
        sync_long_task_archive_day(&mut storage, &task, "2025-01-15").unwrap();
        let month = storage.load_archive_month("2025-01").unwrap();
        let entries = &month.days["2025-01-15"].entries;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, id);
        assert_eq!(entries[0].time, time);
        assert_eq!(entries[0].duration_minutes, Some(45));

        // 全部软删除 → 聚合条目删除。
        for s in task.sessions.iter_mut() {
            s.deleted_at = Some("2025-01-15T12:00:00Z".to_string());
        }
        sync_long_task_archive_day(&mut storage, &task, "2025-01-15").unwrap();
        let month = storage.load_archive_month("2025-01").unwrap();
        assert!(!month.days["2025-01-15"]
            .entries
            .iter()
            .any(|e| e.source == ArchiveSource::LongTask));
    }

    #[test]
    fn test_backfill_long_task_archives_creates_only_missing_entries() {
        let (mut storage, _dir) = storage_with_utc("lt-backfill");
        let task = lt_task(vec![lt_session(
            "s1",
            "2025-01-15T09:00:00Z",
            "2025-01-15T09:20:00Z",
            1_200_000,
            Some("A"),
            false,
        )]);
        storage.save_long_tasks(&[task.clone()]).unwrap();
        let mut cfg = Config::default();
        cfg.timezone = "UTC".to_string();
        let data = AppData {
            events: vec![],
            routines: vec![],
            tasks: vec![],
            long_tasks: vec![task.clone()],
            config: cfg,
            archive: ArchiveFile {
                version: schedule_core::CURRENT_VERSION,
                month: "2025-01".to_string(),
                days: Default::default(),
            },
        };
        // 首次回填创建条目。
        assert_eq!(backfill_long_task_archives(&mut storage, &data).unwrap(), 1);
        let month = storage.load_archive_month("2025-01").unwrap();
        let entries = &month.days["2025-01-15"].entries;
        assert_eq!(entries.len(), 1);

        // 已存在则不动（不覆盖用户可见内容）；再次回填创建数为 0。
        let mut af = month.clone();
        af.days.get_mut("2025-01-15").unwrap().entries[0].title = "外部标题".to_string();
        storage.save_archive_month(&af).unwrap();
        assert_eq!(backfill_long_task_archives(&mut storage, &data).unwrap(), 0);
        let month = storage.load_archive_month("2025-01").unwrap();
        assert_eq!(month.days["2025-01-15"].entries[0].title, "外部标题");
    }

    #[test]
    fn test_all_day_event_date_is_validated() {
        assert!(normalize_absolute("2025-01-15", true).is_ok());
        assert!(normalize_absolute("not-a-date", true).is_err());
    }

    #[test]
    fn test_cross_midnight_routine_window_is_accepted() {
        let mut r = Routine {
            id: "r1".to_string(),
            title: "r".to_string(),
            description: None,
            time_windows: vec![schedule_core::TimeWindow {
                days_of_week: vec![],
                start: "22:00".to_string(),
                end: "02:00".to_string(),
                every_days: None,
                anchor_date: None,
            }],
            duration_minutes: None,
            tags: vec![],
            priority: schedule_core::Priority::Normal,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: None,
        };
        assert!(validate_routine(&r).is_ok());
        r.time_windows[0].end = "22:00".to_string();
        assert!(validate_routine(&r).unwrap_err().contains("同一时刻"));
    }

    #[test]
    fn test_validate_routine_every_days_rules() {
        let mut r = Routine {
            id: "r1".to_string(),
            title: "r".to_string(),
            description: None,
            time_windows: vec![schedule_core::TimeWindow {
                days_of_week: vec![],
                start: "08:00".to_string(),
                end: "09:00".to_string(),
                every_days: Some(2),
                anchor_date: Some("2025-01-01".to_string()),
            }],
            duration_minutes: None,
            tags: vec![],
            priority: schedule_core::Priority::Normal,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: None,
        };
        assert!(validate_routine(&r).is_ok());
        r.time_windows[0].every_days = Some(400);
        assert!(validate_routine(&r).unwrap_err().contains("1–365"));
        r.time_windows[0].every_days = Some(2);
        r.time_windows[0].anchor_date = None;
        assert!(validate_routine(&r).unwrap_err().contains("锚点"));
        r.time_windows[0].every_days = None;
        r.time_windows[0].anchor_date = None;
        r.time_windows[0].end = "08:00".to_string(); // 与开始相同 → 零时长窗口。
        assert!(validate_routine(&r).unwrap_err().contains("同一时刻"));
    }
}
