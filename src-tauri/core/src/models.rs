//! 数据模型，与策划文档第 5 章 JSON Schema 一一对应。
//!
//! 时间约定（§5.8）：
//! - 绝对时刻（start/end/deadline/doneAt/createdAt/updatedAt）落盘为 UTC `Z`（ISO 8601）。
//! - 墙钟时刻（timeWindows.start/end、归档 time）为 `HH:mm`。
//! - 纯日期（全天事件 start/end、归档「天」键）为 `YYYY-MM-DD`。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 当前支持的数据版本（§5.7 版本迁移骨架）。数据版本与应用版本相互独立：
/// v1 = MVP(0.1.0) / Phase1(0.2.0) / Phase2(0.3.0)；
/// v2 = Phase3(0.4.0)；v3 = V3.0(0.5.0)：新增提醒分级配置；
/// v4 = V3.1(1.0.0-rc.1) 与 1.0.0 正式版：标签颜色。
pub const CURRENT_VERSION: u32 = 4;

/// 默认逾期日常宽限小时数（§8.3，MVP 硬编码）。
pub const DEFAULT_GRACE_HOURS: i64 = 4;

// ---------------------------------------------------------------------------
// 基础枚举
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    High,
    #[default]
    Normal,
    Low,
}

/// 事件/浮动事项状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ItemStatus {
    #[default]
    Active,
    Completed,
    Cancelled,
}

/// 归档来源类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveSource {
    Event,
    Routine,
    Task,
    #[default]
    Manual,
}

// ---------------------------------------------------------------------------
// 事件 Event（§5.2）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub offset_minutes: i64,
}

/// 重复规则（Phase 1 预留，MVP 仅落盘不消费）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repeat {
    /// daily | weekly | monthly | yearly | custom
    #[serde(rename = "type")]
    pub repeat_type: String,
    #[serde(default = "default_interval")]
    pub interval: i64,
    #[serde(default)]
    pub days_of_week: Vec<u32>,
    #[serde(default)]
    pub end: Option<String>,
}

fn default_interval() -> i64 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    /// 绝对时刻（UTC Z）或全天事件的纯日期 `YYYY-MM-DD`。
    pub start: String,
    #[serde(default)]
    pub end: Option<String>,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub reminders: Vec<Reminder>,
    #[serde(default)]
    pub repeat: Option<Repeat>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default)]
    pub status: ItemStatus,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsFile {
    pub version: u32,
    #[serde(default)]
    pub events: Vec<Event>,
}

// ---------------------------------------------------------------------------
// 日常 Routine（§5.3）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeWindow {
    /// 1=周一 ... 7=周日（ISO）。
    #[serde(default)]
    pub days_of_week: Vec<u32>,
    /// 墙钟时间 HH:mm。
    pub start: String,
    /// 墙钟时间 HH:mm。
    pub end: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub time_windows: Vec<TimeWindow>,
    /// V1.5 预留（可选），MVP 仅落盘。
    #[serde(default)]
    pub duration_minutes: Option<i64>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutinesFile {
    pub version: u32,
    #[serde(default)]
    pub routines: Vec<Routine>,
}

// ---------------------------------------------------------------------------
// 浮动事项 Task（§5.4）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub priority: Priority,
    #[serde(default)]
    pub deadline: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub status: ItemStatus,
    #[serde(default)]
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksFile {
    pub version: u32,
    #[serde(default)]
    pub tasks: Vec<Task>,
}

