fn opencode_sdk_bridge_script_path() -> PathBuf {
    repo_root_path()
        .join("scripts")
        .join("opencode-sdk-provider.mjs")
}

fn build_opencode_sdk_bridge_args(input_path: &Path) -> Vec<String> {
    vec![
        opencode_sdk_bridge_script_path()
            .to_string_lossy()
            .to_string(),
        input_path.to_string_lossy().to_string(),
    ]
}

fn build_opencode_sdk_metadata_args(input_path: &Path) -> Vec<String> {
    vec![
        opencode_sdk_bridge_script_path()
            .to_string_lossy()
            .to_string(),
        "--metadata".to_string(),
        input_path.to_string_lossy().to_string(),
    ]
}

fn opencode_image_mime_type(image: &str) -> Option<&'static str> {
    let path = image
        .split(['?', '#'])
        .next()
        .unwrap_or(image)
        .to_ascii_lowercase();
    if path.ends_with(".png") {
        Some("image/png")
    } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if path.ends_with(".gif") {
        Some("image/gif")
    } else if path.ends_with(".webp") {
        Some("image/webp")
    } else if path.ends_with(".pdf") {
        Some("application/pdf")
    } else {
        None
    }
}

fn resolve_opencode_file_path(workspace_dir: &Path, image: &str) -> String {
    if image.starts_with("http://") || image.starts_with("https://") || image.starts_with("file://")
    {
        image.to_string()
    } else {
        let path = PathBuf::from(image);
        if path.is_absolute() {
            path.to_string_lossy().to_string()
        } else {
            workspace_dir.join(path).to_string_lossy().to_string()
        }
    }
}

fn build_opencode_sdk_bridge_input(
    request: &ProviderTurnRequest,
    workspace_dir: &Path,
) -> Result<Value, AppError> {
    let mut images = Vec::new();
    for image in &request.images {
        let mime = opencode_image_mime_type(image).ok_or_else(|| {
            AppError::BadRequest(format!(
                "OpenCode SDK file input only supports PNG, JPEG, GIF, WebP, or PDF files: {image}"
            ))
        })?;
        let path = resolve_opencode_file_path(workspace_dir, image);
        images.push(json!({
            "path": path,
            "mime": mime,
            "url": if image.starts_with("http://") || image.starts_with("https://") || image.starts_with("file://") {
                Some(image.clone())
            } else {
                None
            },
        }));
    }

    Ok(json!({
        "text": request.text,
        "cwd": workspace_dir.to_string_lossy(),
        "sessionId": request.session_id,
        "threadId": request.thread_id,
        "model": request.model,
        "agent": provider_option_string(&request.provider_options, "agent"),
        "variant": provider_option_string(&request.provider_options, "variant"),
        "forkSession": provider_option_bool(&request.provider_options, "fork"),
        "dangerouslySkipPermissions": provider_option_bool(&request.provider_options, "dangerously_skip_permissions"),
        "autoApprove": provider_option_bool(&request.provider_options, "auto_approve"),
        "autoCompact": request.provider_options
            .get("auto_compact")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        "env": request.provider_options.get("env"),
        "config": request.provider_options.get("config"),
        "images": images,
    }))
}

fn write_opencode_sdk_bridge_input_file(input: &Value) -> Result<PathBuf, AppError> {
    let path = std::env::temp_dir().join(format!("vibex-opencode-sdk-{}.json", Uuid::new_v4()));
    let bytes = serde_json::to_vec(input).map_err(|error| {
        app_error_from_native(
            ProviderId::Opencode,
            format!("failed to serialize SDK bridge input: {error}"),
        )
    })?;
    std::fs::write(&path, bytes).map_err(|error| {
        app_error_from_native(
            ProviderId::Opencode,
            format!(
                "failed to write SDK bridge input {}: {}",
                path.display(),
                error
            ),
        )
    })?;
    Ok(path)
}

