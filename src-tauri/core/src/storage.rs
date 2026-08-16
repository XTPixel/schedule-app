//! JSON 存储层（§5.1/§5.7）：
//! - 原子写入（临时文件 + rename）
//! - `.bak` 备份机制
//! - 数据版本校验 + 迁移骨架
//! - mtime 外部修改检测
//! - 软删除（deletedAt）

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::id::new_id;
use crate::models::*;
use crate::timeutil;

/// 写入前 mtime 检测结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MtimeStatus {
    Ok,
    /// 文件在最近一次读取后被外部修改。
    ExternalChange,
}

pub struct Storage {
    dir: PathBuf,
    /// 每个文件最近一次读取/写入时记录的磁盘 mtime。
    mtimes: HashMap<String, Option<SystemTime>>,
    /// V3.1：检测到外部修改后，前端选择「覆盖」时置 true；下一次成功写入后自动复位。
    force_overwrite: bool,
}

impl Storage {
    pub fn new(dir: PathBuf) -> Self {
        Storage { dir, mtimes: HashMap::new(), force_overwrite: false }
    }

    pub fn data_dir(&self) -> &Path {
        &self.dir
    }

    /// V3.1：外部修改冲突的用户选择（`reload` 由读取自动重建 mtime 基线，
    /// `overwrite` 允许下一次写入覆盖外部改动）。
    pub fn set_force_overwrite(&mut self, force: bool) {
        self.force_overwrite = force;
    }

    /// 确保数据目录、归档子目录与钩子目录存在。
    pub fn ensure(&self) -> AppResult<()> {
        fs::create_dir_all(&self.dir)?;
        fs::create_dir_all(self.dir.join("archive"))?;
        fs::create_dir_all(self.dir.join("hooks"))?;
        Ok(())
    }

    fn path(&self, file: &str) -> PathBuf {
        self.dir.join(file)
    }

    fn key(file: &str) -> String {
        file.to_string()
    }

    // -----------------------------------------------------------------------
    // 读取
    // -----------------------------------------------------------------------

