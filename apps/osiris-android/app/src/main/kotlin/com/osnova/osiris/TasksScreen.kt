package com.osnova.osiris

import androidx.compose.foundation.background
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
                        TaskCard(task = task, onComplete = { vm.completeTask(task.id) })
                    }
                }
            }
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
