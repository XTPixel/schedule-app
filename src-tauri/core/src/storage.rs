//! JSON 存储层（§5.1/§5.7）：
//! - 原子写入（临时文件 + rename）
//! - `.bak` 备份机制
//! - 数据版本校验 + 迁移骨架
//! - mtime 外部修改检测
//! - 软删除（deletedAt）

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use std::{any::Any, sync::Arc};

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
    /// 初次读取、明确重载或本应用成功写入后认可的磁盘 mtime。
    mtimes: HashMap<String, Option<SystemTime>>,
    /// V3.1：检测到外部修改后，前端选择「覆盖」时置 true；下一次成功写入后自动复位。
    force_overwrite: bool,
    cache: HashMap<String, CachedFile>,
}
struct CachedFile {
    modified: SystemTime,
    bytes: u64,
    value: Arc<dyn Any + Send + Sync>,
}

impl Storage {
    pub fn new(dir: PathBuf) -> Self {
        Storage {
            dir,
            mtimes: HashMap::new(),
            force_overwrite: false,
            cache: HashMap::new(),
        }
    }

    pub fn data_dir(&self) -> &Path {
        &self.dir
    }

    /// `overwrite` 允许下一次写入覆盖外部改动。
    pub fn set_force_overwrite(&mut self, force: bool) {
        self.force_overwrite = force;
    }

