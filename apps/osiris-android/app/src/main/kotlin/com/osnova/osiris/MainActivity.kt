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
            ChatScreen(onOpenSettings = { navController.navigate("settings") })
        }
        composable("settings") {
            SettingsScreen(onSave = { navController.popBackStack() })
        }
    }
}

@Composable
fun ChatScreen(
    onOpenSettings: () -> Unit,
    vm: ChatViewModel = viewModel()
) {
    val messages by vm.messages.collectAsStateWithLifecycle()
    val isLoading by vm.isLoading.collectAsStateWithLifecycle()
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
