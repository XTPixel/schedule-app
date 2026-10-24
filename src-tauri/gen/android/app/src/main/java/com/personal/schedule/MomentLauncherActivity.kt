package com.personal.schedule

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.webkit.WebView
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/** Keep a disabled/missing system WebView from crashing before HTML can load. */
class MomentLauncherActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val available = try { WebView.getCurrentWebViewPackage() != null } catch (_: RuntimeException) { false }
    if (available) {
      startActivity(Intent(this, MainActivity::class.java).apply {
        putExtras(intent)
        action = intent.action
        data = intent.data
        addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      })
      finish()
      return
    }
    val padding = (24 * resources.displayMetrics.density).toInt()
    val panel = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(padding, padding, padding, padding)
      setBackgroundColor(Color.rgb(15, 23, 42))
    }
    panel.addView(TextView(this).apply {
      text = "浏览组件不可用"
      textSize = 24f
      setTextColor(Color.WHITE)
    })
    panel.addView(TextView(this).apply {
      text = "请在系统设置中启用 Android System WebView 或 Chrome，并通过系统应用商店更新后重试。日程数据会保留，无需卸载此刻。"
      textSize = 16f
      setTextColor(Color.rgb(203, 213, 225))
      setPadding(0, padding, 0, padding)
    })
    panel.addView(Button(this).apply {
      text = "打开应用设置"
      setOnClickListener {
        try { startActivity(Intent(Settings.ACTION_APPLICATION_SETTINGS)) } catch (_: RuntimeException) { }
      }
    })
    panel.addView(Button(this).apply {
      text = "重试"
      setOnClickListener { recreate() }
    })
    setContentView(panel)
  }
}
