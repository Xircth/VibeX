use std::{collections::HashMap, sync::Arc, time::Duration};

use application::{
    ApplicationError, ConversationRepository, ConversationSubscriptionRegistrar, Principal,
};
use async_trait::async_trait;
use axum::{
    extract::{
        Extension, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::Response,
};
use futures::{SinkExt, StreamExt};
use remote_protocol::{
    ConversationId, ErrorCode, ErrorEnvelope, OperationId, RemoteEvent, SubscriptionBootstrap,
    SubscriptionClientMessage, SubscriptionId, SubscriptionResource, SubscriptionServerMessage,
};

use crate::{AuthenticatedCredential, runtime::ServerState};

const LIVE_RECONCILE_INTERVAL: Duration = Duration::from_millis(300);
const REVOCATION_POLL_INTERVAL: Duration = Duration::from_millis(250);
const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(15);
const MAX_CLIENT_FRAME_BYTES: usize = 1024 * 1024;

struct DurablePollingRegistration;

#[async_trait]
impl ConversationSubscriptionRegistrar for DurablePollingRegistration {
    async fn register(
        &self,
        _subscription_id: SubscriptionId,
        _conversation_id: ConversationId,
    ) -> Result<(), ApplicationError> {
        Ok(())
    }
}

#[derive(Clone)]
enum ActiveSubscription {
    Conversation {
        conversation_id: ConversationId,
        after_sequence: i64,
    },
    WorkflowRun {
        run_id: uuid::Uuid,
        after_sequence: i64,
    },
    HostEvent {
        channel: String,
        after_sequence: i64,
    },
}

impl ActiveSubscription {
    const fn after_sequence(&self) -> i64 {
        match self {
            Self::Conversation { after_sequence, .. }
            | Self::WorkflowRun { after_sequence, .. }
            | Self::HostEvent { after_sequence, .. } => *after_sequence,
        }
    }

    fn advance(&mut self, sequence: i64) {
        match self {
            Self::Conversation { after_sequence, .. }
            | Self::WorkflowRun { after_sequence, .. }
            | Self::HostEvent { after_sequence, .. } => *after_sequence = sequence,
        }
    }
}

struct PatchStreamRegistry<'a> {
    bus: &'a crate::HostEventBus,
    keys: HashMap<SubscriptionId, String>,
}

impl<'a> PatchStreamRegistry<'a> {
    fn new(bus: &'a crate::HostEventBus) -> Self {
        Self {
            bus,
            keys: HashMap::new(),
        }
    }

    fn track(&mut self, subscription_id: SubscriptionId, task_key: String) {
        self.release(&subscription_id);
        self.bus.retain_stream_task(&task_key);
        self.keys.insert(subscription_id, task_key);
    }

    fn release(&mut self, subscription_id: &SubscriptionId) {
        if let Some(previous_key) = self.keys.remove(subscription_id) {
            self.bus.release_stream_task(&previous_key);
        }
    }
}

impl Drop for PatchStreamRegistry<'_> {
    fn drop(&mut self) {
        for (_, task_key) in self.keys.drain() {
            self.bus.release_stream_task(&task_key);
        }
    }
}

fn has_durable_subscriptions(subscriptions: &HashMap<SubscriptionId, ActiveSubscription>) -> bool {
    subscriptions.values().any(|sub| {
        matches!(
            sub,
            ActiveSubscription::Conversation { .. } | ActiveSubscription::WorkflowRun { .. }
        )
    })
}

pub(crate) async fn ws_handler<R>(
    State(state): State<Arc<ServerState<R>>>,
    Extension(credential): Extension<AuthenticatedCredential>,
    e2ee_session: Option<Extension<crate::e2ee::E2eeSession>>,
    upgrade: WebSocketUpgrade,
) -> Response
where
    R: ConversationRepository + Send + Sync + 'static,
{
    let e2ee = e2ee_session.map(|ext| ext.0);
    upgrade
        .max_frame_size(MAX_CLIENT_FRAME_BYTES)
        .max_message_size(MAX_CLIENT_FRAME_BYTES)
        .protocols(["dimo.v1"])
        .on_upgrade(move |socket| handle_socket(socket, state, credential, e2ee))
}

