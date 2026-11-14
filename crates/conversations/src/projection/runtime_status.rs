use agents::{
    conversation::{ConversationEvent, ConversationSessionNotice, ConversationTimelineRow},
    request_status::{
        ConversationConnectionStatus, ConversationRequestStatus, RequestActivity, RequestPhase,
    },
};
use db::models::conversation_event::ConversationEventRecord;

use super::{ProjectionFold, cache::upsert_stable_notice};

pub const CONNECTION_STATUS_ROW_ID: &str = "status:agent-connection";
pub const REQUEST_STATUS_ROW_ID: &str = "status:agent-request";

impl ProjectionFold {
    pub(super) fn apply_runtime_status(
        &mut self,
        record: &ConversationEventRecord,
        event: &ConversationEvent,
    ) {
        if let ConversationEvent::AgentConnectionStatusChanged {
            status,
            message,
            bound,
        } = event
        {
            if self.side_rows.iter().any(|row| {
                row.row_id == CONNECTION_STATUS_ROW_ID && row.revision >= record.sequence
            }) {
                return;
            }
            let bound = *bound || (*status == agents::conversation::ConversationAgentConnectionStatus::Ready && self.side_rows.iter().any(|row| {
                matches!(&row.row, ConversationTimelineRow::SessionNotice { notice } if notice.connection_status.as_ref().is_some_and(|previous|
                    previous.bound && previous.connection_id == record.connection_id))
            }));
            upsert_stable_notice(
                &mut self.side_rows,
                CONNECTION_STATUS_ROW_ID,
                record.sequence,
                ConversationSessionNotice {
                    title: "Agent connection".into(),
                    severity: "info".into(),
                    connection_status: Some(ConversationConnectionStatus {
                        status: status.clone(),
                        bound,
                        connection_id: record.connection_id.clone(),
                        message: message.clone(),
                        since: record.created_at,
                    }),
                    ..Default::default()
                },
            );
        }
        let activity = match event {
            ConversationEvent::UserTurnCreated { .. } | ConversationEvent::UserTurnQueued => {
                RequestActivity::phase(RequestPhase::Submitting)
            }
            ConversationEvent::UserTurnStarted => RequestActivity::phase(RequestPhase::Submitting),
            ConversationEvent::RequestActivityChanged { activity } => activity.clone(),
            ConversationEvent::TurnCompleted { .. } => {
                RequestActivity::phase(RequestPhase::Completed)
            }
            ConversationEvent::TurnFailed { .. } => RequestActivity::phase(RequestPhase::Failed),
            ConversationEvent::TurnCancelled { .. } => {
                RequestActivity::phase(RequestPhase::Cancelled)
            }
            ConversationEvent::TurnInterrupted { .. } => {
                RequestActivity::phase(RequestPhase::Interrupted)
            }
            _ => return,
        };
        let Some(turn_id) = record.turn_id else {
            return;
        };
        let previous = self.side_rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::SessionNotice { notice }
                if row.row_id == REQUEST_STATUS_ROW_ID =>
            {
                notice.request_status.as_ref()
            }
            _ => None,
        });
        if let Some(previous) = previous {
            if previous.turn_id == turn_id
                && previous.connection_id.is_some()
                && record.connection_id.is_some()
                && previous.connection_id != record.connection_id
            {
                return;
            }
            if previous.turn_id == turn_id
                && (previous.activity.phase.is_terminal()
                    || (previous.activity.phase == RequestPhase::Cancelling
                        && !activity.phase.is_terminal()
                        && activity.phase != RequestPhase::Cancelling))
            {
                return;
            }
            if previous.turn_id != turn_id
                && !matches!(event, ConversationEvent::UserTurnStarted)
                && !(previous.activity.phase.is_terminal()
                    && matches!(event, ConversationEvent::UserTurnCreated { .. }))
            {
                return;
            }
        }
        upsert_stable_notice(
            &mut self.side_rows,
            REQUEST_STATUS_ROW_ID,
            record.sequence,
            ConversationSessionNotice {
                title: "Agent request".into(),
                severity: "info".into(),
                request_status: Some(ConversationRequestStatus {
                    turn_id,
                    prompt_id: record.prompt_id.clone(),
                    connection_id: record.connection_id.clone(),
                    activity,
                    since: record.created_at,
                }),
                ..Default::default()
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;
    use crate::projection::{ConversationProjector, rows::tests::diagnostic_record};
    fn request(events: Vec<(Uuid, ConversationEvent)>) -> ConversationRequestStatus {
        let conversation = Uuid::new_v4();
        let records: Vec<_> = events
            .into_iter()
            .enumerate()
            .map(|(i, (turn, event))| {
                let mut record = diagnostic_record(conversation, i as i64 + 1, &event);
                record.turn_id = Some(turn);
                record.prompt_id = Some(turn.to_string());
                record
            })
            .collect();
        let timeline = ConversationProjector::project_records(conversation, &records).unwrap();
        timeline
            .rows
            .into_iter()
            .find_map(|row| match row.row {
                ConversationTimelineRow::SessionNotice { notice } => notice.request_status,
                _ => None,
            })
            .unwrap()
    }
    #[test]
    fn retry_updates_one_request_and_content_exits_retry() {
        let turn = Uuid::new_v4();
        let retry = |attempt| ConversationEvent::RequestActivityChanged {
            activity: RequestActivity {
                phase: RequestPhase::Retrying,
                retry: Some(agents::request_status::RequestRetry {
                    attempt: Some(attempt),
                    max_attempts: Some(5),
                    delay_ms: None,
                    reason: Some("provider unavailable".into()),
                    code: None,
                }),
            },
        };
        let status = request(vec![
            (turn, ConversationEvent::UserTurnStarted),
            (turn, retry(1)),
            (turn, retry(2)),
        ]);
        assert_eq!(status.activity.retry.unwrap().attempt, Some(2));
        let status = request(vec![
            (turn, ConversationEvent::UserTurnStarted),
            (turn, retry(1)),
            (
                turn,
                ConversationEvent::RequestActivityChanged {
                    activity: RequestActivity::phase(RequestPhase::Responding),
                },
            ),
        ]);
        assert_eq!(status.activity.phase, RequestPhase::Responding);
        assert!(status.activity.retry.is_none());
    }
    #[test]
    fn terminal_and_cancellation_cannot_reopen_or_be_overwritten_by_old_turn() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let activity = |phase| ConversationEvent::RequestActivityChanged {
            activity: RequestActivity::phase(phase),
        };
        let status = request(vec![
            (a, ConversationEvent::UserTurnStarted),
            (a, activity(RequestPhase::Cancelling)),
            (a, activity(RequestPhase::Responding)),
        ]);
        assert_eq!(status.activity.phase, RequestPhase::Cancelling);
        let status = request(vec![
            (a, ConversationEvent::UserTurnStarted),
            (a, ConversationEvent::TurnCancelled { reason: None }),
            (a, activity(RequestPhase::Responding)),
            (b, ConversationEvent::UserTurnStarted),
            (a, activity(RequestPhase::Retrying)),
        ]);
        assert_eq!(status.turn_id, b);
        assert_eq!(status.activity.phase, RequestPhase::Submitting);
    }
}
