package com.osnova.osiris

import android.content.Context
import android.content.SharedPreferences

object AppPreferences {
    private const val PREFS_NAME = "osiris_prefs"
    const val DEFAULT_URL = "http://5.35.80.100:3000"
    const val DEFAULT_USER_ID = "android-user"

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    var baseUrl: String
        get() = prefs.getString("base_url", DEFAULT_URL) ?: DEFAULT_URL
        set(value) = prefs.edit().putString("base_url", value).apply()

    var userId: String
        get() = prefs.getString("user_id", DEFAULT_USER_ID) ?: DEFAULT_USER_ID
        set(value) = prefs.edit().putString("user_id", value).apply()
}
