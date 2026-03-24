package com.osnova.osiris

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object ApiClient {
    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    private val JSON_TYPE = "application/json".toMediaType()

    fun sendMessage(message: String): String {
        val baseUrl = AppPreferences.baseUrl
        val userId = AppPreferences.userId
        val body = JSONObject().apply {
            put("userId", userId)
            put("message", message)
        }.toString().toRequestBody(JSON_TYPE)

        val request = Request.Builder()
            .url("$baseUrl/chat")
            .post(body)
            .build()

        client.newCall(request).execute().use { response ->
            val responseBody = response.body?.string() ?: return "[нет ответа]"
            if (!response.isSuccessful) return "[ошибка ${response.code}]"
            return try {
                JSONObject(responseBody).getString("reply")
            } catch (e: Exception) {
                "[ошибка парсинга]"
            }
        }
    }
}
