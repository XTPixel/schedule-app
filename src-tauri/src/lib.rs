//! Tauri 应用入口：装配后端状态、托盘、系统通知、全局快捷键、被动刷新与 resume 唤醒钩子。
//! Git 一键备份与移动端只读服务已完全移除（对应模块、命令、状态与前端入口均已删除）。

mod commands;
mod state;
pub mod platform;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use schedule_core::{compute_candidates, timeutil, Storage};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

use state::AppState;

const WINDOW_LABEL: &str = "main";
const TRAY_ID: &str = "main-tray";
const DATA_DIR_POINTER: &str = "data_dir.txt";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let base_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&base_dir)?;
            let data_dir = resolve_data_dir(&base_dir);
            let mut storage = Storage::new(data_dir.clone());
            let _ = storage.ensure();
            let config = storage.read_config().unwrap_or_default();
            app.manage(AppState {
                storage: Mutex::new(storage),
                config: Mutex::new(config.clone()),
                notified: Mutex::new(HashSet::new()),
                notified_day: Mutex::new(String::new()),
                base_dir,
                config_generation: AtomicU64::new(0),
            });
            build_tray(app.handle(), config.notifications.enabled)?;
            // 应用启动时同步全局快捷键与开机自启动状态（§1.0.1）。
            apply_behavior_settings(app.handle());
            // 启动/主窗口打开时被动刷新提醒（§6.3）。
            check_and_notify(app.handle());
            // V3.0 F5：启动后台周期调度线程，常驻/最小化时到点也能弹系统通知。
            start_reminder_scheduler(app.handle());
            // V3.1 T4：单一配置应用线程，串行应用全局快捷键等配置。
            start_config_applier(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 最小化到托盘（§4.7 / §7）。
                let minimize = window
                    .state::<AppState>()
                    .config
                    .lock()
                    .map(|c| c.behavior.minimize_to_tray)
                    .unwrap_or(true);
                if minimize {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
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
            commands::archive_entry,
            commands::complete_candidate,
            commands::update_archive_day,
            commands::get_archive_month,
            commands::get_config,
            commands::set_config,
            commands::notify,
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
pub(crate) fn register_hotkey(app: &tauri::AppHandle) {
    let hotkey = app
        .state::<AppState>()
        .config
        .lock()
        .map(|c| c.behavior.global_hotkey.clone())
        .unwrap_or_default();
    // 快捷键解析对大小写敏感，统一转小写（如 Ctrl+Shift+A → ctrl+shift+a）。
    let Ok(shortcut) = hotkey.to_lowercase().parse::<Shortcut>() else { return };
    let _ = app.global_shortcut().unregister_all();
    let _ = app.global_shortcut().on_shortcut(shortcut, |app, _s, event| {
        if event.state() == ShortcutState::Pressed {
            show_main(app);
        }
    });
}

/// 按当前配置应用全局快捷键与开机自启动（启动时 + 配置变更时统一入口）。
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
fn build_tray(app: &tauri::AppHandle, notify_enabled: bool) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开主界面", true, None::<&str>)?;
    let quick_add = MenuItem::with_id(app, "quick_add", "快速新增", true, None::<&str>)?;
    let notify_toggle =
        CheckMenuItem::with_id(app, "toggle_notify", "通知开关", true, notify_enabled, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quick_add, &notify_toggle, &quit])?;

    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("此刻 MOMENT")
        .menu(&menu)
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quick_add" => {
                let _ = app.emit("tray-quick-add", ());
                show_main(app);
            }
            "toggle_notify" => toggle_notify(app),
            "quit" => app.exit(0),
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

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_notify(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let flipped = {
        let mut storage = match state.storage.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
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
fn check_and_notify(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
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
        notified.insert(r.dedup_key.clone());
        let mut builder = app.notification().builder().title(r.title.as_str()).body(r.body.as_str());
        // V3.1 T6：提示音开关真实接入桌面通知（默认系统提示音）。
        if sound_enabled {
            builder = builder.sound("Default");
        }
        let _ = builder.show();
    }
}
