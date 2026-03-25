package com.osnova.osiris

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(onSave: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var urlInput by remember { mutableStateOf(AppPreferences.baseUrl) }
    var otaLoading by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF1A1A2E))
            .systemBarsPadding()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Text(
            text = "Настройки",
            color = Color(0xFF7B68EE),
            fontSize = 20.sp,
            fontWeight = FontWeight.Bold
        )

        HorizontalDivider(color = Color(0xFF2A2A4E))

        Text("Server URL", color = Color.Gray, fontSize = 13.sp)
        TextField(
            value = urlInput,
            onValueChange = { urlInput = it },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
            colors = TextFieldDefaults.colors(
                focusedContainerColor = Color(0xFF2A2A4E),
                unfocusedContainerColor = Color(0xFF2A2A4E),
                focusedTextColor = Color.White,
                unfocusedTextColor = Color.White,
                cursorColor = Color(0xFF7B68EE)
            )
        )

        Button(
            onClick = {
                AppPreferences.baseUrl = urlInput.trim()
                // Force re-registration for new backend.
                AppPreferences.deviceToken = null
                onSave()
            },
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF7B68EE))
        ) {
            Text("Сохранить")
        }

        Button(
            onClick = {
                scope.launch {
                    otaLoading = true
                    try {
                        OtaUpdater.checkAndPromptInstall(context)
                    } finally {
                        otaLoading = false
                    }
                }
            },
            modifier = Modifier.fillMaxWidth(),
            enabled = !otaLoading,
            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF3F37A6))
        ) {
            Text(if (otaLoading) "Обновление..." else "Обновить")
        }
    }
}
