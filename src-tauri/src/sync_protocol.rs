//! Immutable coordination log. Every transition creates exactly one previously
//! absent object. No read/overwrite/read lock and no mutable manifest are used.
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::sync::{Lease, Manifest};

pub trait ObjectStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String>;
    /// Atomic create-if-absent; an existing, different value MUST fail.
    fn create(&self, key: &str, value: &[u8]) -> Result<(), String>;
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Control {
    pub protocol: u32,
    pub sequence: u64,
    pub manifest: Option<Manifest>,
    pub lease: Option<Lease>,
}

fn key(prefix: &str, seq: u64) -> String {
    format!("{prefix}/coordination/{seq:020}.json")
}

fn read(store: &impl ObjectStore, prefix: &str, seq: u64) -> Result<Option<Control>, String> {
    store
        .get(&key(prefix, seq))?
        .map(|raw| {
            if raw.len() > 64 * 1024 {
                return Err("同步协调记录过大".into());
            }
            let c: Control =
                serde_json::from_slice(&raw).map_err(|_| "同步协调记录损坏".to_string())?;
            if c.protocol != 2 || c.sequence != seq {
                return Err("不支持或不完整的同步协议记录".into());
            }
            Ok(c)
        })
        .transpose()
}

/// Contiguous immutable slots permit logarithmic head discovery, without a
/// cached mutable index. Readers must use an origin endpoint, not a stale CDN.
pub fn head(store: &impl ObjectStore, prefix: &str) -> Result<Control, String> {
    let Some(mut latest) = read(store, prefix, 1)? else {
        return Ok(Control {
            protocol: 2,
            ..Default::default()
        });
    };
    let mut low = 1u64;
    let mut high = 2u64;
    while let Some(value) = read(store, prefix, high)? {
        latest = value;
        low = high;
        high = high.checked_mul(2).ok_or("同步序号溢出")?;
    }
    while high - low > 1 {
        let mid = low + (high - low) / 2;
        if let Some(value) = read(store, prefix, mid)? {
            low = mid;
            latest = value;
        } else {
            high = mid;
        }
    }
    Ok(latest)
}

pub fn append(store: &impl ObjectStore, prefix: &str, mut next: Control) -> Result<(), String> {
    next.sequence = next.sequence.checked_add(1).ok_or("同步序号溢出")?;
    let raw = serde_json::to_vec(&next).map_err(|e| e.to_string())?;
    store
        .create(&key(prefix, next.sequence), &raw)
        .map_err(|_| "同步提交发生竞争或网络失败，已保留本地修改，请重试".to_string())
}

pub fn valid_until(lease: &Lease, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(&lease.expires_at)
        .map(|end| end > now && (end.with_timezone(&Utc) - now).num_seconds() <= 31 * 60)
        .unwrap_or(false)
}

pub fn require_owner(c: &Control, held: &Lease, now: DateTime<Utc>) -> Result<(), String> {
    match c.lease.as_ref() {
        Some(remote)
            if remote.device_id == held.device_id
                && remote.lock_token == held.lock_token
                && valid_until(remote, now) =>
        {
            Ok(())
        }
        _ => Err("编辑租约已失效，已保留本地修改，请重新同步".into()),
    }
}

pub fn publish(
    store: &impl ObjectStore,
    prefix: &str,
    held: &Lease,
    base: u64,
    manifest: Manifest,
) -> Result<(), String> {
    let mut c = head(store, prefix)?;
    require_owner(&c, held, Utc::now())?;
    if c.manifest.as_ref().map(|m| m.revision).unwrap_or(0) != base {
        return Err("远端版本已变化，禁止覆盖；请导出本地副本后处理冲突".into());
    }
    if manifest.revision != base.checked_add(1).ok_or("同步版本溢出")? {
        return Err("提交版本无效".into());
    }
    c.manifest = Some(manifest);
    append(store, prefix, c)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::BTreeMap,
        sync::{Arc, Barrier, Mutex},
        thread,
    };
    #[derive(Clone, Default)]
    struct Memory(Arc<Mutex<BTreeMap<String, Vec<u8>>>>);
    impl ObjectStore for Memory {
        fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self.0.lock().unwrap().get(key).cloned())
        }
        fn create(&self, key: &str, value: &[u8]) -> Result<(), String> {
            let mut map = self.0.lock().unwrap();
            if map.contains_key(key) {
                return Err("exists".into());
            }
            map.insert(key.into(), value.into());
            Ok(())
        }
    }
    fn lease() -> Lease {
        Lease {
            device_id: "a".into(),
            device_name: "test".into(),
            revision: 0,
            lock_token: "secret-token".into(),
            locked_at: Utc::now().to_rfc3339(),
            expires_at: (Utc::now() + chrono::Duration::minutes(30)).to_rfc3339(),
        }
    }
    fn manifest(n: u64) -> Manifest {
        Manifest {
            fingerprint: "test".into(),
            schema_version: 1,
            revision: n,
            snapshot_key: "snapshots/test.bin".into(),
            updated_at: Utc::now().to_rfc3339(),
            updated_by: "a".into(),
        }
    }
    #[test]
    fn simultaneous_claims_have_exactly_one_winner() {
        let store = Memory::default();
        let barrier = Arc::new(Barrier::new(2));
        let jobs: Vec<_> = (0..2)
            .map(|n| {
                let s = store.clone();
                let b = barrier.clone();
                thread::spawn(move || {
                    let mut c = head(&s, "test").unwrap();
                    let mut l = lease();
                    l.device_id = n.to_string();
                    c.lease = Some(l);
                    b.wait();
                    append(&s, "test", c).is_ok()
                })
            })
            .collect();
        assert_eq!(
            jobs.into_iter()
                .filter_map(|j| j.join().ok())
                .filter(|v| *v)
                .count(),
            1
        );
        assert_eq!(head(&store, "test").unwrap().sequence, 1);
    }
    #[test]
    fn stale_revision_or_lease_cannot_publish() {
        let s = Memory::default();
        let l = lease();
        let c = Control {
            protocol: 2,
            sequence: 0,
            manifest: Some(manifest(4)),
            lease: Some(l.clone()),
        };
        append(&s, "t", c).unwrap();
        assert!(publish(&s, "t", &l, 3, manifest(4)).is_err());
        let mut wrong = l.clone();
        wrong.lock_token = "old".into();
        assert!(publish(&s, "t", &wrong, 4, manifest(5)).is_err());
        publish(&s, "t", &l, 4, manifest(5)).unwrap();
        assert!(publish(&s, "t", &l, 4, manifest(5)).is_err());
    }
    #[test]
    fn discovers_latest_and_rejects_future_protocol() {
        let s = Memory::default();
        for _ in 0..35 {
            append(&s, "t", head(&s, "t").unwrap()).unwrap();
        }
        assert_eq!(head(&s, "t").unwrap().sequence, 35);
        s.0.lock()
            .unwrap()
            .insert(key("bad", 1), br#"{"protocol":3,"sequence":1}"#.to_vec());
        assert!(head(&s, "bad").is_err());
    }
}
