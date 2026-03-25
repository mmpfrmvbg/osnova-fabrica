package com.osnova.osiris

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class OsirisTaskEvent(
    val id: Int,
    val eventType: String,
    val actor: String,
    val note: String?,
    val createdAt: String,
)

data class OsirisTaskDependency(
    val id: Int,
    val title: String,
    val status: String,
    val project: String,
)

data class OsirisTaskDetails(
    val id: Int,
    val title: String,
    val status: String,
    val project: String,
    val priority: Int?,
    val deadline: String?,
    val description: String?,
)

data class OsirisTaskDetailsResponse(
    val task: OsirisTaskDetails,
    val dependencies: List<OsirisTaskDependency>,
)

data class OsirisTaskDraft(
    val title: String,
    val description: String,
    val project: String = "general",
    val priority: Int? = null,
    val deadline: String? = null,
    val type: String = "task",
)

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
                val parsed = org.json.JSONObject(body)
                val arr = parsed.getJSONArray("tasks")
                val result = mutableListOf<OsirisTask>()
                for (i in 0 until arr.length()) {
                    val obj = arr.getJSONObject(i)
                    result.add(
                        OsirisTask(
                            id = obj.getInt("id"),
                            title = obj.getString("title"),
                            status = obj.getString("status"),
                            project = obj.optString("project", "general"),
                            priority = if (obj.has("priority")) obj.optInt("priority") else null,
                            deadline = if (obj.has("deadline") && !obj.isNull("deadline")) obj.getString("deadline") else null,
                            assignee = if (obj.has("assignee") && !obj.isNull("assignee")) obj.getString("assignee") else null,
                        )
                    )
                }
                result.toList()
            } catch (e: Exception) {
                emptyList()
            }
        }
    }

    fun createTask(draft: OsirisTaskDraft): Boolean {
        val userId = AppPreferences.userId
        val baseUrl = AppPreferences.baseUrl

        val jsonBody = JSONObject()
            .put("title", draft.title)
            .put("description", draft.description)
            .put("project", draft.project)
            .put("type", draft.type)

        if (draft.priority != null) jsonBody.put("priority", draft.priority)
        if (draft.deadline != null) jsonBody.put("deadline", draft.deadline)

        val body = jsonBody.toString().toRequestBody(JSON_TYPE)
        val request = Request.Builder()
            .url("$baseUrl/tasks?userId=$userId")
            .post(body)
            .build()

        client.newCall(request).execute().use { response ->
            return response.isSuccessful
        }
    }

    fun updateTaskFields(taskId: Int, patch: Map<String, Any?>): Boolean {
        val userId = AppPreferences.userId
        val baseUrl = AppPreferences.baseUrl

        val jsonBody = JSONObject()
        patch.forEach { (k, v) ->
            if (v == null) return@forEach
            jsonBody.put(k, v)
        }

        val body = jsonBody.toString().toRequestBody(JSON_TYPE)
        val request = Request.Builder()
            .url("$baseUrl/tasks/$taskId?userId=$userId")
            .patch(body)
            .build()

        client.newCall(request).execute().use { response ->
            return response.isSuccessful
        }
    }

    fun linkDependency(taskId: Int, dependencyId: Int): Boolean {
        val userId = AppPreferences.userId
        val baseUrl = AppPreferences.baseUrl

        val jsonBody = JSONObject().put("dependencyId", dependencyId)
        val body = jsonBody.toString().toRequestBody(JSON_TYPE)
        val request = Request.Builder()
            .url("$baseUrl/tasks/$taskId/dependencies?userId=$userId")
            .post(body)
            .build()

        client.newCall(request).execute().use { response ->
            return response.isSuccessful
        }
    }

    fun unlinkDependency(taskId: Int, dependencyId: Int): Boolean {
        val userId = AppPreferences.userId
        val baseUrl = AppPreferences.baseUrl

        val request = Request.Builder()
            .url("$baseUrl/tasks/$taskId/dependencies?userId=$userId&dependencyId=$dependencyId")
            .delete()
            .build()

        client.newCall(request).execute().use { response ->
            return response.isSuccessful
        }
    }

    fun transitionTask(taskId: Int, status: String, note: String? = null): Boolean {
        val userId = AppPreferences.userId
        val baseUrl = AppPreferences.baseUrl
        val jsonBody = org.json.JSONObject()
            .put("status", status)
        if (note != null) jsonBody.put("note", note)
        val body = jsonBody.toString().toRequestBody(JSON_TYPE)
        val request = Request.Builder()
            .url("$baseUrl/tasks/$taskId/transition?userId=$userId")
            .post(body)
            .build()
        client.newCall(request).execute().use { response ->
            return response.isSuccessful
        }
    }

    fun completeTask(taskId: Int): Boolean {
        return transitionTask(taskId, "done")
    }

    fun getTaskDetails(taskId: Int): OsirisTaskDetailsResponse? {
        val userId = AppPreferences.userId
        val baseUrl = AppPreferences.baseUrl
        val request = Request.Builder()
            .url("$baseUrl/tasks/$taskId?userId=$userId")
            .get()
            .build()
        client.newCall(request).execute().use { response ->
            val body = response.body?.string() ?: return null
            if (!response.isSuccessful) return null
            return try {
                val parsed = org.json.JSONObject(body)
                val taskObj = parsed.getJSONObject("task")
                val task = OsirisTaskDetails(
                    id = taskObj.getInt("id"),
                    title = taskObj.getString("title"),
                    status = taskObj.getString("status"),
                    project = taskObj.optString("project", "general"),
                    priority = if (taskObj.has("priority") && !taskObj.isNull("priority")) taskObj.optInt("priority") else null,
                    deadline = if (taskObj.has("deadline") && !taskObj.isNull("deadline")) taskObj.getString("deadline") else null,
                    description = if (taskObj.has("description") && !taskObj.isNull("description")) taskObj.getString("description") else null,
                )
                val depsArr = parsed.getJSONArray("dependencies")
                val deps = mutableListOf<OsirisTaskDependency>()
                for (i in 0 until depsArr.length()) {
                    val obj = depsArr.getJSONObject(i)
                    deps.add(
                        OsirisTaskDependency(
                            id = obj.getInt("id"),
                            title = obj.getString("title"),
                            status = obj.getString("workflowStatus"),
                            project = obj.optString("project", "general"),
                        )
                    )
                }
                OsirisTaskDetailsResponse(task = task, dependencies = deps)
            } catch (e: Exception) {
                null
            }
        }
    }

    fun getTaskHistory(taskId: Int, limit: Int = 20): List<OsirisTaskEvent> {
        val userId = AppPreferences.userId
        val baseUrl = AppPreferences.baseUrl
        val request = Request.Builder()
            .url("$baseUrl/tasks/$taskId/history?userId=$userId&limit=$limit")
            .get()
            .build()
        client.newCall(request).execute().use { response ->
            val body = response.body?.string() ?: return emptyList()
            if (!response.isSuccessful) return emptyList()
            return try {
                val parsed = org.json.JSONObject(body)
                val eventsArr = parsed.getJSONArray("events")
                val events = mutableListOf<OsirisTaskEvent>()
                for (i in 0 until eventsArr.length()) {
                    val e = eventsArr.getJSONObject(i)
                    events.add(
                        OsirisTaskEvent(
                            id = e.getInt("id"),
                            eventType = e.getString("eventType"),
                            actor = e.getString("actor"),
                            note = if (e.has("note") && !e.isNull("note")) e.getString("note") else null,
                            createdAt = e.getString("createdAt"),
                        )
                    )
                }
                events
            } catch (e: Exception) {
                emptyList()
            }
        }
    }
}
