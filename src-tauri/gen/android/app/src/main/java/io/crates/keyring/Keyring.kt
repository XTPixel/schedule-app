package io.crates.keyring

import android.content.Context

/** Supplies the Android context needed by android-native-keyring-store. */
class Keyring {
  companion object {
    init {
      System.loadLibrary("schedule_app_lib")
    }

    external fun initializeNdkContext(context: Context)
  }
}
