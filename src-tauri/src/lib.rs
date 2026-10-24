//! Tauri 应用入口：装配后端状态、托盘、系统通知、全局快捷键、被动刷新与 resume 唤醒钩子。
//! Git 一键备份与移动端只读服务已完全移除（对应模块、命令、状态与前端入口均已删除）。

mod commands;
#[cfg(target_os = "android")]
mod mobile_reminders;
pub mod platform;
mod state;
mod sync;
mod sync_protocol;
mod sync_snapshot;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
#[cfg(desktop)]
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use schedule_core::{compute_candidates, timeutil, Storage};
use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_notification::NotificationExt;

#[cfg(desktop)]
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
#[cfg(desktop)]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use state::AppState;

#[cfg(desktop)]
const WINDOW_LABEL: &str = "main";
#[cfg(desktop)]
const TRAY_ID: &str = "main-tray";
const DATA_DIR_POINTER: &str = "data_dir.txt";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init());
    let builder = builder.plugin(tauri_plugin_fs::init());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(mobile_reminders::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // 最小化到托盘（§4.7 / §7）。移动端没有桌面窗口关闭事件。
            let minimize = window
                .state::<AppState>()
                .config
                .lock()
                .map(|c| c.behavior.minimize_to_tray)
                .unwrap_or(true);
            if minimize {
                let _ = window.hide();
                api.prevent_close();
            } else {
                api.prevent_close();
                let _ = window.emit("sync-exit-request", ());
            }
        }
    });

    builder
        .setup(|app| {
            // Android 使用 Keystore 加密的 SharedPreferences；桌面沿用平台凭据库。
            #[cfg(target_os = "android")]
            keyring_core::set_default_store(android_native_keyring_store::Store::new()?);
            let base_dir = app.path().app_data_dir()?;
            #[cfg(debug_assertions)]
            let base_dir = if let Some(path) = std::env::var_os("MOMENT_QA_DATA_DIR") {
                let path=PathBuf::from(path);
                if !path.is_absolute() || fs::read_to_string(path.join(".moment-qa-root")).ok().as_deref()!=Some("moment-isolated-test-data-v1") {
                    return Err(std::io::Error::new(std::io::ErrorKind::PermissionDenied,"隔离测试目录缺少有效标记").into());
                }
                path
            } else {base_dir};
            fs::create_dir_all(&base_dir)?;
            let data_dir = resolve_data_dir(&base_dir);
            let mut storage = Storage::new(data_dir.clone());
            storage.ensure()?;
            let (config, recovery_error) = startup_storage(&mut storage);
            app.manage(AppState {
                #[cfg(target_os = "android")]
                mobile_schedule_fingerprint: Mutex::new(String::new()),
                storage: Mutex::new(storage),
                config: Mutex::new(config.clone()),
                notified: Mutex::new(HashSet::new()),
                notified_day: Mutex::new(String::new()),
                base_dir,
                sync_gate: Mutex::new(()),
                sync_control: Default::default(),
                recovery_error: Mutex::new(recovery_error),
                config_generation: AtomicU64::new(0),
            });
            #[cfg(desktop)]
            {
                let isolated_qa=cfg!(debug_assertions) && std::env::var_os("MOMENT_QA_DATA_DIR").is_some();
                if !isolated_qa {
                    build_tray(app.handle(), config.notifications.enabled)?;
                    apply_behavior_settings(app.handle());
                } else if let Some(window)=app.get_webview_window("main") { let _=window.set_title("此刻（隔离测试）"); }
            }
            // 启动/主窗口打开时被动刷新提醒（§6.3）。
            check_and_notify(app.handle());
            // V3.0 F5：启动后台周期调度线程，常驻/最小化时到点也能弹系统通知。
            start_reminder_scheduler(app.handle());
            // V3.1 T4：单一配置应用线程，串行应用全局快捷键等配置。
            #[cfg(desktop)]
            if !(cfg!(debug_assertions) && std::env::var_os("MOMENT_QA_DATA_DIR").is_some()) { start_config_applier(app.handle()); }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_all_data,
            commands::get_now_candidates,
            commands::save_event,
            commands::delete_event,
            commands::save_routine,
            commands::delete_routine,
            commands::save_task,
            commands::delete_task,
            // V1.2：长期任务与会话。
            commands::save_long_task,
            commands::delete_long_task,
            commands::add_long_task_session,
            commands::update_long_task_session_note,
            commands::delete_long_task_session,
            commands::undelete_long_task_session,
            // V1.2.2：归档页删除 / 撤回长期任务聚合条目。
            commands::delete_long_task_archive_day,
            commands::undelete_long_task_archive_day,
            commands::archive_entry,
            commands::complete_candidate,
            commands::update_archive_day,
            commands::get_archive_month,
            commands::get_config,
            commands::set_config,
            commands::notify,
            commands::notification_permission,
            commands::notification_pending_count,
            commands::notification_reminder_status,
            commands::notification_open_settings,
            commands::parse_nl,
            commands::get_calendar,
            commands::search_data,
            commands::get_stats,
            commands::get_review,
            commands::list_tags,
            commands::rename_tag,
            commands::delete_tag,
            commands::pick_directory,
            commands::set_data_dir,
            commands::export_data,
            commands::export_backup_document,
            commands::import_backup_document,
            commands::recovery_points,
            commands::recovery_details,
            commands::export_sync_diagnostics,
            commands::recovery_status,
            commands::restore_recovery_point,
            commands::import_data,
            // Phase 3：事项模板 / 脚本钩子。
            commands::list_templates,
            commands::make_template_default,
            commands::save_template,
            commands::delete_template,
            commands::preview_template_cmd,
            commands::apply_template_cmd,
            commands::hooks_status_cmd,
            commands::run_hook_test,
            // V3.1：外部修改冲突处理。
            commands::resolve_external_change,
            // V3.0：打开数据目录。
            commands::open_data_dir,
            // V2.0 Lite：七牛快照同步。
            commands::sync_get_status,
            commands::sync_cancel,
            commands::sync_configure,
            commands::sync_test_connection,
            commands::sync_now,
            commands::sync_tick,
            commands::sync_resolve_initial,
            commands::sync_takeover_expired,
            commands::sync_disconnect,
            commands::sync_exit,
            commands::sync_force_exit,
            commands::save_local_timer_exit,
            commands::load_local_timer_exit,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Resumed = event {
                // 系统从睡眠/休眠唤醒：全量重算 + 提醒补发（§6.3）。
                check_and_notify(app_handle);
                let _ = app_handle.emit("app-resumed", ());
            }
        });
}

