async fn send_codex_request(
    server: &Arc<CodexAppServer>,
    method: &str,
    params: Value,
    timeout_duration: Duration,
) -> Result<Value, String> {
    let id = server.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    server.pending.lock().await.insert(id, tx);

    let write_result = async {
        let mut stdin = server.stdin.lock().await;
        let mut line = serde_json::to_string(&json!({
            "id": id,
            "method": method,
            "params": params,
        }))
        .map_err(|error| error.to_string())?;
        line.push('\n');
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|error| error.to_string())
    }
    .await;

    if let Err(error) = write_result {
        server.pending.lock().await.remove(&id);
        return Err(error);
    }

    match tokio::time::timeout(timeout_duration, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            server.pending.lock().await.remove(&id);
            Err("request canceled".to_string())
        }
        Err(_) => {
            server.pending.lock().await.remove(&id);
            Err(format!("request `{method}` timed out"))
        }
    }
}

async fn send_codex_notification(
    server: &Arc<CodexAppServer>,
    method: &str,
    params: Option<Value>,
) -> Result<(), String> {
    let mut stdin = server.stdin.lock().await;
    let mut message = serde_json::Map::new();
    message.insert("method".to_string(), json!(method));
    if let Some(params) = params {
        message.insert("params".to_string(), params);
    }
    let mut line = serde_json::to_string(&Value::Object(message)).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())
}

async fn send_codex_response(
    server: &Arc<CodexAppServer>,
    request_id: &str,
    response: Value,
) -> Result<(), String> {
    let id = request_id
        .parse::<u64>()
        .map(Value::from)
        .unwrap_or_else(|_| Value::String(request_id.to_string()));
    let mut stdin = server.stdin.lock().await;
    let mut line = serde_json::to_string(&json!({
        "id": id,
        "result": response,
    }))
    .map_err(|error| error.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|error| error.to_string())
}

fn codex_app_server_command_args(request: &ProviderTurnRequest) -> Vec<String> {
    let mut args = vec!["app-server".to_string()];

    if let Some(listen) = provider_option_string(&request.provider_options, "listen") {
        args.push("--listen".to_string());
        args.push(listen.to_string());
    }

    args
}

fn spawn_codex_app_server_readers(
    server: Arc<CodexAppServer>,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    session_id: String,
) {
    let stdout_server = server.clone();
    let stdout_session_id = session_id.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(error) => {
                    push_provider_event(
                        &stdout_session_id,
                        ProviderRuntimeEvent {
                            provider: ProviderId::Codex,
                            workspace_id: stdout_server.workspace_id.clone(),
                            thread_id: None,
                            turn_id: None,
                            event: json!({
                                "method": "codex/parse_error",
                                "params": { "error": error.to_string(), "raw": line },
                            }),
                        },
                    )
                    .await;
                    continue;
                }
            };

            let id = value
                .get("id")
                .and_then(|id| id.as_u64().or_else(|| id.as_str()?.parse().ok()));
            let has_response = value.get("result").is_some() || value.get("error").is_some();
            if let Some(id) = id
                && has_response
            {
                if let Some(tx) = stdout_server.pending.lock().await.remove(&id) {
                    let _ = tx.send(Ok(value));
                }
                continue;
            }

            if value.get("method").is_some() {
                push_provider_event(
                    &stdout_session_id,
                    ProviderRuntimeEvent {
                        provider: ProviderId::Codex,
                        workspace_id: stdout_server.workspace_id.clone(),
                        thread_id: extract_thread_id(&value),
                        turn_id: extract_turn_id(&value),
                        event: value.clone(),
                    },
                )
                .await;
                route_codex_event_to_native_conversation(&value).await;
            }
        }
    });

    let stderr_server = server.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            push_provider_event(
                &session_id,
                ProviderRuntimeEvent {
                    provider: ProviderId::Codex,
                    workspace_id: stderr_server.workspace_id.clone(),
                    thread_id: None,
                    turn_id: None,
                    event: json!({
                        "method": "codex/stderr",
                        "params": { "message": line },
                    }),
                },
            )
            .await;
        }
    });
}

