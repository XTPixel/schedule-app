//! V1.2.1：日常时间窗口命中判定（统一入口）。
//!
//! 两种互斥模式：
//! - 按星期（`every_days = None`，兼容旧数据）：`days_of_week` 为空 = 每天，否则匹配星期；
//! - 每隔 N 天（`every_days = Some(n)`）：`anchor_date ≤ date` 且 `(date - anchor).days % n == 0`。

use chrono::{Datelike, NaiveDate};

use crate::models::TimeWindow;
use crate::timeutil;

/// `date` 是否命中该时间窗口（按星期 或 每隔 N 天）。
///
/// 所有消费点（候选 / 时间轴 / 日历 / 提醒 / 完成率）必须统一调用本函数。
pub fn time_window_matches_date(w: &TimeWindow, date: NaiveDate) -> bool {
    match w.every_days {
        Some(n) => {
            let n = n as i64;
            if n <= 0 {
                return false;
            }
            let Some(anchor) = w.anchor_date.as_deref().and_then(|s| timeutil::parse_date(s).ok()) else {
                return false;
            };
            let offset = (date - anchor).num_days();
            offset >= 0 && offset.rem_euclid(n) == 0
        }
        None => {
            if w.days_of_week.is_empty() {
                return true;
            }
            let weekday = date.weekday().number_from_monday();
            w.days_of_week.contains(&weekday)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(days: Vec<u32>, every: Option<u32>, anchor: Option<&str>) -> TimeWindow {
        TimeWindow {
            days_of_week: days,
            start: "08:00".to_string(),
            end: "09:00".to_string(),
            every_days: every,
            anchor_date: anchor.map(|s| s.to_string()),
        }
    }

    fn date(s: &str) -> NaiveDate {
        timeutil::parse_date(s).unwrap()
    }

    #[test]
    fn test_weekday_mode_is_backward_compatible() {
        let weekday = w(vec![1, 3], None, None);
        assert!(time_window_matches_date(&weekday, date("2025-01-06"))); // 周一
        assert!(!time_window_matches_date(&weekday, date("2025-01-07"))); // 周二
        assert!(time_window_matches_date(&weekday, date("2025-01-08"))); // 周三
        let daily = w(vec![], None, None);
        assert!(time_window_matches_date(&daily, date("2025-01-07")));
    }

    #[test]
    fn test_every_days_mode_hits_anchor_and_interval() {
        let w = w(vec![1], Some(2), Some("2025-01-01"));
        assert!(time_window_matches_date(&w, date("2025-01-01")));
        assert!(!time_window_matches_date(&w, date("2025-01-02")));
        assert!(time_window_matches_date(&w, date("2025-01-03")));
        assert!(time_window_matches_date(&w, date("2025-01-05")));
        // 锚点之前不命中。
        assert!(!time_window_matches_date(&w, date("2024-12-31")));
    }

    #[test]
    fn test_every_days_invalid_inputs_never_match() {
        assert!(!time_window_matches_date(&w(vec![], Some(0), Some("2025-01-01")), date("2025-01-01")));
        assert!(!time_window_matches_date(&w(vec![], Some(2), None), date("2025-01-01")));
        assert!(!time_window_matches_date(&w(vec![], Some(2), Some("bad")), date("2025-01-01")));
    }
}
