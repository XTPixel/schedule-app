use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);
const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";

/// 生成短 ID：`{prefix}_{随机串}`（§5.7：e_/r_/t_/a_ 前缀 + 随机串）。
/// 基于时间戳纳秒 + 进程内自增计数器混合，本地单用户场景下足以保证唯一性。
pub fn new_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut v = nanos ^ (c.wrapping_mul(0x9E37_79B9_7F4A_7C15));
    let mut s = String::new();
    while v > 0 && s.len() < 12 {
        let idx = (v % 36) as usize;
        s.push(ALPHABET[idx] as char);
        v /= 36;
    }
    while s.len() < 8 {
        s.push('a');
    }
    format!("{}_{}", prefix, s)
}
