use agents::{
    AgentPermissionResponse,
    conversation::{
        ConversationAgentConnectionStatus, ConversationDelegationResult,
        ConversationDelegationView, ConversationError, ConversationErrorView, ConversationEvent,
        ConversationPermissionView, ConversationRowOp, ConversationSessionNotice,
        ConversationTerminalView, ConversationTimelineRow, MessageTurn, SessionLoadFailureReason,
        SessionRecoveryStrategy, TimelineRow, TurnRole,
    },
};
use db::models::conversation_event::ConversationEventRecord;
use uuid::Uuid;

use super::{
    AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID, AGENT_BINDING_REBIND_NOTICE_ROW_ID,
    AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID, AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID,
    ANNOUNCEMENT_ROW_PREFIX, AUTO_PERMISSION_NOTICE_ROW_ID, AUTO_PERMISSION_NOTICE_TITLE,
    CURRENT_EVENT_VERSION, ProjectionFold,
    cache::{remove_side_row, upsert_stable_notice},
    fold::ProjectedTurn,
};

impl ProjectionFold {
    pub(super) fn apply_unknown_event_notice(
        &mut self,
        record: &ConversationEventRecord,
        kind: &str,
    ) -> Vec<ConversationRowOp> {
        tracing::warn!(
            event_kind = %kind,
            sequence = record.sequence,
            "conversation event not renderable by this build; showing placeholder row"
        );
        let notice = if record.event_version > CURRENT_EVENT_VERSION {
            ConversationSessionNotice {
                        title: "此会话包含较新版本的记录".into(),
                        message: Some(
                            "当前版本暂时无法显示其中一条记录，其余会话内容不受影响。更新 Dimo 后可再次查看。"
                                .into(),
                        ),
                        severity: "warning".into(),
                        ..Default::default()
                    }
        } else {
            ConversationSessionNotice {
                title: "部分会话记录无法显示".into(),
                message: Some("Dimo 无法读取其中一条历史记录，其余会话内容不受影响。".into()),
                severity: "warning".into(),
                ..Default::default()
            }
        };
        let row = side_row(
            record.sequence,
            ConversationTimelineRow::SessionNotice { notice },
        );
        let op = ConversationRowOp::Upsert { row: row.clone() };
        self.side_rows.push(row);
        vec![op]
    }