    /// 读取并校验单个 JSON 文件（版本校验 + 迁移骨架 + 损坏备份）。
    fn read_json<T: DeserializeOwned>(&mut self, file: &str) -> AppResult<Option<T>> {
        let path = self.path(file);
        if !path.exists() {
            self.mtimes.insert(Self::key(file), None);
            return Ok(None);
        }
        let mtime = fs::metadata(&path).and_then(|m| m.modified()).ok();
        let raw = fs::read_to_string(&path)?;
        let value: Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                // 加载失败：保留 .bak 备份，不静默覆盖（§5.7）。
                let backup = self.backup_corrupt(file);
                return Err(AppError::Corrupted {
                    file: file.to_string(),
                    backup: backup.unwrap_or_else(|| "(备份失败)".to_string()),
                    detail: e.to_string(),
                });
            }
        };
        let migrated = self.migrate_if_needed(file, value)?;
        let parsed: T =
            serde_json::from_value(migrated).map_err(|e| AppError::Json(e.to_string()))?;
        self.mtimes.insert(Self::key(file), mtime);
        Ok(Some(parsed))
    }

    /// 版本校验 + 迁移骨架（§5.7）。
    fn migrate_if_needed(&self, file: &str, mut value: Value) -> AppResult<Value> {
        let version = value
            .get("version")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        if version > CURRENT_VERSION {
            return Err(AppError::NewerVersion { file: file.to_string(), version });
        }
        let mut v = version;
        while v < CURRENT_VERSION {
            value = migrate_step(file, v, value);
            v += 1;
        }
        Ok(value)
    }

    fn backup_corrupt(&self, file: &str) -> Option<String> {
        let src = self.path(file);
        let ts = chrono::Utc::now().format("%Y%m%d%H%M%S");
        let dst = self.path(&format!("{file}.corrupt-{ts}.bak"));
        fs::copy(&src, &dst).ok().map(|_| dst.display().to_string())
    }

    // -----------------------------------------------------------------------
    // 写入
    // -----------------------------------------------------------------------

    /// 原子写入：临时文件 + rename；写前复制 .bak 备份；mtime 外部修改检测。
    fn write_json_atomic<T: Serialize>(&mut self, file: &str, value: &T) -> AppResult<MtimeStatus> {
        self.ensure()?;
        let path = self.path(file);
        let key = Self::key(file);

        // mtime 外部修改检测（§5.7 防脑裂）。
        let disk_mtime = if path.exists() {
            fs::metadata(&path).and_then(|m| m.modified()).ok()
        } else {
            None
        };
        let known = self.mtimes.get(&key).copied().flatten();
        let status = match (disk_mtime, known) {
            (Some(d), Some(k)) if d != k => MtimeStatus::ExternalChange,
            _ => MtimeStatus::Ok,
        };

        // V3.1：检测到外部修改且未显式选择「覆盖」时，写入前拦截并返回结构化错误，
        // 避免静默覆盖外部改动（用户可在前端选择 reload / overwrite）。
        if status == MtimeStatus::ExternalChange && !self.force_overwrite {
            return Err(AppError::ExternalChange { file: file.to_string() });
        }

        // 覆盖前备份上一份有效内容到 .bak（best-effort）。
        if path.exists() {
            let bak = self.path(&format!("{file}.bak"));
            let _ = fs::copy(&path, &bak);
        }

        let tmp = self.path(&format!("{file}.tmp"));
        let text = serde_json::to_string_pretty(value)?;
        fs::write(&tmp, text)?;
        // 原子重命名（Windows 同卷 rename 为原子操作）。
        fs::rename(&tmp, &path)?;

        self.mtimes.insert(key, fs::metadata(&path).and_then(|m| m.modified()).ok());
        // 覆盖完成后复位，后续外部修改再次触发拦截。
        self.force_overwrite = false;
        Ok(status)
    }

    // -----------------------------------------------------------------------
    // 各文件读写
    // -----------------------------------------------------------------------

    pub fn read_events(&mut self) -> AppResult<Vec<Event>> {
        Ok(self.read_json::<EventsFile>("events.json")?.map(|f| f.events).unwrap_or_default())
    }

    pub fn read_routines(&mut self) -> AppResult<Vec<Routine>> {
        Ok(self
            .read_json::<RoutinesFile>("routines.json")?
            .map(|f| f.routines)
            .unwrap_or_default())
    }

    pub fn read_tasks(&mut self) -> AppResult<Vec<Task>> {
        Ok(self.read_json::<TasksFile>("tasks.json")?.map(|f| f.tasks).unwrap_or_default())
    }

    pub fn read_long_tasks(&mut self) -> AppResult<Vec<LongTask>> {
        Ok(self
            .read_json::<LongTasksFile>("long_tasks.json")?
            .map(|f| f.long_tasks)
            .unwrap_or_default())
    }

    pub fn read_config(&mut self) -> AppResult<Config> {
        Ok(self.read_json::<Config>("config.json")?.unwrap_or_default())
    }

    pub fn save_events(&mut self, events: &[Event]) -> AppResult<MtimeStatus> {
        self.write_json_atomic(
            "events.json",
            &EventsFile { version: CURRENT_VERSION, events: events.to_vec() },
        )
    }

    pub fn save_routines(&mut self, routines: &[Routine]) -> AppResult<MtimeStatus> {
        self.write_json_atomic(
            "routines.json",
            &RoutinesFile { version: CURRENT_VERSION, routines: routines.to_vec() },
        )
    }

    pub fn save_tasks(&mut self, tasks: &[Task]) -> AppResult<MtimeStatus> {
        self.write_json_atomic(
            "tasks.json",
            &TasksFile { version: CURRENT_VERSION, tasks: tasks.to_vec() },
        )
    }

    pub fn save_long_tasks(&mut self, tasks: &[LongTask]) -> AppResult<MtimeStatus> {
        self.write_json_atomic(
            "long_tasks.json",
            &LongTasksFile { version: CURRENT_VERSION, long_tasks: tasks.to_vec() },
        )
    }

    pub fn save_config(&mut self, config: &Config) -> AppResult<MtimeStatus> {
        self.write_json_atomic("config.json", config)
    }

    pub fn read_templates(&mut self) -> AppResult<Vec<Template>> {
        Ok(self
            .read_json::<TemplatesFile>("templates.json")?
            .map(|f| f.templates)
            .unwrap_or_default())
    }

    pub fn save_templates(&mut self, templates: &[Template]) -> AppResult<MtimeStatus> {
        self.write_json_atomic(
            "templates.json",
            &TemplatesFile { version: CURRENT_VERSION, templates: templates.to_vec() },
        )
    }

    // -----------------------------------------------------------------------
    // 归档
    // -----------------------------------------------------------------------

    pub fn load_archive_month(&mut self, month: &str) -> AppResult<ArchiveFile> {
        let file = format!("archive/{month}.json");
        Ok(self
            .read_json::<ArchiveFile>(&file)?
            .unwrap_or_else(|| ArchiveFile { version: CURRENT_VERSION, month: month.to_string(), days: Default::default() }))
    }

    pub fn save_archive_month(&mut self, archive: &ArchiveFile) -> AppResult<MtimeStatus> {
        let file = format!("archive/{}.json", archive.month);
        self.write_json_atomic(&file, archive)
    }

    /// 加载 `[from, to]`（YYYY-MM，含端点）区间的全部归档天，合并为天 → 天内容 映射。
    pub fn load_archive_range(&mut self, from: &str, to: &str) -> AppResult<std::collections::BTreeMap<String, ArchiveDay>> {
        let mut map = std::collections::BTreeMap::new();
        let mut m = from.to_string();
        while m.as_str() <= to {
            let f = self.load_archive_month(&m)?;
            for (k, v) in f.days {
                map.insert(k, v);
            }
            m = next_month(&m);
        }
        Ok(map)
    }

    // -----------------------------------------------------------------------
    // 聚合加载
    // -----------------------------------------------------------------------

    /// 加载全部数据（事件/日常/浮动事项/长期任务/配置/当前月份归档）。
    pub fn load_all(&mut self) -> AppResult<AppData> {
        self.ensure()?;
        let events = self.read_events()?;
        let routines = self.read_routines()?;
        let tasks = self.read_tasks()?;
        let long_tasks = self.read_long_tasks()?;
        let config = self.read_config()?;
        let month = timeutil::current_month_string(&config.timezone);
        let archive = self.load_archive_month(&month)?;
        Ok(AppData { events, routines, tasks, long_tasks, config, archive })
    }
}

