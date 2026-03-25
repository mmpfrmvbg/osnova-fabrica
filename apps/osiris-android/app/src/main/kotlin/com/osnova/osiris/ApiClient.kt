package com.osnova.osiris

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
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

    /** Сериализация повторной регистрации при первых параллельных запросах */
    private val deviceRegisterLock = Any()

    private fun baseUrl(): String = AppPreferences.baseUrl.trimEnd('/')

    private fun authHeader(): String? {
        val t = AppPreferences.deviceToken
        return if (t.isNullOrBlank()) null else "Bearer $t"
    }

    /**
     * Регистрация устройства, если токена ещё нет (гонка со стартом приложения, смена URL, сброс в настройках).
     */
    private fun ensureDeviceTokenOrThrow() {
        if (!AppPreferences.deviceToken.isNullOrBlank()) return
        synchronized(deviceRegisterLock) {
            if (!AppPreferences.deviceToken.isNullOrBlank()) return
            try {
                val reg = AuthClient.registerDevice(baseUrl())
                AppPreferences.deviceToken = reg.deviceToken
            } catch (e: Exception) {
                throw IllegalStateException(
                    "Не удалось получить токен устройства. Проверьте «Server URL» в настройках (доступен ли сервер по HTTPS), сеть и что на бекенде есть POST /auth/device/register. Причина: ${e.message}",
                    e
                )
            }
        }
    }

    private fun requireAuthOrThrow(): String {
        ensureDeviceTokenOrThrow()
        return authHeader()
            ?: throw IllegalStateException("Токен устройства не сохранён после регистрации.")
    }

    private fun requestId(): String = java.util.UUID.randomUUID().toString()

    fun sendMessage(message: String): String {
        val body = JSONObject().apply {
            put("message", message)
        }.toString().toRequestBody(JSON_TYPE)

        val request = Request.Builder()
            .url("${baseUrl()}/chat")
            .header("Authorization", requireAuthOrThrow())
            .header("X-Request-Id", requestId())
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

    fun sendMessageStream(
        message: String,
        onToken: (String) -> Unit,
        onActions: (actions: org.json.JSONArray, explanation: String?) -> Unit,
    ): String {
        val body = JSONObject().apply {
            put("message", message)
            put("previewActions", true)
        }.toString().toRequestBody(JSON_TYPE)

        val request = Request.Builder()
            .url("${baseUrl()}/chat/stream")
            .header("Authorization", requireAuthOrThrow())
            .header("Accept", "text/event-stream")
            .header("X-Request-Id", requestId())
            .post(body)
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IllegalStateException("http ${response.code}")
            val stream = response.body?.byteStream() ?: throw IllegalStateException("empty body")
            val reader = BufferedReader(InputStreamReader(stream))
            val acc = StringBuilder()
            while (true) {
                val line = reader.readLine() ?: break
                if (!line.startsWith("data:")) continue
                val payload = line.removePrefix("data:").trim()
                if (payload.isBlank()) continue
                val json = try { JSONObject(payload) } catch (_: Exception) { null } ?: continue
                if (json.optBoolean("done", false)) break
                val token = json.optString("token", "")
                if (token.isNotEmpty()) {
                    acc.append(token)
                    onToken(token)
                }
                if (json.has("actions") && !json.isNull("actions")) {
                    val actions = json.getJSONArray("actions")
                    val explanation = json.optString("explanation", null)
                    onActions(actions, explanation)
                }
                val err = json.optString("error", "")
                if (err.isNotEmpty()) throw IllegalStateException(err)
            }
            return acc.toString()
        }
    }

    fun applyActions(actions: org.json.JSONArray): String {
        val body = JSONObject()
            .put("clientActionBatchId", java.util.UUID.randomUUID().toString())
            .put("actions", actions)
            .toString()
            .toRequestBody(JSON_TYPE)

        val request = Request.Builder()
            .url("${baseUrl()}/actions/apply")
            .header("Authorization", requireAuthOrThrow())
            .header("X-Request-Id", requestId())
            .post(body)
            .build()

        client.newCall(request).execute().use { response ->
            val responseBody = response.body?.string() ?: ""
            if (!response.isSuccessful) throw IllegalStateException("http ${response.code}")
            val json = JSONObject(responseBody)
            val batchId = json.optString("batchId", "")
            if (batchId.isBlank()) throw IllegalStateException("no batchId")
            return batchId
        }
    }

    fun undoBatch(batchId: String): Boolean {
        val body = JSONObject()
            .put("batchId", batchId)
            .toString()
            .toRequestBody(JSON_TYPE)

        val request = Request.Builder()
            .url("${baseUrl()}/actions/undo")
            .header("Authorization", requireAuthOrThrow())
            .header("X-Request-Id", requestId())
            .post(body)
            .build()

        client.newCall(request).execute().use { response ->
            return response.isSuccessful
        }
    }

    fun getTasks(
        status: String? = null,
        project: String? = null,
        search: String? = null,
        sort: String? = null,
    ): List<OsirisTask> {
        val urlBuilder = "${baseUrl()}/tasks".toHttpUrl().newBuilder()
        if (!status.isNullOrBlank()) urlBuilder.addQueryParameter("status", status)
        if (!project.isNullOrBlank()) urlBuilder.addQueryParameter("project", project)
        if (!search.isNullOrBlank()) urlBuilder.addQueryParameter("search", search)
        if (!sort.isNullOrBlank()) urlBuilder.addQueryParameter("sort", sort)

        val request = Request.Builder()
            .url(urlBuilder.build())
            .header("Authorization", requireAuthOrThrow())
            .header("X-Request-Id", requestId())
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
        val jsonBody = JSONObject()
            .put("title", draft.title)
            .put("description", draft.description)
            .put("project", draft.project)
            .put("type", draft.type)

        if (draft.priority != null) jsonBody.put("priority", draft.priority)
        if (draft.deadline != null) jsonBody.put("deadline", draft.deadline)

        val body = jsonBody.toString().toRequestBody(JSON_TYPE)
        val request = Request.Builder()
            .url("${baseUrl()}/tasks")
            .header("Authorization", requireAuthOrThrow())
            .header("X-Request-Id", requestId())
            .post(body)
            .build()

        client.newCall(request).execute().use { response ->
            return response.isSuccessful
        }
    }

    fun updateTaskFields(taskId: Int, patch: Map<String, Any?>): Boolean {
        val jsonBody = JSONObject()
        patch.forEach { (k, v) ->
            if (v == null) return@forEach
            jsonBody.put(k, v)
        }

        val body = jsonBody.toString().toRequestBody(JSON_TYPE)
        val request = Request.Builder()
            .url("${baseUrl()}/tasks/$taskId")
            .header("Authorization", requireAuthOrThrow())
            .header("X-Request-Id", requestId())
            .patch(body)
            .build()

        client.newCall(request).execute().use { response ->
            return response.isSuccessful
        }
    }

    fun linkDependency(taskId: Int, dependencyId: Int): Boolean {
        val jsonBody = JSONObject().put("dependencyId", dependencyId)
        val body = jsonBody.toString().toRequestBody(JSON_TYPE)
        val request = Request.Builder()
            .url("${baseUrl()}/tasks/$taskId/dependencies")
            .header("Authorization", requireAuthOrThrow())
            .header("X-Request-Id", requestId())
            .post(body)
            .build()

        client.newCall(request).execute().use { response ->
            return response.isSuccessful
        }
    }

    fun unlinkDependency(taskId: Int, dependencyId: Int): Boolean {
        val request = Request.Builder()
            .url("${baseUrl()}/tasks/$taskId/dependencies?dependencyId=$dependencyId")
            .header("Authorization", requireAuthOrThrow())
            .header("X-Request-Id", requestId())
            .delete()
            .build()

        client.newCall(request).execute().use { response ->
            return response.isSuccessful
        }
    }

    fun transitionTask(taskId: Int, status: String, note: String? = null): Boolean {
        val jsonBody = org.json.JSONObject()
            .put("status", status)
        if (note != null) jsonBody.put("note", note)
        val body = jsonBody.toString().toRequestBody(JSON_TYPE)
        val request = Request.Builder()
            .url("${baseUrl()}/tasks/$taskId/transition")
            .header("Authorization", requireAuthOrThrow())
            .header("X-Request-Id", requestId())
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
        val request = Request.Builder()
            .url("${baseUrl()}/tasks/$taskId")
            .header("Authorization", requireAuthOrThrow())
            .header("X-Request-Id", requestId())
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
        val request = Request.Builder()
            .url("${baseUrl()}/tasks/$taskId/history?limit=$limit")
            .header("Authorization", requireAuthOrThrow())
            .header("X-Request-Id", requestId())
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
