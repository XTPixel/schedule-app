use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;

use schedule_core::{Config, Storage};

/// 全局共享状态。
pub struct AppState {
    pub storage: Mutex<Storage>,
    /// 配置缓存（托盘最小化、通知开关、全局快捷键等行为依赖它）。
    pub config: Mutex<Config>,
    /// 本会话已推送过的提醒（避免被动刷新重复弹窗）。
    pub notified: Mutex<HashSet<String>>,
    /// V3.1：`notified` 集合所属的本地日期；跨天切换时清空（只保留当天条目）。
    pub notified_day: Mutex<String>,
    /// 默认应用数据目录（用于自定义数据目录指针文件）。
    pub base_dir: PathBuf,
    /// V3.1 T4：配置代数。`set_config` 只落盘并递增；单线程 applier 循环应用（全局快捷键）。
    pub config_generation: AtomicU64,
}
