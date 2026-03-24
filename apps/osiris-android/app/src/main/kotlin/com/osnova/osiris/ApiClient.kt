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

    fun getTasks(): List<OsirisTask> {
        val userId = AppPreferences.userId
        val baseUrl = AppPreferences.baseUrl
        val request = Request.Builder()
            .url("$baseUrl/tasks?userId=$userId")
            .get()
            .build()
        client.newCall(request).execute().use { response ->
            val body = response.body?.string() ?: return emptyList()
            if (!response.isSuccessful) return emptyList()
            return try {
                val grouped = org.json.JSONObject(body)
                val result = mutableListOf<OsirisTask>()
                grouped.keys().forEach { project ->
                    val arr = grouped.getJSONArray(project)
                    for (i in 0 until arr.length()) {
                        val obj = arr.getJSONObject(i)
                        result.add(
                            OsirisTask(
                                id = obj.getInt("id"),
                                title = obj.getString("title"),
                                status = obj.getString("status"),
                                project = obj.optString("project", "general")
                            )
                        )
                    }
                }
                result
            } catch (e: Exception) {
                emptyList()
            }
        }
    }

    fun completeTask(taskId: Int): Boolean {
        val userId = AppPreferences.userId
        val baseUrl = AppPreferences.baseUrl
        val body = org.json.JSONObject()
            .put("status", "done")
            .toString()
            .toRequestBody(JSON_TYPE)
        val request = Request.Builder()
            .url("$baseUrl/tasks/$taskId?userId=$userId")
            .patch(body)
            .build()
        client.newCall(request).execute().use { response ->
            return response.isSuccessful
        }
    }
}
