use std::path::Path;

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};

use super::common::*;
use crate::host::native::{model_provider_import::ImportDraft, read_json_object_or_empty};

pub(super) async fn native_cline_draft(cline_home: &Path) -> Result<Vec<ImportDraft>, String> {
    let state = read_json_object_or_empty(&cline_home.join("globalState.json")).await?;
    let secrets = read_json_object_or_empty(&cline_home.join("secrets.json")).await?;
    let api_url = json_text(&state, &["openAiBaseUrl"]);
    if api_url.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![ImportDraft {
        source_id: "__native_live__".to_string(),
        name: "当前原生配置".to_string(),
        api_url,
        api_key: json_text(
            &secrets,
            &["openAiApiKey", "apiKey", "openRouterApiKey", "geminiApiKey"],
        ),
        model: json_text(&state, &["apiModelId"]),
        skip_reason: None,
    }])
}

pub(super) async fn apply_cline(
    cline_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    let state_path = cline_home.join("globalState.json");
    let secrets_path = cline_home.join("secrets.json");
    let filesystem = TokioNativeFileSystem;
    let state_original = filesystem.read(&state_path).await?;
    let secrets_original = filesystem.read(&secrets_path).await?;
    let mut state = parse_json_object_bytes(&state_path, state_original.as_deref())?;
    let mut secrets = parse_json_object_bytes(&secrets_path, secrets_original.as_deref())?;
    let state_root = state.as_object_mut().expect("object");
    insert_string(state_root, "apiProvider", "openai");
    insert_string(state_root, "openAiBaseUrl", &provider.api_url);
    insert_string(state_root, "apiModelId", &model_default(&provider.model));
    insert_string(
        secrets.as_object_mut().expect("object"),
        "openAiApiKey",
        &provider.api_key,
    );
    apply_projection_mutations(&[
        NativeFileMutation {
            path: state_path,
            expected: state_original,
            replacement: Some(
                serde_json::to_vec_pretty(&state)
                    .map_err(|error| format!("序列化 Cline 配置失败：{error}"))?,
            ),
            sensitive: false,
        },
        NativeFileMutation {
            path: secrets_path,
            expected: secrets_original,
            replacement: Some(
                serde_json::to_vec_pretty(&secrets)
                    .map_err(|error| format!("序列化 Cline 凭据失败：{error}"))?,
            ),
            sensitive: true,
        },
    ])
    .await
}
