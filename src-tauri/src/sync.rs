//! 七牛 Kodo 单设备互斥快照同步（V2.0 Lite）。
//!
//! 密钥仅存放于 Windows Credential Manager；同步配置与状态保存于应用根目录，
//! 快照经过 zstd 压缩、Argon2id 派生密钥和 AES-256-GCM 加密后上传。

use std::{
    collections::BTreeMap,
    fs,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::sync_protocol::{self as protocol, ObjectStore};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chrono::Utc;
use hmac::{Hmac, Mac};
#[cfg(not(target_os = "android"))]
use keyring::Entry;
#[cfg(target_os = "android")]
use keyring_core::Entry;
use qiniu_sdk::{
    credential::Credential,
    http::Uri,
    prelude::*,
    upload::{ObjectParams, UploadManager, UploadTokenSigner},
};
use rand::RngCore;
use schedule_core::{CandidateConfig, Storage};
use serde::{Deserialize, Serialize};

const PROFILE_FILE: &str = "sync.json";
const STATE_FILE: &str = "sync-state.json";
const SERVICE: &str = "com.personal.schedule.qiniu-sync";
const LEASE_SECS: i64 = 30 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigInput {
    pub bucket: String,
    pub download_domain: String,
    #[serde(default = "default_prefix")]
    pub prefix: String,
    pub device_name: String,
    pub access_key: String,
    pub secret_key: String,
    pub passphrase: String,
}

fn default_prefix() -> String {
    "moment-sync/v2".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProfile {
    pub version: u32,
    pub bucket: String,
    pub download_domain: String,
    pub prefix: String,
    pub device_id: String,
    #[serde(default)]
    pub credential_id: Option<String>,
    pub device_name: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SyncStateFile {
    #[serde(default)]
    generation: u64,
    #[serde(default)]
    ready: bool,
    #[serde(default)]
    last_revision: u64,
    #[serde(default)]
    last_sync_at: Option<String>,
    #[serde(default)]
    dirty: bool,
    #[serde(default)]
    dirty_since_ms: Option<u128>,
    #[serde(default)]
    last_fingerprint: String,
    #[serde(default)]
    last_error: Option<String>,
    #[serde(default)]
    needs_initial_choice: bool,
    #[serde(default)]
    held_lease: Option<Lease>,
    #[serde(default)]
    locked_by: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub syncing: bool,
    pub retry_at: Option<String>,
    pub editable: bool,
    pub configured: bool,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub revision: u64,
    pub dirty: bool,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    pub locked_by: Option<String>,
    pub needs_initial_choice: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitialSyncChoiceInput {
    pub choice: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Manifest {
    #[serde(default)]
    pub(crate) fingerprint: String,
    pub(crate) schema_version: u32,
    pub(crate) revision: u64,
    pub(crate) snapshot_key: String,
    pub(crate) updated_at: String,
    pub(crate) updated_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Lease {
    pub(crate) device_id: String,
    pub(crate) device_name: String,
    pub(crate) revision: u64,
    pub(crate) lock_token: String,
    pub(crate) locked_at: String,
    pub(crate) expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SnapshotPayload {
    pub(crate) schema_version: u32,
    pub(crate) files: BTreeMap<String, String>,
    pub(crate) tag_colors: BTreeMap<String, String>,
    pub(crate) candidate: CandidateConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedSnapshot {
    format: String,
    salt: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Default)]
pub struct SyncControl {
    pub busy: AtomicBool,
    pub cancel: AtomicBool,
    failures: AtomicU32,
    retry_at: Mutex<Option<i64>>,
}
impl SyncControl {
    pub fn retry_due(&self) -> bool {
        self.retry_at
            .lock()
            .map(|t| t.map(|t| Utc::now().timestamp() >= t).unwrap_or(true))
            .unwrap_or(false)
    }
    pub fn completed(&self, success: bool) {
        if success {
            self.failures.store(0, Ordering::SeqCst);
            if let Ok(mut at) = self.retry_at.lock() {
                *at = None;
            }
        } else {
            let n = self.failures.fetch_add(1, Ordering::SeqCst).min(6);
            if let Ok(mut at) = self.retry_at.lock() {
                *at = Some(Utc::now().timestamp() + (5i64 * (1i64 << n)).min(300));
            }
        }
        self.busy.store(false, Ordering::SeqCst);
    }
    fn retry_time(&self) -> Option<String> {
        self.retry_at
            .lock()
            .ok()
            .and_then(|at| *at)
            .and_then(|t| chrono::DateTime::<Utc>::from_timestamp(t, 0))
            .map(|t| t.to_rfc3339())
    }
}
fn cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        Err("同步已取消，本地修改已保留".into())
    } else {
        Ok(())
    }
}
thread_local! { static NETWORK_CONTROL: std::cell::RefCell<Option<Arc<SyncControl>>> = const { std::cell::RefCell::new(None) }; }
pub(crate) struct NetworkScope(Option<Arc<SyncControl>>);
pub(crate) fn network_scope(control: Arc<SyncControl>) -> NetworkScope {
    NetworkScope(NETWORK_CONTROL.with(|current|current.replace(Some(control))))
}
impl Drop for NetworkScope {
    fn drop(&mut self) { NETWORK_CONTROL.with(|current|current.replace(self.0.take())); }
}
fn network_cancelled() -> Result<(),String> {
    NETWORK_CONTROL.with(|current|match current.borrow().as_ref(){Some(control)=>cancelled(&control.cancel),None=>Ok(())})
}
pub struct SyncService {
    base_dir: PathBuf,
    control: Arc<SyncControl>,
    recovery_error: Option<String>,
}

impl SyncService {
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            base_dir,
            control: Arc::new(SyncControl::default()),
            recovery_error: None,
        }
    }
    pub fn with_runtime(
        mut self,
        control: Arc<SyncControl>,
        recovery_error: Option<String>,
    ) -> Self {
        self.control = control;
        self.recovery_error = recovery_error;
        self
    }
    pub fn diagnostics(&self) -> serde_json::Value {
        let status = self.status();
        let code = match status.last_error.as_deref() {
            None => "none",
            Some(e) if e.contains("取消") => "cancelled",
            Some(e) if e.contains("版本") => "revision_or_protocol",
            Some(e) if e.contains("恢复") || e.contains("损坏") => "recovery_required",
            Some(e) if e.contains("凭据") || e.contains("口令") => "credentials",
            Some(e) if e.contains("租约") || e.contains("使用") => "lease",
            Some(_) => "connection_or_operation",
        };
        serde_json::json!({"format":"moment-diagnostics-v1","appVersion":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS,"recordedAt":Utc::now().to_rfc3339(),
            "configured":status.configured,"editable":status.editable,"syncing":status.syncing,"revision":status.revision,"dirty":status.dirty,"retryAt":status.retry_at,
            "lastSyncAt":status.last_sync_at,"errorCode":code,"recoveryRequired":self.recovery_error.is_some()})
    }
    fn profile_path(&self) -> PathBuf {
        self.base_dir.join(PROFILE_FILE)
    }
    fn state_path(&self) -> PathBuf {
        self.base_dir.join(STATE_FILE)
    }

    fn read_profile(&self) -> Result<Option<SyncProfile>, String> {
        let p = self.profile_path();
        if !p.exists() {
            return Ok(None);
        }
        serde_json::from_str(&fs::read_to_string(p).map_err(|e| e.to_string())?)
            .map(Some)
            .map_err(|e| e.to_string())
    }
    fn save_profile(&self, p: &SyncProfile) -> Result<(), String> {
        atomic_write(
            &self.profile_path(),
            &serde_json::to_vec_pretty(p).map_err(|e| e.to_string())?,
        )
    }
    fn read_state(&self) -> Result<SyncStateFile, String> {
        match fs::read(self.state_path()) {
            Ok(raw) => serde_json::from_slice(&raw)
                .map_err(|_| "同步状态损坏，请保留数据并恢复备份，禁止自动重置版本".to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SyncStateFile::default()),
            Err(e) => Err(format!("读取同步状态失败：{e}")),
        }
    }
    fn save_state(&self, s: &SyncStateFile) -> Result<(), String> {
        atomic_write(
            &self.state_path(),
            &serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?,
        )
    }

    pub fn configure(&self, input: SyncConfigInput) -> Result<SyncStatus, String> {
        self.configure_using(input, &SystemVault)
    }

    fn configure_using(
        &self,
        input: SyncConfigInput,
        vault: &impl Vault,
    ) -> Result<SyncStatus, String> {
        validate_input(&input)?;
        let existing = self.read_profile()?;
        let domain = normalize_domain(&input.download_domain)?;
        let prefix = normalize_prefix(&input.prefix)?;
        if existing
            .as_ref()
            .map(|p| {
                p.bucket != input.bucket.trim() || p.prefix != prefix || p.download_domain != domain
            })
            .unwrap_or(false)
        {
            return Err("更换同步空间前请先导出备份并断开当前同步，避免混用版本与设备锁".into());
        }
        let original_state = self.read_state()?;
        let fields = [
            ("access-key", input.access_key.trim(), "AccessKey"),
            ("secret-key", input.secret_key.trim(), "SecretKey"),
            ("passphrase", input.passphrase.trim(), "同步口令"),
        ];
        let mut values = Vec::new();
        // Resolve and validate every field before writing anything.
        for (kind, supplied, label) in fields {
            let value = if supplied.is_empty() {
                let old = existing
                    .as_ref()
                    .ok_or_else(|| format!("{label} 未保存，请填写后再保存配置"))?;
                vault.read(credential_id(old), kind)?
            } else {
                supplied.to_string()
            };
            if kind == "passphrase" && !supplied.is_empty() && original_state.last_revision > 0 {
                if let Some(old) = &existing {
                    if value != vault.read(credential_id(old), kind)? {
                        return Err(
                            "已有同步快照时不能直接更换同步口令，请导出备份后使用新的同步前缀"
                                .into(),
                        );
                    }
                }
            }
            values.push((kind, value));
        }
        let staged_id = format!("credentials-{}", new_token());
        let profile = SyncProfile {
            version: 1,
            bucket: input.bucket.trim().into(),
            download_domain: domain,
            prefix,
            device_id: existing
                .as_ref()
                .map(|p| p.device_id.clone())
                .unwrap_or_else(new_device_id),
            credential_id: Some(staged_id.clone()),
            device_name: input.device_name.trim().into(),
        };
        let result = (|| {
            for (kind, value) in &values {
                vault.write(&staged_id, kind, value)?;
            }
            let mut next_state = original_state.clone();
            next_state.last_error = None;
            // Changing credentials must be validated before editing resumes.
            next_state.ready = false;
            self.save_state(&next_state)?;
            if let Err(error) = self.save_profile(&profile) {
                return match self.save_state(&original_state) {
                    Ok(()) => Err(error),
                    Err(rollback) => Err(format!("{error}；配置回滚未完成：{rollback}")),
                };
            }
            Ok(())
        })();
        if let Err(error) = result {
            for (kind, _) in &values {
                let _ = vault.delete(&staged_id, kind);
            }
            return Err(error);
        }
        // Only the atomic profile switch makes a staged credential set active.
        // The old set stays intact if any preceding write fails.
        if let Some(old) = existing {
            for (kind, _) in &values {
                let _ = vault.delete(credential_id(&old), kind);
            }
        }
        Ok(self.status())
    }

    pub fn disconnect(&self, storage: &Mutex<Storage>) -> Result<(), String> {
        // Freeze writes before releasing the remote lease. Offline disconnect
        // preserves local data even when the best-effort release fails.
        let _ = self.release(storage);
        local(storage, |_| self.disconnect_local())
    }
    fn disconnect_local(&self) -> Result<(), String> {
        if let Some(p) = self.read_profile().ok().flatten() {
            for key in ["access-key", "secret-key", "passphrase"] {
                let _ = delete_secret(credential_id(&p), key);
            }
        }
        // Preserve damaged metadata for diagnostics instead of silently resetting it.
        for file in [self.profile_path(), self.state_path()] {
            if file.exists() {
                let detached = file.with_extension(format!("detached-{}.json", new_token()));
                fs::rename(file, detached).map_err(|e| format!("断开同步时无法保留原状态：{e}"))?;
            }
        }
        Ok(())
    }

    pub fn status(&self) -> SyncStatus {
        let loaded = self.read_state();
        let error = self
            .recovery_error
            .clone()
            .or_else(|| loaded.as_ref().err().cloned());
        let state = loaded.unwrap_or_default();
        match self.read_profile().ok().flatten() {
            Some(p) => {
                let editable = error.is_none()
                    && state.ready
                    && !state.needs_initial_choice
                    && state.locked_by.is_none()
                    && state
                        .held_lease
                        .as_ref()
                        .map(|l| l.device_id == p.device_id && protocol::valid_until(l, Utc::now()))
                        .unwrap_or(false);
                SyncStatus {
                    syncing: self.control.busy.load(Ordering::SeqCst),
                    retry_at: self.control.retry_time(),
                    editable,
                    configured: true,
                    device_id: Some(p.device_id),
                    device_name: Some(p.device_name),
                    revision: state.last_revision,
                    dirty: state.dirty,
                    last_sync_at: state.last_sync_at,
                    last_error: error.or(state.last_error),
                    locked_by: state.locked_by,
                    needs_initial_choice: state.needs_initial_choice,
                }
            }
            None => {
                let profile_error = self.read_profile().err();
                SyncStatus {
                    syncing: self.control.busy.load(Ordering::SeqCst),
                    retry_at: self.control.retry_time(),
                    editable: profile_error.is_none() && error.is_none(),
                    configured: profile_error.is_some(),
                    device_id: None,
                    device_name: None,
                    revision: 0,
                    dirty: false,
                    last_sync_at: None,
                    last_error: profile_error.or(error),
                    locked_by: None,
                    needs_initial_choice: false,
                }
            }
        }
    }

    /// Called while holding the business storage lock, before every mutation.
    /// Persist intent before writing: a process crash cannot erase dirty state.
    pub fn prepare_write(&self) -> Result<(), String> {
        if let Some(error) = &self.recovery_error {
            return Err(format!("需要恢复数据：{error}"));
        }
        self.read_state()?;
        if self.read_profile()?.is_none() {
            return Ok(());
        }
        let status = self.status();
        if !status.editable {
            return Err(status
                .last_error
                .unwrap_or_else(|| "当前为只读状态，请先同步并获取编辑权".into()));
        }
        let mut state = self.read_state()?;
        state.dirty = true;
        state.generation = state.generation.checked_add(1).ok_or("本地修改版本溢出")?;
        state.dirty_since_ms = Some(now_ms());
        self.save_state(&state)
    }

    pub fn test_connection(&self) -> Result<SyncStatus, String> {
        let p = self
            .read_profile()?
            .ok_or_else(|| "请先保存七牛同步配置".to_string())?;
        let s = secrets(&p)?;
        let _ = read_manifest(&p, &s)?;
        let key = format!("{}/checks/{}.json", p.prefix, new_token());
        put_object(&p, &s, &key, b"create-only-v2".to_vec())?;
        if put_object(&p, &s, &key, b"must-not-overwrite".to_vec()).is_ok() {
            return Err("对象存储未拒绝覆盖写入，不能用于安全同步".into());
        }
        if get_object(&p, &s, &key)?.as_deref() != Some(b"create-only-v2") {
            return Err("对象存储无法即时读取已提交记录，不能用于安全同步".into());
        }
        Ok(self.status())
    }

    pub fn record_error(&self, error: &str) {
        if let Ok(mut state) = self.read_state() {
            state.last_error = Some(error.to_string());
            if ["不支持", "旧同步协议", "损坏", "远端版本", "租约已失效"]
                .iter()
                .any(|text| error.contains(text))
            {
                state.ready = false;
            }
            let _ = self.save_state(&state);
        }
    }

    pub fn mark_dirty(&self, storage: &mut Storage) -> Result<(), String> {
        let Some(_) = self.read_profile()? else {
            return Ok(());
        };
        let fingerprint = fingerprint(storage)?;
        let mut state = self.read_state()?;
        if state.last_fingerprint != fingerprint {
            state.last_fingerprint = fingerprint;
            state.generation = state.generation.checked_add(1).ok_or("本地修改版本溢出")?;
            state.dirty = true;
            state.dirty_since_ms = Some(now_ms());
        }
        self.save_state(&state)
    }

    pub fn tick(&self, storage: &Mutex<Storage>) -> Result<SyncStatus, String> {
        if self.read_profile()?.is_none() {
            return Ok(self.status());
        }
        let due = local(storage, |s| {
            self.mark_dirty(s)?;
            let st = self.read_state()?;
            Ok(!st.ready
                || st
                    .held_lease
                    .as_ref()
                    .map(|l| !protocol::valid_until(l, Utc::now() + chrono::Duration::minutes(5)))
                    .unwrap_or(true)
                || (st.dirty
                    && st
                        .dirty_since_ms
                        .map(|t| now_ms().saturating_sub(t) >= 30_000)
                        .unwrap_or(false)))
        })?;
        if due {
            self.sync(storage, false)
        } else {
            Ok(self.status())
        }
    }

    pub fn sync(&self, storage: &Mutex<Storage>, takeover: bool) -> Result<SyncStatus, String> {
        let profile = self.read_profile()?.ok_or("尚未配置七牛同步")?;
        let credentials = secrets(&profile)?;
        self.sync_using(
            storage,
            &Remote {
                profile: &profile,
                secrets: &credentials,
            },
            None,
            takeover,
        )
    }

    fn sync_using(
        &self,
        storage: &Mutex<Storage>,
        remote: &impl SyncRemote,
        choice: Option<&str>,
        takeover: bool,
    ) -> Result<SyncStatus, String> {
        if let Some(error) = &self.recovery_error {
            return Err(format!("需要恢复数据：{error}"));
        }
        cancelled(&self.control.cancel)?;
        let mut lease_state = local(storage, |_| self.read_state())?;
        if lease_state.needs_initial_choice && choice.is_none() {
            return Err("本地和远端均有数据，请选择首次同步方式".into());
        }
        // Network phases never hold the business storage lock.
        remote.manifest()?;
        cancelled(&self.control.cancel)?;
        if let Err(error) = remote.acquire(&mut lease_state, takeover) {
            local(storage, |_| {
                let mut current = self.read_state()?;
                current.ready = false;
                current.last_error = Some(error.clone());
                current.locked_by = lock_owner(&error);
                self.save_state(&current)
            })?;
            return Err(error);
        }
        local(storage, |_| {
            let mut current = self.read_state()?;
            current.held_lease = lease_state.held_lease.clone();
            current.ready &= lease_state.ready;
            current.locked_by = None;
            self.save_state(&current)
        })?;
        let manifest = remote.manifest()?;
        cancelled(&self.control.cancel)?;
        let (state, payload, captured, generation, has_data) = local(storage, |s| {
            self.mark_dirty(s)?;
            let st = self.read_state()?;
            let payload = build_payload(s)?;
            let captured = payload_fingerprint(&payload)?;
            let has_data = has_syncable_data(s.data_dir())?;
            let generation = st.generation;
            Ok((st, payload, captured, generation, has_data))
        })?;
        let held = state.held_lease.clone().ok_or("缺少编辑租约")?;
        if let Some(m) = &manifest {
            if m.revision < state.last_revision {
                return Err("远端版本倒退，已保留本地数据，请检查同步空间或恢复记录".into());
            }
            if choice != Some("download") && !m.fingerprint.is_empty() && m.fingerprint == captured
            {
                return self.finish_sync(storage, m.revision, &captured, generation);
            }
        }
        if choice.is_none() && state.last_revision == 0 && manifest.is_some() && has_data {
            local(storage, |_| {
                let mut current = self.read_state()?;
                current.needs_initial_choice = true;
                current.ready = false;
                current.last_error = Some("本地和远端均有数据，请选择首次同步方式".into());
                self.save_state(&current)
            })?;
            return Err("本地和远端均有数据，请选择首次同步方式".into());
        }
        let download = choice == Some("download")
            || (choice.is_none()
                && manifest
                    .as_ref()
                    .map(|m| m.revision > state.last_revision)
                    .unwrap_or(false)
                && (!state.dirty || (state.last_revision == 0 && !has_data)));
        if download {
            let m = manifest.ok_or("远端尚无快照，无法下载")?;
            let downloaded = remote.download(&m)?;
            cancelled(&self.control.cancel)?;
            remote.verify(&held, m.revision)?;
            cancelled(&self.control.cancel)?;
            local(storage, |s| {
                let current = self.read_state()?;
                if current.generation != generation || fingerprint(s)? != captured {
                    return Err("下载期间本地发生修改，已保留本地数据，请重新同步".into());
                }
                apply_payload(s, &downloaded)?;
                self.finish_sync_locked(
                    s,
                    m.revision,
                    &payload_fingerprint(&downloaded)?,
                    generation,
                )
            })
        } else if state.dirty || manifest.is_none() || choice == Some("upload") {
            let base = manifest.as_ref().map(|m| m.revision).unwrap_or(0);
            if choice != Some("upload") && base != state.last_revision {
                return Err(
                    "远端版本已变化，已保留本地数据，拒绝覆盖，请导出副本后处理冲突".into(),
                );
            }
            let revision = base.checked_add(1).ok_or("同步版本溢出")?;
            cancelled(&self.control.cancel)?;
            remote.upload(&payload, revision, &held, &self.control.cancel)?;
            self.finish_sync(storage, revision, &captured, generation)
        } else {
            self.finish_sync(storage, state.last_revision, &captured, generation)
        }
    }

    fn finish_sync(
        &self,
        storage: &Mutex<Storage>,
        revision: u64,
        uploaded: &str,
        generation: u64,
    ) -> Result<SyncStatus, String> {
        local(storage, |s| {
            self.finish_sync_locked(s, revision, uploaded, generation)
        })
    }
    fn finish_sync_locked(
        &self,
        storage: &mut Storage,
        revision: u64,
        uploaded: &str,
        generation: u64,
    ) -> Result<SyncStatus, String> {
        let current_fingerprint = fingerprint(storage)?;
        let mut state = self.read_state()?;
        // Preserve edits made during encryption/upload, including a change that
        // was later undone to the captured content.
        state.dirty = state.generation != generation || current_fingerprint != uploaded;
        if state.dirty {
            state.dirty_since_ms.get_or_insert_with(now_ms);
        } else {
            state.dirty_since_ms = None;
        }
        state.last_fingerprint = current_fingerprint;
        state.last_revision = revision;
        state.ready = true;
        state.needs_initial_choice = false;
        state.locked_by = None;
        state.last_error = None;
        state.last_sync_at = Some(Utc::now().to_rfc3339());
        self.save_state(&state)?;
        Ok(self.status())
    }

    pub fn resolve_initial(
        &self,
        storage: &Mutex<Storage>,
        input: InitialSyncChoiceInput,
    ) -> Result<SyncStatus, String> {
        if input.choice == "cancel" {
            return Ok(self.status());
        }
        if input.choice != "upload" && input.choice != "download" {
            return Err("首次同步选择无效".into());
        }
        let p = self.read_profile()?.ok_or("尚未配置七牛同步")?;
        let s = secrets(&p)?;
        self.sync_using(
            storage,
            &Remote {
                profile: &p,
                secrets: &s,
            },
            Some(&input.choice),
            false,
        )
    }

    /// The final exit boundary shares the same storage lock as every business
    /// mutation. Recheck the actual fingerprint and freeze writers atomically;
    /// an upload completing with newer pending edits must retain its lease.
    pub fn freeze_clean_exit(&self, storage: &Mutex<Storage>) -> Result<(), String> {
        local(storage, |s| {
            self.mark_dirty(s)?;
            let mut state = self.read_state()?;
            if state.dirty {
                return Err("退出同步期间有新的本地修改，请返回应用再次同步后退出".into());
            }
            state.ready = false;
            self.save_state(&state)
        })
    }

    pub fn release(&self, storage: &Mutex<Storage>) -> Result<(), String> {
        let Some(profile) = self.read_profile()? else {
            return Ok(());
        };
        let credentials = secrets(&profile)?;
        let state = local(storage, |_| {
            let mut st = self.read_state()?;
            st.ready = false;
            self.save_state(&st)?;
            Ok(st)
        })?;
        if let Some(lease) = state.held_lease.as_ref() {
            release_lease(&profile, &credentials, lease)?;
        }
        local(storage, |_| {
            let mut st = self.read_state()?;
            st.held_lease = None;
            self.save_state(&st)
        })
    }
}

fn local<T>(
    storage: &Mutex<Storage>,
    work: impl FnOnce(&mut Storage) -> Result<T, String>,
) -> Result<T, String> {
    let mut locked = storage.lock().map_err(|_| "存储锁获取失败")?;
    work(&mut locked)
}

trait SyncRemote {
    fn manifest(&self) -> Result<Option<Manifest>, String>;
    fn acquire(&self, state: &mut SyncStateFile, takeover: bool) -> Result<(), String>;
    fn upload(
        &self,
        payload: &SnapshotPayload,
        revision: u64,
        held: &Lease,
        cancel: &AtomicBool,
    ) -> Result<(), String>;
    fn download(&self, manifest: &Manifest) -> Result<SnapshotPayload, String>;
    fn verify(&self, held: &Lease, revision: u64) -> Result<(), String>;
}

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(30))
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(30))
        .timeout_write(Duration::from_secs(30))
        .build()
}
struct Secrets {
    ak: String,
    sk: String,
    passphrase: String,
}
fn secret_entry(device: &str, kind: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("{device}:{kind}")).map_err(|e| e.to_string())
}
fn set_secret(device: &str, kind: &str, value: &str) -> Result<(), String> {
    secret_entry(device, kind)?
        .set_password(value)
        .map_err(|e| e.to_string())
}
fn delete_secret(device: &str, kind: &str) -> Result<(), String> {
    secret_entry(device, kind)?
        .delete_credential()
        .map_err(|e| e.to_string())
}
trait Vault {
    fn read(&self, id: &str, kind: &str) -> Result<String, String>;
    fn write(&self, id: &str, kind: &str, value: &str) -> Result<(), String>;
    fn delete(&self, id: &str, kind: &str) -> Result<(), String>;
}
struct SystemVault;
impl Vault for SystemVault {
    fn read(&self, id: &str, kind: &str) -> Result<String, String> {
        secret_entry(id, kind)?
            .get_password()
            .map_err(|_| "系统凭据读取失败，请重新填写同步凭据".into())
    }
    fn write(&self, id: &str, kind: &str, value: &str) -> Result<(), String> {
        set_secret(id, kind, value)
    }
    fn delete(&self, id: &str, kind: &str) -> Result<(), String> {
        delete_secret(id, kind)
    }
}
fn credential_id(p: &SyncProfile) -> &str {
    p.credential_id.as_deref().unwrap_or(&p.device_id)
}
fn secrets(p: &SyncProfile) -> Result<Secrets, String> {
    Ok(Secrets {
        ak: secret_entry(credential_id(p), "access-key")?
            .get_password()
            .map_err(|_| "未找到 AccessKey，请重新配置同步".to_string())?,
        sk: secret_entry(credential_id(p), "secret-key")?
            .get_password()
            .map_err(|_| "未找到 SecretKey，请重新配置同步".to_string())?,
        passphrase: secret_entry(credential_id(p), "passphrase")?
            .get_password()
            .map_err(|_| "未找到同步口令，请重新配置同步".to_string())?,
    })
}

