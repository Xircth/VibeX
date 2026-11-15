use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum EventSourceKind {
    Feishu,
    Jira,
    Github,
    WebhookStandard,
    WebhookCustom,
    TimeCron,
    TimeOnce,
    TimeInterval,
    TimeSla,
    SdkCustom,
    SystemInternal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum EventTrustLevel {
    TrustedHuman,
    TrustedInternal,
    VerifiedExternal,
    UntrustedExternal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct EventSourceMeta {
    pub kind: EventSourceKind,
    pub instance_id: String,
    pub trust_level: EventTrustLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct EventActor {
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub roles: Vec<String>,
    #[serde(default)]
    pub is_bot: bool,
    #[serde(default)]
    pub is_self: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ReplyChannelAddress {
    pub source_kind: EventSourceKind,
    pub instance_id: String,
    pub channel_id: String,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct EventTrace {
    pub root_event_id: String,
    #[serde(default)]
    pub parent_run_id: Option<String>,
    #[serde(default)]
    pub hop_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct EventEnvelope {
    pub event_id: String,
    pub delivery_id: String,
    pub source: EventSourceMeta,
    pub event_type: String,
    pub occurred_at: String,
    pub actor: EventActor,
    #[serde(default)]
    pub thread_key: Option<String>,
    #[serde(default)]
    pub correlations: Vec<String>,
    #[serde(default)]
    pub reply_channels: Vec<ReplyChannelAddress>,
    pub trace: EventTrace,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum PulseEvalMode {
    Off,
    #[default]
    Observe,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum MandateOrigin {
    ExplicitHuman,
    TrustedInternal,
    UntrustedExternal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "snake_case")]
#[ts(export)]
pub enum GateFilterCondition {
    Eq { pointer: String, value: serde_json::Value },
    Neq { pointer: String, value: serde_json::Value },
    Lt { pointer: String, value: f64 },
    Lte { pointer: String, value: f64 },
    Gt { pointer: String, value: f64 },
    Gte { pointer: String, value: f64 },
    Contains { pointer: String, needle: String },
    InSet { pointer: String, values: Vec<serde_json::Value> },
    Exists { pointer: String },
    Regex { pointer: String, pattern: String },
    NotBotActor,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct GateFilterAst {
    #[serde(default)]
    pub source_kinds: Vec<EventSourceKind>,
    #[serde(default)]
    pub source_instance_ids: Vec<String>,
    #[serde(default)]
    pub event_types: Vec<String>,
    #[serde(default)]
    pub allowed_actors: Vec<String>,
    #[serde(default)]
    pub conditions: Vec<GateFilterCondition>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum SessionTargetMode {
    #[default]
    EphemeralFresh,
    ThreadKeyed,
    ExistingSession,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum PulseWorkspaceIsolation {
    #[default]
    IsolatedWorktree,
    ProjectRoot,
    Scratch,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum SessionDeliveryStrategy {
    #[default]
    Queue,
    Steer,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum BotConversationScope {
    #[default]
    FixedPrimary,
    PerThreadTopic,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum BotMailboxPolicy {
    #[default]
    FifoSerial,
    CoalesceBatch,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum GroupMentionOrder {
    #[default]
    Parallel,
    Sequential,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export)]
pub enum GroupDispatchMode {
    SpecificSeat {
        #[serde(rename = "memberId")]
        member_id: String,
    },
    MentionSeats {
        #[serde(rename = "memberIds")]
        member_id_list: Vec<String>,
        #[serde(default)]
        order: GroupMentionOrder,
    },
    ModeratorTriage {
        #[serde(rename = "moderatorMemberId")]
        moderator_member_id: String,
    },
    BroadcastLogOnly,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum UserInteractionKind {
    #[default]
    Notify,
    Approval,
    AskForm,
    Digest,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum UserInteractionSeverity {
    #[default]
    Info,
    Warning,
    Urgent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct ApprovalOptionSpec {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub destructive: bool,
    #[serde(default)]
    pub require_note: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum PulseTargetSpec {
    #[serde(rename_all = "camelCase")]
    Session {
        mode: SessionTargetMode,
        agent_id: String,
        #[serde(default)]
        model_override: Option<String>,
        #[serde(default)]
        workspace_isolation: PulseWorkspaceIsolation,
        #[serde(default)]
        project_id: Option<String>,
        #[serde(default)]
        existing_session_id: Option<String>,
        #[serde(default)]
        delivery_strategy: SessionDeliveryStrategy,
        #[serde(default)]
        subscribe_thread: bool,
        prompt_template: String,
    },
    #[serde(rename_all = "camelCase")]
    Bot {
        member_id: String,
        #[serde(default)]
        conversation_scope: BotConversationScope,
        #[serde(default)]
        mailbox_policy: BotMailboxPolicy,
        #[serde(default)]
        subscribe_thread: bool,
        prompt_template: String,
    },
    #[serde(rename_all = "camelCase")]
    Group {
        space_id: String,
        dispatch_mode: GroupDispatchMode,
        message_template: String,
    },
    #[serde(rename_all = "camelCase")]
    User {
        interaction_kind: UserInteractionKind,
        #[serde(default)]
        severity: UserInteractionSeverity,
        title_template: String,
        body_template: String,
        #[serde(default)]
        mirror_to_channels: Vec<String>,
        #[serde(default)]
        approval_options: Vec<ApprovalOptionSpec>,
        #[serde(default)]
        form_schema: Option<serde_json::Value>,
        #[serde(default)]
        sla_timeout_seconds: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Workflow {
        workflow_id: String,
        pinned_version: u32,
        #[serde(default)]
        input_mapping: BTreeMap<String, String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum PulseTemporalSpec {
    #[serde(rename_all = "camelCase")]
    Cron {
        expression: String,
        timezone: String,
        #[serde(default)]
        weekdays_only: bool,
        #[serde(default)]
        catch_up_once: bool,
    },
    #[serde(rename_all = "camelCase")]
    Once {
        fire_at: String,
    },
    #[serde(rename_all = "camelCase")]
    Interval {
        every_seconds: u32,
        #[serde(default)]
        skip_if_busy: bool,
    },
    #[serde(rename_all = "camelCase")]
    InactivitySla {
        thread_key_prefix: String,
        timeout_seconds: u32,
        #[serde(default)]
        expected_event_types: Vec<String>,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum PresetOrchestratorKind {
    #[default]
    DirectReflex,
    SuperagentRouter,
    HybridPipeline,
    EventSaga,
    WindowAggregator,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct PulseRuleSpec {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub eval_mode: PulseEvalMode,
    #[serde(default)]
    pub orchestrator: PresetOrchestratorKind,
    pub filter: GateFilterAst,
    #[serde(default)]
    pub temporal: Option<PulseTemporalSpec>,
    #[serde(default)]
    pub debounce_ms: u32,
    #[serde(default)]
    pub claim_exclusive: bool,
    pub targets: Vec<PulseTargetSpec>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct PulseRuleView {
    pub id: String,
    pub revision: u32,
    pub enabled: bool,
    pub draft_only: bool,
    pub mandate_origin: MandateOrigin,
    pub spec: PulseRuleSpec,
    #[serde(default)]
    pub webhook_route_id: Option<String>,
    #[serde(default)]
    pub next_fire_at: Option<String>,
    pub matched_count: u64,
    pub observed_count: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct PulseDryRunViolation {
    pub path: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct PulseDryRunReport {
    pub valid: bool,
    pub matched: bool,
    #[serde(default)]
    pub violations: Vec<PulseDryRunViolation>,
    #[serde(default)]
    pub unmatched_conditions: Vec<usize>,
    #[serde(default)]
    pub rendered_previews: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct PulseSourceView {
    pub id: String,
    pub kind: EventSourceKind,
    pub title: String,
    pub enabled: bool,
    pub healthy: bool,
    #[serde(default)]
    pub status_message: Option<String>,
    #[serde(default)]
    pub cursor_watermark: Option<String>,
    #[serde(default)]
    pub public_webhook_path: Option<String>,
    pub received_count_24h: u64,
    pub rejected_count_24h: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct PulseObservedCandidateView {
    pub id: String,
    pub rule_id: String,
    pub rule_name: String,
    pub event_id: String,
    pub event_type: String,
    pub source_kind: EventSourceKind,
    #[serde(default)]
    pub thread_key: Option<String>,
    pub summary: String,
    pub occurred_at: String,
    pub promoted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct PulseUserInteractionView {
    pub id: String,
    pub rule_id: Option<String>,
    pub workflow_run_id: Option<String>,
    pub step_id: Option<String>,
    pub kind: UserInteractionKind,
    pub severity: UserInteractionSeverity,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub approval_options: Vec<ApprovalOptionSpec>,
    #[serde(default)]
    pub form_schema: Option<serde_json::Value>,
    pub status: String,
    pub created_at: String,
    #[serde(default)]
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct PulseSubscriptionView {
    pub id: String,
    pub thread_key: String,
    pub subscriber_kind: String,
    pub subscriber_id: String,
    pub active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct PulseEventSchemaView {
    pub event_type: String,
    pub summary: String,
    pub json_schema: serde_json::Value,
    pub built_in: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename_all = "camelCase")]
pub struct PulseDeckSnapshot {
    pub engine_active: bool,
    pub active_ticket_count: u32,
    pub pending_user_interaction_count: u32,
    pub sources: Vec<PulseSourceView>,
    pub rules: Vec<PulseRuleView>,
    pub observed_candidates: Vec<PulseObservedCandidateView>,
    pub subscriptions: Vec<PulseSubscriptionView>,
    pub pending_interactions: Vec<PulseUserInteractionView>,
}
