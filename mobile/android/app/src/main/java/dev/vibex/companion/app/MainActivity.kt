package dev.vibex.companion.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.vibex.companion.HostOrigin
import dev.vibex.companion.PairingClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    var origin by remember { mutableStateOf("http://127.0.0.1:3080") }
                    var token by remember { mutableStateOf("") }
                    var status by remember { mutableStateOf("Enter the Host origin and pairing token.") }
                    val scope = rememberCoroutineScope()
                    Column(
                        modifier = Modifier.padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text("VibeX Companion", style = MaterialTheme.typography.headlineSmall)
                        OutlinedTextField(
                            value = origin,
                            onValueChange = { origin = it },
                            label = { Text("Host origin") },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = token,
                            onValueChange = { token = it },
                            label = { Text("Pairing token") },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Button(
                            onClick = {
                                scope.launch {
                                    status = runCatching {
                                        val session = withContext(Dispatchers.IO) {
                                            PairingClient().redeem(
                                                HostOrigin.parse(origin),
                                                token,
                                                android.os.Build.MODEL,
                                            )
                                        }
                                        "Paired as ${session.credential.device_id}"
                                    }.getOrElse { error ->
                                        error.message ?: "Pairing failed"
                                    }
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("Pair")
                        }
                        Text(status, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }
        }
    }
}
