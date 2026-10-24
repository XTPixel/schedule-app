//! Validate the complete snapshot before touching live data; retain a durable
//! rollback journal until every file has been applied. Recovery is idempotent.
use crate::sync::SnapshotPayload;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use schedule_core::Storage;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, path::Path};

pub const MAX_BYTES: usize = 64 * 1024 * 1024;
const ROOTS: [&str; 5] = [
    "events.json",
    "routines.json",
    "tasks.json",
    "long_tasks.json",
    "templates.json",
];
const JOURNAL: &str = ".sync-transaction.json";
const BACKUP_INDEX: &str = ".backup.json";
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryDetails {
    pub id: String,
    pub created_at: String,
    pub platform: String,
    pub schema_version: u64,
    pub files: usize,
    pub complete: bool,
}
pub fn recovery_details(dir: &Path) -> Result<Vec<RecoveryDetails>, String> {
    recovery_points(dir)?
        .into_iter()
        .map(|id| {
            let backup = dir.join(".sync-recovery").join(&id);
            let entries: Vec<String> = serde_json::from_slice(
                &fs::read(backup.join(BACKUP_INDEX)).map_err(|e| e.to_string())?,
            )
            .map_err(|_| "恢复点索引损坏")?;
            let metadata: serde_json::Value = fs::read(backup.join(".metadata.json"))
                .ok()
                .and_then(|raw| serde_json::from_slice(&raw).ok())
                .unwrap_or_default();
            let created_at = metadata["createdAt"]
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| id.split('-').next().unwrap_or("").into());
            let platform = metadata["platform"]
                .as_str()
                .unwrap_or("unknown")
                .to_string();
            let complete = entries.len() <= 1024
                && entries
                    .iter()
                    .all(|n| (n == "config.json" || allowed(n)) && backup.join(n).is_file());
            Ok(RecoveryDetails {
                id,
                created_at,
                platform,
                schema_version: metadata["schemaVersion"].as_u64().unwrap_or(0),
                files: entries.len(),
                complete,
            })
        })
        .collect()
}
pub fn recovery_points(dir: &Path) -> Result<Vec<String>, String> {
    let root = dir.join(".sync-recovery");
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut points = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.is_empty()
            && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
            && entry.file_type().map_err(|e| e.to_string())?.is_dir()
            && entry.path().join(BACKUP_INDEX).is_file()
        {
            points.push(name)
        }
    }
    points.sort();
    points.reverse();
    Ok(points)
}

pub fn restore_point(storage: &mut Storage, id: &str) -> Result<(), String> {
    let (payload, _) = point_payload(storage.data_dir(), id)?;
    apply(storage, &payload)
}

/// Run a multi-file business edit in isolation, then commit through the same
/// durable journal used by snapshot imports. A failed edit never touches live files.
pub fn edit<T>(storage: &mut Storage, work: impl FnOnce(&mut Storage) -> Result<T, String>) -> Result<T, String> {
    let dir = storage.data_dir().to_path_buf();
    recover(&dir)?;
    let before = crate::sync::build_payload(storage)?;
    let config = storage.read_config().map_err(|e| e.to_string())?;
    let baseline = serde_json::to_vec(&before).map_err(|e| e.to_string())?;
    let config_baseline = serde_json::to_vec(&config).map_err(|e| e.to_string())?;
    let stage = dir.join(format!(".local-edit-{}", crate::sync::new_token()));
    let result = (|| {
        let mut isolated = Storage::new(stage.clone());
        isolated.ensure().map_err(|e| e.to_string())?;
        apply_with_config(&mut isolated, &before, Some(config))?;
        let output = work(&mut isolated)?;
        let next = crate::sync::build_payload(&mut isolated)?;
        let next_config = isolated.read_config().map_err(|e| e.to_string())?;
        let current = crate::sync::build_payload(storage)?;
        let current_config = storage.read_config().map_err(|e| e.to_string())?;
        if serde_json::to_vec(&current).map_err(|e| e.to_string())? != baseline
            || serde_json::to_vec(&current_config).map_err(|e| e.to_string())? != config_baseline {
            return Err("EXTERNAL_CHANGE: 批量操作期间数据被外部修改，请重新加载后重试".into());
        }
        apply_with_config(storage, &next, Some(next_config))?;
        Ok(output)
    })();
    let _ = fs::remove_dir_all(stage);
    result
}
fn point_payload(
    data_dir: &Path,
    id: &str,
) -> Result<(SnapshotPayload, schedule_core::Config), String> {
    if !recovery_points(data_dir)?.iter().any(|p| p == id) {
        return Err("恢复点不存在".into());
    }
    let dir = data_dir.join(".sync-recovery").join(id);
    let previous: Vec<String> =
        serde_json::from_slice(&fs::read(dir.join(BACKUP_INDEX)).map_err(|e| e.to_string())?)
            .map_err(|_| "恢复点索引损坏".to_string())?;
    if previous.len() > 1024
        || previous
            .iter()
            .any(|name| (name != "config.json" && !allowed(name)) || !dir.join(name).is_file())
    {
        return Err("恢复点不完整".into());
    }
    let mut backup = Storage::new(dir);
    let payload = crate::sync::build_payload(&mut backup)?;
    let config = backup.read_config().map_err(|e| e.to_string())?;
    Ok((payload, config))
}

