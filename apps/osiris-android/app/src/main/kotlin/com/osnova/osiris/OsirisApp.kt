package com.osnova.osiris

import android.app.Application

class OsirisApp : Application() {
    override fun onCreate() {
        super.onCreate()
        AppPreferences.init(this)
    }
}
