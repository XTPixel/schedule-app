//! 完整搜索（Phase 1）：标题关键词 + 标签 + 日期范围组合筛选（§4.1）。
//!
//! 业务规则：三类对象均支持标题（不区分大小写）与标签（任一匹配）过滤；
//! 事件按本地日期/重复实例发生日期、浮动事项按截止日期做日期范围过滤。

use chrono::{Duration, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::models::{AppData, Event, LongTask, Routine, Task};
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
    /// V1.2：长期任务（标题 / 描述 / 标签 / 会话收获命中，含完整 sessions）。
    pub long_tasks: Vec<LongTask>,
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

    // V1.2：长期任务。文本命中范围 = 标题 / 描述 / 标签 / 有效会话收获；
    // 日期筛选要求计划窗口与筛选区间存在交集。
    let long_tasks = data
        .long_tasks
        .iter()
        .filter(|t| t.deleted_at.is_none())
        .filter(|t| long_task_matches(t, &text) && tags_match(&t.tags, &tags))
        .filter(|t| long_task_in_range(t, from, to))
        .cloned()
        .collect();

    SearchResult { events, tasks, routines, long_tasks }
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

fn long_task_matches(t: &LongTask, text: &str) -> bool {
    if text.is_empty() || title_matches(&t.title, text) {
        return true;
    }
    if t.description.as_deref().map(|d| d.to_lowercase().contains(text)).unwrap_or(false) {
        return true;
    }
    if t.tags.iter().any(|x| x.to_lowercase().contains(text)) {
        return true;
    }
    t.sessions
        .iter()
        .filter(|s| s.deleted_at.is_none())
        .any(|s| s.note.as_deref().map(|n| n.to_lowercase().contains(text)).unwrap_or(false))
}

fn long_task_in_range(t: &LongTask, from: Option<NaiveDate>, to: Option<NaiveDate>) -> bool {
    if from.is_none() && to.is_none() {
        return true;
    }
    let (Some(start), Some(due)) = (
        timeutil::parse_date(&t.start_date).ok(),
        timeutil::parse_date(&t.due_date).ok(),
    ) else {
        return false;
    };
    // 计划窗口 [startDate, dueDate] 与 [from, to] 存在交集。
    if let Some(f) = from {
        if due < f {
            return false;
        }
    }
    if let Some(t) = to {
        if start > t {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        ArchiveFile, Config, LongTaskSession, LongTaskStatus, Priority,
    };

    fn lt(
        id: &str,
        title: &str,
        start_date: &str,
        due_date: &str,
        tags: Vec<&str>,
        note: Option<&str>,
        deleted: bool,
    ) -> LongTask {
        LongTask {
            id: id.to_string(),
            title: title.to_string(),
            description: None,
            start_date: start_date.to_string(),
            due_date: due_date.to_string(),
            status: LongTaskStatus::Active,
            ended_at: None,
            tags: tags.into_iter().map(|s| s.to_string()).collect(),
            priority: Priority::Normal,
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: deleted.then(|| "2025-02-01T00:00:00Z".to_string()),
            sessions: note
                .map(|n| {
                    vec![LongTaskSession {
                        id: "s1".to_string(),
                        started_at: "2025-02-15T09:00:00Z".to_string(),
                        ended_at: "2025-02-15T10:00:00Z".to_string(),
                        duration_ms: 3_600_000,
                        note: Some(n.to_string()),
                        created_at: String::new(),
                        updated_at: String::new(),
                        deleted_at: None,
                    }]
                })
                .unwrap_or_default(),
        }
    }

    fn data(long_tasks: Vec<LongTask>) -> AppData {
        AppData {
            events: vec![],
            routines: vec![],
            tasks: vec![],
            long_tasks,
            config: Config::default(),
            archive: ArchiveFile {
                version: crate::models::CURRENT_VERSION,
                month: "2025-02".to_string(),
                days: Default::default(),
            },
        }
    }

    #[test]
    fn test_search_long_tasks_by_title_tags_note_and_range() {
        let d = data(vec![
            lt("lt1", "雅思备考", "2025-01-01", "2025-06-30", vec!["学习"], Some("听力精听两篇"), false),
            lt("lt2", "健身计划", "2025-03-01", "2025-12-31", vec![], None, false),
        ]);

        let hit_by_title = search(&d, &SearchQuery { text: "雅思".to_string(), ..Default::default() });
        assert_eq!(hit_by_title.long_tasks.len(), 1);

        let hit_by_tag = search(&d, &SearchQuery { text: String::new(), tags: vec!["学习".to_string()], ..Default::default() });
        assert_eq!(hit_by_tag.long_tasks.len(), 1);

        let hit_by_note = search(&d, &SearchQuery { text: "精听".to_string(), ..Default::default() });
        assert_eq!(hit_by_note.long_tasks.len(), 1);

        let hit_by_range = search(
            &d,
            &SearchQuery {
                text: String::new(),
                date_from: Some("2025-01-01".to_string()),
                date_to: Some("2025-01-31".to_string()),
                ..Default::default()
            },
        );
        assert_eq!(hit_by_range.long_tasks.len(), 1);
        assert_eq!(hit_by_range.long_tasks[0].id, "lt1");
    }

    #[test]
    fn test_search_excludes_deleted_long_tasks() {
        let d = data(vec![lt("lt1", "已删除任务", "2025-01-01", "2025-12-31", vec![], None, true)]);
        let r = search(&d, &SearchQuery { text: "任务".to_string(), ..Default::default() });
        assert!(r.long_tasks.is_empty());
    }
}
