package com.osnova.osiris

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object AuthClient {
    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    private val JSON_TYPE = "application/json".toMediaType()

    data class RegisterResult(val deviceToken: String, val userId: String?)

    fun registerDevice(baseUrlRaw: String): RegisterResult {
        val baseUrl = baseUrlRaw.trimEnd('/')
        val body = JSONObject()
            .put("deviceName", "android")
            .put(
                "deviceInfo",
                JSONObject()
                    .put("os", "android")
                    .put("appVersion", "unknown")
            )
            .toString()
            .toRequestBody(JSON_TYPE)

        val request = Request.Builder()
            .url("$baseUrl/auth/device/register")
            .post(body)
            .build()

        client.newCall(request).execute().use { response ->
            val responseBody = response.body?.string() ?: ""
            if (!response.isSuccessful) {
                throw IllegalStateException("register failed: http ${response.code}")
            }
            val json = JSONObject(responseBody)
            val token = json.optString("deviceToken", "")
            if (token.isBlank()) throw IllegalStateException("register failed: empty token")
            val userId = json.optString("userId", null)
            return RegisterResult(deviceToken = token, userId = userId)
        }
    }
}
