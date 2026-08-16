//! 事项模板系统（§9 Phase 3：工作日 / 周末 / 自定义模板）。
//!
//! 语义约束：
//! - 模板仅作为「生成源」；`apply_template` 生成全新事件/日常并写入存储，
//!   生成的实例**不携带任何模板引用**，与模板解除绑定（修改模板不影响已生成实例）。
//! - `preview_template` 返回将要生成的事件/日常列表（含临时 id，但不落盘），
//!   前端确认后再调用 `apply_template` 真正写入。
//! - 核心业务计算保留在 Rust 后端，前端只负责展示预览与确认。

use chrono::{Datelike, NaiveDate, NaiveTime};
use chrono_tz::Tz;

use crate::error::{AppError, AppResult};
use crate::models::{Event, Priority, Routine, Template, TemplateItem, TemplateItemKind, TimeWindow};
use crate::storage::{new_event, new_routine, Storage};
use crate::timeutil;

/// 预览结果：将要生成的事件与日常列表（未落盘）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplatePreview {
    pub events: Vec<Event>,
    pub routines: Vec<Routine>,
}

/// 应用结果：实际创建数量。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateApplyResult {
    pub events_created: usize,
    pub routines_created: usize,
}

/// 生成一条事件草稿（不落盘）。
fn build_event(item: &TemplateItem, date: NaiveDate, tz: Tz) -> Event {
    let mut ev = new_event();
    ev.title = item.title.clone();
    ev.description = item.description.clone();
    ev.tags = item.tags.clone();
    ev.priority = item.priority;
    ev.all_day = item.all_day;

    if item.all_day {
        let d = timeutil::fmt_date(&date);
        ev.start = d.clone();
        ev.end = Some(d);
    } else {
        let start_t = item
            .start_time
            .as_deref()
            .and_then(|s| timeutil::parse_hhmm(s).ok())
            .unwrap_or_else(|| NaiveTime::from_hms_opt(9, 0, 0).unwrap());
        let start_utc = timeutil::local_to_utc(date, start_t, tz);
        ev.start = timeutil::to_utc_string(&start_utc);

        let end_t = if let Some(et) = &item.end_time {
            timeutil::parse_hhmm(et).ok()
        } else if let Some(minutes) = item.duration_minutes {
            Some(start_t + chrono::Duration::minutes(minutes))
        } else {
            None
        };
        if let Some(end_t) = end_t {
            ev.end = Some(timeutil::to_utc_string(&timeutil::local_to_utc(date, end_t, tz)));
        }
    }
    ev
}

/// 生成一条日常草稿（不落盘）。
fn build_routine(item: &TemplateItem, date: NaiveDate) -> Routine {
    let mut rt = new_routine();
    rt.title = item.title.clone();
    rt.description = item.description.clone();
    rt.tags = item.tags.clone();
    rt.priority = item.priority;
    rt.duration_minutes = item.duration_minutes;

    let days_of_week = if item.days_of_week.is_empty() {
        vec![date.weekday().number_from_monday()]
    } else {
        item.days_of_week.clone()
    };
    let window = TimeWindow {
        days_of_week,
        start: item.window_start.clone().unwrap_or_else(|| "08:00".to_string()),
        end: item.window_end.clone().unwrap_or_else(|| "09:00".to_string()),
        every_days: None,
        anchor_date: None,
    };
    rt.time_windows = vec![window];
    rt
}

/// 校验模板条目并生成事件/日常草稿列表（不落盘）。
pub fn generate_preview(template: &Template, date: NaiveDate, tz_name: &str) -> AppResult<TemplatePreview> {
    let tz = timeutil::resolve_tz(tz_name);
    let mut events = Vec::new();
    let mut routines = Vec::new();
    for item in &template.items {
        if item.title.trim().is_empty() {
            continue;
        }
        match item.kind {
            TemplateItemKind::Event => events.push(build_event(item, date, tz)),
            TemplateItemKind::Routine => routines.push(build_routine(item, date)),
        }
    }
    Ok(TemplatePreview { events, routines })
}

/// 预览模板：返回将要生成的事件/日常列表（不写入存储）。
pub fn preview_template(template: &Template, date: &str, tz_name: &str) -> AppResult<TemplatePreview> {
    let d = timeutil::parse_date(date).map_err(|_| AppError::InvalidInput(format!("无效日期: {date}")))?;
    generate_preview(template, d, tz_name)
}

/// 应用模板：批量生成事件/日常并写入存储，返回创建数量。
///
/// 生成实例与模板解绑定：不写入 templateId 等任何反向引用。
pub fn apply_template(
    storage: &mut Storage,
    template: &Template,
    date: &str,
    tz_name: &str,
) -> AppResult<TemplateApplyResult> {
    let preview = preview_template(template, date, tz_name)?;

    if !preview.events.is_empty() {
        let mut events = storage.read_events()?;
        events.extend(preview.events.clone());
        storage.save_events(&events)?;
    }
    if !preview.routines.is_empty() {
        let mut routines = storage.read_routines()?;
        routines.extend(preview.routines.clone());
        storage.save_routines(&routines)?;
    }

    Ok(TemplateApplyResult {
        events_created: preview.events.len(),
        routines_created: preview.routines.len(),
    })
}

/// 供前端构造「新建模板」默认值的便捷构造。
pub fn new_template(name: &str, kind: crate::models::TemplateKind) -> Template {
    let now = timeutil::now_utc_string();
    Template {
        id: String::new(),
        name: name.to_string(),
        kind,
        items: vec![],
        created_at: now.clone(),
        updated_at: now,
        deleted_at: None,
    }
}

/// 便捷构造：新建一条空模板条目。
pub fn new_template_item() -> TemplateItem {
    TemplateItem {
        kind: TemplateItemKind::Event,
        title: String::new(),
        description: None,
        tags: vec![],
        priority: Priority::Normal,
        all_day: false,
        start_time: Some("09:00".to_string()),
        end_time: None,
        duration_minutes: Some(60),
        days_of_week: vec![],
        window_start: Some("08:00".to_string()),
        window_end: Some("09:00".to_string()),
    }
}
