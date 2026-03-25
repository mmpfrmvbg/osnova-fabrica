package com.osnova.osiris

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

object OtaUpdater {
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)
        .build()

    private const val LATEST_PATH = "/ota/android/latest"
    private const val APK_MIME = "application/vnd.android.package-archive"

    suspend fun checkAndPromptInstall(context: Context) {
        val latest = withContext(Dispatchers.IO) { fetchLatest(context) } ?: return
        val versionCode = latest.versionCode ?: return
        val apkUrl = latest.apkUrl ?: return

        val currentVersionCode = getCurrentVersionCode(context)
        if (versionCode <= currentVersionCode) return

        // On Android 8+ ensure we are allowed to request installs.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val pm = context.packageManager
            if (!pm.canRequestPackageInstalls()) {
                val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                    data = Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                return
            }
        }

        val apkFile = File(context.cacheDir, "osiris-android-update.apk")
        withContext(Dispatchers.IO) { downloadApk(apkUrl, apkFile) }

        val apkUri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            apkFile
        )

        val installIntent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(apkUri, APK_MIME)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

        context.startActivity(installIntent)
    }

    private data class Latest(val versionCode: Int?, val apkUrl: String?)

    private fun baseUrl(): String = AppPreferences.baseUrl.trimEnd('/')

    private suspend fun fetchLatest(context: Context): Latest? {
        val url = "${baseUrl()}$LATEST_PATH"
        val request = Request.Builder().url(url).get().build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return null
            val body = response.body?.string() ?: return null
            val json = JSONObject(body)
            val versionCode = if (json.has("versionCode")) json.optInt("versionCode") else null
            val apkUrl = json.optString("apkUrl", null)
            return Latest(versionCode = versionCode, apkUrl = apkUrl)
        }
    }

    private fun getCurrentVersionCode(context: Context): Int {
        return try {
            val pInfo = context.packageManager.getPackageInfo(context.packageName, 0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) pInfo.longVersionCode.toInt() else pInfo.versionCode
        } catch {
            0
        }
    }

    private fun downloadApk(apkUrl: String, dest: File) {
        val request = Request.Builder().url(apkUrl).get().build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("Failed to download apk: ${response.code}")
            dest.outputStream().use { out ->
                response.body?.byteStream()?.use { input -> input.copyTo(out) }
                    ?: throw IllegalStateException("Empty apk body")
            }
        }
    }
}