/// Explicit recovery can replace a corrupt transaction journal, after first
/// proving that the selected backup is complete and semantically valid.
pub fn restore_blocked(storage: &mut Storage, id: &str) -> Result<(), String> {
    let dir = storage.data_dir().to_path_buf();
    let (payload, backup_config) = point_payload(&dir, id)?;
    let config = storage.read_config().unwrap_or(backup_config);
    restore_payload_blocked(storage, &payload, config)
}

/// Recover from an explicitly selected document as well as a local point.
/// Validate all input before moving the failed journal or touching live files.
pub fn restore_payload_blocked(storage: &mut Storage, payload: &SnapshotPayload, config: schedule_core::Config) -> Result<(), String> {
    let dir = storage.data_dir().to_path_buf();
    let probe = dir.join(format!(".recovery-validate-{}", crate::sync::new_token()));
    let validation = (|| {
        let mut isolated = Storage::new(probe.clone());
        isolated.ensure().map_err(|e| e.to_string())?;
        isolated.save_config(&config).map_err(|e| e.to_string())?;
        apply(&mut isolated, payload)
    })();
    let _ = fs::remove_dir_all(&probe);
    validation?;
    let journal = dir.join(JOURNAL);
    let quarantined = dir.join(format!(
        ".sync-transaction-failed-{}.json",
        crate::sync::new_token()
    ));
    if journal.exists() {
        fs::rename(&journal, &quarantined).map_err(|e| e.to_string())?;
    }
    let result = apply_with_config(storage, payload, Some(config));
    if result.is_err() && quarantined.exists() && !journal.exists() {
        fs::rename(&quarantined, &journal).map_err(|e| format!("恢复失败且原日志归位失败：{e}"))?;
    }
    result
}

fn prune(dir: &Path) {
    let Ok(points) = recovery_points(dir) else {
        return;
    };
    let root = dir.join(".sync-recovery");
    let Ok(canonical_root) = root.canonicalize() else {
        return;
    };
    for name in points.into_iter().skip(5) {
        let candidate = root.join(name);
        if let Ok(resolved) = candidate.canonicalize() {
            if resolved.starts_with(&canonical_root) {
                let _ = fs::remove_dir_all(candidate);
            }
        }
    }
}

fn allowed(name: &str) -> bool {
    if ROOTS.contains(&name) {
        return true;
    }
    let Some(month) = name
        .strip_prefix("archive/")
        .and_then(|s| s.strip_suffix(".json"))
    else {
        return false;
    };
    month.is_ascii()
        && month.len() == 7
        && month.as_bytes()[4] == b'-'
        && month[..4].bytes().all(|c| c.is_ascii_digit())
        && month[5..].bytes().all(|c| c.is_ascii_digit())
        && (1..=12).contains(&month[5..].parse::<u32>().unwrap_or(0))
}

fn list(dir: &Path) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for name in ROOTS.into_iter().chain(["config.json"]) {
        if dir.join(name).exists() {
            out.push(name.into())
        }
    }
    let archive = dir.join("archive");
    if archive.exists() {
        if fs::symlink_metadata(&archive)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("归档目录不能是符号链接".into());
        }
        for entry in fs::read_dir(archive).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = format!("archive/{}", entry.file_name().to_string_lossy());
            if allowed(&name) {
                out.push(name)
            }
        }
    }
    for name in &out {
        if fs::symlink_metadata(dir.join(name))
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("数据文件不能是符号链接".into());
        }
    }
    Ok(out)
}