    pub(super) fn apply_side_row_event(
        &mut self,
        record: &ConversationEventRecord,
        event: ConversationEvent,
        deleted_rows: &mut Vec<ConversationRowOp>,
        touched_turn_rows: &mut Option<super::cache::TouchedTurnRows>,
        assistant_emit: &mut Option<super::cache::AssistantEmit>,
    ) {
        let latest_turn_id = record.turn_id.or_else(|| self.turn_order.last().copied());
        let side_rows = &mut self.side_rows;
        let side_row_turns = &mut self.side_row_turns;
        let auto_permission_approvals = &mut self.auto_permission_approvals;
        match event {
            ConversationEvent::PermissionRequested { request } => {
                let row = side_row(
                    record.sequence,
                    ConversationTimelineRow::PermissionRequest {
                        request: ConversationPermissionView {
                            permission_id: request.permission_id,
                            title: Some(request.request.title),
                            status: "pending".into(),
                            details: request.request.details,
                            options: request.request.options,
                            revision: (request.request.revision > 0)
                                .then_some(request.request.revision),
                        },
                    },
                );
                if let Some(tid) = record.turn_id {
                    side_row_turns.insert(row.row_id.clone(), tid);
                }
                side_rows.push(row);
            }
            ConversationEvent::PermissionResponded {
                permission_id,
                response,
            } => {
                let auto_allow = response.auto
                    && matches!(response.response, AgentPermissionResponse::Selected { .. });
                let mut denied_tool_call_id: Option<String> = None;
                if auto_allow {
                    let row_id = format!("perm:{permission_id}");
                    side_row_turns.remove(&row_id);
                    remove_side_row(side_rows, deleted_rows, &row_id, record.sequence);
                    *auto_permission_approvals = auto_permission_approvals.saturating_add(1);
                    upsert_stable_notice(
                        side_rows,
                        AUTO_PERMISSION_NOTICE_ROW_ID,
                        record.sequence,
                        auto_permission_notice(*auto_permission_approvals),
                    );
                } else {
                    for entry in side_rows.iter_mut() {
                        if let ConversationTimelineRow::PermissionRequest { request } =
                            &mut entry.row
                            && request.permission_id == permission_id
                        {
                            request.status = "responded".into();
                            entry.revision = record.sequence;
                            if permission_response_is_rejection(&response, &request.options) {
                                denied_tool_call_id = extract_permission_tool_call_id(
                                    request.details.as_ref(),
                                    &permission_id,
                                );
                            }
                            break;
                        }
                    }
                }
                if let Some(call_id) = denied_tool_call_id {
                    self.denied_tool_calls.insert(call_id.clone());
                    if let Some((turn_id, emit)) =
                        self.apply_denied_status_to_existing_tool_call(&call_id, record)
                    {
                        *touched_turn_rows =
                            Some(super::cache::TouchedTurnRows::AssistantOnly(turn_id));
                        *assistant_emit = Some(emit);
                    }
                }
            }
            ConversationEvent::QuestionRequested { request } => {
                let row = side_row(
                    record.sequence,
                    ConversationTimelineRow::QuestionRequest {
                        request,
                        response: None,
                    },
                );
                if let Some(tid) = record.turn_id {
                    side_row_turns.insert(row.row_id.clone(), tid);
                }
                side_rows.push(row);
            }
            ConversationEvent::QuestionResponded {
                question_id,
                response,
            } => {
                for entry in side_rows.iter_mut() {
                    if let ConversationTimelineRow::QuestionRequest {
                        request,
                        response: slot,
                    } = &mut entry.row
                        && request.question_id == question_id
                    {
                        *slot = Some(response);
                        entry.revision = record.sequence;
                        break;
                    }
                }
            }
            ConversationEvent::FeedbackRequested { request } => {
                let row = side_row(
                    record.sequence,
                    ConversationTimelineRow::FeedbackRequest {
                        request,
                        response: None,
                    },
                );
                if let Some(tid) = record.turn_id {
                    side_row_turns.insert(row.row_id.clone(), tid);
                }
                side_rows.push(row);
            }
            ConversationEvent::FeedbackSubmitted {
                feedback_id,
                response,
            } => {
                for entry in side_rows.iter_mut() {
                    if let ConversationTimelineRow::FeedbackRequest {
                        request,
                        response: slot,
                    } = &mut entry.row
                        && request.feedback_id == feedback_id
                    {
                        *slot = Some(response);
                        entry.revision = record.sequence;
                        break;
                    }
                }
            }
            ConversationEvent::TerminalUpdated { terminal } => {
                let view = ConversationTerminalView {
                    terminal_id: terminal.terminal_id.clone(),
                    command: terminal.command,
                    status: terminal.status,
                    output_summary: terminal.output_summary,
                    output_truncated: terminal.output_truncated,
                };
                if let Some(existing) = side_rows.iter_mut().find(|entry| {
                    matches!(
                        &entry.row,
                        ConversationTimelineRow::TerminalSummary { terminal: current }
                            if current.terminal_id == view.terminal_id
                    )
                }) {
                    existing.revision = record.sequence;
                    existing.row = ConversationTimelineRow::TerminalSummary { terminal: view };
                } else {
                    let row = side_row(
                        record.sequence,
                        ConversationTimelineRow::TerminalSummary { terminal: view },
                    );
                    if let Some(tid) = record.turn_id {
                        side_row_turns.insert(row.row_id.clone(), tid);
                    }
                    side_rows.push(row);
                }
            }
            ConversationEvent::DelegationStarted { delegation } => {
                let row = side_row(
                    record.sequence,
                    ConversationTimelineRow::Delegation {
                        delegation: ConversationDelegationView {
                            delegation_id: delegation.delegation_id,
                            parent_tool_call_id: Some(delegation.parent_tool_call_id),
                            child_conversation_id: Some(delegation.child_conversation_id),
                            agent_id: Some(delegation.agent_id),
                            task_preview: Some(delegation.task_preview),
                            status: "running".into(),
                            result: None,
                        },
                    },
                );
                if let Some(tid) = record.turn_id {
                    side_row_turns.insert(row.row_id.clone(), tid);
                }
                side_rows.push(row);
            }
            ConversationEvent::DelegationCompleted {
                delegation_id,
                result,
            } => {
                let status = match &result {
                    ConversationDelegationResult::Ok { .. } => "completed",
                    ConversationDelegationResult::Err { error }
                        if matches!(
                            error.code.as_deref(),
                            Some("canceled" | "cancelled" | "request_cancelled")
                        ) =>
                    {
                        "canceled"
                    }
                    ConversationDelegationResult::Err { .. } => "failed",
                };
                let mut merged = false;
                for entry in side_rows.iter_mut() {
                    if let ConversationTimelineRow::Delegation { delegation } = &mut entry.row
                        && delegation.delegation_id == delegation_id
                    {
                        delegation.status = status.into();
                        delegation.result = Some(result.clone());
                        entry.revision = record.sequence;
                        merged = true;
                        break;
                    }
                }
                if !merged {
                    let row = side_row(
                        record.sequence,
                        ConversationTimelineRow::Delegation {
                            delegation: ConversationDelegationView {
                                delegation_id,
                                parent_tool_call_id: None,
                                child_conversation_id: None,
                                agent_id: None,
                                task_preview: None,
                                status: status.into(),
                                result: Some(result),
                            },
                        },
                    );
                    if let Some(tid) = record.turn_id {
                        side_row_turns.insert(row.row_id.clone(), tid);
                    }
                    side_rows.push(row);
                }
            }
            ConversationEvent::FileChangeSummaryUpdated { summary } => {
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::FileChangeSummary {
                        summary,
                        turn_id: record.turn_id,
                    },
                ));
            }
            ConversationEvent::ArtifactRevisionRecorded { artifact } => {
                let row = side_row(
                    record.sequence,
                    ConversationTimelineRow::ArtifactRevision { artifact },
                );
                if let Some(tid) = record.turn_id {
                    side_row_turns.insert(row.row_id.clone(), tid);
                }
                side_rows.push(row);
            }
            ConversationEvent::AgentBindingLoadFailed { reason } => {
                // Reload path must read the same as the live path: a legible,
                // code-aware notice — not a raw debug blob.
                let notice = match reason {
                    SessionLoadFailureReason::ResourceNotFound => ConversationSessionNotice {
                        title: "代理会话已过期".into(),
                        message: Some(
                            "代理侧已不存在该会话。可见历史仍在，但 Agent 隐藏上下文已丢失。确认重新绑定后才能继续。"
                                .into(),
                        ),
                        severity: "warning".into(),
                        ..Default::default()
                    },
                    SessionLoadFailureReason::AuthenticationRequired { message } => {
                        ConversationSessionNotice {
                            title: "需要重新认证".into(),
                            message: Some(message),
                            severity: "error".into(),
                            ..Default::default()
                        }
                    }
                    SessionLoadFailureReason::Unsupported => ConversationSessionNotice {
                        title: "代理不支持会话恢复".into(),
                        message: Some(
                            "该代理无法恢复原会话。确认重新绑定后将冷启动，不会保留 Agent 侧上下文。"
                                .into(),
                        ),
                        severity: "warning".into(),
                        ..Default::default()
                    },
                    SessionLoadFailureReason::SessionArchived { recovery_command } => {
                        ConversationSessionNotice {
                            title: "代理会话已归档".into(),
                            message: Some(match &recovery_command {
                                Some(command) => format!("运行 `{command}` 后重新加载。"),
                                None => "会话已归档。重新加载或新建对话。".into(),
                            }),
                            severity: "warning".into(),
                            action: recovery_command.map(|command| {
                                agents::conversation::ConversationNoticeAction::CopyCommand {
                                    command,
                                    label: "复制恢复命令".into(),
                                }
                            }),
                            ..Default::default()
                        }
                    }
                    SessionLoadFailureReason::SessionBusy => ConversationSessionNotice {
                        title: "代理会话正被占用".into(),
                        message: Some(
                            "关闭占用该会话的窗口后重新加载。不要新建会话，否则会丢掉唯一指针。"
                                .into(),
                        ),
                        severity: "warning".into(),
                        ..Default::default()
                    },
                    SessionLoadFailureReason::SessionUnavailable => ConversationSessionNotice {
                        title: "代理会话不可用".into(),
                        message: Some(
                            "代理侧会话已结束或不存在。可见历史仍在，但 Agent 隐藏上下文已丢失。"
                                .into(),
                        ),
                        severity: "warning".into(),
                        ..Default::default()
                    },
                    SessionLoadFailureReason::Other { message } => ConversationSessionNotice {
                        title: "加载代理会话失败".into(),
                        message: Some(format!(
                            "{message} 确认重新绑定后将冷启动，不会保留 Agent 侧上下文。"
                        )),
                        severity: "warning".into(),
                        ..Default::default()
                    },
                };
                side_row_turns.remove(AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID);
                remove_side_row(
                    side_rows,
                    deleted_rows,
                    AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
                    record.sequence,
                );
                if let Some(tid) = latest_turn_id {
                    side_row_turns.insert(AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID.into(), tid);
                }
                side_rows.retain(|row| row.row_id != AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID);
                side_rows.push(TimelineRow {
                    row_id: AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID.into(),
                    revision: record.sequence,
                    row: ConversationTimelineRow::SessionNotice { notice },
                });
            }
            ConversationEvent::AgentBindingReady { .. } => {
                side_row_turns.remove(AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID);
                remove_side_row(
                    side_rows,
                    deleted_rows,
                    AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
                    record.sequence,
                );
                side_row_turns.remove(AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID);
                remove_side_row(
                    side_rows,
                    deleted_rows,
                    AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID,
                    record.sequence,
                );
            }
            ConversationEvent::AgentConnectionStatusChanged { status, bound, .. } => match status {
                ConversationAgentConnectionStatus::Connecting
                | ConversationAgentConnectionStatus::Recovering => {
                    if let Some(tid) = latest_turn_id {
                        side_row_turns
                            .insert(AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID.into(), tid);
                    }
                    upsert_stable_notice(
                        side_rows,
                        AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
                        record.sequence,
                        ConversationSessionNotice {
                            title: "正在连接 Agent…".into(),
                            message: None,
                            severity: "info".into(),
                            ..Default::default()
                        },
                    );
                }
                ConversationAgentConnectionStatus::Ready => {
                    if !bound {
                        return;
                    }
                    side_row_turns.remove(AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID);
                    remove_side_row(
                        side_rows,
                        deleted_rows,
                        AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
                        record.sequence,
                    );
                    side_row_turns.remove(AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID);
                    remove_side_row(
                        side_rows,
                        deleted_rows,
                        AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID,
                        record.sequence,
                    );
                }
                ConversationAgentConnectionStatus::Error
                | ConversationAgentConnectionStatus::Closed => {
                    side_row_turns.remove(AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID);
                    remove_side_row(
                        side_rows,
                        deleted_rows,
                        AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
                        record.sequence,
                    );
                }
            },
            ConversationEvent::AgentBindingRecovered {
                strategy,
                continues_from,
            } => {
                side_row_turns.remove(AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID);
                remove_side_row(
                    side_rows,
                    deleted_rows,
                    AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
                    record.sequence,
                );
                side_row_turns.remove(AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID);
                remove_side_row(
                    side_rows,
                    deleted_rows,
                    AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID,
                    record.sequence,
                );
                match strategy {
                    SessionRecoveryStrategy::Loaded | SessionRecoveryStrategy::Resumed => {
                        side_row_turns.remove(AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID);
                        if let Some(index) = side_rows
                            .iter()
                            .position(|row| row.row_id == AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID)
                        {
                            side_rows.remove(index);
                            deleted_rows.push(ConversationRowOp::Delete {
                                row_id: AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID.into(),
                                revision: record.sequence,
                            });
                        }
                    }
                    SessionRecoveryStrategy::Rebound
                    | SessionRecoveryStrategy::CreatedNewSession => {
                        side_row_turns.remove(AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID);
                        if let Some(tid) = latest_turn_id {
                            side_row_turns.insert(AGENT_BINDING_REBIND_NOTICE_ROW_ID.into(), tid);
                        }
                        side_rows.retain(|row| {
                            row.row_id != AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID
                                && row.row_id != AGENT_BINDING_REBIND_NOTICE_ROW_ID
                        });
                        deleted_rows.push(ConversationRowOp::Delete {
                            row_id: AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID.into(),
                            revision: record.sequence,
                        });
                        let message = if continues_from.as_ref().is_some_and(|sid| !sid.is_empty())
                        {
                            "可见历史已链接到上一线程。后续消息走新的 Agent 线程，不会混入其他会话。"
                                .into()
                        } else {
                            "可见历史仍在，但 Agent 隐藏上下文已丢失。后续消息从新的冷启动会话继续。"
                                .into()
                        };
                        side_rows.push(TimelineRow {
                            row_id: AGENT_BINDING_REBIND_NOTICE_ROW_ID.into(),
                            revision: record.sequence,
                            row: ConversationTimelineRow::SessionNotice {
                                notice: ConversationSessionNotice {
                                    title: "Agent 会话已重新绑定".into(),
                                    message: Some(message),
                                    severity: "warning".into(),
                                    ..Default::default()
                                },
                            },
                        });
                    }
                }
            }
            ConversationEvent::AgentBindingRecoveryFailed { reason } => {
                side_row_turns.remove(AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID);
                remove_side_row(
                    side_rows,
                    deleted_rows,
                    AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
                    record.sequence,
                );
                if let Some(tid) = latest_turn_id {
                    side_row_turns.insert(AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID.into(), tid);
                }
                upsert_stable_notice(
                    side_rows,
                    AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID,
                    record.sequence,
                    ConversationSessionNotice {
                        title: "Agent session recovery failed".into(),
                        message: Some(reason),
                        severity: "error".into(),
                        ..Default::default()
                    },
                );
            }
            ConversationEvent::SessionConfigStale { stale, reason } => {
                if stale {
                    side_rows.push(side_row(
                        record.sequence,
                        ConversationTimelineRow::SessionNotice {
                            notice: ConversationSessionNotice {
                                title: "Agent configuration changed".into(),
                                message: reason,
                                severity: "info".into(),
                                ..Default::default()
                            },
                        },
                    ));
                }
            }
            ConversationEvent::RawDiagnosticRecorded { label, payload } => {
                if let Some(action) =
                    agent_handoff_notice(&label, payload.as_ref(), record.sequence)
                {
                    match action {
                        AgentHandoffRowAction::Upsert { row_id, notice } => {
                            upsert_stable_notice(side_rows, &row_id, record.sequence, *notice);
                        }
                        AgentHandoffRowAction::Remove { row_id } => {
                            side_row_turns.remove(&row_id);
                            remove_side_row(side_rows, deleted_rows, &row_id, record.sequence);
                        }
                    }
                } else if let Some(notice) = host_note_notice(&label, payload.as_ref()) {
                    let row_id = notice
                        .announcement_id
                        .clone()
                        .filter(|id| id.starts_with("host-note:"))
                        .unwrap_or_else(|| "host-note:persona".to_string());
                    upsert_stable_notice(side_rows, &row_id, record.sequence, notice);
                } else if label == agents::SESSION_RECONNECT_PROGRESS_KIND
                    || payload
                        .as_ref()
                        .and_then(|value| value.get("kind"))
                        .and_then(serde_json::Value::as_str)
                        == Some(agents::SESSION_RECONNECT_PROGRESS_KIND)
                {
                    if let Some(tid) = latest_turn_id {
                        side_row_turns
                            .insert(AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID.into(), tid);
                    }
                    let (attempt, max) = reconnect_attempt_from_payload(payload.as_ref());
                    upsert_stable_notice(
                        side_rows,
                        AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
                        record.sequence,
                        ConversationSessionNotice {
                            title: format!("会话加载异常，正在重连 {attempt}/{max} 次…"),
                            message: None,
                            severity: "warning".into(),
                            ..Default::default()
                        },
                    );
                } else if label == agents::SESSION_CONNECT_ERROR_KIND
                    || payload
                        .as_ref()
                        .and_then(|value| value.get("kind"))
                        .and_then(serde_json::Value::as_str)
                        == Some(agents::SESSION_CONNECT_ERROR_KIND)
                {
                    if let Some(tid) = latest_turn_id {
                        side_row_turns
                            .insert(AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID.into(), tid);
                    }
                    let message = payload
                        .as_ref()
                        .and_then(|value| value.get("message"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("Agent session could not be established")
                        .to_string();
                    upsert_stable_notice(
                        side_rows,
                        AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID,
                        record.sequence,
                        ConversationSessionNotice {
                            title: "会话出错".into(),
                            message: Some(message),
                            severity: "error".into(),
                            ..Default::default()
                        },
                    );
                } else if let Some(notice) = diagnostic_session_notice(&label, payload.as_ref()) {
                    side_rows.push(side_row(
                        record.sequence,
                        ConversationTimelineRow::SessionNotice { notice },
                    ));
                }
            }
            ConversationEvent::AnnouncementsUpdated { notices, .. } => {
                let stale: Vec<String> = side_rows
                    .iter()
                    .filter(|row| row.row_id.starts_with(ANNOUNCEMENT_ROW_PREFIX))
                    .map(|row| row.row_id.clone())
                    .collect();
                side_rows.retain(|row| !row.row_id.starts_with(ANNOUNCEMENT_ROW_PREFIX));
                for row_id in stale {
                    deleted_rows.push(ConversationRowOp::Delete {
                        row_id,
                        revision: record.sequence,
                    });
                }
                for notice in notices {
                    side_rows.push(TimelineRow {
                        row_id: announcement_row_id(&notice, record.sequence),
                        revision: record.sequence,
                        row: ConversationTimelineRow::SessionNotice { notice },
                    });
                }
            }
            ConversationEvent::TurnBlocked {
                reason: agents::conversation::TurnBlockedReason::Authentication { message },
            } => {
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::TurnError {
                        error: ConversationErrorView {
                            turn_id: record.turn_id,
                            error: ConversationError {
                                message,
                                code: Some("auth_required".into()),
                                raw: None,
                                kind: Default::default(),
                                plan_usage: None,
                            },
                        },
                    },
                ));
            }
            ConversationEvent::TurnBlocked { .. } => {}
            _ => {}
        }
    }

    pub(super) fn timeline_rows(&self) -> Vec<TimelineRow> {
        let mut rows = Vec::with_capacity(self.turn_order.len() * 2 + self.side_rows.len());
        let turn_set: std::collections::HashSet<Uuid> = self.turn_order.iter().copied().collect();
        let mut by_turn: std::collections::HashMap<Uuid, Vec<&TimelineRow>> =
            std::collections::HashMap::new();
        let mut orphan_side_rows = Vec::new();

        for row in &self.side_rows {
            match self.side_row_turn_id(row) {
                None => rows.push(row.clone()),
                Some(tid) if turn_set.contains(&tid) => {
                    by_turn.entry(tid).or_default().push(row);
                }
                Some(_) => orphan_side_rows.push(row),
            }
        }

        for turn_id in &self.turn_order {
            if let Some(turn) = self.turns.get(turn_id) {
                rows.extend(message_rows(turn));
            }
            if let Some(turn_side_rows) = by_turn.remove(turn_id) {
                rows.extend(turn_side_rows.into_iter().cloned());
            }
        }
        rows.extend(orphan_side_rows.into_iter().cloned());
        rows
    }
}