/// 迁移步骤分发：v0 → v1 → v2 → v3 → v4 → v5（`file` 为相对数据目录的文件名）。
fn migrate_step(file: &str, from: u32, value: Value) -> Value {
    match from {
        0 => migrate_v0_to_v1(value),
        1 => migrate_v1_to_v2(file, value),
        2 => migrate_v2_to_v3(file, value),
        3 => migrate_v3_to_v4(file, value),
        4 => migrate_v4_to_v5(value),
        _ => value,
    }
}

/// v0 → v1：写入版本号并补齐全部缺失默认字段（§5.7 字段分阶段启用）。
///
/// 补齐策略与 serde `#[serde(default)]` 一致，但显式写入，保证老 JSON 升级后
/// 结构完整、可直接被旧/新版本一致读取；未知字段保持不动（前向兼容）。
fn migrate_v0_to_v1(mut value: Value) -> Value {
    let Some(obj) = value.as_object_mut() else { return value };
    obj.insert("version".to_string(), json!(1));

    // 事件。
    if let Some(events) = obj.get_mut("events").and_then(|v| v.as_array_mut()) {
        for ev in events.iter_mut() {
            if let Some(o) = ev.as_object_mut() {
                o.entry("description").or_insert(Value::Null);
                o.entry("end").or_insert(Value::Null);
                o.entry("allDay").or_insert(json!(false));
                o.entry("reminders").or_insert(json!([]));
                o.entry("repeat").or_insert(Value::Null);
                o.entry("tags").or_insert(json!([]));
                o.entry("priority").or_insert(json!("normal"));
                o.entry("status").or_insert(json!("active"));
                o.entry("completedAt").or_insert(Value::Null);
                o.entry("deletedAt").or_insert(Value::Null);
            }
        }
    }
    // 日常。
    if let Some(routines) = obj.get_mut("routines").and_then(|v| v.as_array_mut()) {
        for r in routines.iter_mut() {
            if let Some(o) = r.as_object_mut() {
                o.entry("description").or_insert(Value::Null);
                o.entry("timeWindows").or_insert(json!([]));
                o.entry("durationMinutes").or_insert(Value::Null);
                o.entry("tags").or_insert(json!([]));
                o.entry("priority").or_insert(json!("normal"));
                o.entry("enabled").or_insert(json!(true));
                o.entry("deletedAt").or_insert(Value::Null);
            }
        }
    }
    // 浮动事项。
    if let Some(tasks) = obj.get_mut("tasks").and_then(|v| v.as_array_mut()) {
        for t in tasks.iter_mut() {
            if let Some(o) = t.as_object_mut() {
                o.entry("description").or_insert(Value::Null);
                o.entry("priority").or_insert(json!("normal"));
                o.entry("deadline").or_insert(Value::Null);
                o.entry("tags").or_insert(json!([]));
                o.entry("status").or_insert(json!("active"));
                o.entry("sortOrder").or_insert(json!(0));
                o.entry("completedAt").or_insert(Value::Null);
                o.entry("deletedAt").or_insert(Value::Null);
            }
        }
    }
    // 配置（config.json 无 version 时按 v0 处理）。
    obj.entry("timezone").or_insert(json!("Asia/Shanghai"));
    obj.entry("dataDir").or_insert(json!("auto"));
    obj.entry("notifications").or_insert(json!({
        "enabled": true, "sound": false,
        "doNotDisturb": { "enabled": true, "start": "22:00", "end": "08:00" }
    }));
    obj.entry("appearance").or_insert(json!({ "theme": "light" }));
    obj.entry("behavior").or_insert(json!({
        "minimizeToTray": true, "launchAtStartup": false, "globalHotkey": "Ctrl+Shift+A"
    }));
    obj.entry("candidate").or_insert(json!({ "missedRoutineGraceHours": 4 }));

    // 归档天内容。
    if let Some(days) = obj.get_mut("days").and_then(|v| v.as_object_mut()) {
        for day in days.values_mut() {
            if let Some(o) = day.as_object_mut() {
                o.entry("entries").or_insert(json!([]));
                o.entry("summary").or_insert(Value::Null);
            }
        }
    }

    value
}

