package com.osnova.osiris

import android.app.Application
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class OsirisApp : Application() {
    override fun onCreate() {
        super.onCreate()
        AppPreferences.init(this)
        // Ensure device token exists for auth-based API.
        CoroutineScope(Dispatchers.IO).launch {
            try {
                if (AppPreferences.deviceToken.isNullOrBlank()) {
                    val reg = AuthClient.registerDevice(AppPreferences.baseUrl)
                    AppPreferences.deviceToken = reg.deviceToken
                }
            } catch (_: Exception) {
                // Non-fatal: app can still show UI; network calls will fail with 401 until recovered.
            }
        }
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