fn startup_storage(storage: &mut Storage) -> (schedule_core::Config, Option<String>) {
    if let Err(error) = sync_snapshot::recover(storage.data_dir()) {
        return (Default::default(), Some(error));
    }
    let config = match storage.read_config() {
        Ok(config) => config,
        Err(error) => return (Default::default(), Some(error.to_string())),
    };
    // A malformed business file must open the recovery screen too. Keep valid
    // local preferences available for recovery even when another file is bad.
    let error = storage.load_all().and_then(|_| storage.read_templates().map(|_| ())).err().map(|e| e.to_string());
    (config, error)
}

#[cfg(test)]
mod startup_tests {
    use super::*;
    fn fixture() -> Storage {
        let dir=std::env::temp_dir().join(format!("moment-startup-{}",crate::sync::new_token()));
        let mut storage=Storage::new(dir);storage.ensure().unwrap();
        let mut config=schedule_core::Config::default();config.timezone="UTC".into();storage.save_config(&config).unwrap();storage
    }
    fn cleanup(storage:Storage){let dir=storage.data_dir().to_path_buf();assert!(dir.starts_with(std::env::temp_dir()));fs::remove_dir_all(dir).unwrap();}
    #[test]
    fn malformed_business_files_open_recovery_without_replacing_them_or_device_settings() {
        for file in ["events.json","routines.json","tasks.json","long_tasks.json","templates.json"] {
            let mut storage=fixture();fs::write(storage.data_dir().join(file),b"broken-business").unwrap();
            let (config,error)=startup_storage(&mut storage);assert!(error.is_some(),"{file}");assert_eq!(config.timezone,"UTC");
            assert_eq!(fs::read(storage.data_dir().join(file)).unwrap(),b"broken-business");cleanup(storage);
        }
    }
    #[test]
    fn invalid_config_is_blocked_instead_of_silently_starting_with_defaults() {
        let mut storage=fixture();fs::write(storage.data_dir().join("config.json"),b"broken-config").unwrap();
        assert!(startup_storage(&mut storage).1.is_some());assert_eq!(fs::read(storage.data_dir().join("config.json")).unwrap(),b"broken-config");cleanup(storage);
    }
    #[test]
    fn invalid_utf8_and_wrong_json_types_are_preserved_for_recovery() {
        for raw in [vec![0xff,0xfe,0x80],br#"{"version":6,"events":42}"#.to_vec()] {
            let mut storage=fixture();fs::write(storage.data_dir().join("events.json"),&raw).unwrap();
            assert!(startup_storage(&mut storage).1.is_some());assert_eq!(fs::read(storage.data_dir().join("events.json")).unwrap(),raw);cleanup(storage);
        }
    }
    #[test]
    fn newer_business_schema_is_preserved_and_blocks_startup_edits() {
        let mut storage=fixture();let raw=br#"{"version":4294967297,"events":[]}"#;fs::write(storage.data_dir().join("events.json"),raw).unwrap();
        assert!(startup_storage(&mut storage).1.is_some());assert_eq!(fs::read(storage.data_dir().join("events.json")).unwrap(),raw);cleanup(storage);
    }
    #[test]
    fn legacy_schema_remains_readable_and_is_not_rewritten_at_startup() {
        let mut storage=fixture();let raw=br#"{"version":3,"events":[]}"#;fs::write(storage.data_dir().join("events.json"),raw).unwrap();
        assert!(startup_storage(&mut storage).1.is_none());assert_eq!(fs::read(storage.data_dir().join("events.json")).unwrap(),raw);cleanup(storage);
    }
}

