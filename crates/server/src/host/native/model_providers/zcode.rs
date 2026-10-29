use std::path::Path;

use super::common::*;

pub(super) async fn apply_zcode(
    zcode_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    apply_generic_json_env_provider(
        &zcode_home.join("settings.json"),
        provider,
        &[
            ("OPENAI_BASE_URL", &provider.api_url),
            ("OPENAI_API_KEY", &provider.api_key),
            ("ANTHROPIC_BASE_URL", &provider.api_url),
            ("ANTHROPIC_API_KEY", &provider.api_key),
            ("ZHIPU_API_KEY", &provider.api_key),
        ],
        "OPENAI_MODEL",
    )
    .await
}