async fn load_opencode_sdk_metadata(workspace_dir: &Path) -> Result<Value, AppError> {
    let input = json!({
        "cwd": workspace_dir.to_string_lossy(),
    });
    let input_path = write_opencode_sdk_bridge_input_file(&input)?;
    let output = tokio::time::timeout(Duration::from_secs(30), async {
        let mut command =
            new_provider_hidden_command("node", build_opencode_sdk_metadata_args(&input_path))
                .await;
        command
            .current_dir(workspace_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.output().await
    })
    .await
    .map_err(|_| app_error_from_native(ProviderId::Opencode, "SDK metadata discovery timed out"))?
    .map_err(|error| app_error_from_native(ProviderId::Opencode, error.to_string()));
    let _ = std::fs::remove_file(&input_path);
    let output = output?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(app_error_from_native(
            ProviderId::Opencode,
            if stderr.is_empty() {
                "SDK metadata discovery failed".to_string()
            } else {
                stderr
            },
        ));
    }

    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("opencode_sdk_metadata") {
            continue;
        }
        return Ok(value);
    }

    Err(app_error_from_native(
        ProviderId::Opencode,
        "SDK metadata discovery returned no metadata",
    ))
}

fn opencode_sdk_metadata_commands(metadata: &Value) -> Vec<ProviderCommand> {
    metadata
        .get("commands")
        .and_then(Value::as_array)
        .map(|commands| {
            commands
                .iter()
                .filter_map(|command| {
                    let name = command.get("name").and_then(Value::as_str)?;
                    if should_hide_provider_slash_command(ProviderId::Opencode, name) {
                        return None;
                    }
                    let description = command
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let source = command.get("source").and_then(Value::as_str);
                    let kind =
                        if source == Some("skill") || !is_opencode_core_slash_command(name) {
                            SlashCommandKind::Skill
                        } else {
                            SlashCommandKind::Command
                        };
                    Some(ProviderCommand {
                        provider: ProviderId::Opencode,
                        name: name.to_string(),
                        description: description.to_string(),
                        kind,
                        source: CapabilitySource::Sdk,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn is_opencode_core_slash_command(name: &str) -> bool {
    matches!(
        name.trim().trim_start_matches('/').to_ascii_lowercase().as_str(),
        "compact"
    )
}

fn opencode_sdk_metadata_models(metadata: &Value) -> Vec<ProviderModel> {
    let provider_sources: HashMap<String, String> = metadata
        .get("providers")
        .and_then(Value::as_array)
        .map(|providers| {
            providers
                .iter()
                .filter_map(|provider| {
                    let id = provider.get("id").and_then(Value::as_str)?;
                    let source = provider
                        .get("source")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    Some((id.to_string(), source.to_string()))
                })
                .collect()
        })
        .unwrap_or_default();

    metadata
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let id = model.get("id").and_then(Value::as_str)?;
                    let provider_id = model
                        .get("providerID")
                        .and_then(Value::as_str)
                        .or_else(|| id.split_once('/').map(|(provider_id, _)| provider_id))?;
                    let provider_source = model
                        .get("providerSource")
                        .and_then(Value::as_str)
                        .or_else(|| provider_sources.get(provider_id).map(String::as_str));
                    if provider_id != "opencode" && provider_source != Some("config") {
                        return None;
                    }
                    let label = model
                        .get("label")
                        .and_then(Value::as_str)
                        .or_else(|| model.get("name").and_then(Value::as_str))
                        .unwrap_or(id);
                    Some(ProviderModel {
                        provider: ProviderId::Opencode,
                        id: id.to_string(),
                        label: label.to_string(),
                        source: CapabilitySource::Sdk,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

async fn load_opencode_sdk_commands(
    workspace_dir: &Path,
) -> Result<Vec<ProviderCommand>, AppError> {
    let commands =
        opencode_sdk_metadata_commands(&load_opencode_sdk_metadata(workspace_dir).await?);
    if commands.is_empty() {
        return Err(app_error_from_native(
            ProviderId::Opencode,
            "SDK command discovery returned no commands",
        ));
    }
    Ok(commands)
}

async fn load_opencode_sdk_models(workspace_dir: &Path) -> Result<Vec<ProviderModel>, AppError> {
    let models = opencode_sdk_metadata_models(&load_opencode_sdk_metadata(workspace_dir).await?);
    if models.is_empty() {
        return Err(app_error_from_native(
            ProviderId::Opencode,
            "SDK model discovery returned no models",
        ));
    }
    Ok(models)
}