fn response_bytes(response: ureq::Response) -> Result<Vec<u8>, String> {
    validate_response_clock(&response)?;
    let mut raw = Vec::new();
    response
        .into_reader()
        .take(crate::sync_snapshot::MAX_BYTES as u64 + 1)
        .read_to_end(&mut raw)
        .map_err(|_| "读取同步对象失败".to_string())?;
    if raw.len() > crate::sync_snapshot::MAX_BYTES {
        return Err("同步对象超过大小限制".into());
    }
    Ok(raw)
}

fn validate_response_clock(response: &ureq::Response) -> Result<(), String> {
    if let Some(date) = response.header("Date") {
        let server = chrono::DateTime::parse_from_rfc2822(date)
            .map_err(|_| "同步服务器时间无效".to_string())?;
        if (Utc::now() - server.with_timezone(&Utc))
            .num_seconds()
            .abs()
            > 120
        {
            return Err("本机与服务器时钟相差超过两分钟，请校准系统时间后同步".into());
        }
    }
    Ok(())
}
fn get_object(p: &SyncProfile, s: &Secrets, key: &str) -> Result<Option<Vec<u8>>, String> {
    network_cancelled()?;
    if is_qiniu_s3_domain(&p.download_domain) {
        return s3_get_object(p, s, key);
    }
    let base: Uri = format!(
        "{}/{}?moment_read={}",
        p.download_domain.trim_end_matches('/'),
        key,
        new_token()
    )
    .parse()
    .map_err(|e| format!("下载域名无效：{e}"))?;
    let credential = Credential::new(&s.ak, &s.sk);
    let signed = credential.sign_download_url(base, Duration::from_secs(600));
    match http_agent()
        .get(&signed.to_string())
        .set("Cache-Control", "no-cache")
        .call()
    {
        Ok(r) => response_bytes(r).map(Some),
        Err(ureq::Error::Status(404, response)) => {
            validate_response_clock(&response)?;
            Ok(None)
        },
        Err(ureq::Error::Status(code, _)) => Err(format!("七牛下载失败 HTTP {code}")),
        Err(_) => Err("七牛网络连接失败，请检查网络和下载域名".into()),
    }
}
fn is_qiniu_s3_domain(domain: &str) -> bool {
    url::Url::parse(domain)
        .ok()
        .and_then(|u| u.host_str().map(String::from))
        .map(|host| host.contains(".s3.") && host.ends_with(".qiniucs.com"))
        .unwrap_or(false)
}
fn hmac_sha256(key: &[u8], data: &str) -> Vec<u8> {
    let mut mac = <Hmac<sha2::Sha256> as Mac>::new_from_slice(key).expect("hmac accepts key");
    mac.update(data.as_bytes());
    mac.finalize().into_bytes().to_vec()
}
/// 七牛 S3 兼容域名要求 AWS Signature V4；普通 Kodo 下载域名则沿用 QBox 私有下载签名。
fn s3_get_object(p: &SyncProfile, s: &Secrets, key: &str) -> Result<Option<Vec<u8>>, String> {
    use sha2::{Digest, Sha256};
    let mut url =
        url::Url::parse(&p.download_domain).map_err(|e| format!("S3 下载域名无效：{e}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| "S3 下载域名缺少主机名".to_string())?
        .to_string();
    let region = host
        .split(".s3.")
        .nth(1)
        .and_then(|v| v.split('.').next())
        .ok_or_else(|| "无法从 S3 下载域名识别区域".to_string())?;
    let path = format!("{}/{}", url.path().trim_end_matches('/'), key);
    url.set_path(&path);
    let now = Utc::now();
    let date = now.format("%Y%m%d").to_string();
    let amz = now.format("%Y%m%dT%H%M%SZ").to_string();
    let empty = hex::encode(Sha256::digest(b""));
    let canonical_headers =
        format!("host:{host}\nx-amz-content-sha256:{empty}\nx-amz-date:{amz}\n");
    let signed_headers = "host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "GET\n{}\n\n{}\n{}\n{}",
        url.path(),
        canonical_headers,
        signed_headers,
        empty
    );
    let scope = format!("{date}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical_request.as_bytes()))
    );
    let k_date = hmac_sha256(format!("AWS4{}", s.sk).as_bytes(), &date);
    let k_region = hmac_sha256(&k_date, region);
    let k_service = hmac_sha256(&k_region, "s3");
    let k_signing = hmac_sha256(&k_service, "aws4_request");
    let signature = hex::encode(hmac_sha256(&k_signing, &string_to_sign));
    let authorization=format!("AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",s.ak);
    match http_agent()
        .get(url.as_str())
        .set("Host", &host)
        .set("x-amz-content-sha256", &empty)
        .set("x-amz-date", &amz)
        .set("Authorization", &authorization)
        .call()
    {
        Ok(r) => response_bytes(r).map(Some),
        Err(ureq::Error::Status(404, response)) => {
            validate_response_clock(&response)?;
            Ok(None)
        },
        Err(ureq::Error::Status(code, _)) => Err(format!("七牛 S3 下载失败 HTTP {code}")),
        Err(ureq::Error::Transport(error)) => {
            // ErrorKind contains no URL, authorization header or credentials.
            // Keep raw transport errors out of diagnostics and UI messages.
            #[cfg(debug_assertions)]
            return Err(format!("七牛 S3 网络连接失败 [{:?}]，请检查网络和区域域名", error.kind()));
            #[cfg(not(debug_assertions))]
            { let _ = error; Err("七牛 S3 网络连接失败，请检查网络和区域域名".into()) }
        },
    }
}
fn put_object(p: &SyncProfile, s: &Secrets, key: &str, bytes: Vec<u8>) -> Result<(), String> {
    network_cancelled()?;
    let client = qiniu_sdk::http_client::HttpClient::build_ureq()
        .use_https(true)
        .request_retrier(qiniu_sdk::http_client::NeverRetrier)
        .on_before_request_signed(|context| {
            network_cancelled().map_err(std::io::Error::other)?;
            context
                .extensions_mut()
                .insert(qiniu_sdk::ureq::TimeoutExtension::new(Duration::from_secs(
                    30,
                )));
            Ok(())
        })
        .build();
    let manager = UploadManager::builder(
        UploadTokenSigner::new_credential_provider_builder(
            Credential::new(&s.ak, &s.sk),
            &p.bucket,
            Duration::from_secs(60),
        )
        .on_policy_generated(|p| {
            p.insert_only();
            Ok(())
        })
        .build(),
    )
    .http_client(client)
    .build();
    let params = ObjectParams::builder()
        .object_name(key)
        .file_name(key)
        .build();
    let uploader = manager.form_uploader();
    uploader
        .upload_reader(Cursor::new(bytes), params)
        .map_err(|_| "七牛上传失败：请检查网络、凭据权限或对象是否已存在".to_string())?;
    Ok(())
}
struct Remote<'a> {
    profile: &'a SyncProfile,
    secrets: &'a Secrets,
}
impl ObjectStore for Remote<'_> {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        get_object(self.profile, self.secrets, key)
    }
    fn create(&self, key: &str, value: &[u8]) -> Result<(), String> {
        put_object(self.profile, self.secrets, key, value.to_vec())
    }
}
impl SyncRemote for Remote<'_> {
    fn manifest(&self) -> Result<Option<Manifest>, String> {
        read_manifest(self.profile, self.secrets)
    }
    fn acquire(&self, state: &mut SyncStateFile, takeover: bool) -> Result<(), String> {
        ensure_lease(self.profile, self.secrets, state, takeover)
    }
    fn upload(
        &self,
        payload: &SnapshotPayload,
        revision: u64,
        held: &Lease,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        upload_snapshot(self.profile, self.secrets, payload, revision, held, cancel)
    }
    fn download(&self, manifest: &Manifest) -> Result<SnapshotPayload, String> {
        download_snapshot(self.profile, self.secrets, manifest)
    }
    fn verify(&self, held: &Lease, revision: u64) -> Result<(), String> {
        let control = protocol::head(self, &self.profile.prefix)?;
        protocol::require_owner(&control, held, Utc::now())?;
        if control.manifest.as_ref().map(|m| m.revision).unwrap_or(0) != revision {
            return Err("远端版本已变化，请重新同步".into());
        }
        Ok(())
    }
}
fn read_manifest(p: &SyncProfile, s: &Secrets) -> Result<Option<Manifest>, String> {
    let c = protocol::head(
        &Remote {
            profile: p,
            secrets: s,
        },
        &p.prefix,
    )?;
    if c.sequence == 0 && get_object(p, s, &format!("{}/manifest.json", p.prefix))?.is_some() {
        return Err("旧同步协议已停用：请先导出数据，将所有设备升级后改用新的 v2 对象前缀".into());
    }
    Ok(c.manifest)
}
fn ensure_lease(
    p: &SyncProfile,
    s: &Secrets,
    state: &mut SyncStateFile,
    allow_expired_takeover: bool,
) -> Result<(), String> {
    let remote = Remote {
        profile: p,
        secrets: s,
    };
    acquire_lease(&remote, p, state, allow_expired_takeover, Utc::now())
}

