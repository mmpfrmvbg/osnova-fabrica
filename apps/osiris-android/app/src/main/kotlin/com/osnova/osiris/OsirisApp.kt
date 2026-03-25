package com.osnova.osiris

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class OsirisApp : Application() {
    override fun onCreate() {
        super.onCreate()
        AppPreferences.init(this)
        // Check for OTA updates on app start (user will be prompted to install).
        CoroutineScope(Dispatchers.Main).launch {
            try {
                OtaUpdater.checkAndPromptInstall(this@OsirisApp)
            } catch (_: Exception) {
                // Ignore OTA failures to not block app startup.
            }
        }
    }
}
