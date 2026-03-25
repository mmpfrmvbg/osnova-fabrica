package com.osnova.osiris

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import org.json.JSONArray
import org.json.JSONObject

// TODO: theme tuning

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { OsirisNavHost() }
    }
}

@Composable
fun OsirisNavHost() {
    val navController = rememberNavController()
    NavHost(navController = navController, startDestination = "chat") {
        composable("chat") {
            ChatScreen(
                onOpenSettings = { navController.navigate("settings") },
                onOpenTasks = { navController.navigate("tasks") }
            )
        }
        composable("settings") {
            SettingsScreen(onSave = { navController.popBackStack() })
        }
        composable("tasks") {
            TasksScreen(onBack = { navController.popBackStack() })
        }
    }
}

@Composable
fun ChatScreen(
    onOpenSettings: () -> Unit,
    onOpenTasks: () -> Unit,
    vm: ChatViewModel = viewModel()
) {
    val messages by vm.messages.collectAsStateWithLifecycle()
    val isLoading by vm.isLoading.collectAsStateWithLifecycle()
    val pendingActions by vm.pendingActions.collectAsStateWithLifecycle()
    val pendingExplanation by vm.pendingExplanation.collectAsStateWithLifecycle()
    val lastBatchId by vm.lastBatchId.collectAsStateWithLifecycle()
    var inputText by remember { mutableStateOf("") }
    val listState = rememberLazyListState()

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size - 1)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF1A1A2E))
            .systemBarsPadding()
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text("ОСИРИС", color = Color(0xFF7B68EE), fontSize = 20.sp)
            TextButton(onClick = onOpenTasks) {
                Text("☑", color = Color(0xFF7B68EE), fontSize = 20.sp)
            }
            TextButton(onClick = onOpenSettings) {
                Text("⚙", color = Color(0xFF7B68EE), fontSize = 20.sp)
            }
        }

        HorizontalDivider(color = Color(0xFF2A2A4E))

        LazyColumn(
            state = listState,
            modifier = Modifier
                .weight(1f)
                .padding(horizontal = 8.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
            contentPadding = PaddingValues(vertical = 8.dp)
        ) {
            items(messages) { msg -> MessageBubble(msg) }
            if (pendingActions != null) {
                item {
                    ActionCard(
                        actions = pendingActions,
                        explanation = pendingExplanation,
                        onApply = { vm.applyPendingActions() },
                        onDismiss = { vm.dismissPendingActions() }
                    )
                }
            }
            if (lastBatchId != null) {
                item {
                    TextButton(onClick = { vm.undoLastBatch() }) {
                        Text("Undo", color = Color(0xFF7B68EE))
                    }
                }
            }
            if (isLoading) {
                item {
                    Text("...", color = Color(0xFF7B68EE), modifier = Modifier.padding(8.dp))
                }
            }
        }

        // Поле ввода
        HorizontalDivider(color = Color(0xFF2A2A4E))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            TextField(
                value = inputText,
                onValueChange = { inputText = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Сообщение...", color = Color.Gray) },
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color(0xFF2A2A4E),
                    unfocusedContainerColor = Color(0xFF2A2A4E),
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White,
                    cursorColor = Color(0xFF7B68EE)
                ),
                maxLines = 3,
                enabled = !isLoading
            )
            Spacer(Modifier.width(8.dp))
            Button(
                onClick = { vm.sendMessage(inputText); inputText = "" },
                enabled = inputText.isNotBlank() && !isLoading,
                colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF7B68EE))
            ) {
                Text("→")
            }
        }
    }
}

@Composable
fun ActionCard(
    actions: JSONArray?,
    explanation: String?,
    onApply: () -> Unit,
    onDismiss: () -> Unit,
) {
    Card(
        colors = CardDefaults.cardColors(containerColor = Color(0xFF2A2A4E)),
        modifier = Modifier
            .fillMaxWidth()
            .padding(8.dp)
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            Text("Действия", color = Color.White, fontSize = 14.sp)
            if (!explanation.isNullOrBlank()) {
                Spacer(Modifier.height(6.dp))
                Text(explanation, color = Color(0xFFCCCCCC), fontSize = 12.sp)
            }
            Spacer(Modifier.height(8.dp))
            val lines = remember(actions) { actionsToLines(actions) }
            if (lines.isEmpty()) {
                Text("Нет действий", color = Color.Gray, fontSize = 12.sp)
            } else {
                lines.take(12).forEach { line ->
                    Text(text = "• $line", color = Color(0xFFCCCCCC), fontSize = 12.sp)
                    Spacer(Modifier.height(2.dp))
                }
                if (lines.size > 12) {
                    Text(text = "+ ещё ${lines.size - 12}", color = Color.Gray, fontSize = 12.sp)
                }
            }
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = onApply,
                    enabled = !lines.isNullOrEmpty(),
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF7B68EE))
                ) { Text("Применить") }
                TextButton(onClick = onDismiss) { Text("Скрыть", color = Color(0xFF7B68EE)) }
            }
        }
    }
}

private fun actionsToLines(actions: JSONArray?): List<String> {
    if (actions == null) return emptyList()
    val out = mutableListOf<String>()
    for (i in 0 until actions.length()) {
        val a = actions.optJSONObject(i) ?: continue
        val kind = a.optString("kind", "")
        val payload = a.optJSONObject("payload") ?: JSONObject()
        out += when (kind) {
            "create_task" -> {
                val title = payload.optString("title", "")
                val project = payload.optString("project", "general")
                val deadline = payload.optString("deadline", "")
                val prio = if (payload.has("priority")) payload.optInt("priority") else -1
                buildString {
                    append("Создать задачу")
                    if (title.isNotBlank()) append(": \"$title\"")
                    append(" (project=$project")
                    if (prio > 0) append(", P$prio")
                    if (deadline.isNotBlank()) append(", deadline=$deadline")
                    append(")")
                }
            }
            "update_task_fields" -> {
                val taskId = payload.optInt("taskId", -1)
                val patch = payload.optJSONObject("patch") ?: JSONObject()
                val keys = patch.keys().asSequence().toList().sorted()
                val changes = if (keys.isEmpty()) "нет изменений" else keys.take(8).joinToString(", ")
                "Обновить задачу #$taskId: $changes"
            }
            "transition_task" -> {
                val taskId = payload.optInt("taskId", -1)
                val status = payload.optString("status", "")
                "Перевести задачу #$taskId → $status"
            }
            "link_dependency" -> {
                val taskId = payload.optInt("taskId", -1)
                val depId = payload.optInt("dependencyId", -1)
                "Связать зависимость: #$taskId зависит от #$depId"
            }
            "unlink_dependency" -> {
                val taskId = payload.optInt("taskId", -1)
                val depId = payload.optInt("dependencyId", -1)
                "Убрать зависимость: #$taskId больше не зависит от #$depId"
            }
            else -> "Действие: $kind"
        }
    }
    return out
}

@Composable
fun MessageBubble(msg: ChatMessage) {
    val bgColor = if (msg.isUser) Color(0xFF2A2A4E) else Color(0xFF0F3460)
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (msg.isUser) Arrangement.End else Arrangement.Start
    ) {
        Box(
            modifier = Modifier
                .widthIn(max = 280.dp)
                .background(bgColor, RoundedCornerShape(12.dp))
                .padding(horizontal = 12.dp, vertical = 8.dp)
        ) {
            Text(text = msg.text, color = Color.White, fontSize = 15.sp)
        }
    }
}
