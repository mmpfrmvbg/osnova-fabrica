package com.osnova.osiris

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object ApiClient {
    // Замени на IP своего VPS
    private const val BASE_URL = "http://YOUR_VPS_IP:3000"

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()

    private val JSON = "application/json".toMediaType()

    fun sendMessage(userId: String, message: String): String {
        val body = JSONObject().apply {
            put("userId", userId)
            put("message", message)
        }.toString().toRequestBody(JSON)

        val request = Request.Builder()
            .url("$BASE_URL/chat")
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
