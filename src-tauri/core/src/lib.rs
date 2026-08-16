//! `schedule-core`：此刻 MOMENT 核心业务逻辑。
//!
//! 模块划分：
//! - `models`  数据模型（第 5 章 JSON Schema）
//! - `storage` JSON 存储层（原子写入/备份/版本迁移/mtime/软删除）
//! - `candidates` 候选推荐引擎（第 8 章）
//! - `recurrence` 重复事件实例展开（Phase 1）
//! - `nlp` 自然语言时间解析（Phase 1）
//! - `search` 完整搜索（Phase 1）
//! - `stats` 统计与复盘（Phase 2）
//! - `template` 事项模板系统（Phase 3）
//! - `hooks` 插件/脚本钩子（Phase 3，导出钩子）
//! - `timeutil` 时间与时区工具（§5.8）
//! - `id` 短 ID 生成
//! - `error` 统一错误类型

pub mod candidates;
pub mod error;
pub mod hooks;
pub mod id;
pub mod models;
pub mod nlp;
pub mod recurrence;
pub mod search;
pub mod stats;
pub mod storage;
pub mod template;
pub mod timeutil;

pub use candidates::{compute_candidates, Candidate, CandidatesResult, ReminderNotice, Timeline};
pub use hooks::{dispatch as dispatch_hook, list_hooks, HookInfo, HookRunResult};
pub use template::{
    apply_template, new_template, new_template_item, preview_template, TemplateApplyResult,
    TemplatePreview,
};
pub use error::{AppError, AppResult};
pub use models::*;
pub use nlp::{parse_natural_language, NlpEvent};
pub use recurrence::{expand_events, CalendarData, CalendarRoutineWindow, Occurrence};
pub use search::{search, SearchQuery, SearchResult};
pub use stats::{
    compute_review, compute_stats, DayCount, LongTaskStatItem, ReviewDay, ReviewResult,
    RoutineCompletion, StatsResult, StatsTotals, TagDuration,
};
pub use storage::{MtimeStatus, Storage};
