//! 自然语言时间解析（Phase 1 快速录入）。
//!
//! 覆盖常见中文时间表达：今天/明天/后天、星期、X月X日/X号、X天后、
//! 上午/下午/晚上 + X点/点半/X点X分、HH:MM 等。
//! 解析失败返回 `matched: false`，由前端降级为表单兜底（§7.5）。

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, Utc};
use serde::{Deserialize, Serialize};

use crate::timeutil;

/// 自然语言解析结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NlpEvent {
    pub title: String,
    /// 定时事件：UTC Z；全天事件：YYYY-MM-DD。
    pub start: String,
    pub end: Option<String>,
    pub all_day: bool,
    /// 是否识别出任何时间/日期信息；false 时前端走表单兜底。
    pub matched: bool,
    /// 识别出的日期（用于前端高亮时间选择器）。
    pub date: Option<String>,
    /// 识别出的墙钟时间（HH:mm），全天为 None。
    pub time: Option<String>,
}

/// 相对日期允许的最大偏移（天）：超过则视为解析失败并降级表单（BUG-01/24）。
const MAX_REL_DAYS: i64 = 3660;

/// 构造「未匹配」结果（保留原标题）。
fn no_match(text: &str) -> NlpEvent {
    let title = text.trim().to_string();
    NlpEvent {
        title: if title.is_empty() {
            text.to_string()
        } else {
            title
        },
        start: String::new(),
        end: None,
        all_day: false,
        matched: false,
        date: None,
        time: None,
    }
}

