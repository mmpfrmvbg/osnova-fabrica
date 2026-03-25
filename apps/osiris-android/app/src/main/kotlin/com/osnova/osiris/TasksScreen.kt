package com.osnova.osiris

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun TasksScreen(
    onBack: () -> Unit,
    vm: TasksViewModel = viewModel()
) {
    val tasks by vm.tasks.collectAsStateWithLifecycle()
    val isLoading by vm.isLoading.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF1A1A2E))
            .systemBarsPadding()
    ) {
    var detailsTaskId by remember { mutableStateOf<Int?>(null) }
    var detailsVisible by remember { mutableStateOf(false) }
    var detailsLoading by remember { mutableStateOf(false) }
    var detailsResponse by remember { mutableStateOf<OsirisTaskDetailsResponse?>(null) }
    var historyEvents by remember { mutableStateOf<List<OsirisTaskEvent>>(emptyList()) }

    fun openDetails(taskId: Int) {
        detailsTaskId = taskId
        detailsVisible = true
    }

        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            TextButton(onClick = onBack) {
                Text("← Назад", color = Color(0xFF7B68EE))
            }
            Text("Задачи", color = Color(0xFF7B68EE), fontSize = 20.sp)
            TextButton(onClick = { vm.loadTasks() }, enabled = !isLoading) {
                Text("↻", color = Color(0xFF7B68EE), fontSize = 20.sp)
            }
        }

        HorizontalDivider(color = Color(0xFF2A2A4E))

        when {
            isLoading -> {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(color = Color(0xFF7B68EE))
                }
            }
            error != null -> {
                Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
                    Text(error ?: "", color = Color.Red, fontSize = 14.sp)
                }
            }
            tasks.isEmpty() -> {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text("Задач нет", color = Color.Gray, fontSize = 16.sp)
                }
            }
            else -> {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(vertical = 8.dp)
                ) {
                    items(tasks, key = { it.id }) { task ->
                        TaskCard(
                            task = task,
                            onComplete = { vm.completeTask(task.id) },
                            onOpen = { openDetails(task.id) }
                        )
                    }
                }
            }
        }

        if (detailsVisible && detailsTaskId != null) {
            val taskId = detailsTaskId!!
            val scope = rememberCoroutineScope()

            LaunchedEffect(taskId) {
                detailsLoading = true
                detailsResponse = null
                historyEvents = emptyList()
                scope.launch {
                    val d = withContext(Dispatchers.IO) { ApiClient.getTaskDetails(taskId) }
                    val h = withContext(Dispatchers.IO) { ApiClient.getTaskHistory(taskId, limit = 20) }
                    detailsResponse = d
                    historyEvents = h
                    detailsLoading = false
                }
            }

            AlertDialog(
                onDismissRequest = { detailsVisible = false },
                title = {
                    Text(
                        text = detailsResponse?.task?.title ?: "Загрузка...",
                        color = Color.White
                    )
                },
                text = {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        Text(
                            text = "Статус: ${detailsResponse?.task?.status ?: '-'}",
                            color = Color(0xFF7B68EE),
                            fontSize = 12.sp
                        )
                        Spacer(Modifier.height(8.dp))
                        Text(
                            text = "История:",
                            color = Color(0xFFA0A0D0),
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Bold
                        )
                        Spacer(Modifier.height(6.dp))
                        if (detailsLoading) {
                            Text("Загрузка...", color = Color.Gray, fontSize = 13.sp)
                        } else if (historyEvents.isEmpty()) {
                            Text("Пока нет событий", color = Color.Gray, fontSize = 13.sp)
                        } else {
                            val maxShow = minOf(historyEvents.size, 10)
                            historyEvents.take(maxShow).forEach { ev ->
                                Text(
                                    text = "- ${ev.eventType} (${ev.actor})${if (ev.note != null) ": ${ev.note}" else ""}",
                                    color = Color(0xFFCCCCCC),
                                    fontSize = 12.sp
                                )
                            }
                        }
                        Spacer(Modifier.height(12.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = {
                                vm.transitionTask(taskId, "in_progress") {
                                    detailsVisible = false
                                    vm.loadTasks()
                                }
                            }) { Text("В работу") }
                            TextButton(onClick = {
                                vm.transitionTask(taskId, "todo") {
                                    detailsVisible = false
                                    vm.loadTasks()
                                }
                            }) { Text("В очередь") }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = {
                                vm.transitionTask(taskId, "blocked") {
                                    detailsVisible = false
                                    vm.loadTasks()
                                }
                            }) { Text("Блок") }
                            TextButton(onClick = {
                                vm.completeTask(taskId)
                                detailsVisible = false
                                vm.loadTasks()
                            }) { Text("Готово") }
                        }
                    }
                },
                confirmButton = {},
                dismissButton = {}
            )
        }
    }
}

@Composable
fun TaskCard(task: OsirisTask, onComplete: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFF0F3460), RoundedCornerShape(10.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = task.title,
                color = Color.White,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium
            )
            Spacer(Modifier.height(2.dp))
            Text(
                text = task.project,
                color = Color(0xFF7B68EE),
                fontSize = 11.sp
            )
        }
        TextButton(onClick = onComplete) {
            Text("✓", color = Color(0xFF4CAF50), fontSize = 18.sp)
        }
    }
}

@Composable
fun TaskCard(
    task: OsirisTask,
    onComplete: () -> Unit,
    onOpen: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(Color(0xFF0F3460), RoundedCornerShape(10.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .clickable { onOpen() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = task.title,
                color = Color.White,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium
            )
            Spacer(Modifier.height(2.dp))
            Text(
                text = task.project,
                color = Color(0xFF7B68EE),
                fontSize = 11.sp
            )
        }
        TextButton(onClick = onComplete) {
            Text("✓", color = Color(0xFF4CAF50), fontSize = 18.sp)
        }
    }
}