/// 解析自定义数据目录：优先读取默认目录下的指针文件；否则用默认目录。
fn resolve_data_dir(base: &Path) -> PathBuf {
    let ptr = base.join(DATA_DIR_POINTER);
    if let Ok(s) = fs::read_to_string(&ptr) {
        let p = PathBuf::from(s.trim());
        if p.is_absolute() {
            return p;
        }
    }
    base.to_path_buf()
}

/// 注册全局快捷键唤起主窗口（config.behavior.globalHotkey，§4.7）。
#[cfg(desktop)]
pub(crate) fn register_hotkey(app: &tauri::AppHandle) {
    let hotkey = app
        .state::<AppState>()
        .config
        .lock()
        .map(|c| c.behavior.global_hotkey.clone())
        .unwrap_or_default();
    // 快捷键解析对大小写敏感，统一转小写（如 Ctrl+Shift+A → ctrl+shift+a）。
    let Ok(shortcut) = hotkey.to_lowercase().parse::<Shortcut>() else {
        return;
    };
    let _ = app.global_shortcut().unregister_all();
    let _ = app
        .global_shortcut()
        .on_shortcut(shortcut, |app, _s, event| {
            if event.state() == ShortcutState::Pressed {
                show_main(app);
            }
        });
}

/// 按当前配置应用全局快捷键与开机自启动（启动时 + 配置变更时统一入口）。
#[cfg(desktop)]
fn apply_behavior_settings(app: &tauri::AppHandle) {
    register_hotkey(app);
    let autostart = app
        .state::<AppState>()
        .config
        .lock()
        .map(|c| c.behavior.launch_at_startup)
        .unwrap_or(false);
    if let Err(e) = platform::set_autostart(autostart) {
        eprintln!("[autostart] {e}");
    }
}