fn row_id_for(row: &ConversationTimelineRow, sequence: i64) -> String {
    match row {
        ConversationTimelineRow::MessageTurn { turn, .. } => turn.id.clone(),
        ConversationTimelineRow::PermissionRequest { request } => {
            format!("perm:{}", request.permission_id)
        }
        ConversationTimelineRow::QuestionRequest { request, .. } => {
            format!("q:{}", request.question_id)
        }
        ConversationTimelineRow::FeedbackRequest { request, .. } => {
            format!("fb:{}", request.feedback_id)
        }
        ConversationTimelineRow::TerminalSummary { terminal } => {
            format!("term:{}", terminal.terminal_id)
        }
        ConversationTimelineRow::Delegation { delegation } => {
            format!("del:{}", delegation.delegation_id)
        }
        ConversationTimelineRow::FileChangeSummary { .. } => format!("fc:{sequence}"),
        ConversationTimelineRow::ArtifactRevision { artifact } => {
            format!("artifact:{}:{}", artifact.artifact_id, artifact.revision)
        }
        ConversationTimelineRow::TurnError { error } => match error.turn_id {
            Some(turn_id) => format!("err:{turn_id}:{sequence}"),
            None => format!("err:{sequence}"),
        },
        ConversationTimelineRow::SessionNotice { notice } => announcement_row_id(notice, sequence),
    }
}