fn acquire_lease(
    remote: &impl protocol::ObjectStore,
    p: &SyncProfile,
    state: &mut SyncStateFile,
    allow_expired_takeover: bool,
    now: chrono::DateTime<Utc>,
) -> Result<(), String> {
    let mut c = protocol::head(remote, &p.prefix)?;
    let was_ready_lease = state
        .held_lease
        .as_ref()
        .map(|l| protocol::valid_until(l, now))
        .unwrap_or(false);
    if let Some(lease) = c.lease.as_ref() {
        let ours = state
            .held_lease
            .as_ref()
            .map(|l| l.device_id == p.device_id && l.lock_token == lease.lock_token)
            .unwrap_or(false);
        if !ours {
            if protocol::valid_until(lease, now) {
                return Err(format!("数据正在被设备「{}」使用", lease.device_name));
            }
            if !allow_expired_takeover {
                return Err(format!(
                    "设备「{}」租约已过期，请确认接管",
                    lease.device_name
                ));
            }
        }
        if ours && protocol::valid_until(lease, now + chrono::Duration::minutes(5)) {
            state.held_lease = Some(lease.clone());
            return Ok(());
        }
    }
    let lease = Lease {
        device_id: p.device_id.clone(),
        device_name: p.device_name.clone(),
        revision: state.last_revision,
        lock_token: new_token(),
        locked_at: now.to_rfc3339(),
        expires_at: (now + chrono::Duration::seconds(LEASE_SECS)).to_rfc3339(),
    };
    c.lease = Some(lease.clone());
    protocol::append(remote, &p.prefix, c)?;
    state.held_lease = Some(lease);
    state.ready &= was_ready_lease;
    Ok(())
}
fn lock_owner(error: &str) -> Option<String> {
    let start = error.find('「')? + "「".len();
    let end = error[start..].find('」')? + start;
    Some(error[start..end].into())
}
fn release_lease(p: &SyncProfile, s: &Secrets, lease: &Lease) -> Result<(), String> {
    let remote = Remote {
        profile: p,
        secrets: s,
    };
    let mut c = protocol::head(&remote, &p.prefix)?;
    if c.lease
        .as_ref()
        .map(|l| l.lock_token == lease.lock_token)
        .unwrap_or(false)
    {
        c.lease = None;
        protocol::append(&remote, &p.prefix, c)?;
    }
    Ok(())
}
fn upload_snapshot(
    p: &SyncProfile,
    s: &Secrets,
    payload: &SnapshotPayload,
    revision: u64,
    held: &Lease,
    cancel: &AtomicBool,
) -> Result<(), String> {
    cancelled(cancel)?;
    let encrypted = encrypt(payload, &s.passphrase)?;
    cancelled(cancel)?;
    let key = format!("{}/snapshots/{revision}-{}.bin", p.prefix, new_token());
    put_object(p, s, &key, encrypted)?;
    cancelled(cancel)?;
    let m = Manifest {
        fingerprint: payload_fingerprint(&payload)?,
        schema_version: 1,
        revision,
        snapshot_key: key,
        updated_at: Utc::now().to_rfc3339(),
        updated_by: p.device_id.clone(),
    };
    protocol::publish(
        &Remote {
            profile: p,
            secrets: s,
        },
        &p.prefix,
        held,
        revision - 1,
        m,
    )
}
fn download_snapshot(
    p: &SyncProfile,
    s: &Secrets,
    m: &Manifest,
) -> Result<SnapshotPayload, String> {
    let expected_prefix = format!("{}/snapshots/", p.prefix);
    let name = m
        .snapshot_key
        .strip_prefix(&expected_prefix)
        .ok_or("快照对象不属于当前同步空间")?;
    if name.is_empty()
        || name.contains("..")
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.')
    {
        return Err("快照对象键无效".into());
    }
    let raw = get_object(p, s, &m.snapshot_key)?.ok_or_else(|| "远端快照不存在".to_string())?;
    let payload = decrypt(&raw, &s.passphrase)?;
    if m.fingerprint.is_empty() || payload_fingerprint(&payload)? != m.fingerprint {
        return Err("快照与提交指纹不一致".into());
    }
    Ok(payload)
}

