use remote_protocol::{
    NotificationOutcome, NotificationSource, OperationId, TerminalNotificationSummary,
};

pub struct TerminalNotificationEvidence {
    pub source: NotificationSource,
    pub outcome: NotificationOutcome,
    pub occurred_at: String,
    pub operation_id: OperationId,
    /// Private execution context is accepted at the projection boundary so
    /// callers cannot accidentally bypass the redaction policy.
    pub private_detail: Option<String>,
}

pub struct NotificationProjector;

impl NotificationProjector {
    pub fn project(evidence: TerminalNotificationEvidence) -> TerminalNotificationSummary {
        let TerminalNotificationEvidence {
            source,
            outcome,
            occurred_at,
            operation_id,
            private_detail: _,
        } = evidence;
        TerminalNotificationSummary {
            source,
            outcome,
            occurred_at,
            operation_id,
        }
    }
}