/// v1 → v2：写入版本号 2；为 `config.json` 补齐 Phase3 新增配置段。
/// Git 备份与移动端只读配置已移除，仅保留 hooks；历史文件中的 git/mobile
/// 字段为未知字段，serde 忽略并在下次写配置时自然丢弃。
/// 事件/日常/浮动/归档/templates 结构不变。
fn migrate_v1_to_v2(file: &str, mut value: Value) -> Value {
    let Some(obj) = value.as_object_mut() else { return value };
    obj.insert("version".to_string(), json!(2));

    // 仅配置类文件需要新增配置段，避免把配置段写入数据文件。
    if file == "config.json" {
        obj.entry("hooks").or_insert(json!({ "enabled": false }));
    }
    value
}

/// v2 → v3：写入版本号 3；为 `config.json` 的 `notifications` 补齐
/// V3.0 提醒分级策略 `priorityPolicy`（默认 high=system, normal=app, low=app）。
/// 事件/日常/浮动/归档/templates 结构零改动。
fn migrate_v2_to_v3(file: &str, mut value: Value) -> Value {
    let Some(obj) = value.as_object_mut() else { return value };
    obj.insert("version".to_string(), json!(3));

    if file == "config.json" {
        let notifications = obj
            .get_mut("notifications")
            .and_then(|v| v.as_object_mut());
        match notifications {
            Some(notif) => {
                notif.entry("priorityPolicy").or_insert(json!({
                    "high": "system", "normal": "app", "low": "app"
                }));
            }
            // notifications 缺失时兜底插入完整结构（v1 迁移已保证其存在，此处仅防御）。
            None => {
                obj.entry("notifications").or_insert(json!({
                    "enabled": true, "sound": false,
                    "doNotDisturb": { "enabled": true, "start": "22:00", "end": "08:00" },
                    "priorityPolicy": { "high": "system", "normal": "app", "low": "app" }
                }));
            }
        }
    }
    value
}