async fn handle_socket<R>(
    socket: WebSocket,
    state: Arc<ServerState<R>>,
    credential: AuthenticatedCredential,
    e2ee_session: Option<crate::e2ee::E2eeSession>,
) where
    R: ConversationRepository + Send + Sync + 'static,
{
    let (mut sender, mut receiver) = socket.split();
    let mut ws_e2ee_key: Option<[u8; 32]> = e2ee_session
        .as_ref()
        .filter(|s| s.active_e2ee)
        .map(|s| s.key);
    let mut subscriptions = HashMap::<SubscriptionId, ActiveSubscription>::new();
    let mut patch_streams = PatchStreamRegistry::new(&state.events);
    let mut live_ticker = tokio::time::interval(LIVE_RECONCILE_INTERVAL);
    live_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut revocation_ticker = tokio::time::interval(REVOCATION_POLL_INTERVAL);
    revocation_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut keepalive_ticker = tokio::time::interval_at(
        tokio::time::Instant::now() + KEEP_ALIVE_INTERVAL,
        KEEP_ALIVE_INTERVAL,
    );
    keepalive_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let principal = credential.principal();
    let mut host_events = state.events.subscribe();

    loop {
        tokio::select! {
            incoming = receiver.next() => {
                let Some(Ok(message)) = incoming else {
                    break;
                };
                let text = match message {
                    Message::Close(_) => break,
                    Message::Ping(payload) => {
                        if sender.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                        continue;
                    }
                    Message::Pong(_) => continue,
                    Message::Text(text) => text,
                    Message::Binary(_) => continue,
                };
                let decoded_text: String = if let Some(ref session) = e2ee_session
                    && let Ok(wrapper) = serde_json::from_str::<serde_json::Value>(&text)
                    && wrapper.get("type").and_then(|v| v.as_str()) == Some("e2ee")
                {
                    let Some(cipher_b64) = wrapper.get("d").and_then(|v| v.as_str()) else {
                        break;
                    };
                    let Ok(plain_bytes) = crate::e2ee::decrypt_payload(
                        &session.key,
                        crate::e2ee::AAD_WS,
                        cipher_b64,
                    ) else {
                        break;
                    };
                    let Ok(plain_str) = String::from_utf8(plain_bytes) else {
                        break;
                    };
                    ws_e2ee_key = Some(session.key);
                    plain_str
                } else {
                    text.to_string()
                };
                let message = match serde_json::from_str::<SubscriptionClientMessage>(&decoded_text) {
                    Ok(message) => message,
                    Err(error) => {
                        if send_message(
                            &mut sender,
                            SubscriptionServerMessage::Error {
                                error: ErrorEnvelope::new(
                                    ErrorCode::BadRequest,
                                    format!("invalid subscription message: {error}"),
                                    false,
                                    OperationId::new(),
                                ),
                                subscription_id: None,
                            },
                            ws_e2ee_key.as_ref(),
                        )
                        .await
                        .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                };
                if handle_client_message(
                    state.as_ref(),
                    &principal,
                    message,
                    &mut subscriptions,
                    &mut patch_streams,
                    &mut sender,
                    ws_e2ee_key.as_ref(),
                )
                .await
                .is_err()
                {
                    break;
                }
            }
            _ = revocation_ticker.tick() => {
                match state.auth.is_active(&credential).await {
                    Ok(true) => {}
                    Ok(false) => {
                        let _ = send_message(
                            &mut sender,
                            SubscriptionServerMessage::Error {
                                error: ErrorEnvelope::new(
                                    ErrorCode::Unauthorized,
                                    "credential has been revoked",
                                    false,
                                    OperationId::new(),
                                ),
                                subscription_id: None,
                            },
                            ws_e2ee_key.as_ref(),
                        )
                        .await;
                        break;
                    }
                    Err(_) => break,
                }
            }
            host_event = host_events.recv() => {
                let event = match host_event {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        if has_durable_subscriptions(&subscriptions)
                            && reconcile_durable_subscriptions(
                                state.as_ref(),
                                &principal,
                                &mut subscriptions,
                                None,
                                &mut sender,
                                ws_e2ee_key.as_ref(),
                            )
                            .await
                            .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                let matches = subscriptions
                    .iter()
                    .filter(|(_, subscription)| match subscription {
                        ActiveSubscription::HostEvent {
                            channel,
                            after_sequence,
                        } => {
                            event.sequence > *after_sequence
                                && (*channel == event.channel
                                    || event.channel.starts_with(&format!("{channel}:")))
                        }
                        _ => false,
                    })
                    .map(|(id, _)| *id)
                    .collect::<Vec<_>>();
                for subscription_id in matches {
                    if let Some(subscription) = subscriptions.get_mut(&subscription_id) {
                        subscription.advance(event.sequence);
                    }
                    if send_message(
                        &mut sender,
                        SubscriptionServerMessage::Event {
                            subscription_id,
                            event: RemoteEvent {
                                sequence: event.sequence,
                                kind: event.channel.clone(),
                                payload: event.payload.clone(),
                            },
                        },
                        ws_e2ee_key.as_ref(),
                    )
                    .await
                    .is_err()
                    {
                        return;
                    }
                }
                if let Some(target_conv) = conversation_wake_target(&event.channel)
                    && subscriptions.values().any(|sub| match sub {
                        ActiveSubscription::Conversation { conversation_id, .. } => {
                            target_conv.is_none_or(|cid| cid == conversation_id.as_uuid())
                        }
                        _ => false,
                    })
                    && reconcile_durable_subscriptions(
                        state.as_ref(),
                        &principal,
                        &mut subscriptions,
                        Some(target_conv),
                        &mut sender,
                        ws_e2ee_key.as_ref(),
                    )
                    .await
                    .is_err()
                {
                    break;
                }
            }
            _ = keepalive_ticker.tick() => {
                if sender.send(Message::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
            _ = live_ticker.tick(), if has_durable_subscriptions(&subscriptions) => {
                if reconcile_durable_subscriptions(
                    state.as_ref(),
                    &principal,
                    &mut subscriptions,
                    None,
                    &mut sender,
                    ws_e2ee_key.as_ref(),
                )
                .await
                .is_err()
                {
                    break;
                }
            }
        }
    }
}

fn conversation_wake_target(channel: &str) -> Option<Option<uuid::Uuid>> {
    if channel == "conversation-events" {
        return Some(None);
    }
    channel
        .strip_prefix("conversation-events:")
        .and_then(|raw| uuid::Uuid::parse_str(raw).ok())
        .map(Some)
}

async fn reconcile_durable_subscriptions<R, S>(
    state: &ServerState<R>,
    principal: &Principal,
    subscriptions: &mut HashMap<SubscriptionId, ActiveSubscription>,
    conversation_filter: Option<Option<uuid::Uuid>>,
    sender: &mut S,
    e2ee_key: Option<&[u8; 32]>,
) -> Result<(), ()>
where
    R: ConversationRepository + Send + Sync + 'static,
    S: futures::Sink<Message> + Unpin,
{
    let active = subscriptions
        .iter()
        .filter(
            |(_, subscription)| match (subscription, conversation_filter) {
                (ActiveSubscription::HostEvent { .. }, _) => false,
                (
                    ActiveSubscription::Conversation {
                        conversation_id, ..
                    },
                    Some(Some(target)),
                ) => conversation_id.as_uuid() == target,
                (ActiveSubscription::Conversation { .. }, Some(None)) => true,
                (ActiveSubscription::WorkflowRun { .. }, Some(_)) => false,
                (_, None) => true,
            },
        )
        .map(|(id, subscription)| (*id, subscription.clone()))
        .collect::<Vec<_>>();
    for (subscription_id, subscription) in active {
        let bootstrap = match subscription {
            ActiveSubscription::HostEvent { .. } => continue,
            ActiveSubscription::Conversation {
                conversation_id,
                after_sequence,
            } => {
                state
                    .core
                    .attach_conversation(
                        principal,
                        subscription_id,
                        conversation_id,
                        after_sequence,
                        &DurablePollingRegistration,
                    )
                    .await
            }
            ActiveSubscription::WorkflowRun {
                run_id,
                after_sequence,
            } => {
                state
                    .core
                    .attach_workflow_run(principal, subscription_id, run_id, after_sequence)
                    .await
            }
        };
        let Ok(bootstrap) = bootstrap else {
            continue;
        };
        let high_water_mark = bootstrap.high_water_mark;
        let mut cursor = subscription.after_sequence();
        for event in live_events(bootstrap) {
            cursor = cursor.max(event.sequence);
            send_message(
                sender,
                SubscriptionServerMessage::Event {
                    subscription_id,
                    event,
                },
                e2ee_key,
            )
            .await?;
        }
        if let Some(active) = subscriptions.get_mut(&subscription_id) {
            active.advance(cursor.max(high_water_mark));
        }
    }
    Ok(())
}

async fn handle_client_message<R, S>(
    state: &ServerState<R>,
    principal: &Principal,
    message: SubscriptionClientMessage,
    subscriptions: &mut HashMap<SubscriptionId, ActiveSubscription>,
    patch_streams: &mut PatchStreamRegistry<'_>,
    sender: &mut S,
    e2ee_key: Option<&[u8; 32]>,
) -> Result<(), ()>
where
    R: ConversationRepository + Send + Sync + 'static,
    S: futures::Sink<Message> + Unpin,
{
    match message {
        SubscriptionClientMessage::Attach { request } => {
            let subscription_id = request.subscription_id;
            patch_streams.release(&subscription_id);
            let attached =
                attach_resource(state, principal, request, subscriptions, patch_streams).await;
            let (bootstrap, active) = match attached {
                Ok(attached) => attached,
                Err(error) => {
                    send_message(
                        sender,
                        SubscriptionServerMessage::Error {
                            error,
                            subscription_id: Some(subscription_id),
                        },
                        e2ee_key,
                    )
                    .await?;
                    return Ok(());
                }
            };
            send_message(
                sender,
                SubscriptionServerMessage::Ready { subscription_id },
                e2ee_key,
            )
            .await?;
            let mut cursor = active.after_sequence();
            if let Some(snapshot) = bootstrap.snapshot {
                cursor = cursor.max(snapshot.through_sequence);
                send_message(
                    sender,
                    SubscriptionServerMessage::Snapshot {
                        subscription_id,
                        snapshot,
                    },
                    e2ee_key,
                )
                .await?;
            }
            for event in bootstrap.replay {
                cursor = cursor.max(event.sequence);
                send_message(
                    sender,
                    SubscriptionServerMessage::Event {
                        subscription_id,
                        event,
                    },
                    e2ee_key,
                )
                .await?;
            }
            send_message(
                sender,
                SubscriptionServerMessage::Live {
                    subscription_id,
                    high_water_mark: bootstrap.high_water_mark,
                },
                e2ee_key,
            )
            .await?;
            subscriptions.insert(subscription_id, {
                let mut active = active;
                active.advance(cursor.max(bootstrap.high_water_mark));
                active
            });
        }
        SubscriptionClientMessage::Detach { subscription_id } => {
            subscriptions.remove(&subscription_id);
            patch_streams.release(&subscription_id);
        }
        SubscriptionClientMessage::Ping => {
            send_message(sender, SubscriptionServerMessage::Pong, e2ee_key).await?;
        }
    }
    Ok(())
}

async fn attach_resource<R>(
    state: &ServerState<R>,
    principal: &Principal,
    request: remote_protocol::SubscriptionRequest,
    subscriptions: &mut HashMap<SubscriptionId, ActiveSubscription>,
    patch_streams: &mut PatchStreamRegistry<'_>,
) -> Result<(SubscriptionBootstrap, ActiveSubscription), ErrorEnvelope>
where
    R: ConversationRepository + Send + Sync + 'static,
{
    match request.resource {
        SubscriptionResource::Conversation {
            conversation_id,
            after_sequence,
        } => {
            let bootstrap = state
                .core
                .attach_conversation(
                    principal,
                    request.subscription_id,
                    conversation_id,
                    after_sequence,
                    &DurablePollingRegistration,
                )
                .await
                .map_err(application::ApplicationError::into_envelope)?;
            Ok((
                bootstrap,
                ActiveSubscription::Conversation {
                    conversation_id,
                    after_sequence,
                },
            ))
        }
        SubscriptionResource::WorkflowRun {
            run_id,
            after_sequence,
        } => {
            let bootstrap = state
                .core
                .attach_workflow_run(principal, request.subscription_id, run_id, after_sequence)
                .await
                .map_err(application::ApplicationError::into_envelope)?;
            Ok((
                bootstrap,
                ActiveSubscription::WorkflowRun {
                    run_id,
                    after_sequence,
                },
            ))
        }
        SubscriptionResource::HostEvent {
            channel,
            after_sequence,
        } => {
            authorize_host_channel(principal, &channel)?;
            let bootstrap = state
                .events
                .attach_bootstrap(request.subscription_id, &channel, after_sequence)
                .map_err(|message| {
                    ErrorEnvelope::new(ErrorCode::BadRequest, message, false, OperationId::new())
                })?;
            let after_sequence = bootstrap.high_water_mark;
            Ok((
                bootstrap,
                ActiveSubscription::HostEvent {
                    channel,
                    after_sequence,
                },
            ))
        }
        SubscriptionResource::PatchStream { stream, args } => {
            let command = crate::patch_stream_subscribe_command(&stream).ok_or_else(|| {
                ErrorEnvelope::new(
                    ErrorCode::BadRequest,
                    format!("unknown patch stream `{stream}`"),
                    false,
                    OperationId::new(),
                )
            })?;
            let channel = crate::patch_stream_channel(&stream, &args).map_err(|message| {
                ErrorEnvelope::new(ErrorCode::BadRequest, message, false, OperationId::new())
            })?;
            authorize_host_channel(principal, &channel)?;
            let bootstrap = state
                .events
                .attach_bootstrap(request.subscription_id, &channel, 0)
                .map_err(|message| {
                    ErrorEnvelope::new(ErrorCode::BadRequest, message, false, OperationId::new())
                })?;
            let after_sequence = bootstrap.high_water_mark;
            subscriptions.insert(
                request.subscription_id,
                ActiveSubscription::HostEvent {
                    channel: channel.clone(),
                    after_sequence,
                },
            );
            let task_key =
                crate::patch_stream_task_key(&stream, &args).unwrap_or_else(|_| channel.clone());
            if let Err(error) = state
                .commands
                .execute_name(principal, command, OperationId::new(), args)
                .await
            {
                subscriptions.remove(&request.subscription_id);
                return Err(error);
            }
            patch_streams.track(request.subscription_id, task_key);
            Ok((
                bootstrap,
                ActiveSubscription::HostEvent {
                    channel,
                    after_sequence,
                },
            ))
        }
    }
}

fn authorize_host_channel(principal: &Principal, channel: &str) -> Result<(), ErrorEnvelope> {
    let Some(scope) = crate::HostEventBus::required_scope(channel) else {
        return Err(ErrorEnvelope::new(
            ErrorCode::NotFound,
            format!("host event channel `{channel}` is not registered"),
            false,
            OperationId::new(),
        ));
    };
    if !principal.allows(scope) {
        return Err(ErrorEnvelope::new(
            ErrorCode::Forbidden,
            format!("principal lacks {scope}"),
            false,
            OperationId::new(),
        ));
    }
    Ok(())
}

async fn send_message<S>(
    sender: &mut S,
    message: SubscriptionServerMessage,
    e2ee_key: Option<&[u8; 32]>,
) -> Result<(), ()>
where
    S: futures::Sink<Message> + Unpin,
{
    let text = serde_json::to_string(&message).map_err(|_| ())?;
    let wire_text = if let Some(key) = e2ee_key
        && let Ok(encrypted) =
            crate::e2ee::encrypt_payload(key, crate::e2ee::AAD_WS, text.as_bytes())
    {
        serde_json::json!({
            "type": "e2ee",
            "d": encrypted,
        })
        .to_string()
    } else {
        text
    };
    sender
        .send(Message::Text(wire_text.into()))
        .await
        .map_err(|_| ())
}

/// Live polling reuses `attach`, which parks `after_sequence == 0` events in
/// `snapshot` and leaves `replay` empty. A brand-new conversation attaches at
/// sequence 0 before any events exist; the first turn would then be captured
/// in a snapshot the poll loop never forwarded, and the cursor would skip it.
fn live_events(bootstrap: SubscriptionBootstrap) -> Vec<RemoteEvent> {
    if !bootstrap.replay.is_empty() {
        return bootstrap.replay;
    }
    bootstrap
        .snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.payload.get("events").cloned())
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}