pub(crate) fn build_payload(storage: &mut Storage) -> Result<SnapshotPayload, String> {
    let dir = storage.data_dir();
    let mut files = BTreeMap::new();
    for name in [
        "events.json",
        "routines.json",
        "tasks.json",
        "templates.json",
        "long_tasks.json",
    ] {
        let path = dir.join(name);
        if path.exists() {
            files.insert(
                name.to_string(),
                B64.encode(fs::read(path).map_err(|e| e.to_string())?),
            );
        }
    }
    let arc = dir.join("archive");
    if arc.exists() {
        for e in fs::read_dir(arc).map_err(|e| e.to_string())? {
            let p = e.map_err(|e| e.to_string())?.path();
            if p.extension().and_then(|x| x.to_str()) == Some("json") {
                let n = p
                    .file_name()
                    .and_then(|x| x.to_str())
                    .ok_or_else(|| "归档文件名无效".to_string())?;
                files.insert(
                    format!("archive/{n}"),
                    B64.encode(fs::read(p).map_err(|e| e.to_string())?),
                );
            }
        }
    }
    let c = storage.read_config().map_err(|e| e.to_string())?;
    Ok(SnapshotPayload {
        schema_version: 1,
        files,
        tag_colors: c.tag_colors,
        candidate: c.candidate,
    })
}
fn apply_payload(storage: &mut Storage, payload: &SnapshotPayload) -> Result<(), String> {
    crate::sync_snapshot::apply(storage, payload)
}
pub(crate) fn encrypt(payload: &SnapshotPayload, pass: &str) -> Result<Vec<u8>, String> {
    let raw = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    if raw.len() > crate::sync_snapshot::MAX_BYTES {
        return Err("快照过大，请先导出归档".into());
    };
    let compressed = zstd::stream::encode_all(Cursor::new(raw), 3).map_err(|e| e.to_string())?;
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce);
    if salt.len() != 16 || nonce.len() != 12 {
        return Err("快照加密参数长度无效".into());
    };
    let key = derive_key(pass, &salt)?;
    let c = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let ciphertext = c
        .encrypt(Nonce::from_slice(&nonce), compressed.as_ref())
        .map_err(|_| "快照加密失败".to_string())?;
    serde_json::to_vec(&EncryptedSnapshot {
        format: "moment-sync-v1".to_string(),
        salt: B64.encode(salt),
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ciphertext),
    })
    .map_err(|e| e.to_string())
}
pub(crate) fn decrypt(raw: &[u8], pass: &str) -> Result<SnapshotPayload, String> {
    if raw.len() > crate::sync_snapshot::MAX_BYTES {
        return Err("加密快照过大".into());
    };
    let e: EncryptedSnapshot =
        serde_json::from_slice(raw).map_err(|_| "快照格式无效".to_string())?;
    if e.format != "moment-sync-v1" {
        return Err("不支持的快照格式".to_string());
    };
    let salt = B64
        .decode(e.salt)
        .map_err(|_| "快照 salt 无效".to_string())?;
    let nonce = B64
        .decode(e.nonce)
        .map_err(|_| "快照 nonce 无效".to_string())?;
    if salt.len() != 16 || nonce.len() != 12 {
        return Err("快照加密参数长度无效".into());
    }
    let key = derive_key(pass, &salt)?;
    let c = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let compressed = c
        .decrypt(
            Nonce::from_slice(&nonce),
            B64.decode(e.ciphertext)
                .map_err(|_| "快照密文无效".to_string())?
                .as_ref(),
        )
        .map_err(|_| "同步口令错误或快照已被篡改".to_string())?;
    let decoder = zstd::stream::read::Decoder::new(Cursor::new(compressed))
        .map_err(|_| "快照解压失败".to_string())?;
    let mut plain = Vec::new();
    decoder
        .take(crate::sync_snapshot::MAX_BYTES as u64 + 1)
        .read_to_end(&mut plain)
        .map_err(|_| "快照解压失败".to_string())?;
    if plain.len() > crate::sync_snapshot::MAX_BYTES {
        return Err("快照解压后过大".into());
    };
    serde_json::from_slice(&plain).map_err(|_| "快照内容无效".to_string())
}
fn derive_key(pass: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(19 * 1024, 2, 1, Some(32)).map_err(|e| e.to_string())?,
    )
    .hash_password_into(pass.as_bytes(), salt, &mut key)
    .map_err(|e| e.to_string())?;
    Ok(key)
}
fn fingerprint(storage: &mut Storage) -> Result<String, String> {
    let payload = build_payload(storage)?;
    payload_fingerprint(&payload)
}
fn payload_fingerprint(payload: &SnapshotPayload) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let raw = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(raw)))
}
fn has_syncable_data(dir: &Path) -> Result<bool, String> {
    for (name, field) in [
        ("events.json", "events"),
        ("routines.json", "routines"),
        ("tasks.json", "tasks"),
        ("templates.json", "templates"),
        ("long_tasks.json", "longTasks"),
    ] {
        if dir.join(name).exists() {
            let value: serde_json::Value =
                serde_json::from_slice(&fs::read(dir.join(name)).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if value
                .get(field)
                .and_then(|v| v.as_array())
                .map(|v| !v.is_empty())
                .unwrap_or(false)
            {
                return Ok(true);
            }
        }
    }
    let archive = dir.join("archive");
    if archive.exists() {
        for e in fs::read_dir(archive).map_err(|e| e.to_string())? {
            if e.map_err(|e| e.to_string())?
                .path()
                .extension()
                .and_then(|s| s.to_str())
                == Some("json")
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
fn validate_input(i: &SyncConfigInput) -> Result<(), String> {
    if i.bucket.trim().is_empty()
        || i.download_domain.trim().is_empty()
        || i.device_name.trim().is_empty()
    {
        return Err("请填写 Bucket、下载域名和设备名".to_string());
    };
    if !i.passphrase.trim().is_empty() && i.passphrase.trim().len() < 8 {
        return Err("同步口令至少 8 位".to_string());
    };
    normalize_domain(&i.download_domain)?;
    normalize_prefix(&i.prefix)?;
    Ok(())
}
fn normalize_domain(s: &str) -> Result<String, String> {
    let v = s.trim().trim_end_matches('/');
    let url = url::Url::parse(v).map_err(|_| "下载域名无效".to_string())?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err("下载域名必须以 https:// 开头".to_string());
    };
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("下载域名不能包含账号、口令、查询参数或片段".into());
    }
    Ok(v.to_string())
}
fn normalize_prefix(s: &str) -> Result<String, String> {
    let v = s.trim().trim_matches('/');
    if v.is_empty()
        || v.contains("..")
        || !v
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'))
    {
        return Err("对象前缀只能含字母、数字、/、-、_、.".to_string());
    };
    Ok(v.to_string())
}
pub(crate) fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("{}.tmp", new_token()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        file.write_all(data).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
fn new_device_id() -> String {
    format!("{}-{}", std::env::consts::OS, new_token())
}
pub(crate) fn new_token() -> String {
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    hex::encode(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn profile() -> SyncProfile {
        SyncProfile {
            version:1, bucket:"test".into(), download_domain:"https://test.invalid".into(),
            prefix:"test/v2".into(), device_id:"test-device".into(), credential_id:None,
            device_name:"test".into(),
        }
    }

    #[derive(Default)]
    struct LeaseStore(Mutex<BTreeMap<String, Vec<u8>>>);
    impl protocol::ObjectStore for LeaseStore {
        fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn create(&self, key: &str, value: &[u8]) -> Result<(), String> {
            use std::collections::btree_map::Entry;
            match self.0.lock().unwrap().entry(key.into()) {
                Entry::Vacant(entry) => { entry.insert(value.to_vec()); Ok(()) }
                Entry::Occupied(_) => Err("already exists".into()),
            }
        }
    }

    #[test]
    fn expired_takeover_requires_confirmation_and_invalidates_the_old_owner() {
        let store = LeaseStore::default();
        let now = Utc::now();
        let first = profile();
        let mut a = SyncStateFile::default();
        acquire_lease(&store, &first, &mut a, false, now).unwrap();
        let mut second = profile(); second.device_id = "second-device".into();
        let mut b = SyncStateFile::default();
        assert!(acquire_lease(&store, &second, &mut b, true, now).unwrap_err().contains("正在被"));
        let expired = now + chrono::Duration::minutes(31);
        assert!(acquire_lease(&store, &second, &mut b, false, expired).unwrap_err().contains("确认接管"));
        acquire_lease(&store, &second, &mut b, true, expired).unwrap();
        assert!(!b.ready, "Taking a lease must not skip the initial data comparison");
        let head = protocol::head(&store, &first.prefix).unwrap();
        assert!(protocol::require_owner(&head, a.held_lease.as_ref().unwrap(), expired).is_err());
        protocol::require_owner(&head, b.held_lease.as_ref().unwrap(), expired).unwrap();
    }

    #[test]
    fn expired_local_owner_must_reconcile_before_becoming_editable_again() {
        let store = LeaseStore::default(); let now = Utc::now();
        let p = profile(); let mut state = SyncStateFile::default();
        acquire_lease(&store, &p, &mut state, false, now).unwrap();
        state.ready = true;
        acquire_lease(&store, &p, &mut state, false, now + chrono::Duration::minutes(26)).unwrap();
        assert!(state.ready, "Renewing a still valid lease preserves the ready state");
        acquire_lease(&store, &p, &mut state, false, now + chrono::Duration::minutes(57)).unwrap();
        assert!(!state.ready, "Long offline periods require reconciliation before editing");
    }

    fn tcp_response(status: &str, date: String, body: &'static str, length: usize) -> (String, std::thread::JoinHandle<()>) {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let status = status.to_owned();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut request = Vec::new(); let mut byte = [0u8];
            while !request.ends_with(b"\r\n\r\n") && request.len() < 16384 {
                if stream.read(&mut byte).unwrap_or(0) == 0 { break; }
                request.push(byte[0]);
            }
            write!(stream, "HTTP/1.1 {status}\r\nDate: {date}\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{body}").unwrap();
        });
        (address, server)
    }

    #[test]
    fn empty_remote_404_also_rejects_a_skewed_clock_over_actual_tcp() {
        for minutes in [-5, 5] {
            let (address, server) = tcp_response("404 Not Found", (Utc::now() + chrono::Duration::minutes(minutes)).to_rfc2822(), "", 0);
            let mut p = profile(); p.download_domain = address;
            let s = Secrets { ak:"dummy-key".into(), sk:"dummy-secret".into(), passphrase:"dummy-passphrase".into() };
            assert!(get_object(&p, &s, "test/v2/missing.json").unwrap_err().contains("校准系统时间"));
            server.join().unwrap();
        }
    }

    #[test]
    fn interrupted_tcp_body_is_rejected_instead_of_becoming_a_snapshot() {
        let (address, server) = tcp_response("200 OK", Utc::now().to_rfc2822(), "bad", 100);
        let response = http_agent().get(&address).call().unwrap();
        assert!(response_bytes(response).unwrap_err().contains("读取同步对象失败"));
        server.join().unwrap();
    }

    #[test]
    fn malformed_server_time_is_not_accepted_as_a_trusted_clock() {
        let response: ureq::Response = "HTTP/1.1 200 OK\r\nDate: invalid\r\nContent-Length: 2\r\n\r\n{}".parse().unwrap();
        assert!(response_bytes(response).unwrap_err().contains("服务器时间无效"));
    }
    #[test]
    fn encrypted_roundtrip_and_tamper_detection() {
        let p = SnapshotPayload {
            schema_version: 1,
            files: BTreeMap::from([("events.json".to_string(), B64.encode(b"{}"))]),
            tag_colors: BTreeMap::new(),
            candidate: CandidateConfig {
                missed_routine_grace_hours: 4,
            },
        };
        let e = encrypt(&p, "password123").unwrap();
        assert_eq!(decrypt(&e, "password123").unwrap().files, p.files);
        assert!(decrypt(&e, "wrong-password").is_err());
        let mut x = e;
        x[0] ^= 1;
        assert!(decrypt(&x, "password123").is_err());
    }
    #[test]
    fn credentials_are_not_snapshot_fields() {
        let p = SnapshotPayload {
            schema_version: 1,
            files: BTreeMap::new(),
            tag_colors: BTreeMap::new(),
            candidate: CandidateConfig {
                missed_routine_grace_hours: 4,
            },
        };
        let text = String::from_utf8(serde_json::to_vec(&p).unwrap()).unwrap();
        assert!(
            !text.contains("accessKey")
                && !text.contains("secretKey")
                && !text.contains("passphrase")
        );
    }
    #[test]
    fn prefix_validation() {
        assert!(normalize_prefix("moment-sync/v1").is_ok());
        assert!(normalize_prefix("../bad").is_err());
    }
}

#[cfg(test)]
mod safety_tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    #[derive(Default)]
    struct FakeVault {
        values: Mutex<BTreeMap<(String, String), String>>,
        writes: AtomicUsize,
        fail_write: usize,
    }
    impl Vault for FakeVault {
        fn read(&self, id: &str, kind: &str) -> Result<String, String> {
            self.values
                .lock()
                .unwrap()
                .get(&(id.into(), kind.into()))
                .cloned()
                .ok_or("missing".into())
        }
        fn write(&self, id: &str, kind: &str, value: &str) -> Result<(), String> {
            let n = self.writes.fetch_add(1, Ordering::SeqCst) + 1;
            if n == self.fail_write {
                return Err("模拟凭据库写入失败".into());
            }
            self.values
                .lock()
                .unwrap()
                .insert((id.into(), kind.into()), value.into());
            Ok(())
        }
        fn delete(&self, id: &str, kind: &str) -> Result<(), String> {
            self.values
                .lock()
                .unwrap()
                .remove(&(id.into(), kind.into()));
            Ok(())
        }
    }
    fn input() -> SyncConfigInput {
        SyncConfigInput {
            bucket: "test".into(),
            download_domain: "https://test.invalid".into(),
            prefix: "test/v2".into(),
            device_name: "QA".into(),
            access_key: "test-access".into(),
            secret_key: "test-secret".into(),
            passphrase: "test-passphrase".into(),
        }
    }
    #[test]
    fn cancellation_after_download_preserves_local_data_and_revision() {
        let (service, storage, mut payload) = sync_fixture();
        payload.tag_colors.insert("remote".into(), "red".into());
        let remote = FakeRemote::new(payload, Some(2));
        let control = service.control.clone();
        *remote.on_download.lock().unwrap() = Some(Box::new(move || {
            control.cancel.store(true, Ordering::SeqCst)
        }));
        assert!(service
            .sync_using(&storage, &remote, None, false)
            .unwrap_err()
            .contains("已取消"));
        assert!(!storage
            .lock()
            .unwrap()
            .read_config()
            .unwrap()
            .tag_colors
            .contains_key("remote"));
        assert_eq!(service.status().revision, 1);
        fs::remove_dir_all(service.base_dir).unwrap();
    }
    #[test]
    fn retry_backoff_is_bounded_and_success_resets_it() {
        let control = SyncControl::default();
        assert!(control.retry_due());
        for _ in 0..10 {
            control.completed(false);
        }
        assert!(!control.retry_due());
        let retry = control.retry_at.lock().unwrap().unwrap();
        assert!((1..=300).contains(&(retry - Utc::now().timestamp())));
        control.completed(true);
        assert!(control.retry_due());
        assert!(control.retry_time().is_none());
    }
    #[test]
    fn diagnostics_excludes_raw_errors_names_credentials_and_paths() {
        let service = fixture();
        service.save_profile(&profile()).unwrap();
        let mut state = active();
        state.last_error =
            Some("https://private.example/?token=secret-value C:/private/path device-name".into());
        service.save_state(&state).unwrap();
        let text = serde_json::to_string(&service.diagnostics()).unwrap();
        for value in [
            "secret-value",
            "private.example",
            "device-name",
            "private/path",
            "accessKey",
            "secretKey",
            "passphrase",
            "deviceId",
            "downloadDomain",
        ] {
            assert!(!text.contains(value), "{value} leaked");
        }
        fs::remove_dir_all(service.base_dir).unwrap();
    }
    #[test]
    fn credential_update_failure_preserves_active_profile_and_all_old_secrets() {
        let service = fixture();
        let old = profile();
        service.save_profile(&old).unwrap();
        service.save_state(&active()).unwrap();
        let vault = FakeVault {
            fail_write: 2,
            ..Default::default()
        };
        for kind in ["access-key", "secret-key", "passphrase"] {
            vault
                .values
                .lock()
                .unwrap()
                .insert((old.device_id.clone(), kind.into()), format!("old-{kind}"));
        }
        let before = fs::read(service.profile_path()).unwrap();
        assert!(service.configure_using(input(), &vault).is_err());
        assert_eq!(fs::read(service.profile_path()).unwrap(), before);
        assert_eq!(vault.values.lock().unwrap().len(), 3);
        assert_eq!(
            vault.read(&old.device_id, "access-key").unwrap(),
            "old-access-key"
        );
        assert!(service.status().editable);
        fs::remove_dir_all(service.base_dir).unwrap();
    }
    #[test]
    fn missing_credential_is_detected_before_any_writes_and_success_keeps_device_id() {
        let service = fixture();
        let vault = FakeVault::default();
        let mut i = input();
        i.secret_key.clear();
        assert!(service.configure_using(i, &vault).is_err());
        assert_eq!(vault.writes.load(Ordering::SeqCst), 0);
        service.configure_using(input(), &vault).unwrap();
        let first = service.read_profile().unwrap().unwrap();
        service.configure_using(input(), &vault).unwrap();
        let second = service.read_profile().unwrap().unwrap();
        assert_eq!(first.device_id, second.device_id);
        assert_ne!(first.credential_id, second.credential_id);
        assert_eq!(vault.values.lock().unwrap().len(), 3);
        assert!(!service.status().editable);
        fs::remove_dir_all(service.base_dir).unwrap();
    }

    struct FakeRemote {
        head: Mutex<Option<Manifest>>,
        payload: Mutex<SnapshotPayload>,
        on_upload: Mutex<Option<Box<dyn FnOnce() + Send>>>,
        on_download: Mutex<Option<Box<dyn FnOnce() + Send>>>,
        uploads: AtomicUsize,
        lose_ack: bool,
    }
    impl FakeRemote {
        fn new(payload: SnapshotPayload, revision: Option<u64>) -> Self {
            let head = revision.map(|revision| Manifest {
                fingerprint: payload_fingerprint(&payload).unwrap(),
                schema_version: 1,
                revision,
                snapshot_key: "test/snapshots/test.bin".into(),
                updated_at: Utc::now().to_rfc3339(),
                updated_by: "other".into(),
            });
            Self {
                head: Mutex::new(head),
                payload: Mutex::new(payload),
                on_upload: Mutex::new(None),
                on_download: Mutex::new(None),
                uploads: AtomicUsize::new(0),
                lose_ack: false,
            }
        }
    }
    impl SyncRemote for FakeRemote {
        fn manifest(&self) -> Result<Option<Manifest>, String> {
            Ok(self.head.lock().unwrap().clone())
        }
        fn acquire(&self, st: &mut SyncStateFile, _: bool) -> Result<(), String> {
            st.held_lease = active().held_lease;
            Ok(())
        }
        fn upload(
            &self,
            payload: &SnapshotPayload,
            revision: u64,
            _: &Lease,
            _: &AtomicBool,
        ) -> Result<(), String> {
            if let Some(action) = self.on_upload.lock().unwrap().take() {
                action();
            }
            *self.payload.lock().unwrap() = payload.clone();
            *self.head.lock().unwrap() = Some(Manifest {
                fingerprint: payload_fingerprint(payload)?,
                schema_version: 1,
                revision,
                snapshot_key: "test/snapshots/test.bin".into(),
                updated_at: Utc::now().to_rfc3339(),
                updated_by: "test-device".into(),
            });
            let n = self.uploads.fetch_add(1, Ordering::SeqCst);
            if self.lose_ack && n == 0 {
                Err("模拟提交后确认丢失".into())
            } else {
                Ok(())
            }
        }
        fn download(&self, _: &Manifest) -> Result<SnapshotPayload, String> {
            if let Some(action) = self.on_download.lock().unwrap().take() {
                action();
            }
            Ok(self.payload.lock().unwrap().clone())
        }
        fn verify(&self, _: &Lease, revision: u64) -> Result<(), String> {
            if self.head.lock().unwrap().as_ref().map(|m| m.revision) == Some(revision) {
                Ok(())
            } else {
                Err("远端版本已变化".into())
            }
        }
    }
    fn sync_fixture() -> (SyncService, Arc<Mutex<Storage>>, SnapshotPayload) {
        let service = fixture();
        service.save_profile(&profile()).unwrap();
        let mut storage = Storage::new(service.base_dir.clone());
        storage.ensure().unwrap();
        storage.save_config(&Default::default()).unwrap();
        let payload = build_payload(&mut storage).unwrap();
        let mut state = active();
        state.last_revision = 1;
        state.last_fingerprint = payload_fingerprint(&payload).unwrap();
        service.save_state(&state).unwrap();
        (service, Arc::new(Mutex::new(storage)), payload)
    }
    #[test]
    fn upload_releases_storage_and_preserves_edits_until_next_commit() {
        let (service, storage, payload) = sync_fixture();
        let remote = FakeRemote::new(payload.clone(), Some(1));
        {
            let mut s = storage.lock().unwrap();
            service.prepare_write().unwrap();
            let mut c = s.read_config().unwrap();
            c.tag_colors.insert("first".into(), "red".into());
            s.save_config(&c).unwrap();
        }
        let shared = storage.clone();
        let base = service.base_dir.clone();
        *remote.on_upload.lock().unwrap() = Some(Box::new(move || {
            let mut s = shared.try_lock().expect("network must not hold storage");
            SyncService::new(base).prepare_write().unwrap();
            let mut c = s.read_config().unwrap();
            c.tag_colors.insert("during-upload".into(), "blue".into());
            s.save_config(&c).unwrap();
        }));
        let result = service.sync_using(&storage, &remote, None, false).unwrap();
        assert!(result.dirty);
        assert!(service.freeze_clean_exit(&storage).is_err());
        assert!(service.status().editable, "a rejected exit must retain its valid editing lease");
        assert!(!remote
            .payload
            .lock()
            .unwrap()
            .tag_colors
            .contains_key("during-upload"));
        let result = service.sync_using(&storage, &remote, None, false).unwrap();
        assert!(!result.dirty);
        assert_eq!(result.revision, 3);
        assert!(remote
            .payload
            .lock()
            .unwrap()
            .tag_colors
            .contains_key("during-upload"));
        service.freeze_clean_exit(&storage).unwrap();
        assert!(!service.status().editable);
        assert!(service.prepare_write().is_err(), "new mutations must be blocked before lease release starts");
        fs::remove_dir_all(service.base_dir).unwrap();
    }
    #[test]
    fn exit_freeze_rechecks_changes_after_a_clean_sync() {
        let (service, storage, payload) = sync_fixture();
        let remote = FakeRemote::new(payload, Some(1));
        assert!(!service.sync_using(&storage, &remote, None, false).unwrap().dirty);
        {
            let mut s = storage.lock().unwrap();
            let mut config = s.read_config().unwrap();
            config.tag_colors.insert("changed-after-sync".into(), "blue".into());
            s.save_config(&config).unwrap();
        }
        assert!(!service.read_state().unwrap().dirty, "the guard must not trust a previously clean flag");
        assert!(service.freeze_clean_exit(&storage).is_err());
        assert!(service.status().dirty);
        assert!(service.status().editable);
        assert!(service.read_state().unwrap().held_lease.is_some());
        fs::remove_dir_all(service.base_dir).unwrap();
    }
    #[test]
    fn download_does_not_replace_edit_made_during_network() {
        let (service, storage, mut payload) = sync_fixture();
        payload.tag_colors.insert("remote".into(), "green".into());
        let remote = FakeRemote::new(payload, Some(2));
        let shared = storage.clone();
        let base = service.base_dir.clone();
        *remote.on_download.lock().unwrap() = Some(Box::new(move || {
            let mut s = shared.try_lock().expect("download must not hold storage");
            SyncService::new(base).prepare_write().unwrap();
            let mut c = s.read_config().unwrap();
            c.tag_colors.insert("local".into(), "blue".into());
            s.save_config(&c).unwrap();
        }));
        assert!(service
            .sync_using(&storage, &remote, None, false)
            .unwrap_err()
            .contains("本地发生修改"));
        let c = storage.lock().unwrap().read_config().unwrap();
        assert!(c.tag_colors.contains_key("local"));
        assert!(!c.tag_colors.contains_key("remote"));
        assert!(service.status().dirty);
        assert_eq!(service.status().revision, 1);
        fs::remove_dir_all(service.base_dir).unwrap();
    }
    #[test]
    fn first_empty_device_downloads_without_prompt_or_upload() {
        let (service, storage, mut payload) = sync_fixture();
        service.save_state(&Default::default()).unwrap();
        payload.tag_colors.insert("remote".into(), "green".into());
        let remote = FakeRemote::new(payload, Some(2));
        let result = service.sync_using(&storage, &remote, None, false).unwrap();
        assert!(result.editable);
        assert_eq!(result.revision, 2);
        assert!(!result.dirty);
        assert_eq!(remote.uploads.load(Ordering::SeqCst), 0);
        assert!(storage
            .lock()
            .unwrap()
            .read_config()
            .unwrap()
            .tag_colors
            .contains_key("remote"));
        fs::remove_dir_all(service.base_dir).unwrap();
    }
    #[test]
    fn acknowledged_content_retry_does_not_publish_a_second_revision() {
        let (service, storage, payload) = sync_fixture();
        let mut remote = FakeRemote::new(payload, Some(1));
        remote.lose_ack = true;
        {
            let mut s = storage.lock().unwrap();
            service.prepare_write().unwrap();
            let mut c = s.read_config().unwrap();
            c.tag_colors.insert("edit".into(), "red".into());
            s.save_config(&c).unwrap();
        }
        assert!(service.sync_using(&storage, &remote, None, false).is_err());
        assert!(service.status().dirty);
        let result = service.sync_using(&storage, &remote, None, false).unwrap();
        assert_eq!(result.revision, 2);
        assert!(!result.dirty);
        assert_eq!(remote.uploads.load(Ordering::SeqCst), 1);
        fs::remove_dir_all(service.base_dir).unwrap();
    }
    fn fixture() -> SyncService {
        let p = std::env::temp_dir().join(format!("moment-sync-{}", new_token()));
        fs::create_dir_all(&p).unwrap();
        SyncService::new(p)
    }
    fn profile() -> SyncProfile {
        SyncProfile {
            version: 1,
            bucket: "test".into(),
            download_domain: "https://test.invalid".into(),
            prefix: "test/v2".into(),
            device_id: "test-device".into(),
            credential_id: None,
            device_name: "test".into(),
        }
    }
    fn active() -> SyncStateFile {
        SyncStateFile {
            ready: true,
            held_lease: Some(Lease {
                device_id: "test-device".into(),
                device_name: "test".into(),
                revision: 1,
                lock_token: "token".into(),
                locked_at: Utc::now().to_rfc3339(),
                expires_at: (Utc::now() + chrono::Duration::minutes(20)).to_rfc3339(),
            }),
            ..Default::default()
        }
    }
    #[test]
    fn writable_only_after_initial_sync_and_durable_dirty_before_write() {
        let s = fixture();
        assert!(s.status().editable);
        s.save_profile(&profile()).unwrap();
        assert!(!s.status().editable);
        assert!(s.prepare_write().is_err());
        s.save_state(&active()).unwrap();
        s.prepare_write().unwrap();
        assert!(s.read_state().unwrap().dirty);
        let restarted = SyncService::new(s.base_dir.clone());
        assert!(restarted.read_state().unwrap().dirty);
        fs::remove_dir_all(s.base_dir).unwrap();
    }
    #[test]
    fn expired_or_unresolved_lease_cannot_edit() {
        let s = fixture();
        s.save_profile(&profile()).unwrap();
        let mut st = active();
        st.held_lease.as_mut().unwrap().expires_at =
            (Utc::now() - chrono::Duration::seconds(1)).to_rfc3339();
        s.save_state(&st).unwrap();
        assert!(s.prepare_write().is_err());
        st = active();
        st.needs_initial_choice = true;
        s.save_state(&st).unwrap();
        assert!(s.prepare_write().is_err());
        fs::remove_dir_all(s.base_dir).unwrap();
    }
    #[test]
    fn corrupt_state_and_profile_fail_closed() {
        let s = fixture();
        s.save_profile(&profile()).unwrap();
        fs::write(s.state_path(), b"broken").unwrap();
        assert!(!s.status().editable);
        assert!(s.prepare_write().is_err());
        assert_eq!(fs::read(s.state_path()).unwrap(), b"broken");
        fs::write(s.profile_path(), b"broken").unwrap();
        assert!(!s.status().editable);
        assert!(s.prepare_write().is_err());
        fs::remove_dir_all(s.base_dir).unwrap();
    }
    #[test]
    fn empty_json_files_do_not_count_as_existing_business_data() {
        let s = fixture();
        let mut storage = Storage::new(s.base_dir.clone());
        storage.ensure().unwrap();
        storage.save_events(&[]).unwrap();
        storage.save_tasks(&[]).unwrap();
        assert!(!has_syncable_data(&s.base_dir).unwrap());
        fs::remove_dir_all(s.base_dir).unwrap();
    }
    #[test]
    fn bad_nonce_returns_error_instead_of_panicking() {
        let value = serde_json::json!({"format":"moment-sync-v1","salt":B64.encode([0u8;16]),"nonce":B64.encode([0u8;2]),"ciphertext":"AA=="});
        assert!(decrypt(&serde_json::to_vec(&value).unwrap(), "password123").is_err());
    }
}
