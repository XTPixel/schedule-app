//! 统计与复盘（Phase 2 / V1.5）：完成趋势、标签耗时占比、日常完成率、日/周复盘。
//!
//! 全部基于归档 `durationMinutes`（§5.5）+ 来源对象标签计算，纯函数、不依赖存储层。

use std::collections::{BTreeMap, HashMap};

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::models::{ArchiveDay, ArchiveEntry, ArchiveSource, Event, LongTask, Routine, Task};
use crate::timeutil;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCount {
    pub date: String,
    pub count: i64,
    pub duration_minutes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagDuration {
    pub tag: String,
    pub minutes: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineCompletion {
    pub routine_id: String,
    pub title: String,
    pub done_days: i64,
    pub scheduled_days: i64,
    pub rate: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsTotals {
    pub completed_count: i64,
    pub duration_minutes: i64,
    pub active_days: i64,
}

/// V1.2：长期任务投入（独立口径，不计入 totals）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LongTaskStatItem {
    pub task_id: String,
    pub title: String,
    pub count: i64,
    pub duration_minutes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsResult {
    pub from: String,
    pub to: String,
    pub trend: Vec<DayCount>,
    pub tag_durations: Vec<TagDuration>,
    pub routine_completion: Vec<RoutineCompletion>,
    pub totals: StatsTotals,
    /// V1.2：长期任务投入统计（独立口径）。
    pub long_task_stats: Vec<LongTaskStatItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDay {
    pub date: String,
    pub entries: Vec<ArchiveEntry>,
    pub completed_count: i64,
    pub duration_minutes: i64,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewResult {
    pub from: String,
    pub to: String,
    pub days: Vec<ReviewDay>,
    pub totals: StatsTotals,
    pub tag_durations: Vec<TagDuration>,
    pub routine_completion: Vec<RoutineCompletion>,
}

const UNTAGGED: &str = "未分类";

/// 完成趋势 + 标签耗时占比 + 日常完成率 + 长期任务投入（统计页）。
pub fn compute_stats(
    days: &BTreeMap<String, ArchiveDay>,
    routines: &[Routine],
    events: &[Event],
    tasks: &[Task],
    long_tasks: &[LongTask],
    tz: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> StatsResult {
    let trend = build_trend(days, from, to);
    let tag_durations = build_tag_durations(days, routines, events, tasks);
    let routine_completion = build_routine_completion(days, routines, from, to);
    let totals = build_totals(&trend);
    let long_task_stats = build_long_task_stats(long_tasks, tz, from, to);

    StatsResult {
        from: timeutil::fmt_date(&from),
        to: timeutil::fmt_date(&to),
        trend,
        tag_durations,
        routine_completion,
        totals,
        long_task_stats,
    }
}

/// 日/周复盘。
pub fn compute_review(
    days: &BTreeMap<String, ArchiveDay>,
    routines: &[Routine],
    events: &[Event],
    tasks: &[Task],
    from: NaiveDate,
    to: NaiveDate,
) -> ReviewResult {
    let mut out_days = Vec::new();
    let mut d = from;
    while d <= to {
        let key = timeutil::fmt_date(&d);
        let day = days.get(&key);
        let entries = day.map(|x| x.entries.clone()).unwrap_or_default();
        let duration_minutes = entries.iter().map(|e| e.duration_minutes.unwrap_or(0)).sum();
        out_days.push(ReviewDay {
            date: key,
            completed_count: entries.len() as i64,
            duration_minutes,
            summary: day.and_then(|x| x.summary.clone()),
            entries,
        });
        d = match d.succ_opt() {
            Some(x) => x,
            None => break,
        };
    }
    let totals = StatsTotals {
        completed_count: out_days.iter().map(|x| x.completed_count).sum(),
        duration_minutes: out_days.iter().map(|x| x.duration_minutes).sum(),
        active_days: out_days.iter().filter(|x| x.completed_count > 0).count() as i64,
    };
    ReviewResult {
        from: timeutil::fmt_date(&from),
        to: timeutil::fmt_date(&to),
        days: out_days,
        totals,
        tag_durations: build_tag_durations(days, routines, events, tasks),
        routine_completion: build_routine_completion(days, routines, from, to),
    }
}

fn build_trend(days: &BTreeMap<String, ArchiveDay>, from: NaiveDate, to: NaiveDate) -> Vec<DayCount> {
    let mut out = Vec::new();
    let mut d = from;
    while d <= to {
        let key = timeutil::fmt_date(&d);
        let (count, duration_minutes) = days
            .get(&key)
            .map(|day| {
                (
                    day.entries.len() as i64,
                    day.entries.iter().map(|e| e.duration_minutes.unwrap_or(0)).sum(),
                )
            })
            .unwrap_or((0, 0));
        out.push(DayCount { date: key, count, duration_minutes });
        d = match d.succ_opt() {
            Some(x) => x,
            None => break,
        };
    }
    out
}

fn build_totals(trend: &[DayCount]) -> StatsTotals {
    StatsTotals {
        completed_count: trend.iter().map(|x| x.count).sum(),
        duration_minutes: trend.iter().map(|x| x.duration_minutes).sum(),
        active_days: trend.iter().filter(|x| x.count > 0).count() as i64,
    }
}

fn build_tag_durations(
    days: &BTreeMap<String, ArchiveDay>,
    routines: &[Routine],
    events: &[Event],
    tasks: &[Task],
) -> Vec<TagDuration> {
    let mut acc: HashMap<String, (i64, i64)> = HashMap::new(); // tag -> (minutes, count)
    for day in days.values() {
        for e in &day.entries {
            let minutes = e.duration_minutes.unwrap_or(0);
            let tags = resolve_tags(e, routines, events, tasks);
            let tags = if tags.is_empty() { vec![UNTAGGED.to_string()] } else { tags };
            for t in tags {
                let entry = acc.entry(t).or_insert((0, 0));
                entry.0 += minutes;
                entry.1 += 1;
            }
        }
    }
    let mut out: Vec<TagDuration> = acc
        .into_iter()
        .map(|(tag, (minutes, count))| TagDuration { tag, minutes, count })
        .collect();
    out.sort_by(|a, b| b.minutes.cmp(&a.minutes).then(b.count.cmp(&a.count)));
    out
}

fn resolve_tags(e: &ArchiveEntry, routines: &[Routine], events: &[Event], tasks: &[Task]) -> Vec<String> {
    let Some(sid) = &e.source_id else { return vec![] };
    match e.source {
        // 重复事件实例的归档 sourceId 形如 `e_xxx#2025-01-15`：先取 `#` 前的基础 ID 再匹配序列。
        ArchiveSource::Event => events
            .iter()
            .find(|x| x.id == base_id(sid))
            .map(|x| x.tags.clone())
            .unwrap_or_default(),
        ArchiveSource::Routine => routines.iter().find(|x| &x.id == sid).map(|x| x.tags.clone()).unwrap_or_default(),
        ArchiveSource::Task => tasks.iter().find(|x| &x.id == sid).map(|x| x.tags.clone()).unwrap_or_default(),
        ArchiveSource::Manual => vec![],
    }
}

/// 重复实例键 `{seriesId}#{date}` → `{seriesId}`；无 `#` 原样返回。
fn base_id(source_id: &str) -> &str {
    source_id.split('#').next().unwrap_or(source_id)
}

/// V1.2：长期任务投入（独立口径）。
///
/// - 仅统计有效会话（deletedAt = null）且 `startedAt` 本地日期落在窗口内（D7）；
/// - 软删除任务的历史会话照常计入（投入是事实）；
/// - durationMinutes = 窗口内 durationMs 求和后四舍五入到分钟；
/// - 按 durationMinutes 降序（同分钟数按次数降序）返回。
fn build_long_task_stats(
    long_tasks: &[LongTask],
    tz: &str,
    from: NaiveDate,
    to: NaiveDate,
) -> Vec<LongTaskStatItem> {
    let mut out: Vec<LongTaskStatItem> = long_tasks
        .iter()
        .map(|t| {
            let mut count = 0i64;
            let mut total_ms = 0i64;
            for s in &t.sessions {
                if s.deleted_at.is_some() {
                    continue;
                }
                let Ok(started) = timeutil::parse_utc(&s.started_at) else { continue };
                let d = timeutil::to_local(&started, tz).date;
                if d >= from && d <= to {
                    count += 1;
                    total_ms += s.duration_ms.max(0);
                }
            }
            LongTaskStatItem {
                task_id: t.id.clone(),
                title: t.title.clone(),
                count,
                duration_minutes: ((total_ms as f64) / 60_000.0).round() as i64,
            }
        })
        .filter(|x| x.count > 0)
        .collect();
    out.sort_by(|a, b| {
        b.duration_minutes
            .cmp(&a.duration_minutes)
            .then(b.count.cmp(&a.count))
            .then(a.title.cmp(&b.title))
    });
    out
}

fn build_routine_completion(
    days: &BTreeMap<String, ArchiveDay>,
    routines: &[Routine],
    from: NaiveDate,
    to: NaiveDate,
) -> Vec<RoutineCompletion> {
    let mut out = Vec::new();
    for r in routines {
        if r.deleted_at.is_some() {
            continue;
        }
        let mut scheduled = 0i64;
        let mut done = 0i64;
        let mut d = from;
        while d <= to {
            if routine_scheduled_on(r, d) {
                scheduled += 1;
                let key = timeutil::fmt_date(&d);
                let done_today = days.get(&key).map(|day| {
                    day.entries.iter().any(|e| {
                        e.source == ArchiveSource::Routine && e.source_id.as_deref() == Some(r.id.as_str())
                    })
                }).unwrap_or(false);
                if done_today {
                    done += 1;
                }
            }
            d = match d.succ_opt() {
                Some(x) => x,
                None => break,
            };
        }
        let rate = if scheduled > 0 { done as f64 / scheduled as f64 } else { 0.0 };
        out.push(RoutineCompletion {
            routine_id: r.id.clone(),
            title: r.title.clone(),
            done_days: done,
            scheduled_days: scheduled,
            rate,
        });
    }
    out
}

fn routine_scheduled_on(r: &Routine, date: NaiveDate) -> bool {
    if !r.enabled || r.time_windows.is_empty() {
        return false;
    }
    let weekday = date.weekday().number_from_monday();
    r.time_windows.iter().any(|w| w.days_of_week.is_empty() || w.days_of_week.contains(&weekday))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::*;

    fn ev(id: &str, tags: Vec<&str>) -> Event {
        Event {
            id: id.to_string(),
            title: id.to_string(),
            description: None,
            start: "2025-01-01T09:00:00Z".to_string(),
            end: None,
            all_day: false,
            reminders: vec![],
            repeat: None,
            tags: tags.into_iter().map(|s| s.to_string()).collect(),
            priority: Priority::Normal,
            status: ItemStatus::Active,
            created_at: String::new(),
            updated_at: String::new(),
            completed_at: None,
            deleted_at: None,
        }
    }

    fn entry(source: ArchiveSource, source_id: &str) -> ArchiveEntry {
        ArchiveEntry {
            id: source_id.to_string(),
            time: "09:00".to_string(),
            title: "t".to_string(),
            source,
            source_id: Some(source_id.to_string()),
            note: None,
            duration_minutes: Some(30),
            done_at: "2025-01-15T09:00:00Z".to_string(),
        }
    }

    #[test]
    fn test_resolve_tags_for_recurring_event_occurrence() {
        let events = vec![ev("e_xxx", vec!["工作"])];
        let e = entry(ArchiveSource::Event, "e_xxx#2025-01-15");
        assert_eq!(resolve_tags(&e, &[], &events, &[]), vec!["工作".to_string()]);
    }

    #[test]
    fn test_stats_counts_recurring_occurrence_under_real_tag() {
        let mut days = BTreeMap::new();
        days.insert(
            "2025-01-15".to_string(),
            ArchiveDay {
                entries: vec![entry(ArchiveSource::Event, "e_xxx#2025-01-15")],
                summary: None,
                updated_at: String::new(),
            },
        );
        let events = vec![ev("e_xxx", vec!["工作"])];
        let result = compute_stats(
            &days,
            &[],
            &events,
            &[],
            &[],
            "UTC",
            NaiveDate::from_ymd_opt(2025, 1, 15).unwrap(),
            NaiveDate::from_ymd_opt(2025, 1, 15).unwrap(),
        );
        let work = result.tag_durations.iter().find(|t| t.tag == "工作").unwrap();
        assert_eq!(work.minutes, 30);
        assert_eq!(work.count, 1);
        assert!(result.tag_durations.iter().all(|t| t.tag != "未分类"));
    }

    fn lt(id: &str, sessions: Vec<LongTaskSession>) -> LongTask {
        LongTask {
            id: id.to_string(),
            title: id.to_string(),
            description: None,
            start_date: "2025-01-01".to_string(),
            due_date: "2025-12-31".to_string(),
            status: LongTaskStatus::Active,
            ended_at: None,
            tags: vec![],
            priority: Priority::Normal,
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: None,
            sessions,
        }
    }

    fn session(id: &str, started_at: &str, duration_ms: i64, deleted: bool) -> LongTaskSession {
        LongTaskSession {
            id: id.to_string(),
            started_at: started_at.to_string(),
            ended_at: "2025-01-15T10:00:00Z".to_string(),
            duration_ms,
            note: None,
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: deleted.then(|| "2025-01-15T11:00:00Z".to_string()),
        }
    }

    #[test]
    fn test_long_task_stats_window_filters_soft_deleted_and_rounds_minutes() {
        let tasks = vec![
            lt(
                "lt1",
                vec![
                    session("s1", "2025-01-15T09:00:00Z", 90_000, false), // 窗口内，1.5 分钟 → 四舍五入 2
                    session("s2", "2025-01-14T09:00:00Z", 600_000, false), // 窗口外，不计
                    session("s3", "2025-01-15T10:00:00Z", 1_200_000, true), // 软删除，不计
                ],
            ),
        ];
        let result = compute_stats(
            &BTreeMap::new(),
            &[],
            &[],
            &[],
            &tasks,
            "UTC",
            NaiveDate::from_ymd_opt(2025, 1, 15).unwrap(),
            NaiveDate::from_ymd_opt(2025, 1, 15).unwrap(),
        );
        assert_eq!(result.long_task_stats.len(), 1);
        assert_eq!(result.long_task_stats[0].count, 1);
        assert_eq!(result.long_task_stats[0].duration_minutes, 2);
        // 独立口径：不计入 totals。
        assert_eq!(result.totals.duration_minutes, 0);
    }

    #[test]
    fn test_long_task_stats_counts_sessions_of_deleted_task() {
        // 软删除任务的历史投入是事实，照常计入。
        let mut task = lt("lt1", vec![session("s1", "2025-01-15T09:00:00Z", 60_000, false)]);
        task.deleted_at = Some("2025-01-16T00:00:00Z".to_string());
        let result = compute_stats(
            &BTreeMap::new(),
            &[],
            &[],
            &[],
            &[task],
            "UTC",
            NaiveDate::from_ymd_opt(2025, 1, 15).unwrap(),
            NaiveDate::from_ymd_opt(2025, 1, 15).unwrap(),
        );
        assert_eq!(result.long_task_stats.len(), 1);
        assert_eq!(result.long_task_stats[0].count, 1);
    }
}
