package com.personal.schedule

import android.app.Activity
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.notification.Notification
import app.tauri.notification.NotificationStorage
import app.tauri.notification.TauriNotificationManager
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

@InvokeArg
class MomentReminderArgs { lateinit var notification: String }

@InvokeArg
class MomentReminderSettingsArgs { var exact: Boolean = false }

/** Keep the plugin's scheduling, cancellation and boot receiver on one store.
 * Its Rust builder only calls `show`, which does not persist scheduled requests.
 */
@TauriPlugin
class MomentRemindersPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun schedule(invoke: Invoke) {
    val raw = invoke.parseArgs(MomentReminderArgs::class.java).notification
    val notification = jsonMapper().readValue(raw, Notification::class.java)
    require(notification.schedule != null) { "Reminder schedule is required" }
    // The boot receiver can write overdue requests again. Retain a valid source
    // there too, instead of letting NotificationStorage persist the text null.
    val storage = NotificationStorage(activity, jsonMapper())
    val manager = TauriNotificationManager(storage, activity, activity, null)
    manager.createNotificationChannel()
    val audible = notification.sound != null
    notification.channelId = if (audible) "moment-reminders" else "moment-reminders-silent"
    if (Build.VERSION.SDK_INT >= 26) {
      val channel = NotificationChannel(notification.channelId, if (audible) "日程提醒" else "日程提醒（静音）", NotificationManager.IMPORTANCE_HIGH)
      if (!audible) { channel.setSound(null, null); channel.enableVibration(false) }
      (activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(channel)
    }
    val stored = JSONObject(raw).put("channelId", notification.channelId)
    notification.sourceJson = stored.put("sourceJson", stored.toString()).toString()
    storage.appendNotifications(listOf(notification))
    manager.schedule(notification)
    invoke.resolve()
  }

  @Command
  fun status(invoke: Invoke) {
    val alarms = activity.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    invoke.resolve(JSObject().put("exact", Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms()))
  }

  @Command
  fun settings(invoke: Invoke) {
    val exact = invoke.parseArgs(MomentReminderSettingsArgs::class.java).exact
    val intent = if (exact && Build.VERSION.SDK_INT >= 31) {
      Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${activity.packageName}"))
    } else if (Build.VERSION.SDK_INT >= 26) {
      Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
    } else {
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))
    }
    activity.startActivity(intent)
    invoke.resolve()
  }
}
