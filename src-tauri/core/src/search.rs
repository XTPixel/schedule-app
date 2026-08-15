//! 完整搜索（Phase 1）：标题关键词 + 标签 + 日期范围组合筛选（§4.1）。
//!
//! 业务规则：三类对象均支持标题（不区分大小写）与标签（任一匹配）过滤；
//! 事件按本地日期/重复实例发生日期、浮动事项按截止日期做日期范围过滤。

use chrono::{Duration, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::models::{AppData, Event, Routine, Task};
use crate::recurrence;
use crate::timeutil;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub text: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub events: Vec<Event>,
    pub tasks: Vec<Task>,
    pub routines: Vec<Routine>,
}

pub fn search(data: &AppData, q: &SearchQuery) -> SearchResult {
    let tz = &data.config.timezone;
    let text = q.text.trim().to_lowercase();
    let tags: Vec<String> = q.tags.iter().map(|t| t.trim().to_lowercase()).filter(|t| !t.is_empty()).collect();
    let from = q.date_from.as_deref().and_then(|s| timeutil::parse_date(s).ok());
    let to = q.date_to.as_deref().and_then(|s| timeutil::parse_date(s).ok());

    let events = data
        .events
        .iter()
        .filter(|e| e.deleted_at.is_none())
        .filter(|e| title_matches(&e.title, &text) && tags_match(&e.tags, &tags))
        .filter(|e| event_in_range(e, from, to, tz))
        .cloned()
        .collect();

    let tasks = data
        .tasks
        .iter()
        .filter(|t| t.deleted_at.is_none())
        .filter(|t| title_matches(&t.title, &text) && tags_match(&t.tags, &tags))
        .filter(|t| task_in_range(t, from, to, tz))
        .cloned()
        .collect();

    let routines = data
        .routines
        .iter()
        .filter(|r| r.deleted_at.is_none())
        .filter(|r| title_matches(&r.title, &text) && tags_match(&r.tags, &tags))
        .cloned()
        .collect();

    SearchResult { events, tasks, routines }
}

fn title_matches(title: &str, text: &str) -> bool {
    text.is_empty() || title.to_lowercase().contains(text)
}

fn tags_match(item_tags: &[String], query_tags: &[String]) -> bool {
    if query_tags.is_empty() {
        return true;
    }
    let item: Vec<String> = item_tags.iter().map(|t| t.trim().to_lowercase()).collect();
    query_tags.iter().any(|q| item.iter().any(|t| t == q))
}

fn event_in_range(e: &Event, from: Option<NaiveDate>, to: Option<NaiveDate>, tz: &str) -> bool {
    match (from, to) {
        (None, None) => true,
        _ => {
            let today = timeutil::today_string(tz);
            let today_d = timeutil::parse_date(&today).unwrap_or_else(|_| NaiveDate::from_ymd_opt(2000, 1, 1).unwrap());
            let f = from.unwrap_or(today_d - Duration::days(3650));
            let t = to.unwrap_or(today_d + Duration::days(3650));
            if e.repeat.is_some() {
                !recurrence::expand_events(std::slice::from_ref(e), f, t, tz).is_empty()
            } else {
                match timeutil::event_local_date(e, tz) {
                    Some(d) => from.map_or(true, |x| d >= x) && to.map_or(true, |x| d <= x),
                    None => false,
                }
            }
        }
    }
}

fn task_in_range(t: &Task, from: Option<NaiveDate>, to: Option<NaiveDate>, tz: &str) -> bool {
    let Some(dl) = &t.deadline else { return true };
    let Some(d) = timeutil::parse_utc(dl).ok().map(|u| timeutil::to_local(&u, tz).date) else {
        return true;
    };
    from.map_or(true, |x| d >= x) && to.map_or(true, |x| d <= x)
}
