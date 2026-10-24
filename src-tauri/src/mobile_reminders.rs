//! OS alarms continue while the WebView is paused. Android force-stop explicitly
//! disables alarms; opening the application rebuilds the future rolling plan.
use crate::state::AppState;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    hash::{Hash, Hasher},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;

struct NativeReminders(tauri::plugin::PluginHandle<tauri::Wry>);

pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("moment-reminders")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.personal.schedule", "MomentRemindersPlugin")?;
            app.manage(NativeReminders(handle));
            Ok(())
        })
        .build()
}

#[derive(Serialize, Deserialize)]
pub struct ReminderStatus {
    pub exact: bool,
}

pub fn status(app: &AppHandle) -> Result<ReminderStatus, String> {
    app.state::<NativeReminders>().0.run_mobile_plugin("status", ()).map_err(|e| e.to_string())
}

pub fn open_settings(app: &AppHandle, exact: bool) -> Result<(), String> {
    app.state::<NativeReminders>().0.run_mobile_plugin("settings", serde_json::json!({"exact":exact})).map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize)]
struct Registered {
    signature: String,
    at: i64,
}

fn id(key: &str) -> i32 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut h);
    (h.finish() & 0x7fff_ffff) as i32
}

pub fn refresh(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut cached = state
        .mobile_schedule_fingerprint
        .lock()
        .map_err(|_| "提醒计划锁不可用".to_string())?;
    // Read after taking the scheduling lock. A delayed foreground/background
    // refresh must never reinstall an older plan after a newer edit or setting.
    let (data_dir, data) = {
        let mut storage = state.storage.lock().map_err(|_| "存储锁不可用".to_string())?;
        (storage.data_dir().to_path_buf(), storage.load_all().map_err(|e| e.to_string())?)
    };
    let file = data_dir.join(".android-notification-plan.json");
    let previous: BTreeMap<String, Registered> = fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    if app
        .notification()
        .permission_state()
        .map_err(|e| e.to_string())?
        != tauri::plugin::PermissionState::Granted
    {
        app.notification()
            .cancel(previous.keys().map(|key| id(key)).collect())
            .map_err(|e| e.to_string())?;
        crate::sync::atomic_write(&file, b"{}")?;
        cached.clear();
        return Ok(());
    }
    let now = Utc::now();
    let exact = status(app)?.exact;
    let raw = serde_json::to_vec(&(&data, now.timestamp() / 3600, exact)).map_err(|e| e.to_string())?;
    let fingerprint = hex::encode(Sha256::digest(raw));
    if *cached == fingerprint {
        return Ok(());
    }
    let cold = cached.is_empty();
    // The native bridge persists each request in the same store used by the
    // plugin's boot receiver, getPending, delivery and cancellation.
    let pending: BTreeSet<i32> = app
        .notification()
        .pending()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|n| n.id())
        .collect();
    let plan = schedule_core::reminder_plan::plan(&data, now);
    let next_ids: BTreeSet<_> = plan.iter().map(|p| id(&p.key)).collect();
    let registered: BTreeSet<_> = previous
        .keys()
        .map(|key| id(key))
        .chain(pending.iter().copied())
        .collect();
    let obsolete: Vec<_> = registered.difference(&next_ids).copied().collect();
    if !obsolete.is_empty() {
        app.notification()
            .cancel(obsolete)
            .map_err(|e| e.to_string())?;
    }
    let mut next = BTreeMap::new();
    for planned in plan {
        let notification_id = id(&planned.key);
        let signature = hex::encode(Sha256::digest(
            serde_json::to_vec(&(&planned, exact, data.config.notifications.sound)).map_err(|e| e.to_string())?,
        ));
        let prior = previous.get(&planned.key);
        let already_delivered = prior
            .map(|p| {
                p.at <= now.timestamp()
                    && planned.at <= now + chrono::Duration::seconds(2)
                    && !pending.contains(&notification_id)
            })
            .unwrap_or(false);
        let unchanged = prior.map(|p| p.signature == signature).unwrap_or(false);
        if !already_delivered && (!unchanged || cold) {
            let at = planned.at.max(now + chrono::Duration::seconds(2));
            // Android's Java date adapter interprets fractional digits as
            // milliseconds. Whole-second values avoid nanosecond amplification.
            let at = chrono::DateTime::<Utc>::from_timestamp(at.timestamp() + 1, 0)
                .ok_or("提醒时间超出范围")?;
            let notification = serde_json::json!({
                "id":notification_id,"title":planned.notice.title,"body":planned.notice.body,
                "sound":if data.config.notifications.sound {Some("Default")} else {None},
                "schedule":{"at":{"date":at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),"repeating":false,"allowWhileIdle":true}}
            });
            app.state::<NativeReminders>().0.run_mobile_plugin::<()>("schedule", serde_json::json!({"notification":notification.to_string()})).map_err(|e| e.to_string())?;
        }
        next.insert(
            planned.key,
            Registered {
                signature,
                at: prior
                    .filter(|_| already_delivered)
                    .map(|p| p.at)
                    .unwrap_or(planned.at.timestamp()),
            },
        );
    }
    crate::sync::atomic_write(
        &file,
        &serde_json::to_vec(&next).map_err(|e| e.to_string())?,
    )?;
    *cached = fingerprint;
    Ok(())
}
