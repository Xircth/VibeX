use remote_protocol::{
    ConversationId, OfflineConversationCache, RemoteEvent, SubscriptionBootstrap, SubscriptionId,
    SubscriptionRequest, SubscriptionResource,
};
use serde_json::json;

#[test]
fn subscription_fixture_preserves_unknown_conversation_events() {
    let subscription_id =
        SubscriptionId::parse("0195d6f4-8c37-7b28-a982-6a9e60142f53").expect("subscription id");
    let conversation_id =
        ConversationId::parse("0195d6f4-8c37-7b28-a982-6a9e60142f54").expect("conversation id");
    let request = SubscriptionRequest {
        subscription_id,
        resource: SubscriptionResource::Conversation {
            conversation_id,
            after_sequence: 4,
        },
    };
    let unknown = RemoteEvent {
        sequence: 5,
        kind: "future_event_kind".to_owned(),
        payload: json!({"new_field": true}),
    };
    let bootstrap = SubscriptionBootstrap {
        subscription_id,
        ready: true,
        snapshot: None,
        replay: vec![unknown],
        high_water_mark: 5,
    };

    let encoded = serde_json::to_value((&request, &bootstrap)).expect("serialize subscription");
    let (decoded_request, decoded_bootstrap): (SubscriptionRequest, SubscriptionBootstrap) =
        serde_json::from_value(encoded.clone()).expect("deserialize subscription");

    assert_eq!(decoded_request, request);
    assert_eq!(decoded_bootstrap, bootstrap);
    assert_eq!(decoded_bootstrap.replay[0].kind, "future_event_kind");
    assert_eq!(
        serde_json::to_value((decoded_request, decoded_bootstrap)).expect("reserialize"),
        encoded
    );
}

#[test]
fn offline_cache_preserves_unknown_events_and_resumes_from_confirmed_high_water() {
    let fixture = json!({
        "conversation_id": "0195d6f4-8c37-7b28-a982-6a9e60142f54",
        "confirmed_through": 7,
        "read_only": true,
        "events": [{
            "sequence": 7,
            "kind": "future_mobile_event",
            "payload": {
                "future_shape": ["preserved", 2]
            }
        }]
    });

    let cache: OfflineConversationCache =
        serde_json::from_value(fixture.clone()).expect("future event remains readable");

    assert!(cache.read_only);
    assert_eq!(cache.resume_after(), 7);
    assert_eq!(cache.events[0].kind, "future_mobile_event");
    assert_eq!(
        serde_json::to_value(cache).expect("cache JSON remains portable"),
        fixture
    );
}
