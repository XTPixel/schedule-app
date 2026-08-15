//! 时间与时区工具（§5.8）。
//!
//! - 绝对时刻：接受任意 ISO 8601 时区，落盘统一归一化为 UTC `Z`。
//! - 墙钟时刻：`HH:mm`。
//! - 纯日期：`YYYY-MM-DD`。

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;

use crate::error::{AppError, AppResult};

/// 解析任意 ISO 8601（含时区偏移）为 UTC 时刻。
pub fn parse_utc(s: &str) -> AppResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|e| AppError::Parse(format!("无法解析绝对时刻 '{s}': {e}")))
}

/// 将任意 ISO 时刻归一化为 UTC `Z` 字符串（落盘格式）。
pub fn normalize_to_utc(s: &str) -> AppResult<String> {
    Ok(to_utc_string(&parse_utc(s)?))
}

/// UTC 时刻 → RFC3339 秒级 `Z` 字符串。
pub fn to_utc_string(dt: &DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub fn now_utc() -> DateTime<Utc> {
    Utc::now()
}

pub fn now_utc_string() -> String {
    to_utc_string(&now_utc())
}

/// 解析时区名，失败回退 UTC。
pub fn resolve_tz(name: &str) -> Tz {
    name.parse::<Tz>().unwrap_or(Tz::UTC)
}

/// 本地墙钟视图。
#[derive(Debug, Clone, Copy)]
pub struct LocalNow {
    pub date: NaiveDate,
    pub time: NaiveTime,
    /// 1=周一 ... 7=周日。
    pub weekday: u32,
}

/// UTC 时刻 → 指定时区的本地日期/时间/星期。
pub fn to_local(utc: &DateTime<Utc>, tz_name: &str) -> LocalNow {
    let tz = resolve_tz(tz_name);
    let local = utc.with_timezone(&tz);
    LocalNow {
        date: local.date_naive(),
        time: local.time(),
        weekday: local.weekday().number_from_monday(),
    }
}

/// 本地日期 + 墙钟时间 → UTC 时刻（处理 DST 歧义，MVP 平台无 DST，取 Single/Ambiguous 首个）。
pub fn local_to_utc(date: NaiveDate, time: NaiveTime, tz: Tz) -> DateTime<Utc> {
    let ndt = date.and_time(time);
    match tz.from_local_datetime(&ndt) {
        chrono::LocalResult::Single(dt) => dt.with_timezone(&Utc),
        chrono::LocalResult::Ambiguous(a, _b) => a.with_timezone(&Utc),
        chrono::LocalResult::None => ndt.and_utc(),
    }
}

/// UTC 时刻 → 本地 `HH:mm` 字符串。
pub fn fmt_local_time(utc: &DateTime<Utc>, tz_name: &str) -> String {
    to_local(utc, tz_name).time.format("%H:%M").to_string()
}

/// UTC 时刻 → 本地 `YYYY-MM-DD` 字符串。
pub fn fmt_local_date(utc: &DateTime<Utc>, tz_name: &str) -> String {
    to_local(utc, tz_name).date.format("%Y-%m-%d").to_string()
}

pub fn parse_hhmm(s: &str) -> AppResult<NaiveTime> {
    NaiveTime::parse_from_str(s, "%H:%M")
        .map_err(|e| AppError::Parse(format!("无法解析墙钟时间 '{s}': {e}")))
}

pub fn fmt_hhmm(t: &NaiveTime) -> String {
    t.format("%H:%M").to_string()
}

pub fn parse_date(s: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map_err(|e| AppError::Parse(format!("无法解析纯日期 '{s}': {e}")))
}

pub fn fmt_date(d: &NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// 当前本地月份 `YYYY-MM`。
pub fn current_month_string(tz_name: &str) -> String {
    let local = to_local(&now_utc(), tz_name);
    format!("{:04}-{:02}", local.date.year(), local.date.month())
}

/// 当前本地日期 `YYYY-MM-DD`。
pub fn today_string(tz_name: &str) -> String {
    fmt_date(&to_local(&now_utc(), tz_name).date)
}

/// 判断墙钟时刻是否落在 [start, end] 窗口内（支持跨午夜，如 22:00–08:00）。
pub fn time_in_window(t: NaiveTime, start: NaiveTime, end: NaiveTime) -> bool {
    if start <= end {
        t >= start && t < end
    } else {
        // 跨午夜：22:00–08:00
        t >= start || t < end
    }
}

/// 两个本地时间点之间的分钟差（end - start），跨午夜按自然顺序计算。
pub fn minutes_between(start: NaiveTime, end: NaiveTime) -> i64 {
    let mut diff = (end - start).num_minutes();
    if diff < 0 {
        diff += 24 * 60;
    }
    diff
}

/// UTC 时刻之间的分钟差（b - a）。
pub fn minutes_between_utc(a: &DateTime<Utc>, b: &DateTime<Utc>) -> i64 {
    (*b - *a).num_minutes()
}

/// 解析事件的「开始本地日期」：全天事件直接读纯日期；定时事件转本地时区。
pub fn event_local_date(event: &crate::models::Event, tz_name: &str) -> Option<NaiveDate> {
    if event.all_day {
        parse_date(&event.start).ok()
    } else {
        parse_utc(&event.start)
            .ok()
            .map(|utc| to_local(&utc, tz_name).date)
    }
}

/// 全天事件取当日开始（本地 00:00）；定时事件取开始 UTC。
pub fn event_start_utc(event: &crate::models::Event, tz: Tz) -> Option<DateTime<Utc>> {
    if event.all_day {
        let d = parse_date(&event.start).ok()?;
        Some(local_to_utc(d, NaiveTime::from_hms_opt(0, 0, 0)?, tz))
    } else {
        parse_utc(&event.start).ok()
    }
}

/// 时长（用于 `Duration` 常量）。
pub fn hours(n: i64) -> Duration {
    Duration::hours(n)
}
