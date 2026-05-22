use executors::executors::BaseCodingAgent;

use super::*;

fn turn_request(provider: ProviderId) -> ProviderTurnRequest {
    ProviderTurnRequest {
        provider,
        workspace_id: Uuid::new_v4().to_string(),
        executor_profile_id: None,
        thread_id: None,
        session_id: None,
        text: "hello".to_string(),
        model: None,
        images: Vec::new(),
        provider_options: serde_json::Map::new(),
    }
}

#[test]
fn display_prompt_includes_provider_turn_images_as_markdown() {
    let images = vec![
        ".vibe-images/shot.png".to_string(),
        "  ".to_string(),
        ".vibe-images/second.webp".to_string(),
    ];

    assert_eq!(
        prompt_with_display_images("analyze this", &images),
        "analyze this\n\n![](.vibe-images/shot.png)\n![](.vibe-images/second.webp)"
    );
}

#[test]
fn display_prompt_can_be_image_only() {
    assert_eq!(
        prompt_with_display_images("", &[".vibe-images/shot.png".to_string()]),
        "![](.vibe-images/shot.png)"
    );
}

include!("tests_events.rs");
include!("tests_sdk.rs");