/// v3 → v4：写入版本号 4；为 `config.json` 补齐 V3.1 标签颜色映射 `tagColors`。
/// 事件/日常/浮动/归档/templates 结构零改动。
fn migrate_v3_to_v4(file: &str, mut value: Value) -> Value {
    let Some(obj) = value.as_object_mut() else { return value };
    obj.insert("version".to_string(), json!(4));

    if file == "config.json" {
        obj.entry("tagColors").or_insert(json!({}));
    }
    value
}

/// v4 → v5：写入版本号 5。长期任务为独立新文件，既有文件无需结构变更（无操作迁移）。
fn migrate_v4_to_v5(mut value: Value) -> Value {
    if let Some(obj) = value.as_object_mut() {
        obj.insert("version".to_string(), json!(5));
    }
    value
}

/// 月份字符串 +1（YYYY-MM）。
fn next_month(m: &str) -> String {
    let mut parts = m.split('-');
    let year: i32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(2000);
    let month: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(1);
    let (y, mo) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    format!("{y:04}-{mo:02}")
}

// ---------------------------------------------------------------------------
// 便捷构造：新对象默认值
// ---------------------------------------------------------------------------

pub fn new_event() -> Event {
    let now = timeutil::now_utc_string();
    Event {
        id: new_id("e"),
        title: String::new(),
        description: None,
        start: now.clone(),
        end: None,
        all_day: false,
        reminders: vec![],
        repeat: None,
        tags: vec![],
        priority: Priority::Normal,
        status: ItemStatus::Active,
        created_at: now.clone(),
        updated_at: now,
        completed_at: None,
        deleted_at: None,
    }
}

pub fn new_routine() -> Routine {
    let now = timeutil::now_utc_string();
    Routine {
        id: new_id("r"),
        title: String::new(),
        description: None,
        time_windows: vec![],
        duration_minutes: None,
        tags: vec![],
        priority: Priority::Normal,
        enabled: true,
        created_at: now.clone(),
        updated_at: now,
        deleted_at: None,
    }
}

pub fn new_task() -> Task {
    let now = timeutil::now_utc_string();
    Task {
        id: new_id("t"),
        title: String::new(),
        description: None,
        priority: Priority::Normal,
        deadline: None,
        tags: vec![],
        status: ItemStatus::Active,
        sort_order: 0,
        created_at: now.clone(),
        updated_at: now,
        completed_at: None,
        deleted_at: None,
    }
}