#[derive(Serialize, Deserialize)]
struct Journal {
    backup: String,
    previous: Vec<String>,
}

pub fn recover(dir: &Path) -> Result<(), String> {
    let file = dir.join(JOURNAL);
    if !file.exists() {
        return Ok(());
    }
    let journal: Journal = serde_json::from_slice(&fs::read(&file).map_err(|e| e.to_string())?)
        .map_err(|_| "恢复日志损坏，请保留数据目录并手动恢复备份".to_string())?;
    if journal.backup.is_empty()
        || !journal
            .backup
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || journal
            .previous
            .iter()
            .any(|s| s != "config.json" && !allowed(s))
    {
        return Err("恢复日志含非法路径".into());
    }
    let backup = dir.join(".sync-recovery").join(&journal.backup);
    // Check every backup before removing anything; interrupted restores can retry.
    for name in &journal.previous {
        if !backup.join(name).is_file() {
            return Err(format!("恢复备份缺少 {name}"));
        }
    }
    for name in list(dir)? {
        fs::remove_file(dir.join(name)).map_err(|e| e.to_string())?;
    }
    for name in &journal.previous {
        let dst = dir.join(name);
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?
        }
        super::sync::atomic_write(
            &dst,
            &fs::read(backup.join(name)).map_err(|e| e.to_string())?,
        )?;
    }
    fs::remove_file(file).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn apply(storage: &mut Storage, payload: &SnapshotPayload) -> Result<(), String> {
    apply_with_config(storage, payload, None)
}
pub(crate) fn apply_with_config(
    storage: &mut Storage,
    payload: &SnapshotPayload,
    recovery_config: Option<schedule_core::Config>,
) -> Result<(), String> {
    if payload.schema_version != 1 {
        return Err("不支持的快照版本".into());
    }
    if payload.files.len() > 1024 {
        return Err("快照文件过多".into());
    }
    let dir = storage.data_dir().to_path_buf();
    recover(&dir)?;
    let token = format!(
        "{}-{}",
        chrono::Utc::now().timestamp_millis(),
        crate::sync::new_token()
    );
    let stage = dir.join(format!(".sync-stage-{token}"));
    fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut total = 0usize;
        let mut decoded = BTreeMap::new();
        for (name, encoded) in &payload.files {
            if !allowed(name) {
                return Err(format!("快照含非法文件名：{name}"));
            }
            if encoded.len() > MAX_BYTES * 4 / 3 + 4 {
                return Err("快照文件过大".into());
            }
            let raw = B64
                .decode(encoded)
                .map_err(|_| "快照编码无效".to_string())?;
            total = total.checked_add(raw.len()).ok_or("快照大小溢出")?;
            if total > MAX_BYTES {
                return Err("快照解压后超过 64 MB 限制".into());
            }
            let dst = stage.join(name);
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?
            }
            fs::write(&dst, &raw).map_err(|e| e.to_string())?;
            decoded.insert(name.clone(), raw);
        }
        let mut config = match recovery_config {
            Some(c) => c,
            None => storage.read_config().map_err(|e| e.to_string())?,
        };
        config.tag_colors = payload.tag_colors.clone();
        config.candidate = payload.candidate.clone();
        let config_raw = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
        fs::write(stage.join("config.json"), &config_raw).map_err(|e| e.to_string())?;
        let mut staged = Storage::new(stage.clone());
        let staged_data = staged.load_all().map_err(|e| e.to_string())?;
        crate::commands::validate_snapshot_data(&staged_data)?;
        staged.read_templates().map_err(|e| e.to_string())?;
        for name in decoded.keys().filter(|n| n.starts_with("archive/")) {
            let month = &name[8..15];
            let archive = staged
                .load_archive_month(month)
                .map_err(|e| e.to_string())?;
            if archive.month != month
                || archive.days.keys().any(|day| {
                    !day.starts_with(&format!("{month}-"))
                        || chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").is_err()
                })
            {
                return Err("快照归档月份或日期不一致".into());
            }
        }
        decoded.insert("config.json".into(), config_raw);
        let previous = list(&dir)?;
        let backup = dir.join(".sync-recovery").join(&token);
        fs::create_dir_all(&backup).map_err(|e| e.to_string())?;
        for name in &previous {
            let dst = backup.join(name);
            if let Some(parent) = dst.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?
            }
            super::sync::atomic_write(&dst, &fs::read(dir.join(name)).map_err(|e| e.to_string())?)?;
        }
        let journal = Journal {
            backup: token,
            previous,
        };
        super::sync::atomic_write(
            &backup.join(BACKUP_INDEX),
            &serde_json::to_vec(&journal.previous).map_err(|e| e.to_string())?,
        )?;
        super::sync::atomic_write(&backup.join(".metadata.json"), &serde_json::to_vec(&serde_json::json!({
            "createdAt":chrono::Utc::now().to_rfc3339(),"platform":std::env::consts::OS,"schemaVersion":schedule_core::CURRENT_VERSION,"source":"before-local-replace"
        })).map_err(|e|e.to_string())?)?;
        super::sync::atomic_write(
            &dir.join(JOURNAL),
            &serde_json::to_vec(&journal).map_err(|e| e.to_string())?,
        )?;
        let commit: Result<(), String> = (|| {
            for name in list(&dir)? {
                if !decoded.contains_key(&name) {
                    fs::remove_file(dir.join(name)).map_err(|e| e.to_string())?;
                }
            }
            for (name, raw) in &decoded {
                super::sync::atomic_write(&dir.join(name), raw)?;
            }
            *storage = Storage::new(dir.clone());
            storage.load_all().map_err(|e| e.to_string())?;
            fs::remove_file(dir.join(JOURNAL)).map_err(|e| e.to_string())?;
            Ok(())
        })();
        if let Err(error) = commit {
            return match recover(&dir) {
                Ok(()) => {
                    *storage = Storage::new(dir.clone());
                    Err(format!("应用失败，已恢复本地数据：{error}"))
                }
                Err(recovery) => Err(format!("应用失败：{error}；恢复未完成：{recovery}")),
            };
        }
        Ok(())
    })();
    let _ = fs::remove_dir_all(&stage);
    if result.is_ok() {
        prune(&dir)
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocked_document_restore_validates_before_moving_the_failed_journal() {
        let (mut storage, mut payload) = fixture();
        let dir = storage.data_dir().to_path_buf();
        let original = fs::read(dir.join("events.json")).unwrap();
        fs::write(dir.join(JOURNAL), b"failed-journal").unwrap();
        payload.files.insert("events.json".into(), B64.encode(b"invalid-backup"));
        assert!(restore_payload_blocked(&mut storage, &payload, Default::default()).is_err());
        assert_eq!(fs::read(dir.join(JOURNAL)).unwrap(), b"failed-journal");
        assert_eq!(fs::read(dir.join("events.json")).unwrap(), original);
        assert!(dir.starts_with(std::env::temp_dir()));fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn blocked_document_restore_keeps_corrupt_live_files_and_failed_journal() {
        let (mut storage, payload) = fixture();
        let dir = storage.data_dir().to_path_buf();
        fs::write(dir.join("events.json"), b"broken-events").unwrap();
        fs::write(dir.join("config.json"), b"broken-config").unwrap();
        fs::write(dir.join(JOURNAL), b"failed-journal").unwrap();
        restore_payload_blocked(&mut storage, &payload, Default::default()).unwrap();
        storage.load_all().unwrap();
        let newest = recovery_points(&dir).unwrap()[0].clone();
        assert_eq!(fs::read(dir.join(".sync-recovery").join(&newest).join("events.json")).unwrap(),b"broken-events");
        assert_eq!(fs::read(dir.join(".sync-recovery").join(&newest).join("config.json")).unwrap(),b"broken-config");
        let failed=fs::read_dir(&dir).unwrap().map(|p|p.unwrap().path()).find(|p|p.file_name().unwrap().to_string_lossy().starts_with(".sync-transaction-failed-")).unwrap();
        assert_eq!(fs::read(failed).unwrap(), b"failed-journal");
        assert!(dir.starts_with(std::env::temp_dir()));fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn blocked_point_restore_retains_valid_current_device_preferences() {
        let (mut storage, payload) = fixture();
        apply(&mut storage, &payload).unwrap();
        let point = recovery_points(storage.data_dir()).unwrap()[0].clone();
        let mut config=storage.read_config().unwrap();config.timezone="UTC".into();config.appearance.theme="dark".into();storage.save_config(&config).unwrap();
        fs::write(storage.data_dir().join(JOURNAL), b"failed-journal").unwrap();
        restore_blocked(&mut storage, &point).unwrap();
        assert_eq!(storage.read_config().unwrap().timezone,"UTC");assert_eq!(storage.read_config().unwrap().appearance.theme,"dark");
        let dir=storage.data_dir().to_path_buf();assert!(dir.starts_with(std::env::temp_dir()));fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn isolated_edit_failure_leaves_all_live_files_and_config_unchanged() {
        let (mut s, before) = fixture();
        let result: Result<(), String> = edit(&mut s, |stage| {
            let mut config = stage.read_config().unwrap();
            config.tag_colors.insert("qa".into(), "red".into());
            stage.save_config(&config).unwrap();
            stage.save_tasks(&[]).unwrap();
            Err("injected failure after partial staged writes".into())
        });
        assert!(result.is_err());
        assert_eq!(serde_json::to_vec(&crate::sync::build_payload(&mut s).unwrap()).unwrap(), serde_json::to_vec(&before).unwrap());
        assert!(s.read_config().unwrap().tag_colors.is_empty());
        assert!(!s.data_dir().join("tasks.json").exists());
        assert!(recovery_points(s.data_dir()).unwrap().is_empty());
        fs::remove_dir_all(s.data_dir()).unwrap();
    }
    #[test]
    fn isolated_edit_commits_all_files_and_preserves_external_edits() {
        let (mut s, _) = fixture();
        edit(&mut s, |stage| {
            let mut config = stage.read_config().map_err(|e|e.to_string())?;
            config.tag_colors.insert("qa".into(), "red".into());
            stage.save_config(&config).map_err(|e|e.to_string())?;
            stage.save_tasks(&[]).map_err(|e|e.to_string())?;
            Ok(())
        }).unwrap();
        assert!(s.read_config().unwrap().tag_colors.contains_key("qa"));
        assert!(s.data_dir().join("tasks.json").exists());
        assert_eq!(recovery_points(s.data_dir()).unwrap().len(), 1);
        let live = s.data_dir().join("events.json");
        let external = br#"{"version":6,"events":[],"external":true}"#;
        assert!(edit(&mut s, |_| {fs::write(&live, external).unwrap();Ok(())}).is_err());
        assert_eq!(fs::read(live).unwrap(), external);
        fs::remove_dir_all(s.data_dir()).unwrap();
    }
    #[test]
    fn corrupt_journal_recovery_keeps_failed_log_and_pre_restore_files() {
        let (mut s, payload) = fixture();
        apply(&mut s, &payload).unwrap();
        let id = recovery_points(s.data_dir()).unwrap()[0].clone();
        fs::write(s.data_dir().join(JOURNAL), b"corrupt-journal").unwrap();
        fs::write(s.data_dir().join("config.json"), b"broken-current-config").unwrap();
        assert!(recover(s.data_dir()).is_err());
        restore_blocked(&mut s, &id).unwrap();
        s.load_all().unwrap();
        assert!(!s.data_dir().join(JOURNAL).exists());
        assert!(fs::read_dir(s.data_dir()).unwrap().any(|p| p
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".sync-transaction-failed-")));
        let newest = recovery_points(s.data_dir()).unwrap()[0].clone();
        assert_eq!(
            fs::read(
                s.data_dir()
                    .join(".sync-recovery")
                    .join(newest)
                    .join("config.json")
            )
            .unwrap(),
            b"broken-current-config"
        );
        fs::remove_dir_all(s.data_dir()).unwrap();
    }
    #[test]
    fn invalid_recovery_point_never_moves_corrupt_live_journal() {
        let (mut s, payload) = fixture();
        apply(&mut s, &payload).unwrap();
        let id = recovery_points(s.data_dir()).unwrap()[0].clone();
        fs::write(
            s.data_dir()
                .join(".sync-recovery")
                .join(&id)
                .join("events.json"),
            b"invalid-backup",
        )
        .unwrap();
        fs::write(s.data_dir().join(JOURNAL), b"live-journal").unwrap();
        assert!(restore_blocked(&mut s, &id).is_err());
        assert_eq!(
            fs::read(s.data_dir().join(JOURNAL)).unwrap(),
            b"live-journal"
        );
        fs::remove_dir_all(s.data_dir()).unwrap();
    }
    #[test]
    fn restore_point_preserves_pre_restore_data_and_limits_history() {
        let (mut s, mut payload) = fixture();
        payload.tag_colors.insert("qa".into(), "red".into());
        apply(&mut s, &payload).unwrap();
        let original = recovery_points(s.data_dir()).unwrap().pop().unwrap();
        assert!(s.read_config().unwrap().tag_colors.contains_key("qa"));
        restore_point(&mut s, &original).unwrap();
        assert!(s.read_config().unwrap().tag_colors.is_empty());
        for _ in 0..6 {
            apply(&mut s, &payload).unwrap();
        }
        assert_eq!(recovery_points(s.data_dir()).unwrap().len(), 5);
        let details = recovery_details(s.data_dir()).unwrap();
        assert_eq!(details.len(), 5);
        assert!(details.iter().all(|d| d.complete
            && d.schema_version == schedule_core::CURRENT_VERSION as u64
            && !d.platform.is_empty()));
        assert!(restore_point(&mut s, "../outside").is_err());
        fs::remove_dir_all(s.data_dir()).unwrap();
    }
    fn fixture() -> (Storage, SnapshotPayload) {
        let dir =
            std::env::temp_dir().join(format!("moment-snapshot-{}", crate::sync::new_token()));
        let mut s = Storage::new(dir);
        s.ensure().unwrap();
        s.save_events(&[]).unwrap();
        s.save_config(&Default::default()).unwrap();
        let p = crate::sync::build_payload(&mut s).unwrap();
        (s, p)
    }
    #[test]
    fn rejects_paths_and_bad_json_before_writing() {
        let (mut s, mut p) = fixture();
        let before = fs::read(s.data_dir().join("events.json")).unwrap();
        for name in [
            "C:\\escape.json",
            "../escape.json",
            "archive/../../escape.json",
            "archive/2026-99.json",
        ] {
            p.files.insert(name.into(), B64.encode(b"{}"));
            assert!(apply(&mut s, &p).is_err());
            p.files.remove(name);
        }
        p.files
            .insert("templates.json".into(), B64.encode(b"invalid-json"));
        assert!(apply(&mut s, &p).is_err());
        assert_eq!(fs::read(s.data_dir().join("events.json")).unwrap(), before);
        p.files.remove("templates.json");
        p.files.insert("events.json".into(),B64.encode(br#"{"version":6,"events":[{"id":"bad","title":"QA","start":"invalid-date","allDay":false,"reminders":[],"tags":[],"priority":"high","status":"active","createdAt":"","updatedAt":""}]}"#));
        assert!(apply(&mut s, &p).is_err());
        assert_eq!(fs::read(s.data_dir().join("events.json")).unwrap(), before);
        p.files.remove("templates.json");
        p.files.insert("events.json".into(),B64.encode(br#"{"version":6,"events":[{"id":"bad","title":"QA","start":"invalid-date","allDay":false,"reminders":[],"tags":[],"priority":"high","status":"active","createdAt":"","updatedAt":""}]}"#));
        assert!(apply(&mut s, &p).is_err());
        assert_eq!(fs::read(s.data_dir().join("events.json")).unwrap(), before);
        fs::remove_dir_all(s.data_dir()).unwrap();
    }
    #[test]
    fn complete_snapshot_removes_stale_files_and_is_idempotent() {
        let (mut s, p) = fixture();
        s.save_tasks(&[]).unwrap();
        fs::write(
            s.data_dir().join("archive/2020-01.json"),
            br#"{"version":6,"month":"2020-01","days":{}}"#,
        )
        .unwrap();
        apply(&mut s, &p).unwrap();
        assert!(!s.data_dir().join("tasks.json").exists());
        assert!(!s.data_dir().join("archive/2020-01.json").exists());
        apply(&mut s, &p).unwrap();
        s.load_all().unwrap();
        fs::remove_dir_all(s.data_dir()).unwrap();
    }
    #[test]
    fn recovers_interrupted_transaction_including_config() {
        let (mut s, _) = fixture();
        let dir = s.data_dir().to_path_buf();
        let backup = dir.join(".sync-recovery/test");
        fs::create_dir_all(&backup).unwrap();
        let previous = list(&dir).unwrap();
        for n in &previous {
            fs::copy(dir.join(n), backup.join(n)).unwrap();
        }
        fs::write(
            dir.join(JOURNAL),
            serde_json::to_vec(&Journal {
                backup: "test".into(),
                previous,
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(dir.join("config.json"), b"broken").unwrap();
        // Simulate the transaction's raw partial commit, bypassing the public
        // storage write guard that now rejects pending journals.
        fs::write(dir.join("tasks.json"), br#"{"version":6,"tasks":[]}"#).unwrap();
        recover(&dir).unwrap();
        assert!(!dir.join("tasks.json").exists());
        s.read_config().unwrap();
        recover(&dir).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
}
