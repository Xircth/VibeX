use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
};

use application::{
    ApplicationCore, ApplicationError, CommandRegistry, ConversationRepository,
    ConversationSubscriptionRegistrar, RegisteredCommand,
};
use async_trait::async_trait;
use remote_protocol::{
    BULK_BUFFERED_HIGH_WATER_BYTES, BULK_CHUNK_MAX_BYTES, BulkChannelFrame, CommandResponse,
    ControlChannelFrame, ConversationId, ErrorCode, ErrorEnvelope, OperationId,
    SIGNALING_PIGGYBACK_MAX_BYTES, SignalingPiggybackEvents, SignalingResumeCursor,
    SubscriptionBootstrap, SubscriptionClientMessage, SubscriptionId, SubscriptionRequest,
    SubscriptionResource, SubscriptionServerMessage,
};
use serde_json::Value;
use sqlx::{Row, SqlitePool};

use crate::{AuthClock, AuthStoreError, AuthenticatedCredential, ServerAuth, SystemAuthClock};

pub const IDEMPOTENCY_TTL_SECONDS: i64 = 24 * 60 * 60;

#[derive(Clone)]
pub struct SqliteIdempotencyLedger {
    pool: SqlitePool,
    clock: Arc<dyn AuthClock>,
    ttl_seconds: i64,
}

impl SqliteIdempotencyLedger {
    pub fn new(pool: SqlitePool) -> Self {
        Self::with_clock(pool, Arc::new(SystemAuthClock))
    }

    pub fn with_clock(pool: SqlitePool, clock: Arc<dyn AuthClock>) -> Self {
        Self {
            pool,
            clock,
            ttl_seconds: IDEMPOTENCY_TTL_SECONDS,
        }
    }

    pub fn is_write_command(command: &str) -> bool {
        let Ok(registered) = command.parse::<RegisteredCommand>() else {
            return false;
        };
        let scope = registered.required_scope();
        matches!(
            scope,
            "conversation.write"
                | "conversation.permission"
                | "conversation.question"
                | "conversation.cancel"
                | "conversation.steer"
                | "workflow.write"
                | "workflow.run"
                | "workflow.approve"
                | "automation.write"
                | "delegation.cancel"
                | "plugin.write"
        )
    }

    pub async fn lookup(
        &self,
        credential_id: &str,
        operation_id: OperationId,
        command: &str,
    ) -> Result<Option<CommandResponse<Value>>, sqlx::Error> {
        let now = self.clock.unix_seconds();
        let Some(row) = sqlx::query(
            "SELECT response_json
             FROM companion_idempotency_ledger
             WHERE credential_id = ? AND operation_id = ? AND command = ? AND expires_at_unix > ?
             LIMIT 1",
        )
        .bind(credential_id)
        .bind(operation_id.to_string())
        .bind(command)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?
        else {
            return Ok(None);
        };
        let response_json: String = row.try_get("response_json")?;
        let response: CommandResponse<Value> = serde_json::from_str(&response_json)
            .map_err(|err| sqlx::Error::Protocol(format!("invalid idempotency response: {err}")))?;
        Ok(Some(response))
    }

