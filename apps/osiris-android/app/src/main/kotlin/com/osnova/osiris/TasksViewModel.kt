package com.osnova.osiris

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch

data class OsirisTask(
    val id: Int,
    val title: String,
    val status: String,
    val project: String,
    val priority: Int? = null,
    val deadline: String? = null,
    val assignee: String? = null,
)

class TasksViewModel : ViewModel() {
    private val _tasks = MutableStateFlow<List<OsirisTask>>(emptyList())
    val tasks: StateFlow<List<OsirisTask>> = _tasks.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    init { loadTasks() }

    fun loadTasks() {
        _isLoading.value = true
        _error.value = null
        viewModelScope.launch(Dispatchers.IO) {
            try {
                _tasks.value = ApiClient.getTasks()
            } catch (e: Exception) {
                _error.value = "Ошибка: ${e.message}"
            } finally {
                _isLoading.value = false
            }
        }
    }

    fun completeTask(taskId: Int) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                ApiClient.transitionTask(taskId, "done")
                loadTasks()
            } catch (e: Exception) {
                _error.value = "Ошибка: ${e.message}"
            }
        }
    }

    fun transitionTask(taskId: Int, status: String, onDone: () -> Unit = {}) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                ApiClient.transitionTask(taskId, status)
                loadTasks()
                withContext(Dispatchers.Main) { onDone() }
            } catch (e: Exception) {
                _error.value = "Ошибка: ${e.message}"
            }
        }
    }

    fun createTask(draft: OsirisTaskDraft, onDone: () -> Unit = {}) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                ApiClient.createTask(draft)
                loadTasks()
                withContext(Dispatchers.Main) { onDone() }
            } catch (e: Exception) {
                _error.value = "Ошибка: ${e.message}"
            }
        }
    }

    fun updateTaskFields(
        taskId: Int,
        title: String?,
        description: String?,
        project: String?,
        priority: Int?,
        deadline: String?,
        onDone: () -> Unit = {}
    ) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val patch = mutableMapOf<String, Any?>()
                patch["title"] = title
                patch["description"] = description
                patch["project"] = project
                patch["priority"] = priority
                patch["deadline"] = deadline
                ApiClient.updateTaskFields(taskId, patch)
                loadTasks()
                withContext(Dispatchers.Main) { onDone() }
            } catch (e: Exception) {
                _error.value = "Ошибка: ${e.message}"
            }
        }
    }

    fun linkDependency(taskId: Int, dependencyId: Int, onDone: () -> Unit = {}) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                ApiClient.linkDependency(taskId, dependencyId)
                loadTasks()
                withContext(Dispatchers.Main) { onDone() }
            } catch (e: Exception) {
                _error.value = "Ошибка: ${e.message}"
            }
        }
    }

    fun unlinkDependency(taskId: Int, dependencyId: Int, onDone: () -> Unit = {}) {
        viewModelScope.launch(Dispatchers.IO) {
            try {
                ApiClient.unlinkDependency(taskId, dependencyId)
                loadTasks()
                withContext(Dispatchers.Main) { onDone() }
            } catch (e: Exception) {
                _error.value = "Ошибка: ${e.message}"
            }
        }
    }
}
