# Add project specific ProGuard rules here.
-keep class io.crates.keyring.Keyring { *; }
-keep class io.crates.keyring.Keyring$Companion { *; }
-keep class com.personal.schedule.MomentRemindersPlugin { *; }
-keep class com.personal.schedule.MomentReminderArgs { *; }
-keep class com.personal.schedule.MomentReminderSettingsArgs { *; }
# Jackson accesses notification DTO properties through reflection. Keep them in
# optimized APKs as well as Debug (pending-list getters have no direct callers).
-keep class app.tauri.notification.PendingNotification { *; }
-keep class app.tauri.notification.NotificationSchedule* { *; }
-keep class app.tauri.notification.DateMatch { *; }
-keep enum app.tauri.notification.NotificationInterval { *; }
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
