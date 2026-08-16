//! 候选推荐引擎（第 8 章）：`get_now_candidates` 的打分与过滤。
//!
//! 分层（§8.2）：
//! 1. 进行中/即将开始的事件
//! 2. 当前时间窗口内的日常
//! 3. 逾期未完成的日常（窗口结束后 X 小时内，X=missedRoutineGraceHours，MVP 硬编码 4）
//! 4. 今天晚些时候的事件预告
//! 5. 浮动事项（有空可做）

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::models::*;
use crate::recurrence;
use crate::timeutil;

/// 候选来源类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CandidateSource {
    Event,
    Routine,
    Task,
}

/// 单个候选（§8.4 输出）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub source_type: CandidateSource,
    /// 完成归档时的来源键：一次性事件 = id；重复实例 = `{id}#{日期}`。
    pub source_id: String,
    /// 重复事件的序列 id（仅重复实例非空）；用于「完成仅归档本次」语义。
    pub series_id: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub score: i64,
    /// 1..5，对应 §8.2 层级。
    pub layer: u8,
    pub reason: String,
    pub suggested_duration_minutes: Option<i64>,
    pub priority: Priority,
    pub time_label: Option<String>,
}

/// 今日时间轴中的日常窗口视图。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineWindowView {
    pub routine_id: String,
    pub title: String,
    pub start: String,
    pub end: String,
    pub priority: Priority,
    pub done_today: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub date: String,
    pub events: Vec<Event>,
    pub routine_windows: Vec<RoutineWindowView>,
    pub archive: Vec<ArchiveEntry>,
}

/// 提醒通知（§4.5，被动刷新 + V3.0 后台调度触发）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderNotice {
    /// event_start | event_reminder | routine_window | task_deadline
    pub kind: String,
    pub title: String,
    pub body: String,
    pub source_id: String,
    /// 后端生成的全局唯一去重键（V3.1）：同源多级提醒/日常开始结束不再互相屏蔽。
    pub dedup_key: String,
    /// 来源事项优先级（V3.0 分级提醒）。
    pub priority: Priority,
    /// 是否可弹系统通知（全局开关 + 免打扰时段 + 优先级分级策略）。
    pub should_notify: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidatesResult {
    /// 归一化后的 UTC `Z` 时刻。
    pub now: String,
    pub local_date: String,
    pub local_time: String,
    pub main: Option<Candidate>,
    pub secondary: Vec<Candidate>,
    pub timeline: Timeline,
    pub due_reminders: Vec<ReminderNotice>,
}

// ---------------------------------------------------------------------------
// 打分常量（层间保持隔离，层内可微调）
// ---------------------------------------------------------------------------

const PRIO_HIGH: i64 = 40;
const PRIO_NORMAL: i64 = 15;
const PRIO_LOW: i64 = 0;

/// 事件「即将开始」的判定窗口（分钟）。
const UPCOMING_SOON_MIN: i64 = 30;
/// 无结束时间的事件，开始后多少小时内仍视为「进行中」。
const NO_END_IN_PROGRESS_HOURS: i64 = 4;
/// 提醒提前量（分钟）：事件开始提醒。
const EVENT_START_NOTIFY_MIN: i64 = 15;
/// 次级候选数量（§8.4 默认 5）。
const SECONDARY_LIMIT: usize = 5;