/// 解析自然语言，参考时刻为 now_utc（本地日期由 tz 决定）。
pub fn parse_natural_language(text: &str, tz_name: &str, now_utc: &DateTime<Utc>) -> NlpEvent {
    let tz = timeutil::resolve_tz(tz_name);
    let local = timeutil::to_local(now_utc, tz_name);
    let today = local.date;

    // BUG-01/24/25：超大偏移 / 非法日期一律解析失败，避免 panic 与静默钳制。
    let Ok((date, date_lit)) = extract_date(text, today) else {
        return no_match(text);
    };
    let (time, time_lit) = extract_time(text);

    let matched = date.is_some() || time.is_some();
    let mut title = text.trim().to_string();
    if let Some(lit) = date_lit {
        title = title.replace(lit, " ");
    }
    if let Some(lit) = time_lit {
        title = title.replace(lit, " ");
    }
    // 去掉残留的时段词/介词/空白。
    for p in [
        "凌晨", "早上", "早晨", "上午", "下午", "傍晚", "晚上", "中午", "正午", "的",
    ] {
        title = title.replace(p, " ");
    }
    title = title
        .replace("，", " ")
        .replace(",", " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let title = title.trim().to_string();

    if !matched {
        return no_match(text);
    }

    let final_title = if title.is_empty() {
        text.trim().to_string()
    } else {
        title
    };

    // 只有日期、无时间 → 全天事件。
    let date = date.unwrap_or(today);
    match time {
        None => NlpEvent {
            title: final_title,
            start: timeutil::fmt_date(&date),
            end: Some(timeutil::fmt_date(&date)),
            all_day: true,
            matched: true,
            date: Some(timeutil::fmt_date(&date)),
            time: None,
        },
        Some(t) => {
            let start_utc = timeutil::local_to_utc(date, t, tz);
            let end_utc = start_utc + Duration::hours(1);
            NlpEvent {
                title: final_title,
                start: timeutil::to_utc_string(&start_utc),
                end: Some(timeutil::to_utc_string(&end_utc)),
                all_day: false,
                matched: true,
                date: Some(timeutil::fmt_date(&date)),
                time: Some(timeutil::fmt_hhmm(&t)),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 日期识别
// ---------------------------------------------------------------------------

/// 返回 (目标日期, 匹配到的字面量)。越界 / 非法日期返回 Err，调用方降级表单。
fn extract_date(text: &str, today: NaiveDate) -> Result<(Option<NaiveDate>, Option<&str>), ()> {
    // 相对天数。
    for (pat, delta) in [
        ("大后天", 3i64),
        ("后天", 2),
        ("明天", 1),
        ("今天", 0),
        ("昨日", -1),
        ("昨天", -1),
    ] {
        if text.contains(pat) {
            return Ok((Some(today + Duration::days(delta)), Some(pat)));
        }
    }

    // X天后 / X日后（BUG-01/24：上界 3660 天，checked_add 防溢出）。
    if let Some((n, lit)) = find_number_suffix(text, &["天后", "日后", "天之后"]) {
        if n < 0 || n > MAX_REL_DAYS {
            return Err(());
        }
        let d = today.checked_add_signed(Duration::days(n)).ok_or(())?;
        return Ok((Some(d), Some(lit)));
    }
    // X周后 / X星期后。
    if let Some((n, lit)) = find_number_suffix(text, &["周后", "星期后", "个星期后"]) {
        if n < 0 || n > MAX_REL_DAYS / 7 {
            return Err(());
        }
        let d = today.checked_add_signed(Duration::days(n * 7)).ok_or(())?;
        return Ok((Some(d), Some(lit)));
    }

    // 下周X / 下星期X。
    if let Some((wd, lit)) = find_weekday(text, &["下个星期", "下星期", "下周"]) {
        let d = next_weekday_after(today, wd, 7);
        return Ok((Some(d), Some(lit)));
    }
    // 本周X / 这周X（从今天起最近的该星期几，含今天）。
    if let Some((wd, lit)) = find_weekday(text, &["这个星期", "这星期", "本周", "这周"])
    {
        return Ok((Some(next_weekday_after(today, wd, 0)), Some(lit)));
    }
    // 周X / 星期X / 礼拜X。
    if let Some((wd, lit)) = find_weekday(text, &["星期", "礼拜", "周"]) {
        return Ok((Some(next_weekday_after(today, wd, 0)), Some(lit)));
    }

    // X月X日 / X月X号（BUG-25：非法日期不再静默钳制，降级表单）。
    if let Some((d, lit)) = extract_month_day(text) {
        let y = today.year();
        let candidate = NaiveDate::from_ymd_opt(y, d.0, d.1).ok_or(())?;
        // 已过则视为明年。
        let candidate = if candidate < today {
            NaiveDate::from_ymd_opt(y + 1, d.0, d.1).ok_or(())?
        } else {
            candidate
        };
        return Ok((Some(candidate), Some(lit)));
    }

    // X号 / X日（本月）。
    if let Some((day, lit)) = find_number_suffix(text, &["号", "日"]) {
        if !(1..=31).contains(&day) {
            return Err(());
        }
        let y = today.year();
        let m = today.month();
        let mut d = NaiveDate::from_ymd_opt(y, m, day as u32).ok_or(())?;
        if d < today {
            // 下个月；该月无此日则视为非法。
            let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
            d = NaiveDate::from_ymd_opt(ny, nm, day as u32).ok_or(())?;
        }
        return Ok((Some(d), Some(lit)));
    }

    // 下个月 / 下月。
    for pat in ["下个月", "下月"] {
        if text.contains(pat) {
            let (y, m) = if today.month() == 12 {
                (today.year() + 1, 1)
            } else {
                (today.year(), today.month() + 1)
            };
            let day = today.day().min(28);
            return Ok((
                Some(NaiveDate::from_ymd_opt(y, m, day).ok_or(())?),
                Some(pat),
            ));
        }
    }

    Ok((None, None))
}

/// 在给定前缀列表中查找「星期几」，返回 (1..7, 匹配字面量)。
fn find_weekday<'a>(text: &'a str, prefixes: &[&str]) -> Option<(u32, &'a str)> {
    for p in prefixes {
        if let Some(pos) = text.find(p) {
            let rest = &text[pos + p.len()..];
            // 取一个字符判断「几/日/天」。
            let mut chars = rest.chars();
            let c = chars.next()?;
            let wd = match c {
                '一' => Some(1),
                '二' => Some(2),
                '三' => Some(3),
                '四' => Some(4),
                '五' => Some(5),
                '六' => Some(6),
                '日' | '天' => Some(7),
                _ => {
                    if c.is_ascii_digit() {
                        let n = (c as u8 - b'0') as u32;
                        if (1..=7).contains(&n) {
                            Some(n)
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
            };
            if let Some(wd) = wd {
                // 字面量长度：前缀 + 星期几字符。
                let lit_end = pos + p.len() + c.len_utf8();
                return Some((wd, &text[pos..lit_end]));
            }
        }
    }
    None
}

/// 下一个「星期几」（offset=0 表示从今天起最近的该日，含今天；offset=7 表示下周）。
fn next_weekday_after(today: NaiveDate, weekday: u32, offset: i64) -> NaiveDate {
    let cur = today.weekday().number_from_monday();
    let diff = (weekday as i64 - cur as i64).rem_euclid(7);
    if diff == 0 {
        // 今天就是目标星期几：offset=0 → 今天；offset=7 → 下周同日。
        today + Duration::days(offset)
    } else {
        today + Duration::days(diff + offset)
    }
}

/// X月X日 / X月X号。
fn extract_month_day(text: &str) -> Option<((u32, u32), &str)> {
    let bytes = text.as_bytes();
    // 找「月」。
    for (i, &b) in bytes.iter().enumerate() {
        if b == 0xE6 && bytes.get(i + 1) == Some(&0x9C) && bytes.get(i + 2) == Some(&0x88) {
            // '月' = E6 9C 88
            let before = &text[..i];
            if let Some((m, _)) = trailing_number(before) {
                let after = &text[i + 3..];
                for suffix in ["日", "号"] {
                    if let Some(j) = after.find(suffix) {
                        if let Some((d, _)) = leading_number(&after[..j]) {
                            if (1..=12).contains(&m) && (1..=31).contains(&d) {
                                let lit = &text
                                    [before.len() - _digit_len(before)..i + 3 + j + suffix.len()];
                                return Some(((m as u32, d as u32), lit));
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 时间识别
// ---------------------------------------------------------------------------

/// 返回 (墙钟时间, 匹配字面量)。
fn extract_time(text: &str) -> (Option<NaiveTime>, Option<&str>) {
    // 时段修饰：凌晨/早上/早晨/上午 → AM；下午/傍晚 → PM；晚上 → PM 且 12 点视为 0 点；
    // 中午/正午 → 12:00。
    let (period, period_lit, midnight_12): (i64, Option<&str>, bool) =
        if let Some(p) = first_of(text, &["凌晨"]) {
            (0, Some(p), true)
        } else if let Some(p) = first_of(text, &["早上", "早晨", "上午"]) {
            (0, Some(p), false)
        } else if let Some(p) = first_of(text, &["下午", "傍晚"]) {
            (12, Some(p), false)
        } else if let Some(p) = first_of(text, &["晚上"]) {
            (12, Some(p), true)
        } else if let Some(p) = first_of(text, &["中午", "正午"]) {
            (12, Some(p), false)
        } else {
            (0, None, false)
        };

    // 中午/正午 → 12:00（不依赖具体点数）。
    if period_lit.is_some()
        && period == 12
        && !midnight_12
        && (text.contains("中午") || text.contains("正午"))
        && !text.contains("点")
    {
        return (NaiveTime::from_hms_opt(12, 0, 0), period_lit);
    }

    // HH:MM 或 H:MM。
    if let (Some(h), Some(m), lit) = extract_clock(text) {
        return (build_time(h, m, period, midnight_12), lit);
    }

    // BUG-06：X点半 / 点30 必须在「X点Y分/X点」之前判断，否则会被 extract_hour_minute 吞掉半小时。
    if let Some((h, lit)) = find_number_suffix(text, &["点半", "点30"]) {
        let t = build_time(h, 30, period, midnight_12);
        return (t, Some(lit));
    }

    // X点Y分 / X点Y / X点。
    if let (Some(h), Some(m), lit) = extract_hour_minute(text) {
        let t = build_time(h, m, period, midnight_12);
        return (t, lit);
    }

    // X时 / X点钟（extract_hour_minute 未覆盖的「时/点钟」表达）。
    if let Some((h, lit)) = find_number_suffix(text, &["点钟", "时"]) {
        let t = build_time(h, 0, period, midnight_12);
        return (t, Some(lit));
    }

    (None, None)
}

/// `period=12` 为下午/晚上时段；`midnight_12=true` 时 12 点按 0 点处理（晚上/凌晨 12 点）。
fn build_time(hour: i64, minute: i64, period: i64, midnight_12: bool) -> Option<NaiveTime> {
    let mut h = hour;
    if period == 12 && !(midnight_12 && h == 12) {
        // 下午/晚上：<12 的钟点 +12；12 点保持 12（除非是晚上/凌晨 12 点）。
        if h < 12 {
            h += 12;
        }
    } else if midnight_12 && h == 12 {
        h = 0;
    }
    if !(0..24).contains(&h) || !(0..60).contains(&minute) {
        return None;
    }
    NaiveTime::from_hms_opt(h as u32, minute as u32, 0)
}

/// HH:MM → (时, 分, 字面量)。
fn extract_clock(text: &str) -> (Option<i64>, Option<i64>, Option<&str>) {
    let bytes = text.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b == b':' {
            let before = &text[..i];
            let Some((h, _)) = trailing_number(before) else {
                continue;
            };
            let after = &text[i + 1..];
            let Some((m, _)) = leading_number(after) else {
                continue;
            };
            if (0..24).contains(&h) && (0..60).contains(&m) {
                let start = i - _digit_len(before);
                let end = i + 1 + _digit_len(after);
                let lit = &text[start..end];
                return (Some(h), Some(m), Some(lit));
            }
        }
    }
    (None, None, None)
}

/// X点Y分 / X点Y。
fn extract_hour_minute(text: &str) -> (Option<i64>, Option<i64>, Option<&str>) {
    if let Some(pos) = text.find("点") {
        let before = &text[..pos];
        let Some((h, _)) = trailing_number(before) else {
            return (None, None, None);
        };
        let after = &text[pos + "点".len()..];
        // X点Y分。
        if let Some(j) = after.find("分") {
            if let Some((m, _)) = leading_number(&after[..j]) {
                if (0..60).contains(&m) {
                    let start = pos - _digit_len(before);
                    let end = pos + "点".len() + j + "分".len();
                    let lit = &text[start..end];
                    return (Some(h), Some(m), Some(lit));
                }
            }
        }
        // X点 后面紧跟数字（如 3点20）。
        if let Some((m, _)) = leading_number(after) {
            if (0..60).contains(&m) {
                let start = pos - _digit_len(before);
                let end = pos + "点".len() + _digit_len(after);
                let lit = &text[start..end];
                return (Some(h), Some(m), Some(lit));
            }
        }
        // 只有 X点。
        let start = pos - _digit_len(before);
        let end = pos + "点".len();
        return (Some(h), Some(0), Some(&text[start..end]));
    }
    (None, None, None)
}

// ---------------------------------------------------------------------------
// 中文数字与扫描辅助
// ---------------------------------------------------------------------------

/// 解析中文/阿拉伯数字（0~59）。
fn parse_cn_number(s: &str) -> Option<i64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(n) = t.parse::<i64>() {
        return Some(n);
    }
    let map = |c: char| -> Option<i64> {
        Some(match c {
            '零' | '〇' => 0,
            '一' => 1,
            '二' | '两' => 2,
            '三' => 3,
            '四' => 4,
            '五' => 5,
            '六' => 6,
            '七' => 7,
            '八' => 8,
            '九' => 9,
            '十' => 10,
            _ => return None,
        })
    };
    let chars: Vec<char> = t.chars().collect();
    if chars.len() == 1 {
        return map(chars[0]);
    }
    // 十位带十：十三 / 二十 / 二十三 / 三十。
    let mut total = 0i64;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '十' {
            if total == 0 {
                total = 10;
            } else {
                total = total * 10;
            }
        } else {
            let v = map(c)?;
            if i + 1 < chars.len() && chars[i + 1] == '十' {
                total += v * 10;
                i += 1; // 跳过十，由循环继续处理十的语义
            } else {
                total += v;
            }
        }
        i += 1;
    }
    Some(total)
}

/// 从字符串末尾抓取一个数字（返回 (数值, 数字字符长度)）。
fn trailing_number(s: &str) -> Option<(i64, usize)> {
    let chars: Vec<char> = s.chars().collect();
    let end = chars.len();
    // 从尾部收集数字字符（阿拉伯或中文数字）。
    let mut start = end;
    while start > 0 {
        let c = chars[start - 1];
        if c.is_ascii_digit() || "零〇一二两三四五六七八九十".contains(c) {
            start -= 1;
        } else {
            break;
        }
    }
    if start == end {
        return None;
    }
    let seg: String = chars[start..end].iter().collect();
    let n = parse_cn_number(&seg)?;
    Some((n, seg.chars().map(|c| c.len_utf8()).sum()))
}

/// 从字符串开头抓取一个数字（返回 (数值, 数字字符长度)）。
fn leading_number(s: &str) -> Option<(i64, usize)> {
    let chars: Vec<char> = s.chars().collect();
    let mut end = 0;
    while end < chars.len() {
        let c = chars[end];
        if c.is_ascii_digit() || "零〇一二两三四五六七八九十".contains(c) {
            end += 1;
        } else {
            break;
        }
    }
    if end == 0 {
        return None;
    }
    let seg: String = chars[..end].iter().collect();
    let n = parse_cn_number(&seg)?;
    Some((n, seg.chars().map(|c| c.len_utf8()).sum()))
}

/// 数字字符长度（字节）。
fn _digit_len(s: &str) -> usize {
    trailing_number(s)
        .map(|(_, l)| l)
        .or_else(|| leading_number(s).map(|(_, l)| l))
        .unwrap_or(0)
}

/// 查找「数字 + 后缀」组合，返回 (数值, 完整字面量)。
fn find_number_suffix<'a>(text: &'a str, suffixes: &[&str]) -> Option<(i64, &'a str)> {
    for suffix in suffixes {
        if let Some(pos) = text.find(suffix) {
            let before = &text[..pos];
            if let Some((n, len)) = trailing_number(before) {
                let start = pos - len;
                let end = pos + suffix.len();
                return Some((n, &text[start..end]));
            }
        }
    }
    None
}

/// 返回最先出现的字面量。
fn first_of<'a>(text: &'a str, pats: &[&'a str]) -> Option<&'a str> {
    pats.iter()
        .filter_map(|p| text.find(*p).map(|i| (i, *p)))
        .min_by_key(|(i, _)| *i)
        .map(|(_, p)| p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn now() -> DateTime<Utc> {
        // 固定参考时刻：2025-01-15（周三）12:00 上海。
        chrono_tz::Asia::Shanghai
            .with_ymd_and_hms(2025, 1, 15, 12, 0, 0)
            .single()
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn test_tomorrow_afternoon() {
        let r = parse_natural_language("明天下午3点开会", "Asia/Shanghai", &now());
        assert!(r.matched);
        assert!(!r.all_day);
        assert_eq!(r.title, "开会");
        // 明天 = 2025-01-16，15:00 上海 = 07:00 UTC。
        assert!(r.start.starts_with("2025-01-16T07:00:00"));
    }

    #[test]
    fn test_today_clock() {
        let r = parse_natural_language("今天 9:00 和周总碰面", "Asia/Shanghai", &now());
        assert!(r.matched);
        assert_eq!(r.title, "和周总碰面");
        assert!(r.start.starts_with("2025-01-15T01:00:00"));
    }

    #[test]
    fn test_next_week() {
        let r = parse_natural_language("下周三晚上8点健身", "Asia/Shanghai", &now());
        assert!(r.matched);
        // 2025-01-15 是周三；下周三 = 2025-01-22。
        assert_eq!(r.date.as_deref(), Some("2025-01-22"));
    }

    #[test]
    fn test_month_day() {
        let r = parse_natural_language("3月5日交房租", "Asia/Shanghai", &now());
        assert!(r.matched);
        assert_eq!(r.date.as_deref(), Some("2025-03-05"));
        assert!(r.all_day);
    }

    #[test]
    fn test_no_match() {
        let r = parse_natural_language("随便写点东西", "Asia/Shanghai", &now());
        assert!(!r.matched);
    }

    #[test]
    fn test_half_hour_is_kept() {
        let r = parse_natural_language("明天3点半开会", "Asia/Shanghai", &now());
        assert_eq!(r.time.as_deref(), Some("03:30"));
        let r2 = parse_natural_language("明天下午3点半开会", "Asia/Shanghai", &now());
        assert_eq!(r2.time.as_deref(), Some("15:30"));
    }

    #[test]
    fn test_midnight_twelve_hour_semantics() {
        let r = parse_natural_language("晚上12点开会", "Asia/Shanghai", &now());
        assert_eq!(r.time.as_deref(), Some("00:00"));
        let r2 = parse_natural_language("凌晨12点开会", "Asia/Shanghai", &now());
        assert_eq!(r2.time.as_deref(), Some("00:00"));
        let r3 = parse_natural_language("下午12点半开会", "Asia/Shanghai", &now());
        assert_eq!(r3.time.as_deref(), Some("12:30"));
    }

    #[test]
    fn test_huge_relative_days_falls_back() {
        let r = parse_natural_language("9999999999天后开会", "Asia/Shanghai", &now());
        assert!(!r.matched);
        let r2 = parse_natural_language("999999999999999天后开会", "Asia/Shanghai", &now());
        assert!(!r2.matched);
    }

    #[test]
    fn test_invalid_calendar_date_falls_back() {
        let r = parse_natural_language("2月30日交付", "Asia/Shanghai", &now());
        assert!(!r.matched);
        let r2 = parse_natural_language("2月31日交付", "Asia/Shanghai", &now());
        assert!(!r2.matched);
    }
}
