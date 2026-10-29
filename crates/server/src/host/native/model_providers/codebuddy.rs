use std::path::Path;

use agents::{NativeFileMutation, NativeFileSystem, TokioNativeFileSystem};

use super::common::*;

pub(super) async fn apply_codebuddy(
    codebuddy_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    let path = codebuddy_home.join(".env");
    let filesystem = TokioNativeFileSystem;
    let original = filesystem.read(&path).await?;
    let mut lines: Vec<String> = original
        .as_deref()
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .map(|text| {
            text.lines()
                .filter(|line| {
                    let trimmed = line.trim();
                    !trimmed.starts_with("CODEBUDDY_BASE_URL=")
                        && !trimmed.starts_with("CODEBUDDY_API_KEY=")
                        && !trimmed.starts_with("CODEBUDDY_MODEL=")
                })
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    lines.push(format!("CODEBUDDY_BASE_URL={}", provider.api_url));
    lines.push(format!("CODEBUDDY_API_KEY={}", provider.api_key));
    let model = model_default(&provider.model);
    if !model.trim().is_empty() {
        lines.push(format!("CODEBUDDY_MODEL={}", model.trim()));
    }
    let mut body = lines.join("\n");
    body.push('\n');
    apply_projection_mutations(&[NativeFileMutation {
        path,
        expected: original,
        replacement: Some(body.into_bytes()),
        sensitive: true,
    }])
    .await
}