    /// Only an explicit reload may accept external file changes as a baseline.
    /// Passive refreshes must not silently authorize overwriting an open draft.
    pub fn accept_external_changes(&mut self) {
        self.force_overwrite = false;
        self.mtimes.clear();
        self.cache.clear();
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
    fn read_json<T: DeserializeOwned + Clone + Send + Sync + 'static>(&mut self, file: &str) -> AppResult<Option<T>> {
        let path = self.path(file);
        if !path.exists() {
            self.cache.remove(file);
            self.mtimes.entry(Self::key(file)).or_insert(None);
            return Ok(None);
        }
        let metadata = fs::metadata(&path)?;
        let mtime = metadata.modified().ok();
        if let (Some(modified), Some(cached)) = (mtime, self.cache.get(file)) {
            if cached.modified == modified && cached.bytes == metadata.len() {
                if let Some(value) = cached.value.downcast_ref::<T>() {
                    self.mtimes.entry(Self::key(file)).or_insert(mtime);
                    return Ok(Some(value.clone()));
                }
            }
        }
        self.cache.remove(file);
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
        self.mtimes.entry(Self::key(file)).or_insert(mtime);
        self.cache_value(file, &parsed);
        Ok(Some(parsed))
    }
    /// Bound cached serialized size to 8 MiB. External edits/deletions invalidate
    /// the typed cache through both modification time and file length.
    fn cache_value<T: Clone + Send + Sync + 'static>(&mut self, file: &str, value: &T) {
        const LIMIT: u64 = 8 * 1024 * 1024;
        let Ok(metadata) = fs::metadata(self.path(file)) else { return };
        let Ok(modified) = metadata.modified() else { return };
        self.cache.remove(file);
        if metadata.len() > LIMIT { return; }
        if self.cache.values().map(|c|c.bytes).sum::<u64>() + metadata.len() > LIMIT { self.cache.clear(); }
        self.cache.insert(file.into(), CachedFile { modified, bytes: metadata.len(), value: Arc::new(value.clone()) });
    }

    /// 版本校验 + 迁移骨架（§5.7）。
    fn migrate_if_needed(&self, file: &str, mut value: Value) -> AppResult<Value> {
        let version = value.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
        // BUG-13：版本号超过 u32 或高于当前版本都拒绝加载，避免 as u32 截断后被误当旧数据迁移。
        if version > CURRENT_VERSION as u64 {
            return Err(AppError::NewerVersion {
                file: file.to_string(),
                version,
            });
        }
        let mut v = version as u32;
        while v < CURRENT_VERSION {
            value = migrate_step(file, v, value);
            v += 1;
        }
        Ok(value)
    }

    fn backup_corrupt(&self, file: &str) -> Option<String> {
        let ts = chrono::Utc::now().format("%Y%m%d%H%M%S%3f").to_string();
        self.backup_corrupt_at(file, &ts)
    }

    fn backup_corrupt_at(&self, file: &str, ts: &str) -> Option<String> {
        let mut source = fs::File::open(self.path(file)).ok()?;
        // A timestamp alone can collide within one millisecond or across
        // processes. Reserve each destination atomically and never overwrite it.
        for suffix in 0..1000 {
            let ending = if suffix == 0 { String::new() } else { format!("-{suffix}") };
            let dst = self.path(&format!("{file}.corrupt-{ts}{ending}.bak"));
            let mut target = match fs::OpenOptions::new().write(true).create_new(true).open(&dst) {
                Ok(target) => target,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return None,
            };
            if std::io::copy(&mut source, &mut target).and_then(|_| target.sync_all()).is_err() {
                drop(target);
                let _ = fs::remove_file(&dst);
                return None;
            }
            return Some(dst.display().to_string());
        }
        None
    }

    // -----------------------------------------------------------------------
    // 写入
    // -----------------------------------------------------------------------

    /// 原子写入：临时文件 + rename；写前复制 .bak 备份；mtime 外部修改检测。
    fn write_json_atomic<T: Serialize + Clone + Send + Sync + 'static>(&mut self, file: &str, value: &T) -> AppResult<MtimeStatus> {
        if self.dir.join(".sync-transaction.json").exists() {
            return Err(AppError::InvalidInput("数据事务尚未恢复，请重新打开应用并完成恢复".into()));
        }
        self.ensure()?;
        let path = self.path(file);
        let key = Self::key(file);

        // mtime 外部修改检测（§5.7 防脑裂）。
        let disk_mtime = if path.exists() {
            fs::metadata(&path).and_then(|m| m.modified()).ok()
        } else {
            None
        };
        let status = match self.mtimes.get(&key) {
            Some(known) if *known != disk_mtime => MtimeStatus::ExternalChange,
            _ => MtimeStatus::Ok,
        };

        // V3.1：检测到外部修改且未显式选择「覆盖」时，写入前拦截并返回结构化错误，
        // 避免静默覆盖外部改动（用户可在前端选择 reload / overwrite）。
        if status == MtimeStatus::ExternalChange && !self.force_overwrite {
            return Err(AppError::ExternalChange {
                file: file.to_string(),
            });
        }

        // 覆盖前备份上一份有效内容到 .bak（best-effort）。
        if path.exists() {
            let bak = self.path(&format!("{file}.bak"));
            if fs::copy(&path, &bak).is_ok() {
                if let Ok(backup) = fs::OpenOptions::new().write(true).open(&bak) {
                    let _ = backup.sync_all();
                }
            }
        }

        let tmp = self.path(&format!("{file}.tmp"));
        let text = serde_json::to_string_pretty(value)?;
        {
            let mut staged = fs::File::create(&tmp)?;
            staged.write_all(text.as_bytes())?;
            staged.sync_all()?;
        }
        // 原子重命名（Windows 同卷 rename 为原子操作）。
        fs::rename(&tmp, &path)?;

        self.mtimes
            .insert(key, fs::metadata(&path).and_then(|m| m.modified()).ok());
        self.cache_value(file, value);
        // 覆盖完成后复位，后续外部修改再次触发拦截。
        self.force_overwrite = false;
        Ok(status)
    }

    // -----------------------------------------------------------------------
    // 各文件读写
    // -----------------------------------------------------------------------

    pub fn read_events(&mut self) -> AppResult<Vec<Event>> {
        Ok(self
            .read_json::<EventsFile>("events.json")?
            .map(|f| f.events)
            .unwrap_or_default())
    }

    pub fn read_routines(&mut self) -> AppResult<Vec<Routine>> {
        Ok(self
            .read_json::<RoutinesFile>("routines.json")?
            .map(|f| f.routines)
            .unwrap_or_default())
    }

    pub fn read_tasks(&mut self) -> AppResult<Vec<Task>> {
        Ok(self
            .read_json::<TasksFile>("tasks.json")?
            .map(|f| f.tasks)
            .unwrap_or_default())
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
            &EventsFile {
                version: CURRENT_VERSION,
                events: events.to_vec(),
            },
        )
    }

    pub fn save_routines(&mut self, routines: &[Routine]) -> AppResult<MtimeStatus> {
        self.write_json_atomic(
            "routines.json",
            &RoutinesFile {
                version: CURRENT_VERSION,
                routines: routines.to_vec(),
            },
        )
    }

    pub fn save_tasks(&mut self, tasks: &[Task]) -> AppResult<MtimeStatus> {
        self.write_json_atomic(
            "tasks.json",
            &TasksFile {
                version: CURRENT_VERSION,
                tasks: tasks.to_vec(),
            },
        )
    }

    pub fn save_long_tasks(&mut self, tasks: &[LongTask]) -> AppResult<MtimeStatus> {
        self.write_json_atomic(
            "long_tasks.json",
            &LongTasksFile {
                version: CURRENT_VERSION,
                long_tasks: tasks.to_vec(),
            },
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
            &TemplatesFile {
                version: CURRENT_VERSION,
                templates: templates.to_vec(),
            },
        )
    }

    // -----------------------------------------------------------------------
    // 归档
    // -----------------------------------------------------------------------

    pub fn load_archive_month(&mut self, month: &str) -> AppResult<ArchiveFile> {
        let file = format!("archive/{month}.json");
        Ok(self
            .read_json::<ArchiveFile>(&file)?
            .unwrap_or_else(|| ArchiveFile {
                version: CURRENT_VERSION,
                month: month.to_string(),
                days: Default::default(),
            }))
    }

    pub fn save_archive_month(&mut self, archive: &ArchiveFile) -> AppResult<MtimeStatus> {
        let file = format!("archive/{}.json", archive.month);
        self.write_json_atomic(&file, archive)
    }

    /// 加载 `[from, to]`（YYYY-MM，含端点）区间的全部归档天，合并为天 → 天内容 映射。
    pub fn load_archive_range(
        &mut self,
        from: &str,
        to: &str,
    ) -> AppResult<std::collections::BTreeMap<String, ArchiveDay>> {
        // BUG-21：先校验月份参数，避免 next_month 对非法输入永不收敛。
        if !valid_month(from) || !valid_month(to) || from > to {
            return Err(AppError::InvalidInput(format!(
                "归档月份区间无效：{from} ~ {to}"
            )));
        }
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
        Ok(AppData {
            events,
            routines,
            tasks,
            long_tasks,
            config,
            archive,
        })
    }
}

