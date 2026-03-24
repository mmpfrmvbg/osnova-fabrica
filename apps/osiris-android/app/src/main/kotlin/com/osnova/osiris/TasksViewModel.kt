package com.osnova.osiris

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class OsirisTask(
    val id: Int,
    val title: String,
    val status: String,
    val project: String
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
                ApiClient.completeTask(taskId)
                loadTasks()
            } catch (e: Exception) {
                _error.value = "Ошибка: ${e.message}"
            }
        }
    }
}