async fn ensure_codex_app_server(
    request: &ProviderTurnRequest,
    workspace_id: Uuid,
    workspace_dir: &Path,
    session_id: &str,
) -> Result<Arc<CodexAppServer>, String> {
    let key = codex_runtime_key(&workspace_id.to_string(), workspace_dir);
    if let Some(server) = CODEX_APP_SERVERS.lock().await.get(&key).cloned() {
        let process_alive = server
            .child
            .lock()
            .await
            .try_wait()
            .map(|status| status.is_none())
            .unwrap_or(false);
        if process_alive
            && send_codex_request(&server, "model/list", json!({}), Duration::from_secs(4))
                .await
                .is_ok()
        {
            return Ok(server);
        }
        CODEX_APP_SERVERS.lock().await.remove(&key);
    }

    let mut command = new_provider_hidden_command("codex", codex_app_server_command_args(request)).await;
    command
        .current_dir(workspace_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdin = child.stdin.take().ok_or("missing codex app-server stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("missing codex app-server stdout")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("missing codex app-server stderr")?;

    let server = Arc::new(CodexAppServer {
        workspace_id: workspace_id.to_string(),
        workspace_dir: workspace_dir.to_path_buf(),
        child: Arc::new(Mutex::new(child)),
        stdin: Arc::new(Mutex::new(stdin)),
        pending: Arc::new(Mutex::new(HashMap::new())),
        next_id: AtomicU64::new(1),
    });

    spawn_codex_app_server_readers(server.clone(), stdout, stderr, session_id.to_string());
    let init_params = json!({
        "clientInfo": {
            "name": "vibex",
            "title": "VibeX",
            "version": env!("CARGO_PKG_VERSION"),
        },
        "capabilities": {
            "experimentalApi": true,
        },
    });
    let init_response = send_codex_request(
        &server,
        "initialize",
        init_params,
        Duration::from_secs(CODEX_INITIALIZE_TIMEOUT_SECS),
    )
    .await?;
    if let Some(error) = init_response.get("error") {
        return Err(format!("initialize failed: {error}"));
    }
    send_codex_notification(&server, "initialized", None).await?;

    CODEX_APP_SERVERS.lock().await.insert(key, server.clone());
    Ok(server)
}

async fn start_codex_native_turn(
    state: &tauri::State<'_, AppState>,
    request: ProviderTurnRequest,
    workspace: &Workspace,
    workspace_dir: PathBuf,
    session: &Session,
) -> Result<ProviderRuntimeEvent, AppError> {
    let request =
        resolve_native_provider_request(&state.deployment.db().pool, session, request).await?;
    let workspace_id = workspace.id;
    let queued_turn_id = Uuid::new_v4().to_string();
    let process = create_native_execution_process(
        state,
        workspace,
        session,
        &request,
        request.thread_id.clone(),
        Some(queued_turn_id.clone()),
    )
    .await?;
    let conversation_sink = register_native_conversation_sink(state, process.id, session.id).await;
    CODEX_NATIVE_TURN_SINKS
        .lock()
        .await
        .insert(queued_turn_id.clone(), conversation_sink.clone());

    let event = ProviderRuntimeEvent {
        provider: ProviderId::Codex,
        workspace_id: workspace_id.to_string(),
        thread_id: request.thread_id.clone(),
        turn_id: Some(queued_turn_id.clone()),
        event: json!({
            "method": "turn/queued",
            "runtime_source": "native_app_server",
            "execution_process_id": process.id,
            "session_id": session.id,
        }),
    };
    push_provider_event(&session.id.to_string(), event.clone()).await;

    let pool = state.deployment.db().pool.clone();
    let session_id = session.id;
    let session_id_string = session.id.to_string();
    let workspace_id_string = workspace_id.to_string();
    let process_id = process.id;
    tokio::spawn(async move {
        let codex_options = resolve_codex_runtime_options(&request, &workspace_dir);
        let failure_event = |message: String| {
            json!({
                "method": "turn/error",
                "runtime_source": "native_app_server",
                "error": message,
            })
        };
        let mut final_thread_id = request.thread_id.clone();
        let mut final_turn_id = queued_turn_id.clone();

        let server = match ensure_codex_app_server(
            &request,
            workspace_id,
            &workspace_dir,
            &session_id_string,
        )
        .await
        {
            Ok(server) => server,
            Err(error) => {
                let event = failure_event(error);
                push_provider_event(
                    &session_id_string,
                    ProviderRuntimeEvent {
                        provider: ProviderId::Codex,
                        workspace_id: workspace_id_string.clone(),
                        thread_id: final_thread_id.clone(),
                        turn_id: Some(final_turn_id.clone()),
                        event: event.clone(),
                    },
                )
                .await;
                push_native_provider_event_to_conversation(&conversation_sink, &event).await;
                CODEX_NATIVE_TURN_SINKS.lock().await.remove(&final_turn_id);
                complete_native_conversation_sink(
                    conversation_sink,
                    ExecutionProcessStatus::Failed,
                    None,
                )
                .await;
                return;
            }
        };

        let thread_result: Result<String, String> = match request.thread_id.clone() {
            Some(thread_id) if provider_option_bool(&request.provider_options, "fork") => {
                let mut fork_params = serde_json::Map::new();
                fork_params.insert("threadId".to_string(), json!(thread_id));
                if let Some(message_id) =
                    provider_option_string(&request.provider_options, "message_id")
                {
                    fork_params.insert("messageId".to_string(), json!(message_id));
                }
                match send_codex_request(
                    &server,
                    "thread/fork",
                    Value::Object(fork_params),
                    Duration::from_secs(CODEX_REQUEST_TIMEOUT_SECS),
                )
                .await
                {
                    Ok(response) if response.get("error").is_some() => {
                        Err(format!("thread/fork failed: {}", response["error"]))
                    }
                    Ok(response) => extract_thread_id(&response).ok_or_else(|| {
                        format!("thread/fork did not return a thread id: {response}")
                    }),
                    Err(error) => Err(error),
                }
            }
            Some(thread_id) => {
                match send_codex_request(
                    &server,
                    "thread/resume",
                    json!({ "threadId": thread_id }),
                    Duration::from_secs(CODEX_REQUEST_TIMEOUT_SECS),
                )
                .await
                {
                    Ok(response) if response.get("error").is_some() => {
                        Err(format!("thread/resume failed: {}", response["error"]))
                    }
                    Ok(response) => Ok(extract_thread_id(&response).unwrap_or(thread_id)),
                    Err(error) => Err(error),
                }
            }
            None => {
                let mut params = serde_json::Map::new();
                params.insert("cwd".to_string(), json!(workspace_dir.to_string_lossy()));
                params.insert(
                    "approvalPolicy".to_string(),
                    json!(codex_options.approval_policy.as_str()),
                );
                params.insert(
                    "sandbox".to_string(),
                    json!(codex_options.sandbox_mode.as_str()),
                );
                if let Some(model) = codex_options.model.as_deref() {
                    params.insert("model".to_string(), json!(model));
                }
                match send_codex_request(
                    &server,
                    "thread/start",
                    Value::Object(params),
                    Duration::from_secs(CODEX_REQUEST_TIMEOUT_SECS),
                )
                .await
                {
                    Ok(response) if response.get("error").is_some() => {
                        Err(format!("thread/start failed: {}", response["error"]))
                    }
                    Ok(response) => extract_thread_id(&response).ok_or_else(|| {
                        format!("thread/start did not return a thread id: {response}")
                    }),
                    Err(error) => Err(error),
                }
            }
        };

        let thread_id = match thread_result {
            Ok(thread_id) => thread_id,
            Err(error) => {
                let event = failure_event(error);
                push_provider_event(
                    &session_id_string,
                    ProviderRuntimeEvent {
                        provider: ProviderId::Codex,
                        workspace_id: workspace_id_string.clone(),
                        thread_id: final_thread_id.clone(),
                        turn_id: Some(final_turn_id.clone()),
                        event: event.clone(),
                    },
                )
                .await;
                push_native_provider_event_to_conversation(&conversation_sink, &event).await;
                CODEX_NATIVE_TURN_SINKS.lock().await.remove(&final_turn_id);
                complete_native_conversation_sink(
                    conversation_sink,
                    ExecutionProcessStatus::Failed,
                    None,
                )
                .await;
                return;
            }
        };
        final_thread_id = Some(thread_id.clone());
        CODEX_NATIVE_THREAD_SINKS
            .lock()
            .await
            .insert(thread_id.clone(), conversation_sink.clone());
        if let Err(error) =
            CodingAgentTurn::update_agent_session_id(&pool, process_id, &thread_id).await
        {
            tracing::error!(
                "Failed to persist Codex app-server thread id for process {}: {}",
                process_id,
                error
            );
        }

        if is_context_compact_prompt(&request.text) {
            let response = match send_codex_request(
                &server,
                "thread/compact/start",
                json!({ "threadId": thread_id }),
                Duration::from_secs(CODEX_REQUEST_TIMEOUT_SECS),
            )
            .await
            {
                Ok(response) if response.get("error").is_some() => {
                    let event = failure_event(format!(
                        "thread/compact/start failed: {}",
                        response["error"]
                    ));
                    push_provider_event(
                        &session_id_string,
                        ProviderRuntimeEvent {
                            provider: ProviderId::Codex,
                            workspace_id: workspace_id_string.clone(),
                            thread_id: final_thread_id.clone(),
                            turn_id: Some(final_turn_id.clone()),
                            event: event.clone(),
                        },
                    )
                    .await;
                    push_native_provider_event_to_conversation(&conversation_sink, &event).await;
                    CODEX_NATIVE_TURN_SINKS.lock().await.remove(&final_turn_id);
                    CODEX_NATIVE_THREAD_SINKS.lock().await.remove(&thread_id);
                    complete_native_conversation_sink(
                        conversation_sink,
                        ExecutionProcessStatus::Failed,
                        None,
                    )
                    .await;
                    return;
                }
                Ok(response) => response,
                Err(error) => {
                    let event = failure_event(error);
                    push_provider_event(
                        &session_id_string,
                        ProviderRuntimeEvent {
                            provider: ProviderId::Codex,
                            workspace_id: workspace_id_string.clone(),
                            thread_id: final_thread_id.clone(),
                            turn_id: Some(final_turn_id.clone()),
                            event: event.clone(),
                        },
                    )
                    .await;
                    push_native_provider_event_to_conversation(&conversation_sink, &event).await;
                    CODEX_NATIVE_TURN_SINKS.lock().await.remove(&final_turn_id);
                    CODEX_NATIVE_THREAD_SINKS.lock().await.remove(&thread_id);
                    complete_native_conversation_sink(
                        conversation_sink,
                        ExecutionProcessStatus::Failed,
                        None,
                    )
                    .await;
                    return;
                }
            };

            let event = ProviderRuntimeEvent {
                provider: ProviderId::Codex,
                workspace_id: workspace_id.to_string(),
                thread_id: final_thread_id.clone(),
                turn_id: Some(final_turn_id),
                event: json!({
                    "method": "thread/compact/started",
                    "runtime_source": "native_app_server",
                    "execution_process_id": process_id,
                    "session_id": session_id,
                    "response": response,
                }),
            };
            if let Some(turn_id) = event.turn_id.as_deref() {
                CODEX_NATIVE_TURN_SINKS.lock().await.remove(turn_id);
            }
            push_provider_event(&session_id_string, event).await;
            return;
        }

        let mut params = serde_json::Map::new();
        params.insert("threadId".to_string(), json!(thread_id));
        params.insert(
            "cwd".to_string(),
            json!(server.workspace_dir.to_string_lossy()),
        );
        params.insert(
            "approvalPolicy".to_string(),
            json!(codex_options.approval_policy.as_str()),
        );
        params.insert(
            "sandboxPolicy".to_string(),
            codex_options.sandbox_policy.clone(),
        );
        if let Some(model) = codex_options.model.as_deref() {
            params.insert("model".to_string(), json!(model));
        }
        if let Some(effort) = codex_options.effort.as_deref() {
            params.insert("effort".to_string(), json!(effort));
        }
        if let Some(collaboration_mode) =
            provider_option_string(&request.provider_options, "collaboration_mode")
        {
            params.insert(
                "collaborationMode".to_string(),
                json!({ "id": collaboration_mode }),
            );
        }
        params.insert(
            "input".to_string(),
            Value::Array(codex_input_items(&request)),
        );

        let response = match send_codex_request(
            &server,
            "turn/start",
            Value::Object(params),
            Duration::from_secs(CODEX_REQUEST_TIMEOUT_SECS),
        )
        .await
        {
            Ok(response) if response.get("error").is_some() => {
                let event = failure_event(format!("turn/start failed: {}", response["error"]));
                push_provider_event(
                    &session_id_string,
                    ProviderRuntimeEvent {
                        provider: ProviderId::Codex,
                        workspace_id: workspace_id_string.clone(),
                        thread_id: final_thread_id.clone(),
                        turn_id: Some(final_turn_id.clone()),
                        event: event.clone(),
                    },
                )
                .await;
                push_native_provider_event_to_conversation(&conversation_sink, &event).await;
                CODEX_NATIVE_TURN_SINKS.lock().await.remove(&final_turn_id);
                if let Some(thread_id) = final_thread_id.as_deref() {
                    CODEX_NATIVE_THREAD_SINKS.lock().await.remove(thread_id);
                }
                complete_native_conversation_sink(
                    conversation_sink,
                    ExecutionProcessStatus::Failed,
                    None,
                )
                .await;
                return;
            }
            Ok(response) => response,
            Err(error) => {
                let event = failure_event(error);
                push_provider_event(
                    &session_id_string,
                    ProviderRuntimeEvent {
                        provider: ProviderId::Codex,
                        workspace_id: workspace_id_string.clone(),
                        thread_id: final_thread_id.clone(),
                        turn_id: Some(final_turn_id.clone()),
                        event: event.clone(),
                    },
                )
                .await;
                push_native_provider_event_to_conversation(&conversation_sink, &event).await;
                CODEX_NATIVE_TURN_SINKS.lock().await.remove(&final_turn_id);
                if let Some(thread_id) = final_thread_id.as_deref() {
                    CODEX_NATIVE_THREAD_SINKS.lock().await.remove(thread_id);
                }
                complete_native_conversation_sink(
                    conversation_sink,
                    ExecutionProcessStatus::Failed,
                    None,
                )
                .await;
                return;
            }
        };

        if let Some(turn_id) = extract_turn_id(&response) {
            final_turn_id = turn_id;
            CODEX_NATIVE_TURN_SINKS.lock().await.remove(&queued_turn_id);
            CODEX_NATIVE_TURN_SINKS
                .lock()
                .await
                .insert(final_turn_id.clone(), conversation_sink.clone());
            if let Err(error) =
                CodingAgentTurn::update_agent_message_id(&pool, process_id, &final_turn_id).await
            {
                tracing::error!(
                    "Failed to persist Codex app-server turn id for process {}: {}",
                    process_id,
                    error
                );
            }
        }

        let event = ProviderRuntimeEvent {
            provider: ProviderId::Codex,
            workspace_id: workspace_id.to_string(),
            thread_id: final_thread_id.clone(),
            turn_id: Some(final_turn_id.clone()),
            event: json!({
                "method": "turn/started",
                "runtime_source": "native_app_server",
                "execution_process_id": process_id,
                "session_id": session_id,
                "response": response,
            }),
        };
        push_provider_event(&session_id_string, event).await;

        if let Some(status) = codex_turn_status(&response)
            && codex_turn_status_is_terminal(status)
        {
            let method = if codex_turn_status_is_complete(status) {
                "turn/completed"
            } else {
                "turn/error"
            };
            let terminal_event = json!({
                "method": method,
                "runtime_source": "native_app_server",
                "execution_process_id": process_id,
                "session_id": session_id,
                "params": {
                    "threadId": final_thread_id,
                    "turn": codex_turn_from_response(&response).cloned(),
                },
                "response": response,
            });
            push_provider_event(
                &session_id_string,
                ProviderRuntimeEvent {
                    provider: ProviderId::Codex,
                    workspace_id: workspace_id.to_string(),
                    thread_id: terminal_event
                        .get("params")
                        .and_then(|params| params.get("threadId"))
                        .and_then(Value::as_str)
                        .map(ToString::to_string),
                    turn_id: Some(final_turn_id.clone()),
                    event: terminal_event.clone(),
                },
            )
            .await;
            push_native_provider_event_to_conversation(&conversation_sink, &terminal_event).await;
            CODEX_NATIVE_TURN_SINKS.lock().await.remove(&final_turn_id);
            if let Some(thread_id) = extract_thread_id(&terminal_event) {
                CODEX_NATIVE_THREAD_SINKS.lock().await.remove(&thread_id);
            }
            let execution_status = if method == "turn/completed" {
                ExecutionProcessStatus::Completed
            } else {
                ExecutionProcessStatus::Failed
            };
            let exit_code = if execution_status == ExecutionProcessStatus::Completed {
                Some(0)
            } else {
                None
            };
            complete_native_conversation_sink(conversation_sink, execution_status, exit_code).await;
        }
    });

    Ok(event)
}