    pub async fn record(
        &self,
        credential_id: &str,
        operation_id: OperationId,
        command: &str,
        response: &CommandResponse<Value>,
    ) -> Result<(), sqlx::Error> {
        let now = self.clock.unix_seconds();
        let expires_at = now.saturating_add(self.ttl_seconds);
        let serialized = serde_json::to_string(response)
            .map_err(|err| sqlx::Error::Protocol(format!("serialize idempotency: {err}")))?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("DELETE FROM companion_idempotency_ledger WHERE expires_at_unix <= ?")
            .bind(now)
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT OR REPLACE INTO companion_idempotency_ledger
             (credential_id, operation_id, command, response_json, created_at_unix, expires_at_unix)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(credential_id)
        .bind(operation_id.to_string())
        .bind(command)
        .bind(serialized)
        .bind(now)
        .bind(expires_at)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TransportSessionTelemetry {
    pub replayed_events_count: u64,
    pub idempotency_hit_count: u64,
    pub last_rtt_ms: Option<i64>,
}

/// Abstract WebRTC PeerConnection engine trait (Section 3.1 & 7.1) decoupling
/// Host business logic from the underlying ICE/DTLS/SCTP implementation
/// (`libdatachannel` / `str0m`).
#[async_trait]
pub trait RtcPeerEngine: Send + Sync {
    async fn create_answer(&self, offer_sdp: &str) -> Result<(String, String), ErrorEnvelope>;

    async fn add_ice_candidate(&self, candidate_sdp: &str) -> Result<(), ErrorEnvelope>;

    async fn close(&self);
}

struct SessionPollingRegistrar;

#[async_trait]
impl ConversationSubscriptionRegistrar for SessionPollingRegistrar {
    async fn register(
        &self,
        _subscription_id: SubscriptionId,
        _conversation_id: ConversationId,
    ) -> Result<(), ApplicationError> {
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SessionSubscription {
    Conversation {
        conversation_id: ConversationId,
        after_sequence: i64,
    },
    WorkflowRun {
        run_id: uuid::Uuid,
        after_sequence: i64,
    },
}

/// Unified transport session shared by WebRTC DataChannels (`vibex.control.v1`
/// + `vibex.bulk.v1`) and local adapters.
pub struct TransportSession<R> {
    credential: AuthenticatedCredential,
    auth: Arc<dyn ServerAuth>,
    core: Arc<ApplicationCore<R>>,
    commands: CommandRegistry<R>,
    ledger: SqliteIdempotencyLedger,
    subscriptions: HashMap<SubscriptionId, SessionSubscription>,
    bulk_queue: VecDeque<BulkChannelFrame>,
    suspended: bool,
    telemetry: TransportSessionTelemetry,
}

impl<R> TransportSession<R>
where
    R: ConversationRepository + Send + Sync + 'static,
{
    pub fn new(
        credential: AuthenticatedCredential,
        auth: Arc<dyn ServerAuth>,
        core: Arc<ApplicationCore<R>>,
        ledger: SqliteIdempotencyLedger,
    ) -> Self {
        let commands = CommandRegistry::from_core(Arc::clone(&core));
        Self {
            credential,
            auth,
            core,
            commands,
            ledger,
            subscriptions: HashMap::new(),
            bulk_queue: VecDeque::new(),
            suspended: false,
            telemetry: TransportSessionTelemetry::default(),
        }
    }

    pub const fn telemetry(&self) -> TransportSessionTelemetry {
        self.telemetry
    }

    pub const fn is_suspended(&self) -> bool {
        self.suspended
    }

    pub async fn handle_control_frame(
        &mut self,
        frame: ControlChannelFrame,
    ) -> Result<Vec<ControlChannelFrame>, AuthStoreError> {
        if !self.auth.is_active(&self.credential).await? {
            let op_id = match &frame {
                ControlChannelFrame::RpcRequest { operation_id, .. } => *operation_id,
                _ => OperationId::new(),
            };
            return Ok(vec![ControlChannelFrame::RpcError {
                operation_id: op_id,
                status: 401,
                error: ErrorEnvelope::new(
                    ErrorCode::Unauthorized,
                    "credential has been revoked",
                    false,
                    op_id,
                ),
            }]);
        }

        self.suspended = false;
        match frame {
            ControlChannelFrame::RpcRequest {
                operation_id,
                command,
                args,
            } => {
                if SqliteIdempotencyLedger::is_write_command(&command)
                    && let Some(cached) = self
                        .ledger
                        .lookup(&self.credential.credential_id, operation_id, &command)
                        .await?
                {
                    self.telemetry.idempotency_hit_count += 1;
                    return Ok(vec![ControlChannelFrame::from_command_response(
                        200, cached,
                    )]);
                }

                let principal = self.credential.principal();
                match self
                    .commands
                    .execute_name(&principal, &command, operation_id, args)
                    .await
                {
                    Ok(response) => {
                        if SqliteIdempotencyLedger::is_write_command(&command) {
                            self.ledger
                                .record(
                                    &self.credential.credential_id,
                                    operation_id,
                                    &command,
                                    &response,
                                )
                                .await?;
                        }
                        Ok(vec![ControlChannelFrame::from_command_response(
                            200, response,
                        )])
                    }
                    Err(error) => Ok(vec![ControlChannelFrame::RpcError {
                        operation_id,
                        status: status_code_for_error(error.code),
                        error,
                    }]),
                }
            }
            ControlChannelFrame::SubClient { payload } => {
                Ok(self.handle_subscription_message(payload).await)
            }
            ControlChannelFrame::Ping { timestamp_ms } => {
                Ok(vec![ControlChannelFrame::Pong { timestamp_ms }])
            }
            ControlChannelFrame::Pong { timestamp_ms } => {
                self.telemetry.last_rtt_ms = Some(timestamp_ms.max(0));
                Ok(Vec::new())
            }
            ControlChannelFrame::Suspend => {
                self.subscriptions.clear();
                self.suspended = true;
                Ok(Vec::new())
            }
            ControlChannelFrame::RpcResponse { .. }
            | ControlChannelFrame::RpcError { .. }
            | ControlChannelFrame::SubServer { .. } => Ok(Vec::new()),
        }
    }

    async fn handle_subscription_message(
        &mut self,
        message: SubscriptionClientMessage,
    ) -> Vec<ControlChannelFrame> {
        let principal = self.credential.principal();
        match message {
            SubscriptionClientMessage::Ping => vec![ControlChannelFrame::SubServer {
                payload: SubscriptionServerMessage::Pong,
            }],
            SubscriptionClientMessage::Detach { subscription_id } => {
                self.subscriptions.remove(&subscription_id);
                vec![ControlChannelFrame::SubServer {
                    payload: SubscriptionServerMessage::Detached {
                        subscription_id,
                        reason: "client_detached".to_owned(),
                    },
                }]
            }
            SubscriptionClientMessage::Attach {
                request:
                    SubscriptionRequest {
                        subscription_id,
                        resource,
                    },
            } => match resource {
                SubscriptionResource::Conversation {
                    conversation_id,
                    after_sequence,
                } => match self
                    .core
                    .attach_conversation(
                        &principal,
                        subscription_id,
                        conversation_id,
                        after_sequence,
                        &SessionPollingRegistrar,
                    )
                    .await
                {
                    Ok(bootstrap) => {
                        self.telemetry.replayed_events_count += bootstrap.replay.len() as u64;
                        self.subscriptions.insert(
                            subscription_id,
                            SessionSubscription::Conversation {
                                conversation_id,
                                after_sequence: bootstrap.high_water_mark,
                            },
                        );
                        bootstrap_to_control_frames(bootstrap)
                    }
                    Err(error) => vec![ControlChannelFrame::SubServer {
                        payload: SubscriptionServerMessage::Error {
                            error: error.into_envelope(),
                            subscription_id: Some(subscription_id),
                        },
                    }],
                },
                SubscriptionResource::WorkflowRun {
                    run_id,
                    after_sequence,
                } => match self
                    .core
                    .attach_workflow_run(&principal, subscription_id, run_id, after_sequence)
                    .await
                {
                    Ok(bootstrap) => {
                        self.telemetry.replayed_events_count += bootstrap.replay.len() as u64;
                        self.subscriptions.insert(
                            subscription_id,
                            SessionSubscription::WorkflowRun {
                                run_id,
                                after_sequence: bootstrap.high_water_mark,
                            },
                        );
                        bootstrap_to_control_frames(bootstrap)
                    }
                    Err(error) => vec![ControlChannelFrame::SubServer {
                        payload: SubscriptionServerMessage::Error {
                            error: error.into_envelope(),
                            subscription_id: Some(subscription_id),
                        },
                    }],
                },
                SubscriptionResource::HostEvent { .. }
                | SubscriptionResource::PatchStream { .. } => {
                    vec![ControlChannelFrame::SubServer {
                        payload: SubscriptionServerMessage::Ready { subscription_id },
                    }]
                }
            },
        }
    }

    /// Builds an optional Signaling Piggyback payload (`<= 32KB`) for a mobile
    /// client resuming from background (Section 6.3 Scenario 4).
    pub async fn build_signaling_piggyback(
        &mut self,
        cursor: &SignalingResumeCursor,
    ) -> Result<Option<SignalingPiggybackEvents>, ApplicationError> {
        let principal = self.credential.principal();
        let bootstrap = self
            .core
            .attach_conversation(
                &principal,
                SubscriptionId::new(),
                cursor.conversation_id,
                cursor.after_sequence,
                &SessionPollingRegistrar,
            )
            .await?;
        let candidate = SignalingPiggybackEvents {
            conversation_id: cursor.conversation_id,
            events: bootstrap.replay,
            high_water_mark: bootstrap.high_water_mark,
        };
        let encoded = serde_json::to_vec(&candidate)
            .map_err(|err| ApplicationError::internal(err.to_string()))?;
        if encoded.len() <= SIGNALING_PIGGYBACK_MAX_BYTES {
            self.telemetry.replayed_events_count += candidate.events.len() as u64;
            Ok(Some(candidate))
        } else {
            Ok(None)
        }
    }

    /// Enqueues a large payload onto the `vibex.bulk.v1` outbox split into `32KB` chunks.
    pub fn enqueue_bulk_payload(
        &mut self,
        operation_id: OperationId,
        content_type: impl Into<String>,
        payload: &[u8],
    ) {
        let frames = BulkChannelFrame::chunk_payload(
            operation_id,
            content_type,
            payload,
            BULK_CHUNK_MAX_BYTES,
        );
        self.bulk_queue.extend(frames);
    }

    /// Drains queued `vibex.bulk.v1` frames while enforcing the `128KB`
    /// (`BULK_BUFFERED_HIGH_WATER_BYTES`) SCTP bufferedAmount backpressure ceiling.
    pub fn drain_bulk_frames(
        &mut self,
        buffered_amount_bytes: &mut usize,
    ) -> Vec<BulkChannelFrame> {
        let mut out = Vec::new();
        while *buffered_amount_bytes <= BULK_BUFFERED_HIGH_WATER_BYTES {
            let Some(frame) = self.bulk_queue.pop_front() else {
                break;
            };
            let approx_bytes = match &frame {
                BulkChannelFrame::BulkChunk { data_base64, .. } => data_base64.len(),
                _ => 128,
            };
            *buffered_amount_bytes = buffered_amount_bytes.saturating_add(approx_bytes);
            out.push(frame);
        }
        out
    }

    /// Processes an inbound `vibex.bulk.v1` control frame such as `bulk_cancel`.
    pub fn handle_bulk_frame(&mut self, frame: BulkChannelFrame) {
        if let BulkChannelFrame::BulkCancel { operation_id } = frame {
            self.bulk_queue.retain(|queued| match queued {
                BulkChannelFrame::BulkStart {
                    operation_id: id, ..
                }
                | BulkChannelFrame::BulkChunk {
                    operation_id: id, ..
                }
                | BulkChannelFrame::BulkEnd { operation_id: id }
                | BulkChannelFrame::BulkCancel { operation_id: id } => *id != operation_id,
            });
        }
    }
}

fn bootstrap_to_control_frames(bootstrap: SubscriptionBootstrap) -> Vec<ControlChannelFrame> {
    let mut frames = Vec::with_capacity(bootstrap.replay.len() + 3);
    frames.push(ControlChannelFrame::SubServer {
        payload: SubscriptionServerMessage::Ready {
            subscription_id: bootstrap.subscription_id,
        },
    });
    if let Some(snapshot) = bootstrap.snapshot {
        frames.push(ControlChannelFrame::SubServer {
            payload: SubscriptionServerMessage::Snapshot {
                subscription_id: bootstrap.subscription_id,
                snapshot,
            },
        });
    }
    for event in bootstrap.replay {
        frames.push(ControlChannelFrame::SubServer {
            payload: SubscriptionServerMessage::Event {
                subscription_id: bootstrap.subscription_id,
                event,
            },
        });
    }
    frames.push(ControlChannelFrame::SubServer {
        payload: SubscriptionServerMessage::Live {
            subscription_id: bootstrap.subscription_id,
            high_water_mark: bootstrap.high_water_mark,
        },
    });
    frames
}

fn status_code_for_error(code: ErrorCode) -> u16 {
    match code {
        ErrorCode::BadRequest => 400,
        ErrorCode::Unauthorized => 401,
        ErrorCode::Forbidden => 403,
        ErrorCode::NotFound => 404,
        ErrorCode::Conflict => 409,
        ErrorCode::CapabilityUnavailable => 501,
        ErrorCode::Internal => 500,
        _ => 500,
    }
}
