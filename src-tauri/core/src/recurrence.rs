//! 重复事件实例展开（Phase 1）：daily / weekly / monthly / yearly 规则 → 具体发生实例。
//!
//! 语义（§4.4 / §5.8）：
//! - 重复事件按「墙钟时间」展开：定时事件每次发生保持与首发生相同的本地 HH:mm；
//!   全天事件保持纯日期。
//! - 每个实例以 `key = "{seriesId}#{YYYY-MM-DD}"` 唯一标识，用于「完成仅归档本次」：
//!   归档 `sourceId` 写该 key，序列本身不修改、后续实例不受影响。

use chrono::{Datelike, Duration, NaiveDate, NaiveTime};
use serde::{Deserialize, Serialize};

use crate::models::{Event, ItemStatus, Priority};
use crate::timeutil;

/// 一个具体发生实例（日历/候选/时间轴共用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Occurrence {
    /// 完成归档时使用的来源键：一次性事件 = 事件 id；重复实例 = `{id}#{日期}`。
    pub key: String,
    /// 重复事件的序列 id；一次性事件为 None。
    pub series_id: Option<String>,
    /// 该实例的本地日期 YYYY-MM-DD（日历分组用）。
    pub local_date: String,
    /// 已把 start/end 调整到本实例的完整事件视图。
    pub event: Event,
}

/// 日历单元格（§7.3②）：单日的发生实例 + 日常窗口。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarRoutineWindow {
    pub date: String,
    pub routine_id: String,
    pub title: String,
    pub start: String,
    pub end: String,
    pub priority: Priority,
    /// V3.0 F3：日常所属标签（供日历按标签筛选）。
    #[serde(default)]
    pub tags: Vec<String>,
}

/// `get_calendar(start, end)` 的返回：区间内全部事件实例 + 日常窗口（前端按 date 分组）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarData {
    pub occurrences: Vec<Occurrence>,
    pub routine_windows: Vec<CalendarRoutineWindow>,
}

/// 将事件列表在 `[from, to]`（含端点，按本地日期）范围内展开为实例。
pub fn expand_events(
    events: &[Event],
    from: NaiveDate,
    to: NaiveDate,
    tz_name: &str,
) -> Vec<Occurrence> {
    let mut out = Vec::new();
    for ev in events {
        if ev.deleted_at.is_some() || ev.status != ItemStatus::Active {
            continue;
        }
        match &ev.repeat {
            None => push_single(ev, from, to, tz_name, &mut out),
            Some(rep) => expand_recurring(ev, rep, from, to, tz_name, &mut out),
        }
    }
    out
}

fn push_single(ev: &Event, from: NaiveDate, to: NaiveDate, tz_name: &str, out: &mut Vec<Occurrence>) {
    let Some(date) = timeutil::event_local_date(ev, tz_name) else { return };
    if date < from || date > to {
        return;
    }
    out.push(Occurrence {
        key: ev.id.clone(),
        series_id: None,
        local_date: timeutil::fmt_date(&date),
        event: ev.clone(),
    });
}

fn expand_recurring(
    ev: &Event,
    rep: &crate::models::Repeat,
    from: NaiveDate,
    to: NaiveDate,
    tz_name: &str,
    out: &mut Vec<Occurrence>,
) {
    let tz = timeutil::resolve_tz(tz_name);
    let all_day = ev.all_day;

    // 首发生锚点日期（本地）。
    let anchor = if all_day {
        match timeutil::parse_date(&ev.start) {
            Ok(d) => d,
            Err(_) => return,
        }
    } else {
        match timeutil::parse_utc(&ev.start) {
            Ok(u) => timeutil::to_local(&u, tz_name).date,
            Err(_) => return,
        }
    };

    // 定时事件的墙钟开始时间（HH:mm）与时长（分钟）。
    let start_hhmm: Option<NaiveTime> = if all_day {
        None
    } else {
        timeutil::parse_utc(&ev.start)
            .ok()
            .map(|u| timeutil::to_local(&u, tz_name).time)
    };
    let duration_min: Option<i64> = if all_day {
        None
    } else {
        let s = timeutil::parse_utc(&ev.start).ok();
        let e = ev.end.as_deref().and_then(|x| timeutil::parse_utc(x).ok());
        match (s, e) {
            (Some(s), Some(e)) if e > s => Some((e - s).num_minutes()),
            _ => None,
        }
    };

    // 重复截止日期（含）。
    let end_bound = rep.end.as_deref().and_then(|s| parse_end_date(s, tz_name));
    let interval = rep.interval.max(1);

    // 从锚点起逐日扫描到 to，匹配规则；加保护上限防异常配置死循环。
    let mut date = anchor.max(from);
    let mut guard = 0u32;
    while date <= to && guard < 200_000 {
        guard += 1;
        if date >= anchor
            && rule_matches(rep, anchor, date, interval)
            && end_bound.map_or(true, |e| date <= e)
        {
            out.push(build_occurrence(ev, date, all_day, start_hhmm, duration_min, tz));
        }
        date = match date.succ_opt() {
            Some(d) => d,
            None => break,
        };
    }
}