// ---------------------------------------------------------------------------
// 归档 Archive（§5.5）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub id: String,
    /// 显示用时间 HH:mm（与 doneAt 可不同）。
    pub time: String,
    pub title: String,
    #[serde(default)]
    pub source: ArchiveSource,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    /// V1.5 预留（可选）。
    #[serde(default)]
    pub duration_minutes: Option<i64>,
    /// 完成时的系统时间戳（UTC Z），用于时序排序。
    pub done_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDay {
    #[serde(default)]
    pub entries: Vec<ArchiveEntry>,
    #[serde(default)]
    pub summary: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveFile {
    pub version: u32,
    /// YYYY-MM
    pub month: String,
    #[serde(default)]
    pub days: BTreeMap<String, ArchiveDay>,
}

// ---------------------------------------------------------------------------
// 配置 Config（§5.6）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoNotDisturbConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_dnd_start")]
    pub start: String,
    #[serde(default = "default_dnd_end")]
    pub end: String,
}

fn default_dnd_start() -> String {
    "22:00".to_string()
}
fn default_dnd_end() -> String {
    "08:00".to_string()
}

/// 提醒分级策略（V3.0 F5）：`system`=系统级通知，`app`=仅应用内，`off`=不提醒。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum NotifyLevel {
    System,
    #[default]
    App,
    Off,
}

/// 按优先级分级的提醒策略（V3.0 F5，默认「高=系统级，中/低=仅应用内」）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriorityPolicy {
    #[serde(default = "default_high_level")]
    pub high: NotifyLevel,
    #[serde(default = "default_normal_level")]
    pub normal: NotifyLevel,
    #[serde(default = "default_low_level")]
    pub low: NotifyLevel,
}

fn default_high_level() -> NotifyLevel {
    NotifyLevel::System
}
fn default_normal_level() -> NotifyLevel {
    NotifyLevel::App
}
fn default_low_level() -> NotifyLevel {
    NotifyLevel::App
}

