fn claude_settings_path() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| PathBuf::from(home).join(".claude").join("settings.json"))
}

fn read_claude_model_env() -> HashMap<String, String> {
    let mut env = HashMap::new();
    for key in [
        CLAUDE_PRIMARY_MODEL_ENV,
        CLAUDE_DEFAULT_SONNET_ENV,
        CLAUDE_DEFAULT_OPUS_ENV,
        CLAUDE_DEFAULT_HAIKU_ENV,
    ] {
        if let Ok(value) = std::env::var(key)
            && !value.trim().is_empty()
        {
            env.insert(key.to_string(), value);
        }
    }

    if let Some(path) = claude_settings_path()
        && let Ok(content) = std::fs::read_to_string(path)
        && let Ok(value) = serde_json::from_str::<Value>(&content)
        && let Some(settings_env) = value.get("env").and_then(Value::as_object)
    {
        for key in [
            CLAUDE_PRIMARY_MODEL_ENV,
            CLAUDE_DEFAULT_SONNET_ENV,
            CLAUDE_DEFAULT_OPUS_ENV,
            CLAUDE_DEFAULT_HAIKU_ENV,
        ] {
            if let Some(value) = settings_env.get(key).and_then(Value::as_str)
                && !value.trim().is_empty()
            {
                env.insert(key.to_string(), value.to_string());
            }
        }
    }

    env
}

fn resolve_claude_model_from_env(model: &str, env: &HashMap<String, String>) -> Option<String> {
    let model = model.trim();
    let env_key = match model.to_ascii_lowercase().as_str() {
        "sonnet" => Some(CLAUDE_DEFAULT_SONNET_ENV),
        "opus" => Some(CLAUDE_DEFAULT_OPUS_ENV),
        "haiku" => Some(CLAUDE_DEFAULT_HAIKU_ENV),
        _ => None,
    };

    if let Some(env_key) = env_key {
        if let Some(value) = env.get(env_key).map(String::as_str).map(str::trim)
            && !value.is_empty()
        {
            return Some(value.to_string());
        }

        if model.eq_ignore_ascii_case("sonnet")
            && let Some(value) = env
                .get(CLAUDE_PRIMARY_MODEL_ENV)
                .map(String::as_str)
                .map(str::trim)
            && !value.is_empty()
        {
            return Some(value.to_string());
        }
    }

    Some(model.to_string())
}

fn resolve_claude_model(model: Option<&str>) -> Option<String> {
    let model = model?.trim();
    if model.is_empty() {
        return None;
    }
    resolve_claude_model_from_env(model, &read_claude_model_env())
}

fn claude_image_mime_type(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        _ => None,
    }
}

fn resolve_claude_image_path(workspace_dir: &Path, image: &str) -> Result<PathBuf, AppError> {
    if image.starts_with("http://") || image.starts_with("https://") {
        return Err(AppError::BadRequest(
            "Claude Code native vision input requires local image files; remote image URLs are not supported yet."
                .to_string(),
        ));
    }

    let path = PathBuf::from(image);
    Ok(if path.is_absolute() {
        path
    } else {
        workspace_dir.join(path)
    })
}

fn repo_root_path() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or(manifest_dir)
}

fn claude_sdk_bridge_script_path() -> PathBuf {
    repo_root_path()
        .join("scripts")
        .join("claude-agent-sdk-provider.mjs")
}

fn build_claude_sdk_bridge_args(input_path: &Path) -> Vec<String> {
    vec![
        claude_sdk_bridge_script_path()
            .to_string_lossy()
            .to_string(),
        input_path.to_string_lossy().to_string(),
    ]
}

fn build_claude_sdk_metadata_args(input_path: &Path) -> Vec<String> {
    vec![
        claude_sdk_bridge_script_path()
            .to_string_lossy()
            .to_string(),
        "--metadata".to_string(),
        input_path.to_string_lossy().to_string(),
    ]
}

fn claude_provider_option_string<'a>(
    request: &'a ProviderTurnRequest,
    snake_case_key: &str,
    camel_case_key: &str,
) -> Option<&'a str> {
    provider_option_string(&request.provider_options, snake_case_key)
        .or_else(|| provider_option_string(&request.provider_options, camel_case_key))
}