fn build_occurrence(
    ev: &Event,
    date: NaiveDate,
    all_day: bool,
    start_hhmm: Option<NaiveTime>,
    duration_min: Option<i64>,
    tz: chrono_tz::Tz,
) -> Occurrence {
    let mut e = ev.clone();
    let date_s = timeutil::fmt_date(&date);
    if all_day {
        e.start = date_s.clone();
        if ev.end.is_some() {
            e.end = Some(date_s.clone());
        }
    } else {
        if let Some(t) = start_hhmm {
            let start_utc = timeutil::local_to_utc(date, t, tz);
            e.start = timeutil::to_utc_string(&start_utc);
            if let Some(d) = duration_min {
                e.end = Some(timeutil::to_utc_string(&(start_utc + Duration::minutes(d))));
            }
        }
    }
    Occurrence {
        key: format!("{}#{}", ev.id, date_s),
        series_id: Some(ev.id.clone()),
        local_date: date_s,
        event: e,
    }
}

/// 判断某日期是否命中重复规则。
fn rule_matches(rep: &crate::models::Repeat, anchor: NaiveDate, date: NaiveDate, interval: i64) -> bool {
    match rep.repeat_type.as_str() {
        "daily" => (date - anchor).num_days().rem_euclid(interval) == 0,
        "weekly" => {
            let weeks = (date - anchor).num_days().div_euclid(7);
            if weeks.rem_euclid(interval) != 0 {
                return false;
            }
            let wd = date.weekday().number_from_monday();
            if rep.days_of_week.is_empty() {
                wd == anchor.weekday().number_from_monday()
            } else {
                rep.days_of_week.contains(&wd)
            }
        }
        "monthly" => {
            let months = (date.year() as i64 * 12 + date.month0() as i64)
                - (anchor.year() as i64 * 12 + anchor.month0() as i64);
            if months.rem_euclid(interval) != 0 {
                return false;
            }
            let target = anchor.day().min(days_in_month(date.year(), date.month()));
            date.day() == target
        }
        "yearly" => {
            let years = date.year() as i64 - anchor.year() as i64;
            if years.rem_euclid(interval) != 0 {
                return false;
            }
            date.month() == anchor.month()
                && date.day() == anchor.day().min(days_in_month(date.year(), date.month()))
        }
        // custom：按 weekly 语义（daysOfWeek 为空则退化为 daily）。
        "custom" => {
            if rep.days_of_week.is_empty() {
                (date - anchor).num_days().rem_euclid(interval) == 0
            } else {
                let weeks = (date - anchor).num_days().div_euclid(7);
                weeks.rem_euclid(interval) == 0
                    && rep.days_of_week.contains(&date.weekday().number_from_monday())
            }
        }
        _ => false,
    }
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (y, m) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    NaiveDate::from_ymd_opt(y, m, 1)
        .map(|d| d.pred_opt().map(|p| p.day()).unwrap_or(28))
        .unwrap_or(28)
}

/// 解析 repeat.end：优先按绝对时刻（转本地日期），其次按纯日期。
fn parse_end_date(s: &str, tz_name: &str) -> Option<NaiveDate> {
    if let Ok(u) = timeutil::parse_utc(s) {
        return Some(timeutil::to_local(&u, tz_name).date);
    }
    // 纯日期 YYYY-MM-DD
    timeutil::parse_date(s).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_event(repeat_type: &str, days_of_week: Vec<u32>, start: &str) -> Event {
        Event {
            id: "e_test".to_string(),
            title: "t".to_string(),
            description: None,
            start: start.to_string(),
            end: None,
            all_day: true,
            reminders: vec![],
            repeat: Some(crate::models::Repeat {
                repeat_type: repeat_type.to_string(),
                interval: 1,
                days_of_week,
                end: None,
            }),
            tags: vec![],
            priority: Priority::Normal,
            status: ItemStatus::Active,
            created_at: String::new(),
            updated_at: String::new(),
            completed_at: None,
            deleted_at: None,
        }
    }

    #[test]
    fn test_daily_expansion() {
        let ev = mk_event("daily", vec![], "2025-01-01");
        let occs = expand_events(&[ev], NaiveDate::from_ymd_opt(2025, 1, 1).unwrap(), NaiveDate::from_ymd_opt(2025, 1, 3).unwrap(), "UTC");
        assert_eq!(occs.len(), 3);
        assert_eq!(occs[0].key, "e_test#2025-01-01");
        assert_eq!(occs[2].key, "e_test#2025-01-03");
    }

    #[test]
    fn test_weekly_days() {
        // 每周一/三（ISO 1,3），锚点周一 2025-01-06。
        let ev = mk_event("weekly", vec![1, 3], "2025-01-06");
        let occs = expand_events(&[ev], NaiveDate::from_ymd_opt(2025, 1, 6).unwrap(), NaiveDate::from_ymd_opt(2025, 1, 8).unwrap(), "UTC");
        // 周一(1/6)、周三(1/8)。
        let dates: Vec<String> = occs.iter().map(|o| o.local_date.clone()).collect();
        assert_eq!(dates, vec!["2025-01-06", "2025-01-08"]);
    }

    #[test]
    fn test_monthly_clamp() {
        // 每月 31 号，2 月应钳到 28（2025 非闰年）。
        let ev = mk_event("monthly", vec![], "2025-01-31");
        let occs = expand_events(&[ev], NaiveDate::from_ymd_opt(2025, 2, 1).unwrap(), NaiveDate::from_ymd_opt(2025, 2, 28).unwrap(), "UTC");
        assert_eq!(occs.len(), 1);
        assert_eq!(occs[0].local_date, "2025-02-28");
    }
}