/// 迁移步骤分发：v0 → … → v6（`file` 为相对数据目录的文件名）。
fn migrate_step(file: &str, from: u32, value: Value) -> Value {
    match from {
        0 => migrate_v0_to_v1(value),
        1 => migrate_v1_to_v2(file, value),
        2 => migrate_v2_to_v3(file, value),
        3 => migrate_v3_to_v4(file, value),
        4 => migrate_v4_to_v5(value),
        5 => migrate_v5_to_v6(file, value),
        _ => value,
    }
}

/// v0 → v1：写入版本号并补齐全部缺失默认字段（§5.7 字段分阶段启用）。
///
/// 补齐策略与 serde `#[serde(default)]` 一致，但显式写入，保证老 JSON 升级后
/// 结构完整、可直接被旧/新版本一致读取；未知字段保持不动（前向兼容）。
fn migrate_v0_to_v1(mut value: Value) -> Value {
    let Some(obj) = value.as_object_mut() else {
        return value;
    };
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
    obj.entry("appearance")
        .or_insert(json!({ "theme": "light" }));
    obj.entry("behavior").or_insert(json!({
        "minimizeToTray": true, "launchAtStartup": false, "globalHotkey": "Ctrl+Shift+A"
    }));
    obj.entry("candidate")
        .or_insert(json!({ "missedRoutineGraceHours": 4 }));

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
    let Some(obj) = value.as_object_mut() else {
        return value;
    };
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
    let Some(obj) = value.as_object_mut() else {
        return value;
    };
    obj.insert("version".to_string(), json!(3));

    if file == "config.json" {
        let notifications = obj.get_mut("notifications").and_then(|v| v.as_object_mut());
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
    let Some(obj) = value.as_object_mut() else {
        return value;
    };
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

/// v5 → v6：写入版本号 6；为 `routines.json` 的每个时间窗口显式补齐
/// V1.2.1 新增字段 `everyDays: null` / `anchorDate: null`（按星期模式）。
fn migrate_v5_to_v6(file: &str, mut value: Value) -> Value {
    let Some(obj) = value.as_object_mut() else {
        return value;
    };
    obj.insert("version".to_string(), json!(6));

    if file == "routines.json" {
        if let Some(routines) = obj.get_mut("routines").and_then(|v| v.as_array_mut()) {
            for r in routines.iter_mut() {
                if let Some(windows) = r.get_mut("timeWindows").and_then(|v| v.as_array_mut()) {
                    for w in windows.iter_mut() {
                        if let Some(o) = w.as_object_mut() {
                            o.entry("everyDays").or_insert(Value::Null);
                            o.entry("anchorDate").or_insert(Value::Null);
                        }
                    }
                }
            }
        }
    }
    value
}

/// 月份字符串 +1（YYYY-MM）。调用方需先校验格式。
fn next_month(m: &str) -> String {
    let mut parts = m.split('-');
    let year: i32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(2000);
    let month: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(1);
    let (y, mo) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    format!("{y:04}-{mo:02}")
}

/// `YYYY-MM` 格式且月份合法。
fn valid_month(s: &str) -> bool {
    let mut parts = s.split('-');
    let Some(y) = parts.next() else { return false };
    let Some(m) = parts.next() else { return false };
    parts.next().is_none()
        && y.len() == 4
        && y.chars().all(|c| c.is_ascii_digit())
        && m.len() == 2
        && m.chars().all(|c| c.is_ascii_digit())
        && (1..=12).contains(&m.parse::<u32>().unwrap_or(0))
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

pub fn new_archive_entry(
    source: ArchiveSource,
    source_id: Option<String>,
    title: &str,
    time: &str,
) -> ArchiveEntry {
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
    #[test]
    fn corrupt_backups_never_replace_an_existing_backup_at_the_same_timestamp() {
        let dir = tmp_dir("corrupt-backup-collision");
        let storage = Storage::new(dir.clone());
        let legacy = dir.join("events.json.corrupt-fixed.bak");
        fs::write(&legacy, "existing backup").unwrap();
        fs::write(dir.join("events.json"), "first corrupted version").unwrap();
        let first = storage.backup_corrupt_at("events.json", "fixed").unwrap();
        fs::write(dir.join("events.json"), "second corrupted version").unwrap();
        let second = storage.backup_corrupt_at("events.json", "fixed").unwrap();
        assert_ne!(first, second);
        assert_eq!(fs::read_to_string(first).unwrap(), "first corrupted version");
        assert_eq!(fs::read_to_string(second).unwrap(), "second corrupted version");
        assert_eq!(fs::read_to_string(legacy).unwrap(), "existing backup");
        assert_eq!(fs::read_to_string(dir.join("events.json")).unwrap(), "second corrupted version");
        assert!(dir.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_corrupt_backups_atomically_reserve_distinct_destinations() {
        use std::sync::{Arc, Barrier};
        let dir = tmp_dir("corrupt-backup-concurrent");
        fs::write(dir.join("events.json"), "corrupted source").unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let handles:Vec<_> = (0..2).map(|_| {
            let dir = dir.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || { barrier.wait(); Storage::new(dir).backup_corrupt_at("events.json", "fixed").unwrap() })
        }).collect();
        let backups:Vec<_> = handles.into_iter().map(|h|h.join().unwrap()).collect();
        assert_ne!(backups[0], backups[1]);
        for backup in backups { assert_eq!(fs::read_to_string(backup).unwrap(), "corrupted source"); }
        assert!(dir.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn pending_transaction_blocks_writes_without_changing_live_data() {
        let dir=tmp_dir("pending-transaction");let mut storage=Storage::new(dir.clone());
        storage.save_events(&[new_ev()]).unwrap();
        let before=fs::read(dir.join("events.json")).unwrap();
        fs::write(dir.join(".sync-transaction.json"), b"unresolved").unwrap();
        assert!(storage.save_events(&[]).is_err());
        assert_eq!(fs::read(dir.join("events.json")).unwrap(),before);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn typed_cache_detects_external_changes_corruption_and_deletion() {
        let dir=tmp_dir("typed-cache-external");let mut storage=Storage::new(dir.clone());
        storage.save_events(&[new_ev()]).unwrap();
        let mut external=new_ev();external.title="external title with different length".into();
        fs::write(dir.join("events.json"),serde_json::to_vec(&EventsFile {version:CURRENT_VERSION,events:vec![external.clone()]}).unwrap()).unwrap();
        assert_eq!(storage.read_events().unwrap()[0].title,external.title);
        fs::write(dir.join("events.json"),b"broken").unwrap();
        assert!(storage.read_events().is_err());
        fs::remove_file(dir.join("events.json")).unwrap();
        assert!(storage.read_events().unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn typed_cache_returns_independent_values() {
        let dir=tmp_dir("typed-cache-owned");let mut storage=Storage::new(dir.clone());
        storage.save_events(&[new_ev()]).unwrap();
        let mut copy=storage.read_events().unwrap();copy[0].title="unsaved mutation".into();
        assert_eq!(storage.read_events().unwrap()[0].title,"t");
        fs::remove_dir_all(dir).unwrap();
    }

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
        // v3→v4→v5→v6 对数据文件结构零改动：保存后除 version 外不新增配置类字段。
        storage.save_events(&events).unwrap();
        let raw = fs::read_to_string(dir.join("events.json")).unwrap();
        assert!(!raw.contains("tagColors"));
        assert!(raw.contains("\"version\": 6"));
    }

    #[test]
    fn test_migrate_v5_routines_adds_every_days_fields() {
        let dir = tmp_dir("migrate-v5-routines");
        fs::write(
            dir.join("routines.json"),
            r#"{"version":5,"routines":[{"id":"r1","title":"r","timeWindows":[{"daysOfWeek":[1,3],"start":"08:00","end":"09:00"}],"enabled":true,"createdAt":"2025-01-01T00:00:00Z","updatedAt":"2025-01-01T00:00:00Z"}]}"#,
        )
        .unwrap();
        let mut storage = Storage::new(dir.clone());
        let routines = storage.read_routines().unwrap();
        assert_eq!(routines[0].time_windows[0].every_days, None);
        assert_eq!(routines[0].time_windows[0].anchor_date, None);
        // 保存后显式写入补齐字段与 version 6。
        storage.save_routines(&routines).unwrap();
        let raw = fs::read_to_string(dir.join("routines.json")).unwrap();
        assert!(raw.contains("\"version\": 6"));
        assert!(raw.contains("\"everyDays\": null"));
        assert!(raw.contains("\"anchorDate\": null"));
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
        assert!(raw.contains("\"version\": 6"));
        assert!(raw.contains("\"longTasks\""));
    }

    #[test]
    fn test_version_above_u32_is_rejected() {
        let dir = tmp_dir("newer-u32");
        fs::write(
            dir.join("config.json"),
            r#"{"version":4294967297,"timezone":"Asia/Shanghai"}"#,
        )
        .unwrap();
        let mut storage = Storage::new(dir);
        let err = storage.read_config().unwrap_err();
        assert!(matches!(err, AppError::NewerVersion { version, .. } if version == 4294967297));
    }

    #[test]
    fn test_invalid_archive_range_is_rejected() {
        let dir = tmp_dir("archive-range-invalid");
        let mut storage = Storage::new(dir);
        storage.ensure().unwrap();
        assert!(storage.load_archive_range("2025-13", "2026-01").is_err());
    }

    #[test]
    fn passive_refresh_keeps_external_change_blocked_until_explicit_reload() {
        let dir=tmp_dir("external-refresh");let mut storage=Storage::new(dir.clone());
        let stale=new_ev();storage.save_events(&[stale.clone()]).unwrap();
        sleep(Duration::from_millis(25));let mut external=stale.clone();external.title="externally changed title".into();
        fs::write(dir.join("events.json"),serde_json::to_vec(&EventsFile{version:CURRENT_VERSION,events:vec![external.clone()]}).unwrap()).unwrap();
        // Both a fresh read and the next typed-cache hit preserve the guard.
        for _ in 0..2 {
            assert_eq!(storage.read_events().unwrap()[0].title,external.title);
            assert!(matches!(storage.save_events(&[stale.clone()]),Err(AppError::ExternalChange{..})));
        }
        storage.accept_external_changes();let mut current=storage.read_events().unwrap();current[0].title="edited after reload".into();
        storage.save_events(&current).unwrap();assert_eq!(storage.read_events().unwrap()[0].title,current[0].title);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn externally_deleted_file_is_not_recreated_by_a_stale_write() {
        let dir=tmp_dir("external-delete");let mut storage=Storage::new(dir.clone());storage.save_events(&[new_ev()]).unwrap();
        fs::remove_file(dir.join("events.json")).unwrap();assert!(storage.read_events().unwrap().is_empty());
        assert!(matches!(storage.save_events(&[new_ev()]),Err(AppError::ExternalChange{..})));assert!(!dir.join("events.json").exists());
        storage.accept_external_changes();assert!(storage.read_events().unwrap().is_empty());storage.save_events(&[]).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn externally_created_file_is_not_overwritten_after_a_missing_file_was_read() {
        let dir=tmp_dir("external-create");let mut storage=Storage::new(dir.clone());assert!(storage.read_events().unwrap().is_empty());
        fs::write(dir.join("events.json"),serde_json::to_vec(&EventsFile{version:CURRENT_VERSION,events:vec![new_ev()]}).unwrap()).unwrap();
        assert_eq!(storage.read_events().unwrap().len(),1);assert!(matches!(storage.save_events(&[]),Err(AppError::ExternalChange{..})));
        storage.set_force_overwrite(true);storage.save_events(&[]).unwrap();assert!(storage.read_events().unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
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
        assert_eq!(
            fs::read_to_string(dir.join("events.json")).unwrap(),
            external
        );

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