fn announcement_row_id(notice: &ConversationSessionNotice, sequence: i64) -> String {
    notice
        .announcement_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| format!("{ANNOUNCEMENT_ROW_PREFIX}{id}"))
        .unwrap_or_else(|| format!("notice:{sequence}"))
}

/// Wrap a freshly-produced side row with its row_id + revision (= the producing
/// event's sequence).
pub(super) fn side_row(sequence: i64, row: ConversationTimelineRow) -> TimelineRow {
    TimelineRow {
        row_id: row_id_for(&row, sequence),
        revision: sequence,
        row,
    }
}

fn auto_permission_notice(count: u32) -> ConversationSessionNotice {
    ConversationSessionNotice {
        title: AUTO_PERMISSION_NOTICE_TITLE.into(),
        message: Some(format!("已自动批准 {count} 项权限请求")),
        severity: "info".into(),
        ..Default::default()
    }
}

fn reconnect_attempt_from_payload(payload: Option<&serde_json::Value>) -> (u32, u32) {
    let attempt = payload
        .and_then(|value| value.get("attempt"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(1)
        .max(1);
    let max = payload
        .and_then(|value| value.get("max"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .unwrap_or(attempt)
        .max(attempt);
    (attempt, max)
}

pub(super) fn annotate_fork_point_rows(
    rows: &mut [TimelineRow],
    fork_session: bool,
    agent_kind: Option<agents::AgentKind>,
) {
    let turns: Vec<MessageTurn> = rows
        .iter()
        .filter_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. } => Some(turn.clone()),
            _ => None,
        })
        .collect();
    let last_assistant_id = turns
        .iter()
        .rev()
        .find(|turn| turn.role == TurnRole::Assistant)
        .map(|turn| turn.id.clone());
    for row in rows.iter_mut() {
        let ConversationTimelineRow::MessageTurn {
            turn,
            fork_point_status,
            ..
        } = &mut row.row
        else {
            continue;
        };
        if turn.role != TurnRole::Assistant {
            continue;
        }
        let is_tail = last_assistant_id.as_deref() == Some(turn.id.as_str());
        *fork_point_status = Some(match agent_kind {
            Some(kind) => {
                agents::classify_fork_point(&turns, &turn.id, kind, fork_session, is_tail)
            }
            None => agents::ForkPointStatus::Unsupported,
        });
    }
}

pub(super) fn message_row(turn: &ProjectedTurn, role: TurnRole) -> TimelineRow {
    let (message, revision, phase) = match role {
        TurnRole::User => (
            turn.user.clone(),
            turn.effective_user_revision(),
            turn.effective_user_phase(),
        ),
        _ => (turn.assistant.clone(), turn.revision, turn.phase.clone()),
    };
    TimelineRow {
        row_id: message.id.clone(),
        revision,
        row: ConversationTimelineRow::MessageTurn {
            turn: message,
            phase,
            fork_point_status: None,
        },
    }
}

pub(super) fn message_rows(turn: &ProjectedTurn) -> Vec<TimelineRow> {
    let mut rows = Vec::with_capacity(2 + turn.prefix_segments.len());
    if !turn.user.blocks.is_empty() {
        rows.push(message_row(turn, TurnRole::User));
    }
    let closed_phase = turn.closed_segment_phase();
    for (idx, segment) in turn.prefix_segments.iter().enumerate() {
        if segment.blocks.is_empty() {
            continue;
        }
        rows.push(TimelineRow {
            row_id: segment.id.clone(),
            revision: turn.prefix_segment_revision(idx),
            row: ConversationTimelineRow::MessageTurn {
                turn: segment.clone(),
                phase: closed_phase.clone(),
                fork_point_status: None,
            },
        });
    }
    if !turn.assistant.blocks.is_empty() {
        rows.push(message_row(turn, TurnRole::Assistant));
    }
    rows
}

enum AgentHandoffRowAction {
    Upsert {
        row_id: String,
        notice: Box<ConversationSessionNotice>,
    },
    Remove {
        row_id: String,
    },
}

fn normalize_agent_key(raw: &str) -> String {
    raw.trim().to_ascii_lowercase().replace(['-', ' '], "_")
}

fn agent_handoff_notice(
    label: &str,
    payload: Option<&serde_json::Value>,
    sequence: i64,
) -> Option<AgentHandoffRowAction> {
    let kind = payload
        .and_then(|value| value.get("kind"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or(label);
    if kind != "agent_handoff" {
        return None;
    }
    let payload = payload?;
    let from_agent = payload
        .get("fromAgent")
        .or_else(|| payload.get("from_agent"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let to_agent = payload
        .get("toAgent")
        .or_else(|| payload.get("to_agent"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let after_turn_id = payload
        .get("afterTurnId")
        .or_else(|| payload.get("after_turn_id"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let row_id = match after_turn_id {
        Some(turn_id) => format!("host-note:agent-handoff:after:{turn_id}"),
        None => format!("host-note:agent-handoff:seq:{sequence}"),
    };
    let handoff_kind = payload
        .get("handoffKind")
        .or_else(|| payload.get("handoff_kind"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| *s == "fork")
        .unwrap_or("switch");
    if handoff_kind != "fork" && normalize_agent_key(from_agent) == normalize_agent_key(to_agent) {
        return Some(AgentHandoffRowAction::Remove { row_id });
    }
    let from_model = payload
        .get("fromModel")
        .or_else(|| payload.get("from_model"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let to_model = payload
        .get("toModel")
        .or_else(|| payload.get("to_model"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let continuation_policy = payload
        .get("continuationPolicy")
        .or_else(|| payload.get("continuation_policy"))
        .and_then(serde_json::Value::as_str)
        .filter(|p| matches!(*p, "portable" | "fresh"))
        .unwrap_or("portable");
    let handoff_tokens = payload
        .get("handoffTokens")
        .or_else(|| payload.get("handoff_tokens"))
        .or_else(|| payload.get("totalTokens"))
        .or_else(|| payload.get("total_tokens"))
        .and_then(serde_json::Value::as_u64)
        .filter(|&tokens| tokens > 0);
    let structured = serde_json::json!({
        "kind": "agent_handoff",
        "handoffKind": handoff_kind,
        "fromAgent": from_agent,
        "toAgent": to_agent,
        "fromModel": from_model,
        "toModel": to_model,
        "handoffTokens": handoff_tokens,
        "continuationPolicy": continuation_policy,
    });
    Some(AgentHandoffRowAction::Upsert {
        row_id: row_id.clone(),
        notice: Box::new(ConversationSessionNotice {
            title: if handoff_kind == "fork" {
                "Fork交接".into()
            } else {
                "交接".into()
            },
            message: Some(structured.to_string()),
            severity: "info".into(),
            announcement_id: Some(row_id),
            action: None,
            ..Default::default()
        }),
    })
}

fn host_note_notice(
    label: &str,
    payload: Option<&serde_json::Value>,
) -> Option<ConversationSessionNotice> {
    let kind = payload
        .and_then(|value| value.get("kind"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or(label);
    if kind != "host_note" {
        return None;
    }
    let message = payload
        .and_then(|value| value.get("message"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if message.is_empty() {
        return None;
    }
    let title = payload
        .and_then(|value| value.get("title"))
        .and_then(serde_json::Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("人设");
    let announcement_id = payload
        .and_then(|value| {
            value
                .get("announcementId")
                .or_else(|| value.get("announcement_id"))
        })
        .and_then(serde_json::Value::as_str)
        .filter(|id| id.starts_with("host-note:"))
        .unwrap_or("host-note:persona");
    Some(ConversationSessionNotice {
        title: title.to_string(),
        message: Some(message),
        severity: "info".into(),
        announcement_id: Some(announcement_id.to_string()),
        action: None,
        ..Default::default()
    })
}

fn diagnostic_session_notice(
    label: &str,
    payload: Option<&serde_json::Value>,
) -> Option<ConversationSessionNotice> {
    let kind = payload
        .and_then(|value| {
            value
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .or_else(|| {
                    value
                        .get("sessionUpdate")
                        .and_then(serde_json::Value::as_str)
                })
        })
        .unwrap_or(label);
    match kind {
        "session_config_override_skipped" => Some(ConversationSessionNotice {
            title: "会话配置未应用".into(),
            message: payload.and_then(skipped_override_message),
            severity: "warning".into(),
            ..Default::default()
        }),
        agents::AGENT_SESSION_NOTICE_KIND => {
            payload.and_then(agents::session_notice_from_diagnostic)
        }
        "host_note"
        | "agent_handoff"
        | "model_consistency_mismatch"
        | "user_message_acknowledged"
        | "companion_capability"
        | "ext_notification"
        | "prompt_cancel_requested" => None,
        _ => Some(ConversationSessionNotice {
            title: "未识别的会话更新".into(),
            message: Some(label.to_string()),
            severity: "info".into(),
            ..Default::default()
        }),
    }
}

fn skipped_override_message(payload: &serde_json::Value) -> Option<String> {
    let reason = payload.get("reason").and_then(serde_json::Value::as_str)?;
    let requested = payload
        .get("requested")
        .and_then(serde_json::Value::as_str)?;
    Some(format!("{reason}: {requested}"))
}

fn permission_response_is_rejection(
    response: &agents::conversation::ConversationPermissionResponse,
    options: &[agents::AgentPermissionOption],
) -> bool {
    match &response.response {
        AgentPermissionResponse::Selected { option_id, .. } => {
            if let Some(opt) = options.iter().find(|opt| opt.id == *option_id) {
                matches!(
                    opt.kind,
                    agents::AgentPermissionOptionKind::RejectOnce
                        | agents::AgentPermissionOptionKind::RejectAlways
                )
            } else {
                let lower = option_id.trim().to_ascii_lowercase();
                matches!(
                    lower.as_str(),
                    "deny" | "decline" | "reject" | "reject_once" | "reject_always"
                ) || lower.contains("reject")
                    || lower.contains("decline")
                    || lower.contains("deny")
            }
        }
        AgentPermissionResponse::Cancelled => !response.auto,
    }
}

fn extract_permission_tool_call_id(
    details: Option<&serde_json::Value>,
    permission_id: &str,
) -> Option<String> {
    let from_details = details
        .and_then(|d| {
            d.get("toolCallId")
                .or_else(|| d.get("itemId"))
                .or_else(|| d.get("callId"))
                .or_else(|| d.get("toolUseId"))
                .or_else(|| d.get("toolUseID"))
                .or_else(|| d.get("tool_use_id"))
        })
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    from_details.or_else(|| {
        let trimmed = permission_id.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

impl ProjectionFold {
    fn apply_denied_status_to_existing_tool_call(
        &mut self,
        call_id: &str,
        record: &ConversationEventRecord,
    ) -> Option<(Uuid, super::cache::AssistantEmit)> {
        let mut updated_turn: Option<Uuid> = None;
        for turn_id in self.turn_order.iter().rev() {
            let Some(turn) = self.turns.get_mut(turn_id) else {
                continue;
            };
            let mut matched = false;
            for block in &mut turn.assistant.blocks {
                if let agents::conversation::ContentBlock::ToolUse {
                    tool_use_id: Some(id),
                    status,
                    ended_at,
                    ..
                } = block
                    && id == call_id
                {
                    let can_override = match status.as_deref() {
                        None => true,
                        Some(s) => matches!(
                            s.trim().to_ascii_lowercase().as_str(),
                            "pending"
                                | "running"
                                | "in_progress"
                                | "failed"
                                | "error"
                                | "cancelled"
                                | "canceled"
                        ),
                    };
                    if can_override {
                        *status = Some("denied".to_string());
                        if ended_at.is_none() {
                            *ended_at = Some(record.created_at);
                        }
                        matched = true;
                    }
                    break;
                }
            }
            if matched {
                let mut has_result = false;
                for block in &mut turn.assistant.blocks {
                    if let agents::conversation::ContentBlock::ToolResult {
                        tool_use_id: Some(id),
                        is_error,
                        ..
                    } = block
                        && id == call_id
                    {
                        *is_error = true;
                        has_result = true;
                        break;
                    }
                }
                if !has_result {
                    turn.assistant
                        .blocks
                        .push(agents::conversation::ContentBlock::ToolResult {
                            tool_use_id: Some(call_id.to_string()),
                            output_preview: None,
                            is_error: true,
                            agent_stats: None,
                        });
                }
                turn.revision = record.sequence;
                updated_turn = Some(*turn_id);
                break;
            }
        }
        let turn_id = updated_turn?;
        let turn = self.turns.get(&turn_id)?;
        let blocks = turn
            .assistant
            .blocks
            .iter()
            .filter(|block| match block {
                agents::conversation::ContentBlock::ToolUse {
                    tool_use_id: Some(id),
                    ..
                }
                | agents::conversation::ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    ..
                } => id == call_id,
                _ => false,
            })
            .cloned()
            .collect();
        Some((
            turn_id,
            super::cache::AssistantEmit::Patch {
                blocks,
                usage: None,
            },
        ))
    }
}

#[cfg(test)]
#[path = "rows_tests.rs"]
pub(super) mod tests;
