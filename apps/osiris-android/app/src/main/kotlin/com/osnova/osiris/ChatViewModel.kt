package com.osnova.osiris

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray

data class ChatMessage(
    val text: String,
    val isUser: Boolean
)

class ChatViewModel : ViewModel() {
    private val _messages = MutableStateFlow<List<ChatMessage>>(emptyList())
    val messages: StateFlow<List<ChatMessage>> = _messages.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _pendingActions = MutableStateFlow<JSONArray?>(null)
    val pendingActions: StateFlow<JSONArray?> = _pendingActions.asStateFlow()

    private val _pendingExplanation = MutableStateFlow<String?>(null)
    val pendingExplanation: StateFlow<String?> = _pendingExplanation.asStateFlow()

    private val _lastBatchId = MutableStateFlow<String?>(null)
    val lastBatchId: StateFlow<String?> = _lastBatchId.asStateFlow()

    fun sendMessage(text: String) {
        if (text.isBlank()) return
        _pendingActions.value = null
        _pendingExplanation.value = null
        val current = _messages.value
        val userMsg = ChatMessage(text = text, isUser = true)
        val assistantPlaceholder = ChatMessage(text = "", isUser = false)
        val assistantIndex = current.size + 1
        _messages.value = current + userMsg + assistantPlaceholder
        _isLoading.value = true
        viewModelScope.launch(Dispatchers.IO) {
            val reply = try {
                ApiClient.sendMessageStream(
                    message = text,
                    onToken = { token ->
                        val list = _messages.value.toMutableList()
                        if (assistantIndex in list.indices) {
                            val old = list[assistantIndex]
                            list[assistantIndex] = old.copy(text = old.text + token)
                            _messages.value = list
                        }
                    },
                    onActions = { actions, explanation ->
                        _pendingActions.value = actions
                        _pendingExplanation.value = explanation
                    }
                )
            } catch (e: Exception) {
                "[ошибка сети: ${e.message}]"
            }
            val list = _messages.value.toMutableList()
            if (assistantIndex in list.indices) {
                list[assistantIndex] = list[assistantIndex].copy(text = reply)
                _messages.value = list
            } else {
                _messages.value = _messages.value + ChatMessage(text = reply, isUser = false)
            }
            _isLoading.value = false
        }
    }

    fun applyPendingActions() {
        val actions = _pendingActions.value ?: return
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val batchId = ApiClient.applyActions(actions)
                _lastBatchId.value = batchId
                _pendingActions.value = null
                _pendingExplanation.value = null
            } catch (e: Exception) {
                _messages.value = _messages.value + ChatMessage(text = "[ошибка apply: ${e.message}]", isUser = false)
            }
        }
    }

    fun dismissPendingActions() {
        _pendingActions.value = null
        _pendingExplanation.value = null
    }

    fun undoLastBatch() {
        val batchId = _lastBatchId.value ?: return
        viewModelScope.launch(Dispatchers.IO) {
            try {
                val ok = ApiClient.undoBatch(batchId)
                _messages.value = _messages.value + ChatMessage(
                    text = if (ok) "[undo ok]" else "[undo failed]",
                    isUser = false
                )
                if (ok) _lastBatchId.value = null
            } catch (e: Exception) {
                _messages.value = _messages.value + ChatMessage(text = "[ошибка undo: ${e.message}]", isUser = false)
            }
        }
    }
}