pub fn new_archive_entry(source: ArchiveSource, source_id: Option<String>, title: &str, time: &str) -> ArchiveEntry {
    ArchiveEntry {
        id: new_id("a"),
        time: time.to_string(),
        title: title.to_string(),
        source,
        source_id,
        note: None,
        duration_minutes: None,
        done_at: timeutil::now_utc_string(),
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration;

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "schedule-core-test-{name}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn new_ev() -> Event {
        Event {
            id: "e_test".to_string(),
            title: "t".to_string(),
            description: None,
            start: "2025-01-15T09:00:00Z".to_string(),
            end: None,
            all_day: false,
            reminders: vec![],
            repeat: None,
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
    fn test_migrate_v3_config_adds_empty_tag_colors() {
        let dir = tmp_dir("migrate-v3");
        fs::write(
            dir.join("config.json"),
            r#"{
              "version": 3,
              "timezone": "Asia/Shanghai",
              "notifications": {
                "enabled": true,
                "sound": false,
                "doNotDisturb": {"enabled": false, "start": "22:00", "end": "08:00"},
                "priorityPolicy": {"high": "system", "normal": "app", "low": "app"}
              },
              "appearance": {"theme": "light"},
              "behavior": {"minimizeToTray": true, "launchAtStartup": false, "globalHotkey": "Ctrl+Shift+A"},
              "candidate": {"missedRoutineGraceHours": 4},
              "hooks": {"enabled": false},
              "dataDir": "auto"
            }"#,
        )
        .unwrap();
        let mut storage = Storage::new(dir);
        let config = storage.read_config().unwrap();
        assert_eq!(config.version, CURRENT_VERSION);
        assert!(config.tag_colors.is_empty());
    }

    #[test]
    fn test_migrate_v3_data_file_keeps_structure_and_roundtrips() {
        let dir = tmp_dir("migrate-v3-data");
        fs::write(
            dir.join("events.json"),
            r#"{"version":3,"events":[{"id":"e1","title":"x","start":"2025-01-15T09:00:00Z","createdAt":"2025-01-15T00:00:00Z","updatedAt":"2025-01-15T00:00:00Z"}]}"#,
        )
        .unwrap();
        let mut storage = Storage::new(dir.clone());
        let events = storage.read_events().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "e1");
        // v3→v4→v5 对数据文件结构零改动：保存后除 version 外不新增配置类字段。
        storage.save_events(&events).unwrap();
        let raw = fs::read_to_string(dir.join("events.json")).unwrap();
        assert!(!raw.contains("tagColors"));
        assert!(raw.contains("\"version\": 5"));
    }

    #[test]
    fn test_long_tasks_missing_file_defaults_empty_and_roundtrips() {
        let dir = tmp_dir("long-tasks");
        let mut storage = Storage::new(dir.clone());
        storage.ensure().unwrap();
        // 新目录：long_tasks.json 缺失 → 空列表，不报错（v1.0/v1.1 旧备份兼容）。
        assert!(storage.read_long_tasks().unwrap().is_empty());

        let task = LongTask {
            id: "lt1".to_string(),
            title: "备考".to_string(),
            description: None,
            start_date: "2025-03-01".to_string(),
            due_date: "2025-06-30".to_string(),
            status: LongTaskStatus::Active,
            ended_at: None,
            tags: vec!["学习".to_string()],
            priority: Priority::Normal,
            created_at: "2025-02-20T00:00:00Z".to_string(),
            updated_at: "2025-02-20T00:00:00Z".to_string(),
            deleted_at: None,
            sessions: vec![],
        };
        storage.save_long_tasks(&[task.clone()]).unwrap();
        let loaded = storage.read_long_tasks().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].title, "备考");
        let raw = fs::read_to_string(dir.join("long_tasks.json")).unwrap();
        assert!(raw.contains("\"version\": 5"));
        assert!(raw.contains("\"longTasks\""));
    }

    #[test]
    fn test_external_change_rejected_then_force_overwrite() {
        let dir = tmp_dir("mtime");
        let mut storage = Storage::new(dir.clone());
        storage.ensure().unwrap();
        storage.save_events(&[new_ev()]).unwrap();

        // 外部修改：直接写盘（mtime 发生变化）。
        sleep(Duration::from_millis(25));
        let external = r#"{"version":4,"events":[]}"#;
        fs::write(dir.join("events.json"), external).unwrap();

        // 未选择覆盖：写入前拦截，磁盘内容保持外部改动。
        let err = storage.save_events(&[new_ev()]).unwrap_err();
        assert!(matches!(err, AppError::ExternalChange { file } if file == "events.json"));
        assert_eq!(fs::read_to_string(dir.join("events.json")).unwrap(), external);

        // 选择覆盖：写入成功，并更新 mtime 基线；再次外部修改后重新拦截。
        storage.set_force_overwrite(true);
        storage.save_events(&[new_ev()]).unwrap();
        assert_eq!(storage.read_events().unwrap().len(), 1);

        sleep(Duration::from_millis(25));
        fs::write(dir.join("events.json"), external).unwrap();
        assert!(matches!(
            storage.save_events(&[new_ev()]).unwrap_err(),
            AppError::ExternalChange { .. }
        ));
    }
}