impl Default for PriorityPolicy {
    fn default() -> Self {
        PriorityPolicy {
            high: default_high_level(),
            normal: default_normal_level(),
            low: default_low_level(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationsConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub sound: bool,
    #[serde(default)]
    pub do_not_disturb: DoNotDisturbConfig,
    #[serde(default)]
    pub priority_policy: PriorityPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceConfig {
    #[serde(default = "default_theme")]
    pub theme: String,
}

fn default_theme() -> String {
    // V3.1：支持浅色/深色/跟随系统（§4.8）。
    "light".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BehaviorConfig {
    #[serde(default = "default_true")]
    pub minimize_to_tray: bool,
    #[serde(default)]
    pub launch_at_startup: bool,
    #[serde(default = "default_hotkey")]
    pub global_hotkey: String,
}

fn default_hotkey() -> String {
    "Ctrl+Shift+A".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateConfig {
    #[serde(default = "default_grace")]
    pub missed_routine_grace_hours: i64,
}

fn default_grace() -> i64 {
    DEFAULT_GRACE_HOURS
}

impl Default for DoNotDisturbConfig {
    fn default() -> Self {
        DoNotDisturbConfig {
            enabled: false,
            start: default_dnd_start(),
            end: default_dnd_end(),
        }
    }
}

impl Default for NotificationsConfig {
    fn default() -> Self {
        NotificationsConfig {
            enabled: true,
            sound: false,
            do_not_disturb: DoNotDisturbConfig::default(),
            priority_policy: PriorityPolicy::default(),
        }
    }
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        AppearanceConfig { theme: default_theme() }
    }
}

impl Default for BehaviorConfig {
    fn default() -> Self {
        BehaviorConfig {
            minimize_to_tray: true,
            launch_at_startup: false,
            global_hotkey: default_hotkey(),
        }
    }
}

impl Default for CandidateConfig {
    fn default() -> Self {
        CandidateConfig { missed_routine_grace_hours: default_grace() }
    }
}

// ---------------------------------------------------------------------------
// Phase 3（V2.0）配置：脚本钩子（Git 备份与移动端只读已移除）
// ---------------------------------------------------------------------------

/// 脚本钩子配置（Phase 3，默认关闭）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HooksConfig {
    /// 是否允许加载并执行数据目录 `hooks/*.js`（安全开关，默认关闭）。
    #[serde(default)]
    pub enabled: bool,
}

impl Default for HooksConfig {
    fn default() -> Self {
        HooksConfig { enabled: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default = "default_timezone")]
    pub timezone: String,
    #[serde(default)]
    pub notifications: NotificationsConfig,
    #[serde(default)]
    pub appearance: AppearanceConfig,
    #[serde(default)]
    pub behavior: BehaviorConfig,
    #[serde(default)]
    pub candidate: CandidateConfig,
    #[serde(default)]
    pub hooks: HooksConfig,
    /// V3.1：标签名 → 颜色 token（如 "red"）。缺省为空，展示层回退默认灰。
    #[serde(default)]
    pub tag_colors: BTreeMap<String, String>,
    #[serde(default = "default_data_dir")]
    pub data_dir: String,
}

fn default_version() -> u32 {
    CURRENT_VERSION
}
fn default_timezone() -> String {
    "Asia/Shanghai".to_string()
}
fn default_data_dir() -> String {
    "auto".to_string()
}

impl Default for Config {
    fn default() -> Self {
        Config {
            version: CURRENT_VERSION,
            timezone: default_timezone(),
            notifications: NotificationsConfig {
                enabled: true,
                sound: false,
                do_not_disturb: DoNotDisturbConfig {
                    enabled: true,
                    start: default_dnd_start(),
                    end: default_dnd_end(),
                },
                priority_policy: PriorityPolicy::default(),
            },
            appearance: AppearanceConfig { theme: default_theme() },
            behavior: BehaviorConfig {
                minimize_to_tray: true,
                launch_at_startup: false,
                global_hotkey: default_hotkey(),
            },
            candidate: CandidateConfig { missed_routine_grace_hours: default_grace() },
            hooks: HooksConfig::default(),
            tag_colors: BTreeMap::new(),
            data_dir: default_data_dir(),
        }
    }
}

// ---------------------------------------------------------------------------
// 事项模板 Template（§9 Phase 3：工作日 / 周末 / 自定义）
// ---------------------------------------------------------------------------

/// 模板类型：工作日 / 周末 / 自定义。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TemplateKind {
    Workday,
    Weekend,
    #[default]
    Custom,
}

/// 模板条目生成的对象类型：事件 / 日常。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TemplateItemKind {
    #[default]
    Event,
    Routine,
}

/// 模板中的单条生成项（生成源）。生成后与实例解绑定，不含任何模板引用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateItem {
    #[serde(default)]
    pub kind: TemplateItemKind,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub priority: Priority,
    /// 事件：全天事件为 true。
    #[serde(default)]
    pub all_day: bool,
    /// 事件：开始墙钟时间 HH:mm（默认 09:00）。
    #[serde(default)]
    pub start_time: Option<String>,
    /// 事件：结束墙钟时间 HH:mm（优先级高于 durationMinutes）。
    #[serde(default)]
    pub end_time: Option<String>,
    /// 事件：时长（分钟），用于在无 endTime 时推算结束；日常：写入 durationMinutes。
    #[serde(default)]
    pub duration_minutes: Option<i64>,
    /// 日常：时间窗口星期（1=周一..7=周日；空 = 生成目标日期所在星期）。
    #[serde(default)]
    pub days_of_week: Vec<u32>,
    /// 日常：窗口开始墙钟时间 HH:mm（默认 08:00）。
    #[serde(default)]
    pub window_start: Option<String>,
    /// 日常：窗口结束墙钟时间 HH:mm（默认 09:00）。
    #[serde(default)]
    pub window_end: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub kind: TemplateKind,
    #[serde(default)]
    pub items: Vec<TemplateItem>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplatesFile {
    pub version: u32,
    #[serde(default)]
    pub templates: Vec<Template>,
}

// ---------------------------------------------------------------------------
// 内存聚合视图
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppData {
    pub events: Vec<Event>,
    pub routines: Vec<Routine>,
    pub tasks: Vec<Task>,
    pub config: Config,
    /// 当前月份的归档文件。
    pub archive: ArchiveFile,
}
