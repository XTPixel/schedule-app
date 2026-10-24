//! Future notification planning reuses the same policy and completion filters
//! as foreground reminders. Each probe contains one concrete entity, keeping
//! repeated events and large collections from forming a quadratic scan.
use crate::candidates::{build_reminders, collect_done_today, EVENT_START_NOTIFY_MIN};
use crate::{expand_events, time_window_matches_date, timeutil, AppData, ReminderNotice};
use chrono::{DateTime, Duration, NaiveTime, Utc};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize)]
pub struct PlannedReminder {
    pub key: String,
    pub at: DateTime<Utc>,
    pub notice: ReminderNotice,
}

fn probe(
    data: &AppData,
    times: BTreeSet<DateTime<Utc>>,
    now: DateTime<Utc>,
    until: DateTime<Utc>,
    out: &mut BTreeMap<String, PlannedReminder>,
) {
    for at in times.into_iter().filter(|t| *t >= now && *t <= until) {
        let local = timeutil::to_local(&at, &data.config.timezone);
        let done = collect_done_today(&data.archive, &local.date);
        for notice in build_reminders(data, &at, &local, &data.config, &done)
            .into_iter()
            .filter(|n| n.should_notify)
        {
            let key = notice.dedup_key.clone();
            let value = PlannedReminder {
                key: key.clone(),
                at,
                notice,
            };
            match out.get(&key) {
                Some(old) if old.at <= at => {}
                _ => {
                    out.insert(key, value);
                }
            }
        }
    }
}

