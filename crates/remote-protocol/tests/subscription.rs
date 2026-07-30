use remote_protocol::{
    ConversationId, RemoteEvent, SubscriptionBootstrap, SubscriptionId, SubscriptionRequest,
    SubscriptionResource,
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
