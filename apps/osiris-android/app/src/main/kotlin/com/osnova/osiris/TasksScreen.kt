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

    var createVisible by remember { mutableStateOf(false) }
    var createTitle by remember { mutableStateOf("") }
    var createDescription by remember { mutableStateOf("") }
    var createProject by remember { mutableStateOf("general") }
    var createPriorityStr by remember { mutableStateOf("3") }
    var createDeadline by remember { mutableStateOf("") }

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
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = { createVisible = true }, enabled = !isLoading) {
                    Text("＋", color = Color(0xFF7B68EE), fontSize = 20.sp)
                }
                TextButton(onClick = { vm.loadTasks() }, enabled = !isLoading) {
                    Text("↻", color = Color(0xFF7B68EE), fontSize = 20.sp)
                }
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

            var editing by remember { mutableStateOf(false) }
            var editTitle by remember { mutableStateOf("") }
            var editDescription by remember { mutableStateOf("") }
            var editProject by remember { mutableStateOf("general") }
            var editPriorityStr by remember { mutableStateOf("") }
            var editDeadline by remember { mutableStateOf("") }

            var addDependencyVisible by remember { mutableStateOf(false) }

            LaunchedEffect(taskId) {
                detailsLoading = true
                detailsResponse = null
                historyEvents = emptyList()
                scope.launch {
                    val d = withContext(Dispatchers.IO) { ApiClient.getTaskDetails(taskId) }
                    val h = withContext(Dispatchers.IO) { ApiClient.getTaskHistory(taskId, limit = 20) }
                    detailsResponse = d
                    historyEvents = h
                    val dt = d?.task
                    editTitle = dt?.title ?: ""
                    editDescription = dt?.description ?: ""
                    editProject = dt?.project ?: "general"
                    editPriorityStr = dt?.priority?.toString() ?: ""
                    editDeadline = dt?.deadline ?: ""
                    editing = false
                    addDependencyVisible = false
                    detailsLoading = false
                }
            }

            fun reloadDetails() {
                detailsLoading = true
                detailsResponse = null
                historyEvents = emptyList()
                scope.launch {
                    val d = withContext(Dispatchers.IO) { ApiClient.getTaskDetails(taskId) }
                    val h = withContext(Dispatchers.IO) { ApiClient.getTaskHistory(taskId, limit = 20) }
                    detailsResponse = d
                    historyEvents = h
                    val dt = d?.task
                    editTitle = dt?.title ?: ""
                    editDescription = dt?.description ?: ""
                    editProject = dt?.project ?: "general"
                    editPriorityStr = dt?.priority?.toString() ?: ""
                    editDeadline = dt?.deadline ?: ""
                    editing = false
                    addDependencyVisible = false
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
                        Text(
                            text = "Проект: ${detailsResponse?.task?.project ?: '-'}",
                            color = Color(0xFF7B68EE),
                            fontSize = 12.sp
                        )
                        Text(
                            text = "Приоритет: ${detailsResponse?.task?.priority?.toString() ?: '-'}",
                            color = Color(0xFFA0A0D0),
                            fontSize = 12.sp
                        )
                        Text(
                            text = "Дедлайн: ${detailsResponse?.task?.deadline ?: '-'}",
                            color = Color(0xFFA0A0D0),
                            fontSize = 12.sp
                        )
                        Spacer(Modifier.height(10.dp))
                        Text(
                            text = "Блокирующие зависимости:",
                            color = Color(0xFFA0A0D0),
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Bold
                        )
                        Spacer(Modifier.height(6.dp))

                        val deps = detailsResponse?.dependencies.orEmpty()
                        if (detailsLoading) {
                            Text("Загрузка...", color = Color.Gray, fontSize = 13.sp)
                        } else if (deps.isEmpty()) {
                            Text("Нет", color = Color.Gray, fontSize = 13.sp)
                        } else {
                            deps.take(10).forEach { dep ->
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(
                                            text = dep.title,
                                            color = Color(0xFFCCCCCC),
                                            fontSize = 12.sp,
                                            maxLines = 1
                                        )
                                        Text(
                                            text = "Статус: ${dep.status}",
                                            color = Color.Gray,
                                            fontSize = 11.sp
                                        )
                                    }
                                    TextButton(onClick = {
                                        vm.unlinkDependency(taskId, dep.id) {
                                            reloadDetails()
                                        }
                                    }) {
                                        Text("Отвязать")
                                    }
                                }
                            }
                        }

                        Spacer(Modifier.height(8.dp))
                        TextButton(
                            onClick = { addDependencyVisible = true },
                            enabled = !detailsLoading
                        ) {
                            Text("Добавить зависимость")
                        }

                        if (addDependencyVisible) {
                            Spacer(Modifier.height(8.dp))
                            val existingDepIds = deps.map { it.id }.toSet()
                            val candidates = tasks.filter { it.id != taskId && !existingDepIds.contains(it.id) }
                            if (candidates.isEmpty()) {
                                Text(
                                    "Нет доступных задач для зависимости",
                                    color = Color.Gray,
                                    fontSize = 12.sp
                                )
                            } else {
                                candidates.take(10).forEach { c ->
                                    TextButton(onClick = {
                                        vm.linkDependency(taskId, c.id) {
                                            addDependencyVisible = false
                                            reloadDetails()
                                        }
                                    }) {
                                        Text(c.title, color = Color(0xFF7B68EE))
                                    }
                                }
                            }
                            Spacer(Modifier.height(6.dp))
                            TextButton(onClick = { addDependencyVisible = false }) { Text("Закрыть") }
                        }

                        Spacer(Modifier.height(12.dp))

                        if (!editing) {
                            TextButton(
                                onClick = { editing = true },
                                enabled = !detailsLoading
                            ) { Text("Редактировать") }
                        } else {
                            Column {
                                TextField(
                                    value = editTitle,
                                    onValueChange = { editTitle = it },
                                    modifier = Modifier.fillMaxWidth(),
                                    singleLine = true,
                                    placeholder = { Text("Название") }
                                )
                                Spacer(Modifier.height(8.dp))
                                TextField(
                                    value = editDescription,
                                    onValueChange = { editDescription = it },
                                    modifier = Modifier.fillMaxWidth(),
                                    placeholder = { Text("Описание") },
                                    minLines = 3,
                                    maxLines = 5
                                )
                                Spacer(Modifier.height(8.dp))
                                TextField(
                                    value = editProject,
                                    onValueChange = { editProject = it },
                                    modifier = Modifier.fillMaxWidth(),
                                    singleLine = true,
                                    placeholder = { Text("Проект") }
                                )
                                Spacer(Modifier.height(8.dp))
                                TextField(
                                    value = editPriorityStr,
                                    onValueChange = { editPriorityStr = it },
                                    modifier = Modifier.fillMaxWidth(),
                                    singleLine = true,
                                    placeholder = { Text("Приоритет (число)") }
                                )
                                Spacer(Modifier.height(8.dp))
                                TextField(
                                    value = editDeadline,
                                    onValueChange = { editDeadline = it },
                                    modifier = Modifier.fillMaxWidth(),
                                    singleLine = true,
                                    placeholder = { Text("Дедлайн") }
                                )
                                Spacer(Modifier.height(8.dp))
                                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    TextButton(onClick = { editing = false }) { Text("Отмена") }
                                    TextButton(
                                        onClick = {
                                            val title = editTitle.trim()
                                            if (title.isBlank()) return@TextButton
                                            val project = editProject.trim().ifBlank { "general" }
                                            val prio = editPriorityStr.trim().toIntOrNull()
                                            val deadline = editDeadline.trim().takeIf { it.isNotBlank() }
                                            vm.updateTaskFields(
                                                taskId = taskId,
                                                title = title,
                                                description = editDescription,
                                                project = project,
                                                priority = prio,
                                                deadline = deadline
                                            ) {
                                                editing = false
                                                reloadDetails()
                                            }
                                        },
                                        enabled = editTitle.trim().isNotBlank()
                                    ) { Text("Сохранить") }
                                }
                            }
                        }

                        Spacer(Modifier.height(12.dp))
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

        if (createVisible) {
            AlertDialog(
                onDismissRequest = { createVisible = false },
                title = { Text("Новая задача", color = Color.White) },
                text = {
                    Column(modifier = Modifier.fillMaxWidth()) {
                        TextField(
                            value = createTitle,
                            onValueChange = { createTitle = it },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            placeholder = { Text("Название") }
                        )
                        Spacer(Modifier.height(8.dp))
                        TextField(
                            value = createDescription,
                            onValueChange = { createDescription = it },
                            modifier = Modifier.fillMaxWidth(),
                            placeholder = { Text("Описание") },
                            minLines = 3,
                            maxLines = 5
                        )
                        Spacer(Modifier.height(8.dp))
                        TextField(
                            value = createProject,
                            onValueChange = { createProject = it },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            placeholder = { Text("Проект (например: general)") }
                        )
                        Spacer(Modifier.height(8.dp))
                        TextField(
                            value = createPriorityStr,
                            onValueChange = { createPriorityStr = it },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            placeholder = { Text("Приоритет (число, например 3)") }
                        )
                        Spacer(Modifier.height(8.dp))
                        TextField(
                            value = createDeadline,
                            onValueChange = { createDeadline = it },
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = true,
                            placeholder = { Text("Дедлайн (строка или ISO)") }
                        )
                    }
                },
                confirmButton = {
                    TextButton(
                        onClick = {
                            val title = createTitle.trim()
                            val project = createProject.trim().ifBlank { "general" }
                            val prio = createPriorityStr.trim().toIntOrNull()
                            val deadline = createDeadline.trim().takeIf { it.isNotBlank() }

                            vm.createTask(
                                OsirisTaskDraft(
                                    title = title,
                                    description = createDescription.trim(),
                                    project = project,
                                    priority = prio,
                                    deadline = deadline
                                )
                            ) {
                                createVisible = false
                                createTitle = ""
                                createDescription = ""
                                createProject = "general"
                                createPriorityStr = "3"
                                createDeadline = ""
                            }
                        },
                        enabled = createTitle.trim().isNotBlank()
                    ) {
                        Text("Создать")
                    }
                },
                dismissButton = {
                    TextButton(onClick = { createVisible = false }) { Text("Отмена") }
                }
            )
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
            Spacer(Modifier.height(2.dp))
            Text(
                text = "P${task.priority ?: "-"} • ${task.status}",
                color = Color(0xFFCCCCCC),
                fontSize = 10.sp
            )
        }
        TextButton(onClick = onComplete) {
            Text("✓", color = Color(0xFF4CAF50), fontSize = 18.sp)
        }
    }
}
