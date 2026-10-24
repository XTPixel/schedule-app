package com.personal.schedule

import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import android.content.res.Configuration
import io.crates.keyring.Keyring

class MainActivity : TauriActivity() {
  override val handleBackNavigation = false
  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    val light = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK != Configuration.UI_MODE_NIGHT_YES
    WindowInsetsControllerCompat(window, webView).apply {
      isAppearanceLightStatusBars = light
      isAppearanceLightNavigationBars = light
    }
    // Android 15+ draws behind system bars by default. Give the WebView an
    // actual measured inset so 100vh and focused form fields stay visible.
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
      val bottom = maxOf(bars.bottom, keyboard.bottom)
      (view.layoutParams as? ViewGroup.MarginLayoutParams)?.let { params ->
        if (params.leftMargin != bars.left || params.topMargin != bars.top || params.rightMargin != bars.right || params.bottomMargin != bottom) {
          params.setMargins(bars.left, bars.top, bars.right, bottom)
          view.layoutParams = params
        }
      }
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(webView)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript("(function(){return typeof window.__momentBack==='function' && window.__momentBack();})()") { handled ->
          if (handled != "true") moveTaskToBack(true)
        }
      }
    })
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    Keyring.initializeNdkContext(applicationContext)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