/// Plan at most 128 notifications in the next 48 hours. Opening the application
/// refreshes the rolling window; no background network service is required.
pub fn plan(data: &AppData, now: DateTime<Utc>) -> Vec<PlannedReminder> {
    if !data.config.notifications.enabled {
        return Vec::new();
    }
    let until = now + Duration::hours(48);
    let tz = timeutil::resolve_tz(&data.config.timezone);
    let today = timeutil::to_local(&now, &data.config.timezone).date;
    let mut common = BTreeSet::from([now]);
    // DND ending is a policy boundary: a reminder suppressed just before it may
    // still be eligible immediately afterwards.
    for offset in 0..=3 {
        let Some(date) = today.checked_add_signed(Duration::days(offset)) else {
            continue;
        };
        common.insert(timeutil::local_to_utc(date, NaiveTime::MIN, tz));
        if let Ok(end) = timeutil::parse_hhmm(&data.config.notifications.do_not_disturb.end) {
            common.insert(timeutil::local_to_utc(date, end, tz));
        }
    }
    let mut subset = data.clone();
    subset.events.clear();
    subset.routines.clear();
    subset.tasks.clear();
    subset.long_tasks.clear();
    let mut out = BTreeMap::new();
    for event in &data.events {
        if event.all_day {
            continue;
        }
        let offsets: BTreeSet<_> = std::iter::once(EVENT_START_NOTIFY_MIN)
            .chain(
                event
                    .reminders
                    .iter()
                    .map(|r| r.offset_minutes)
                    .filter(|n| *n > EVENT_START_NOTIFY_MIN && *n <= 525600),
            )
            .collect();
        for offset in offsets {
            let shifted_start = now + Duration::minutes(offset);
            let shifted_end = until + Duration::minutes(offset);
            let from = timeutil::to_local(&shifted_start, &data.config.timezone)
                .date
                .pred_opt()
                .unwrap_or(today);
            let to = timeutil::to_local(&shifted_end, &data.config.timezone)
                .date
                .succ_opt()
                .unwrap_or(today);
            for occurrence in
                expand_events(std::slice::from_ref(event), from, to, &data.config.timezone)
            {
                let mut concrete = occurrence.event;
                let Ok(start) = timeutil::parse_utc(&concrete.start) else {
                    continue;
                };
                concrete.id = occurrence.key;
                concrete.repeat = None;
                subset.events = vec![concrete];
                let mut times = common.clone();
                if let Some(at) = start.checked_sub_signed(Duration::minutes(offset)) {
                    times.insert(at);
                }
                probe(&subset, times, now, until, &mut out);
            }
        }
    }
    subset.events.clear();
    for routine in &data.routines {
        subset.routines = vec![routine.clone()];
        let mut times = common.clone();
        for offset in -1..=3 {
            let Some(date) = today.checked_add_signed(Duration::days(offset)) else {
                continue;
            };
            for window in &routine.time_windows {
                if !time_window_matches_date(window, date) {
                    continue;
                }
                let (Ok(start), Ok(end)) = (
                    timeutil::parse_hhmm(&window.start),
                    timeutil::parse_hhmm(&window.end),
                ) else {
                    continue;
                };
                let end_date = if end <= start {
                    date.succ_opt().unwrap_or(date)
                } else {
                    date
                };
                times.insert(
                    timeutil::local_to_utc(date, start, tz)
                        - Duration::minutes(EVENT_START_NOTIFY_MIN),
                );
                times.insert(
                    timeutil::local_to_utc(end_date, end, tz)
                        - Duration::minutes(EVENT_START_NOTIFY_MIN),
                );
            }
        }
        probe(&subset, times, now, until, &mut out);
    }
    subset.routines.clear();
    for task in &data.tasks {
        subset.tasks = vec![task.clone()];
        probe(&subset, common.clone(), now, until, &mut out);
    }
    let mut result: Vec<_> = out.into_values().collect();
    result.sort_by_key(|r| r.at);
    result.truncate(128);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn data() -> AppData {
        AppData {
            events: Vec::new(),
            routines: Vec::new(),
            tasks: Vec::new(),
            long_tasks: Vec::new(),
            config: crate::Config::default(),
            archive: crate::ArchiveFile {
                version: crate::CURRENT_VERSION,
                month: "2026-10".into(),
                days: Default::default(),
            },
        }
    }
    #[test]
    fn plans_separate_offsets_and_filters_completion_and_dnd() {
        let mut d = data();
        d.config.timezone = "UTC".into();
        d.config.notifications.do_not_disturb.enabled = false;
        d.events.push(serde_json::from_value(serde_json::json!({"id":"qa","title":"QA","start":"2026-10-22T12:00:00Z","allDay":false,"reminders":[{"offsetMinutes":60}],"tags":[],"priority":"high","status":"active","createdAt":"","updatedAt":""})).unwrap());
        let now = timeutil::parse_utc("2026-10-22T10:00:00Z").unwrap();
        let p = plan(&d, now);
        assert!(p
            .iter()
            .any(|n| n.at == timeutil::parse_utc("2026-10-22T11:00:00Z").unwrap()));
        assert!(p
            .iter()
            .any(|n| n.at == timeutil::parse_utc("2026-10-22T11:45:00Z").unwrap()));
        d.events[0].status = crate::ItemStatus::Completed;
        assert!(plan(&d, now).is_empty());
        d.events[0].status = crate::ItemStatus::Active;
        d.config.notifications.enabled = false;
        assert!(plan(&d, now).is_empty());
    }
    #[test]
    fn preserves_recurring_occurrence_identity() {
        let mut d = data();
        d.config.timezone = "UTC".into();
        d.config.notifications.do_not_disturb.enabled = false;
        d.events.push(serde_json::from_value(serde_json::json!({"id":"repeat","title":"QA","start":"2026-10-21T12:00:00Z","allDay":false,"reminders":[],"repeat":{"type":"daily","interval":1,"daysOfWeek":[],"end":null},"tags":[],"priority":"high","status":"active","createdAt":"","updatedAt":""})).unwrap());
        let p = plan(&d, timeutil::parse_utc("2026-10-22T10:00:00Z").unwrap());
        assert!(p.iter().any(|n| n.notice.source_id == "repeat#2026-10-22"));
        assert!(p.iter().any(|n| n.notice.source_id == "repeat#2026-10-23"));
        assert!(p
            .iter()
            .all(|n| n.at <= timeutil::parse_utc("2026-10-24T10:00:00Z").unwrap()));
    }
    #[test]
    fn cross_midnight_window_uses_previous_anchor_and_dedups_midnight() {
        let mut d = data();
        d.config.timezone = "UTC".into();
        d.config.notifications.do_not_disturb.enabled = false;
        d.routines.push(serde_json::from_value(serde_json::json!({"id":"night","title":"QA","timeWindows":[{"daysOfWeek":[4],"start":"23:00","end":"01:00"}],"tags":[],"priority":"high","enabled":true,"createdAt":"","updatedAt":""})).unwrap());
        let planned = plan(&d, timeutil::parse_utc("2026-10-23T00:30:00Z").unwrap());
        assert!(planned.iter().any(|r| r.at
            == timeutil::parse_utc("2026-10-23T00:45:00Z").unwrap()
            && r.key.contains("2026-10-22")));
        d.routines.clear();
        d.events.push(serde_json::from_value(serde_json::json!({"id":"midnight","title":"QA","start":"2026-10-23T00:05:00Z","allDay":false,"reminders":[],"tags":[],"priority":"high","status":"active","createdAt":"","updatedAt":""})).unwrap());
        assert_eq!(
            plan(&d, timeutil::parse_utc("2026-10-22T23:40:00Z").unwrap()).len(),
            1
        );
    }
}
