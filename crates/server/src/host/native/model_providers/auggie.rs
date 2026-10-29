use std::path::Path;

use super::common::*;

pub(super) async fn apply_auggie(
    auggie_home: &Path,
    provider: &StoredProvider,
) -> Result<(), crate::host::native::NativeError> {
    apply_generic_json_env_provider(
        &auggie_home.join("settings.json"),
        provider,
        &[
            ("AUGMENT_API_URL", &provider.api_url),
            ("AUGMENT_API_TOKEN", &provider.api_key),
            ("OPENAI_BASE_URL", &provider.api_url),
            ("OPENAI_API_KEY", &provider.api_key),
        ],
        "OPENAI_MODEL",
    )
    .await
}