/// 构建托盘图标与菜单（§4.7：最小化、菜单、通知开关、退出）。
#[cfg(desktop)]
fn build_tray(app: &tauri::AppHandle, notify_enabled: bool) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
    let quick_add = MenuItem::with_id(app, "quick_add", "快速新增", true, None::<&str>)?;
    let notify_toggle = CheckMenuItem::with_id(
        app,
        "toggle_notify",
        "通知开关",
        true,
        notify_enabled,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quick_add, &notify_toggle, &quit])?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("此刻 MOMENT")
        .menu(&menu)
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| match event.id.as_ref() {
        "show" => show_main(app),
        "quick_add" => {
            let _ = app.emit("tray-quick-add", ());
            show_main(app);
        }
        "toggle_notify" => toggle_notify(app),
        "quit" => {
            let _ = app.emit("sync-exit-request", ());
            show_main(app);
        }
        _ => {}
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            show_main(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

#[cfg(desktop)]
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(desktop)]
fn toggle_notify(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let flipped = {
        let mut storage = match state.storage.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        if sync::SyncService::new(state.base_dir.clone())
            .prepare_write()
            .is_err()
        {
            return;
        }
        let mut config = match storage.read_config() {
            Ok(c) => c,
            Err(_) => return,
        };
        config.notifications.enabled = !config.notifications.enabled;
        // V3.1 T3：外部修改冲突时 write_json_atomic 会在写入前拦截，此处不覆盖。
        let _ = storage.save_config(&config);
        config
    };
    if let Ok(mut cfg) = state.config.lock() {
        *cfg = flipped;
    };
}

/// V3.1 T4：单一配置应用线程。`set_config` 只落盘并递增 generation；
/// 本线程串行读取最新配置并应用全局快捷键与开机自启动，快速连续保存只按最终状态执行。
#[cfg(desktop)]
fn start_config_applier(app: &tauri::AppHandle) {
    let handle = app.clone();
    thread::spawn(move || {
        let mut applied = 0u64;
        loop {
            thread::sleep(Duration::from_millis(100));
            let state = handle.state::<AppState>();
            let generation = state.config_generation.load(Ordering::SeqCst);
            if generation == applied {
                continue;
            }
            applied = generation;
            apply_behavior_settings(&handle);
        }
    });
}

/// V3.0 F5：后台周期调度线程，每 30 秒触发一次 `check_and_notify`，
/// 使常驻托盘/最小化状态下到点也能弹系统级通知；复用 `state.notified` 去重。
fn start_reminder_scheduler(app: &tauri::AppHandle) {
    let handle = tauri::AppHandle::clone(app);
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(30));
        check_and_notify(&handle);
    });
}

/// 被动刷新：重算候选，对「应弹系统通知」的提醒补发通知（本会话去重）。
#[cfg(not(target_os = "android"))]
fn check_and_notify(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if state
        .recovery_error
        .lock()
        .map(|e| e.is_some())
        .unwrap_or(true)
    {
        return;
    }
    let data = {
        let mut storage = match state.storage.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        match storage.load_all() {
            Ok(d) => d,
            Err(_) => return,
        }
    };
    let now = timeutil::now_utc_string();
    let result = match compute_candidates(&data, &now, &data.config) {
        Ok(r) => r,
        Err(_) => return,
    };
    let sound_enabled = data.config.notifications.sound;
    let mut notified = match state.notified.lock() {
        Ok(n) => n,
        Err(_) => return,
    };
    // V3.1 T2：跨天时清空上一日的去重集合，避免长期增长。
    if let Ok(mut day) = state.notified_day.lock() {
        if *day != result.local_date {
            notified.clear();
            *day = result.local_date.clone();
        }
    }
    for r in &result.due_reminders {
        if !r.should_notify {
            continue;
        }
        // V3.1 T2：直接使用后端生成的细粒度 dedup_key，同源多级提醒不再互相屏蔽。
        if notified.contains(&r.dedup_key) {
            continue;
        }
        use std::hash::{Hash, Hasher};
        let mut identifier = std::collections::hash_map::DefaultHasher::new();
        r.dedup_key.hash(&mut identifier);
        let mut builder = app
            .notification()
            .builder()
            .id((identifier.finish() & 0x7fff_ffff) as i32)
            .title(r.title.as_str())
            .body(r.body.as_str());
        // V3.1 T6：提示音开关真实接入桌面通知（默认系统提示音）。
        if sound_enabled {
            builder = builder.sound("Default");
        }
        if builder.show().is_ok() {
            notified.insert(r.dedup_key.clone());
        }
    }
}

#[cfg(target_os = "android")]
fn check_and_notify(app: &tauri::AppHandle) {
    let handle = app.clone();
    thread::spawn(move || {
        let state = handle.state::<AppState>();
        if state
            .recovery_error
            .lock()
            .map(|e| e.is_some())
            .unwrap_or(true)
        {
            return;
        }
        if let Err(error) = mobile_reminders::refresh(&handle) {
            eprintln!("Android reminder plan: {error}");
        }
    });
}
