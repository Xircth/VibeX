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

include!("tests_events.rs");
include!("tests_sdk.rs");