fn prio_w(p: Priority) -> i64 {
    match p {
        Priority::High => PRIO_HIGH,
        Priority::Normal => PRIO_NORMAL,
        Priority::Low => PRIO_LOW,
    }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

pub fn compute_candidates(data: &AppData, now_str: &str, config: &Config) -> AppResult<CandidatesResult> {
    let now = timeutil::parse_utc(now_str)?;
    let tz = timeutil::resolve_tz(&config.timezone);
    let local = timeutil::to_local(&now, &config.timezone);
    let today = local.date;
    let grace_hours = config.candidate.missed_routine_grace_hours.max(0);

    // 当日已完成集合（source, sourceId）。
    let done_today = collect_done_today(&data.archive, &today);
    // 日常最近完成时刻（用于「最久未做」打破平局）。
    let last_done = collect_last_done(&data.archive);

    let mut candidates: Vec<Candidate> = Vec::new();

    // ---- 事件（层级 1 / 4），含重复实例展开 ----
    let occurrences = recurrence::expand_events(&data.events, today, today, &config.timezone);
    for occ in &occurrences {
        // 重复实例若今日已归档，则跳过（完成仅归档本次）。
        if done_today.contains(&(ArchiveSource::Event, occ.key.clone())) {
            continue;
        }
        push_event_candidate(occ, &now, &config.timezone, &mut candidates);
    }

    // ---- 日常（层级 2 / 3）----
    for rt in &data.routines {
        if !rt.enabled || rt.deleted_at.is_some() {
            continue;
        }
        let done = done_today.contains(&(ArchiveSource::Routine, rt.id.clone()));
        for w in &rt.time_windows {
            if !window_applies_today(w, local.weekday) {
                continue;
            }
            let (Ok(start), Ok(end)) = (timeutil::parse_hhmm(&w.start), timeutil::parse_hhmm(&w.end)) else { continue };
            if !done && timeutil::time_in_window(local.time, start, end) {
                // 层级 2：当前窗口内（V3.0 B5：当日已完成则不再作为候选）
                let remaining = timeutil::minutes_between(local.time, end);
                let total = timeutil::minutes_between(start, end).max(1);
                let frac = (remaining as f64 / total as f64).clamp(0.0, 1.0);
                let urgency = (1.0 - frac) * 200.0; // 越接近结束越紧急
                let score = 4000 + urgency as i64 + prio_w(rt.priority);
                candidates.push(Candidate {
                    source_type: CandidateSource::Routine,
                    source_id: rt.id.clone(),
                    series_id: None,
                    title: rt.title.clone(),
                    description: rt.description.clone(),
                    score,
                    layer: 2,
                    reason: format!("时间窗口内 · 剩余 {remaining} 分钟"),
                    suggested_duration_minutes: rt.duration_minutes,
                    priority: rt.priority,
                    time_label: Some(format!("{}–{}", w.start, w.end)),
                });
            } else if !done {
                // 层级 3：逾期可补（窗口结束后 grace 小时内）
                let ended = timeutil::local_to_utc(today, end, tz);
                if now > ended {
                    let overdue = timeutil::minutes_between_utc(&ended, &now);
                    if overdue <= grace_hours * 60 {
                        let score = 3000 + overdue.min(240) + prio_w(rt.priority);
                        candidates.push(Candidate {
                            source_type: CandidateSource::Routine,
                            source_id: rt.id.clone(),
                            series_id: None,
                            title: rt.title.clone(),
                            description: rt.description.clone(),
                            score,
                            layer: 3,
                            reason: format!("已逾期 {overdue} 分钟 · 可补"),
                            suggested_duration_minutes: rt.duration_minutes,
                            priority: rt.priority,
                            time_label: Some(format!("{}–{}", w.start, w.end)),
                        });
                    }
                }
            }
        }
    }

    // ---- 浮动事项（层级 5）----
    for t in &data.tasks {
        if t.deleted_at.is_some() || t.status != ItemStatus::Active {
            continue;
        }
        let mut score = 500 + prio_w(t.priority) - t.sort_order.clamp(0, 200);
        let mut reason = "有空可做".to_string();
        let mut time_label = None;
        if let Some(dl) = &t.deadline {
            if let Ok(dl_utc) = timeutil::parse_utc(dl) {
                let days = (dl_utc - now).num_days();
                if days < 0 {
                    score += 150;
                    reason = "已过截止日 · 待办".to_string();
                    time_label = Some("已逾期".to_string());
                } else if days <= 3 {
                    score += (3 - days) * 50;
                    reason = format!("{days} 天后截止");
                    time_label = Some(format!("{days} 天后截止"));
                }
            }
        }
        candidates.push(Candidate {
            source_type: CandidateSource::Task,
            source_id: t.id.clone(),
            series_id: None,
            title: t.title.clone(),
            description: t.description.clone(),
            score,
            layer: 5,
            reason,
            suggested_duration_minutes: None,
            priority: t.priority,
            time_label,
        });
    }

    // ---- 排序：层级升序，层内分数降序；日常同分按「最久未做」优先 ----
    candidates.sort_by(|a, b| {
        b.layer.cmp(&a.layer).reverse().then(b.score.cmp(&a.score)).then_with(|| {
            let ar = last_done.get(&a.source_id);
            let br = last_done.get(&b.source_id);
            cmp_last_done(ar, br)
        })
    });

    let main = candidates.first().cloned();
    let secondary = candidates.iter().skip(1).take(SECONDARY_LIMIT).cloned().collect();

    // ---- 今日时间轴 ----
    let mut timeline_events: Vec<Event> = occurrences.iter().map(|o| o.event.clone()).collect();
    timeline_events.sort_by(|a, b| event_sort_key(a).cmp(&event_sort_key(b)));

    let mut windows: Vec<RoutineWindowView> = Vec::new();
    for rt in &data.routines {
        if !rt.enabled || rt.deleted_at.is_some() {
            continue;
        }
        let done = done_today.contains(&(ArchiveSource::Routine, rt.id.clone()));
        for w in &rt.time_windows {
            if window_applies_today(w, local.weekday) {
                windows.push(RoutineWindowView {
                    routine_id: rt.id.clone(),
                    title: rt.title.clone(),
                    start: w.start.clone(),
                    end: w.end.clone(),
                    priority: rt.priority,
                    done_today: done,
                });
            }
        }
    }
    windows.sort_by(|a, b| a.start.cmp(&b.start));

    let mut archive_today: Vec<ArchiveEntry> = data
        .archive
        .days
        .get(&timeutil::fmt_date(&today))
        .map(|d| d.entries.clone())
        .unwrap_or_default();
    archive_today.sort_by(|a, b| a.done_at.cmp(&b.done_at));

    let timeline = Timeline {
        date: timeutil::fmt_date(&today),
        events: timeline_events,
        routine_windows: windows,
        archive: archive_today,
    };

    // ---- 提醒（v1.1.0：已完成的来源不再生成提醒） ----
    let due_reminders = build_reminders(data, &now, &local, &config, &done_today);

    Ok(CandidatesResult {
        now: timeutil::to_utc_string(&now),
        local_date: timeutil::fmt_date(&today),
        local_time: local.time.format("%H:%M").to_string(),
        main,
        secondary,
        timeline,
        due_reminders,
    })
}

// ---------------------------------------------------------------------------
// 事件候选（层级 1 / 4）
// ---------------------------------------------------------------------------

fn push_event_candidate(occ: &recurrence::Occurrence, now: &DateTime<Utc>, tz_name: &str, out: &mut Vec<Candidate>) {
    let ev = &occ.event;
    let source_id = &occ.key;
    let series_id: Option<String> = occ.series_id.clone();
    let tz = timeutil::resolve_tz(tz_name);
    let local = timeutil::to_local(now, tz_name);

    // 全天事件：当天 → 层级 1 进行中；未来 → 层级 4。
    if ev.all_day {
        if let Ok(d) = timeutil::parse_date(&ev.start) {
            if d == local.date {
                out.push(Candidate {
                    source_type: CandidateSource::Event,
                    source_id: source_id.clone(),
                    series_id: series_id.clone(),
                    title: ev.title.clone(),
                    description: ev.description.clone(),
                    score: 5900 + prio_w(ev.priority),
                    layer: 1,
                    reason: "今天全天".to_string(),
                    suggested_duration_minutes: None,
                    priority: ev.priority,
                    time_label: Some("全天".to_string()),
                });
            } else if d > local.date {
                out.push(Candidate {
                    source_type: CandidateSource::Event,
                    source_id: source_id.clone(),
                    series_id: series_id.clone(),
                    title: ev.title.clone(),
                    description: ev.description.clone(),
                    score: 1500 + prio_w(ev.priority),
                    layer: 4,
                    reason: format!("{} 全天", d.format("%m-%d")),
                    suggested_duration_minutes: None,
                    priority: ev.priority,
                    time_label: Some("全天".to_string()),
                });
            }
        }
        return;
    }

    let Ok(start) = timeutil::parse_utc(&ev.start) else { return };
    let end = ev.end.as_deref().and_then(|e| timeutil::parse_utc(e).ok());
    let label = time_label(ev, tz_name);
    let dur = event_duration_minutes(ev, tz);

    let in_progress = start <= *now
        && match end {
            Some(e) => *now < e,
            None => timeutil::minutes_between_utc(&start, now) <= NO_END_IN_PROGRESS_HOURS * 60,
        };

    if in_progress {
        out.push(Candidate {
            source_type: CandidateSource::Event,
            source_id: source_id.clone(),
            series_id,
            title: ev.title.clone(),
            description: ev.description.clone(),
            score: 6200 + prio_w(ev.priority),
            layer: 1,
            reason: "正在进行".to_string(),
            suggested_duration_minutes: dur,
            priority: ev.priority,
            time_label: label,
        });
    } else if start > *now {
        let until = timeutil::minutes_between_utc(now, &start);
        if until <= UPCOMING_SOON_MIN {
            out.push(Candidate {
                source_type: CandidateSource::Event,
                source_id: source_id.clone(),
                series_id,
                title: ev.title.clone(),
                description: ev.description.clone(),
                score: 6000 - until + prio_w(ev.priority),
                layer: 1,
                reason: format!("{until} 分钟后开始"),
                suggested_duration_minutes: dur,
                priority: ev.priority,
                time_label: label,
            });
        } else {
            out.push(Candidate {
                source_type: CandidateSource::Event,
                source_id: source_id.clone(),
                series_id,
                title: ev.title.clone(),
                description: ev.description.clone(),
                score: 1500 - until.min(1000) + prio_w(ev.priority),
                layer: 4,
                reason: format!("今天 {}", label.clone().unwrap_or_default()),
                suggested_duration_minutes: dur,
                priority: ev.priority,
                time_label: label,
            });
        }
    }
}

fn is_event_active(ev: &Event) -> bool {
    ev.deleted_at.is_none() && ev.status == ItemStatus::Active
}

fn time_label(ev: &Event, tz_name: &str) -> Option<String> {
    if ev.all_day {
        return Some("全天".to_string());
    }
    let start = timeutil::parse_utc(&ev.start).ok()?;
    let s = timeutil::fmt_local_time(&start, tz_name);
    match ev.end.as_deref().and_then(|e| timeutil::parse_utc(e).ok()) {
        Some(e) => Some(format!("{s}–{}", timeutil::fmt_local_time(&e, tz_name))),
        None => Some(s),
    }
}

fn event_duration_minutes(ev: &Event, tz: chrono_tz::Tz) -> Option<i64> {
    let start = timeutil::event_start_utc(ev, tz)?;
    let end = if ev.all_day {
        start + chrono::Duration::hours(24)
    } else {
        ev.end.as_deref().and_then(|e| timeutil::parse_utc(e).ok())?
    };
    let m = (end - start).num_minutes();
    if m > 0 { Some(m) } else { None }
}

fn event_sort_key(ev: &Event) -> (String, String) {
    (ev.start.clone(), ev.id.clone())
}

// ---------------------------------------------------------------------------
// 日常辅助
// ---------------------------------------------------------------------------

fn window_applies_today(w: &TimeWindow, weekday: u32) -> bool {
    // daysOfWeek 为空表示每天。
    w.days_of_week.is_empty() || w.days_of_week.contains(&weekday)
}

// ---------------------------------------------------------------------------
// 归档辅助
// ---------------------------------------------------------------------------

/// 当日已完成集合（用于过滤「已归档过的（当天）」）。
fn collect_done_today(archive: &ArchiveFile, today: &NaiveDate) -> std::collections::HashSet<(ArchiveSource, String)> {
    let mut set = std::collections::HashSet::new();
    let key = timeutil::fmt_date(today);
    if let Some(day) = archive.days.get(&key) {
        for e in &day.entries {
            if let Some(sid) = &e.source_id {
                set.insert((e.source, sid.clone()));
            }
        }
    }
    set
}

/// 日常最近完成时刻（用于「最久未做」打破平局）。
fn collect_last_done(archive: &ArchiveFile) -> HashMap<String, DateTime<Utc>> {
    let mut map: HashMap<String, DateTime<Utc>> = HashMap::new();
    for day in archive.days.values() {
        for e in &day.entries {
            if e.source == ArchiveSource::Routine {
                if let (Some(sid), Ok(dt)) = (&e.source_id, timeutil::parse_utc(&e.done_at)) {
                    map.entry(sid.clone())
                        .and_modify(|cur| {
                            if dt > *cur {
                                *cur = dt;
                            }
                        })
                        .or_insert(dt);
                }
            }
        }
    }
    map
}

/// 比较「最近完成」：None（从未完成）排最前（最久未做）。
fn cmp_last_done(a: Option<&DateTime<Utc>>, b: Option<&DateTime<Utc>>) -> std::cmp::Ordering {
    match (a, b) {
        (None, None) => std::cmp::Ordering::Equal,
        (None, Some(_)) => std::cmp::Ordering::Less, // 从未完成 → 优先曝光
        (Some(_), None) => std::cmp::Ordering::Greater,
        (Some(x), Some(y)) => x.cmp(y), // 越早完成 → 越优先
    }
}

// ---------------------------------------------------------------------------
// 提醒（§4.5，MVP 被动刷新触发）
// ---------------------------------------------------------------------------

fn build_reminders(
    data: &AppData,
    now: &DateTime<Utc>,
    local: &timeutil::LocalNow,
    config: &Config,
    done_today: &std::collections::HashSet<(ArchiveSource, String)>,
) -> Vec<ReminderNotice> {
    let mut out = Vec::new();
    let tz = timeutil::resolve_tz(&config.timezone);
    let dnd = config.notifications.do_not_disturb.enabled
        && timeutil::time_in_window(
            local.time,
            timeutil::parse_hhmm(&config.notifications.do_not_disturb.start).unwrap_or_else(|_| NaiveTime::from_hms_opt(22, 0, 0).unwrap()),
            timeutil::parse_hhmm(&config.notifications.do_not_disturb.end).unwrap_or_else(|_| NaiveTime::from_hms_opt(8, 0, 0).unwrap()),
        );
    // V3.0 F5：按优先级分级计算是否可弹系统通知。
    let notify = |priority: Priority| -> bool {
        if !config.notifications.enabled || dnd {
            return false;
        }
        let level = match priority {
            Priority::High => config.notifications.priority_policy.high,
            Priority::Normal => config.notifications.priority_policy.normal,
            Priority::Low => config.notifications.priority_policy.low,
        };
        matches!(level, NotifyLevel::System)
    };

    // 事件开始 / 多级提前提醒（重复事件按实例展开，§4.5）。
    let max_offset_days = data
        .events
        .iter()
        .filter(|e| is_event_active(e))
        .flat_map(|e| e.reminders.iter().map(|r| r.offset_minutes))
        .max()
        .unwrap_or(0)
        .div_euclid(1440)
        .max(1) as i64;
    let horizon = local.date + chrono::Duration::days(max_offset_days + 1);
    let occurrences = recurrence::expand_events(&data.events, local.date, horizon, &config.timezone);
    for occ in &occurrences {
        let ev = &occ.event;
        // v1.1.0：已完成的来源不执行提醒。
        if ev.completed_at.is_some() || done_today.contains(&(ArchiveSource::Event, occ.key.clone())) {
            continue;
        }
        if ev.all_day {
            continue;
        }
        let Ok(start) = timeutil::parse_utc(&ev.start) else { continue };
        let until = timeutil::minutes_between_utc(now, &start);
        if until >= 0 && until <= EVENT_START_NOTIFY_MIN {
            out.push(ReminderNotice {
                kind: "event_start".to_string(),
                title: "事件即将开始".to_string(),
                body: format!("{}（{} 分钟后）", ev.title, until),
                source_id: occ.key.clone(),
                dedup_key: format!("event_start:{}", occ.key),
                priority: ev.priority,
                should_notify: notify(ev.priority),
            });
        } else if until < 0 && until >= -EVENT_START_NOTIFY_MIN {
            out.push(ReminderNotice {
                kind: "event_start".to_string(),
                title: "事件已开始".to_string(),
                body: ev.title.clone(),
                source_id: occ.key.clone(),
                dedup_key: format!("event_start:{}", occ.key),
                priority: ev.priority,
                should_notify: notify(ev.priority),
            });
        }
        // 多级提前提醒：消费 reminders 中的全部偏移量。
        for r in &ev.reminders {
            let offset = r.offset_minutes;
            if until > 0 && until <= offset && offset > EVENT_START_NOTIFY_MIN {
                out.push(ReminderNotice {
                    kind: "event_reminder".to_string(),
                    title: "事件提醒".to_string(),
                    body: format!("{}（{} 分钟后开始）", ev.title, until),
                    source_id: occ.key.clone(),
                    dedup_key: format!("event_reminder:{}:{offset}", occ.key),
                    priority: ev.priority,
                    should_notify: notify(ev.priority),
                });
            }
        }
    }

    // 日常窗口开始/即将结束（v1.1.0：当日已完成的日常不再提醒）。
    for rt in &data.routines {
        if !rt.enabled || rt.deleted_at.is_some() {
            continue;
        }
        if done_today.contains(&(ArchiveSource::Routine, rt.id.clone())) {
            continue;
        }
        for w in &rt.time_windows {
            if !window_applies_today(w, local.weekday) {
                continue;
            }
            let (Ok(start), Ok(end)) = (timeutil::parse_hhmm(&w.start), timeutil::parse_hhmm(&w.end)) else { continue };
            let start_utc = timeutil::local_to_utc(local.date, start, tz);
            let end_utc = timeutil::local_to_utc(local.date, end, tz);
            let until_start = timeutil::minutes_between_utc(now, &start_utc);
            let until_end = timeutil::minutes_between_utc(now, &end_utc);
            if until_start >= 0 && until_start <= EVENT_START_NOTIFY_MIN {
                out.push(ReminderNotice {
                    kind: "routine_window".to_string(),
                    title: "日常窗口开始".to_string(),
                    body: format!("{}（{}）", rt.title, w.start),
                    source_id: rt.id.clone(),
                    dedup_key: format!("routine_window:{}:{}:start", rt.id, w.start),
                    priority: rt.priority,
                    should_notify: notify(rt.priority),
                });
            } else if until_end >= 0 && until_end <= EVENT_START_NOTIFY_MIN {
                out.push(ReminderNotice {
                    kind: "routine_window".to_string(),
                    title: "日常窗口即将结束".to_string(),
                    body: format!("{}（{} 结束）", rt.title, w.end),
                    source_id: rt.id.clone(),
                    dedup_key: format!("routine_window:{}:{}:end", rt.id, w.end),
                    priority: rt.priority,
                    should_notify: notify(rt.priority),
                });
            }
        }
    }

    // 浮动事项截止日提醒（v1.1.0：已完成的事项不再提醒）。
    for t in &data.tasks {
        if t.deleted_at.is_some() || t.status != ItemStatus::Active || t.completed_at.is_some() {
            continue;
        }
        if let Some(dl) = &t.deadline {
            if let Ok(dl_utc) = timeutil::parse_utc(dl) {
                if timeutil::to_local(&dl_utc, &config.timezone).date == local.date {
                    out.push(ReminderNotice {
                        kind: "task_deadline".to_string(),
                        title: "浮动事项今日截止".to_string(),
                        body: t.title.clone(),
                        source_id: t.id.clone(),
                        dedup_key: format!("task_deadline:{}:{}", t.id, local.date.format("%Y-%m-%d")),
                        priority: t.priority,
                        should_notify: notify(t.priority),
                    });
                }
            }
        }
    }

    out
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ArchiveFile;

    fn base_data(events: Vec<Event>, routines: Vec<Routine>) -> AppData {
        AppData {
            events,
            routines,
            tasks: vec![],
            long_tasks: vec![],
            config: Config::default(),
            archive: ArchiveFile {
                version: crate::models::CURRENT_VERSION,
                month: "2025-01".to_string(),
                days: Default::default(),
            },
        }
    }

    fn event_at(id: &str, start: &str, reminders: Vec<i64>) -> Event {
        Event {
            id: id.to_string(),
            title: "事件".to_string(),
            description: None,
            start: start.to_string(),
            end: None,
            all_day: false,
            reminders: reminders.into_iter().map(|offset_minutes| crate::models::Reminder { offset_minutes }).collect(),
            repeat: None,
            tags: vec![],
            priority: Priority::Normal,
            status: ItemStatus::Active,
            created_at: String::new(),
            updated_at: String::new(),
            completed_at: None,
            deleted_at: None,
        }
    }

    fn routine_at(id: &str, windows: Vec<(&str, &str)>) -> Routine {
        Routine {
            id: id.to_string(),
            title: "日常".to_string(),
            description: None,
            time_windows: windows
                .into_iter()
                .map(|(start, end)| TimeWindow { days_of_week: vec![], start: start.to_string(), end: end.to_string() })
                .collect(),
            duration_minutes: None,
            tags: vec![],
            priority: Priority::Normal,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: None,
        }
    }

    fn task_at(id: &str, deadline: Option<&str>, status: ItemStatus) -> Task {
        Task {
            id: id.to_string(),
            title: "浮动事项".to_string(),
            description: None,
            priority: Priority::Normal,
            deadline: deadline.map(|s| s.to_string()),
            tags: vec![],
            status,
            sort_order: 0,
            created_at: String::new(),
            updated_at: String::new(),
            completed_at: None,
            deleted_at: None,
        }
    }

    /// 向测试数据写入一条「今日已完成」归档（用于验证已完成来源不再提醒）。
    fn mark_done_today(data: &mut AppData, date: &str, source: ArchiveSource, source_id: &str) {
        let day = data.archive.days.entry(date.to_string()).or_insert_with(|| crate::models::ArchiveDay {
            entries: vec![],
            summary: None,
            updated_at: String::new(),
        });
        day.entries.push(crate::models::ArchiveEntry {
            id: format!("a-{source_id}"),
            time: "08:00".to_string(),
            title: "已完成".to_string(),
            source,
            source_id: Some(source_id.to_string()),
            note: None,
            duration_minutes: None,
            done_at: format!("{date}T08:00:00Z"),
        });
    }

    #[test]
    fn test_multi_level_reminders_have_distinct_dedup_keys() {
        // 2025-01-15 为周三；08:00 UTC = 本地 08:00（UTC 时区）。
        let ev = event_at("e1", "2025-01-15T09:00:00Z", vec![120, 60]);
        let data = base_data(vec![ev], vec![]);
        let mut config = Config::default();
        config.timezone = "UTC".to_string();
        let result = compute_candidates(&data, "2025-01-15T08:05:00Z", &config).unwrap();

        let mut keys: Vec<String> = result
            .due_reminders
            .iter()
            .filter(|r| r.kind == "event_reminder")
            .map(|r| r.dedup_key.clone())
            .collect();
        keys.sort_by_key(|k| k.rsplit(':').next().unwrap_or("0").parse::<i64>().unwrap_or(0));
        assert_eq!(keys, vec!["event_reminder:e1:60", "event_reminder:e1:120"]);
    }

    #[test]
    fn test_routine_window_start_and_end_have_distinct_dedup_keys() {
        // 同一日常两个窗口：一个即将开始、一个即将结束，验证两者不再互相吞掉。
        let rt = routine_at("r1", vec![("09:00", "10:00"), ("08:00", "08:55")]);
        let data = base_data(vec![], vec![rt]);
        let mut config = Config::default();
        config.timezone = "UTC".to_string();
        let result = compute_candidates(&data, "2025-01-15T08:50:00Z", &config).unwrap();

        let mut keys: Vec<String> = result
            .due_reminders
            .iter()
            .filter(|r| r.kind == "routine_window")
            .map(|r| r.dedup_key.clone())
            .collect();
        keys.sort();
        assert_eq!(keys, vec!["routine_window:r1:08:55:end", "routine_window:r1:09:00:start"]);
    }

    #[test]
    fn test_completed_task_does_not_remind() {
        // v1.1.0：已完成（status=completed）的浮动事项，即使今日截止也不生成提醒。
        let task = task_at("t1", Some("2025-01-15T09:00:00Z"), ItemStatus::Completed);
        let mut data = base_data(vec![], vec![]);
        data.tasks = vec![task];
        let mut config = Config::default();
        config.timezone = "UTC".to_string();
        let result = compute_candidates(&data, "2025-01-15T08:00:00Z", &config).unwrap();

        assert!(!result.due_reminders.iter().any(|r| r.kind == "task_deadline"));
    }

    #[test]
    fn test_completed_at_task_does_not_remind() {
        // v1.1.0：防御性检查——completedAt 已设置的事项即使 status 尚未同步，也不提醒。
        let mut task = task_at("t1", Some("2025-01-15T09:00:00Z"), ItemStatus::Active);
        task.completed_at = Some("2025-01-15T08:00:00Z".to_string());
        let mut data = base_data(vec![], vec![]);
        data.tasks = vec![task];
        let mut config = Config::default();
        config.timezone = "UTC".to_string();
        let result = compute_candidates(&data, "2025-01-15T08:00:00Z", &config).unwrap();

        assert!(!result.due_reminders.iter().any(|r| r.kind == "task_deadline"));
    }

    #[test]
    fn test_completed_recurring_occurrence_today_does_not_remind() {
        // v1.1.0：重复事件「完成仅归档本次」后，今日实例不应继续触发事件提醒。
        let mut ev = event_at("e1", "2025-01-15T09:00:00Z", vec![]);
        ev.repeat = Some(crate::models::Repeat {
            repeat_type: "daily".to_string(),
            interval: 1,
            days_of_week: vec![],
            end: None,
        });
        let mut data = base_data(vec![ev], vec![]);
        mark_done_today(&mut data, "2025-01-15", ArchiveSource::Event, "e1#2025-01-15");
        let mut config = Config::default();
        config.timezone = "UTC".to_string();
        let result = compute_candidates(&data, "2025-01-15T08:50:00Z", &config).unwrap();

        assert!(!result
            .due_reminders
            .iter()
            .any(|r| r.source_id == "e1#2025-01-15" && r.kind == "event_start"));
    }

    #[test]
    fn test_completed_routine_today_does_not_remind() {
        // v1.1.0：当日已完成的日常，不再触发窗口开始/即将结束提醒。
        let rt = routine_at("r1", vec![("09:00", "10:00")]);
        let mut data = base_data(vec![], vec![rt]);
        mark_done_today(&mut data, "2025-01-15", ArchiveSource::Routine, "r1");
        let mut config = Config::default();
        config.timezone = "UTC".to_string();
        let result = compute_candidates(&data, "2025-01-15T08:50:00Z", &config).unwrap();

        assert!(!result.due_reminders.iter().any(|r| r.kind == "routine_window"));
    }

    #[test]
    fn test_active_task_deadline_still_reminds() {
        // 回归保护：未完成的浮动事项今日截止时仍正常提醒。
        let task = task_at("t1", Some("2025-01-15T09:00:00Z"), ItemStatus::Active);
        let mut data = base_data(vec![], vec![]);
        data.tasks = vec![task];
        let mut config = Config::default();
        config.timezone = "UTC".to_string();
        let result = compute_candidates(&data, "2025-01-15T08:00:00Z", &config).unwrap();

        assert!(result.due_reminders.iter().any(|r| r.kind == "task_deadline" && r.source_id == "t1"));
    }
}