fn build_claude_sdk_bridge_input(
    request: &ProviderTurnRequest,
    workspace_dir: &Path,
) -> Result<Value, AppError> {
    let mut images = Vec::new();

    for image in &request.images {
        let path = resolve_claude_image_path(workspace_dir, image)?;
        let mime_type = claude_image_mime_type(&path).ok_or_else(|| {
            AppError::BadRequest(format!(
                "Claude Code native vision input only supports PNG, JPEG, GIF, or WebP images: {}",
                path.display()
            ))
        })?;
        let bytes = std::fs::read(&path).map_err(|error| {
            AppError::BadRequest(format!(
                "Failed to read Claude Code image input {}: {}",
                path.display(),
                error
            ))
        })?;
        images.push(json!({
            "path": path.to_string_lossy(),
            "mediaType": mime_type,
            "base64": BASE64_STANDARD.encode(bytes),
        }));
    }

    Ok(json!({
        "text": request.text,
        "cwd": workspace_dir.to_string_lossy(),
        "sessionId": request.session_id,
        "threadId": request.thread_id,
        "resume": provider_option_string(&request.provider_options, "resume"),
        "model": resolve_claude_model(request.model.as_deref()),
        "effort": provider_option_string(&request.provider_options, "effort"),
        "permissionMode": claude_provider_option_string(
            request,
            "permission_mode",
            "permissionMode",
        ),
        "env": request.provider_options.get("env"),
        "forkSession": provider_option_bool(&request.provider_options, "fork")
            || provider_option_bool(&request.provider_options, "forkSession"),
        "images": images,
    }))
}

fn write_claude_sdk_bridge_input_file(input: &Value) -> Result<PathBuf, AppError> {
    let path = std::env::temp_dir().join(format!("vibex-claude-sdk-{}.json", Uuid::new_v4()));
    let bytes = serde_json::to_vec(input).map_err(|error| {
        app_error_from_native(
            ProviderId::Claude,
            format!("failed to serialize SDK bridge input: {error}"),
        )
    })?;
    std::fs::write(&path, bytes).map_err(|error| {
        app_error_from_native(
            ProviderId::Claude,
            format!(
                "failed to write SDK bridge input {}: {}",
                path.display(),
                error
            ),
        )
    })?;
    Ok(path)
}

async fn load_claude_sdk_metadata(workspace_dir: &Path) -> Result<Value, AppError> {
    let input = json!({
        "cwd": workspace_dir.to_string_lossy(),
    });
    let input_path = write_claude_sdk_bridge_input_file(&input)?;
    let output = tokio::time::timeout(Duration::from_secs(20), async {
        let mut command =
            new_provider_hidden_command("node", build_claude_sdk_metadata_args(&input_path)).await;
        command
            .current_dir(workspace_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.output().await
    })
    .await
    .map_err(|_| app_error_from_native(ProviderId::Claude, "SDK metadata discovery timed out"))?
    .map_err(|error| app_error_from_native(ProviderId::Claude, error.to_string()));
    let _ = std::fs::remove_file(&input_path);
    let output = output?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(app_error_from_native(
            ProviderId::Claude,
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
        if value.get("type").and_then(Value::as_str) != Some("sdk_metadata") {
            continue;
        }
        return Ok(value);
    }

    Err(app_error_from_native(
        ProviderId::Claude,
        "SDK metadata discovery returned no metadata",
    ))
}

fn claude_sdk_metadata_commands(metadata: &Value) -> Vec<ProviderCommand> {
    metadata
        .get("commands")
        .and_then(Value::as_array)
        .map(|commands| {
            commands
                .iter()
                .filter_map(|command| {
                    let name = command.get("name").and_then(Value::as_str)?;
                    if should_hide_provider_slash_command(ProviderId::Claude, name) {
                        return None;
                    }
                    let description = command
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    Some(ProviderCommand {
                        provider: ProviderId::Claude,
                        name: name.to_string(),
                        description: description.to_string(),
                        kind: SlashCommandKind::Command,
                        source: CapabilitySource::Sdk,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn claude_sdk_metadata_models(metadata: &Value) -> Vec<ProviderModel> {
    metadata
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    let id = model.get("value").and_then(Value::as_str)?;
                    let label = model
                        .get("displayName")
                        .and_then(Value::as_str)
                        .or_else(|| model.get("description").and_then(Value::as_str))
                        .unwrap_or(id);
                    Some(ProviderModel {
                        provider: ProviderId::Claude,
                        id: id.to_string(),
                        label: label.to_string(),
                        source: CapabilitySource::Sdk,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

async fn load_claude_sdk_commands(workspace_dir: &Path) -> Result<Vec<ProviderCommand>, AppError> {
    let commands = claude_sdk_metadata_commands(&load_claude_sdk_metadata(workspace_dir).await?);
    if commands.is_empty() {
        return Err(app_error_from_native(
            ProviderId::Claude,
            "SDK command discovery returned no commands",
        ));
    }
    Ok(commands)
}

async fn load_claude_sdk_models(workspace_dir: &Path) -> Result<Vec<ProviderModel>, AppError> {
    let models = claude_sdk_metadata_models(&load_claude_sdk_metadata(workspace_dir).await?);
    if models.is_empty() {
        return Err(app_error_from_native(
            ProviderId::Claude,
            "SDK model discovery returned no models",
        ));
    }
    Ok(models)
}

