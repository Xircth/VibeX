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
                            "当前版本暂时无法显示其中一条记录，其余会话内容不受影响。更新 VibeX 后可再次查看。"
                                .into(),
                        ),
                        severity: "warning".into(),
                        ..Default::default()
                    }
        } else {
            ConversationSessionNotice {
                title: "部分会话记录无法显示".into(),
                message: Some("VibeX 无法读取其中一条历史记录，其余会话内容不受影响。".into()),
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
    ) {
        let side_rows = &mut self.side_rows;
        let auto_permission_approvals = &mut self.auto_permission_approvals;
        match event {
            ConversationEvent::PermissionRequested { request } => {
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::PermissionRequest {
                        request: ConversationPermissionView {
                            permission_id: request.permission_id,
                            title: Some(request.request.title),
                            status: "pending".into(),
                            details: request.request.details,
                            options: request.request.options,
                        },
                    },
                ));
            }
            ConversationEvent::PermissionResponded {
                permission_id,
                response,
            } => {
                let auto_allow = response.auto
                    && matches!(response.response, AgentPermissionResponse::Selected { .. });
                if auto_allow {
                    remove_side_row(
                        side_rows,
                        deleted_rows,
                        &format!("perm:{permission_id}"),
                        record.sequence,
                    );
                    *auto_permission_approvals = auto_permission_approvals.saturating_add(1);
                    upsert_stable_notice(
                        side_rows,
                        AUTO_PERMISSION_NOTICE_ROW_ID,
                        record.sequence,
                        auto_permission_notice(*auto_permission_approvals),
                    );
                } else {
                    // Fold the response onto the pending permission row so a rebuilt
                    // projection matches the live store (which sets `status: 'responded'`)
                    // — otherwise an answered (or recovery-voided, ADR-0001) permission
                    // reloads as perpetually pending.
                    for entry in side_rows.iter_mut() {
                        if let ConversationTimelineRow::PermissionRequest { request } =
                            &mut entry.row
                            && request.permission_id == permission_id
                        {
                            request.status = "responded".into();
                            entry.revision = record.sequence;
                            break;
                        }
                    }
                }
            }
            ConversationEvent::QuestionRequested { request } => {
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::QuestionRequest {
                        request,
                        response: None,
                    },
                ));
            }
            ConversationEvent::QuestionResponded {
                question_id,
                response,
            } => {
                // Fold the answer onto the pending question row so a rebuilt projection
                // no longer shows answered questions as perpetually pending.
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
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::FeedbackRequest {
                        request,
                        response: None,
                    },
                ));
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
                    side_rows.push(side_row(
                        record.sequence,
                        ConversationTimelineRow::TerminalSummary { terminal: view },
                    ));
                }
            }
            ConversationEvent::DelegationStarted { delegation } => {
                side_rows.push(side_row(
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
                ));
            }
            ConversationEvent::DelegationCompleted {
                delegation_id,
                result,
            } => {
                // Fold the outcome onto the running delegation row so a rebuilt
                // projection shows one card per delegation (keeping agent_type,
                // task_preview, child_conversation_id from the start event) rather
                // than a second, context-less "completed" row.
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
                    side_rows.push(side_row(
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
                    ));
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
                side_rows.push(side_row(
                    record.sequence,
                    ConversationTimelineRow::ArtifactRevision { artifact },
                ));
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
                remove_side_row(
                    side_rows,
                    deleted_rows,
                    AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
                    record.sequence,
                );
                side_rows.retain(|row| row.row_id != AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID);
                side_rows.push(TimelineRow {
                    row_id: AGENT_BINDING_LOAD_FAILURE_NOTICE_ROW_ID.into(),
                    revision: record.sequence,
                    row: ConversationTimelineRow::SessionNotice { notice },
                });
            }
            ConversationEvent::AgentBindingReady { .. } => {
                remove_side_row(
                    side_rows,
                    deleted_rows,
                    AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
                    record.sequence,
                );
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
                    remove_side_row(
                        side_rows,
                        deleted_rows,
                        AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
                        record.sequence,
                    );
                    remove_side_row(
                        side_rows,
                        deleted_rows,
                        AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID,
                        record.sequence,
                    );
                }
                ConversationAgentConnectionStatus::Error
                | ConversationAgentConnectionStatus::Closed => {
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
                remove_side_row(
                    side_rows,
                    deleted_rows,
                    AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
                    record.sequence,
                );
                remove_side_row(
                    side_rows,
                    deleted_rows,
                    AGENT_SESSION_CONNECT_ERROR_NOTICE_ROW_ID,
                    record.sequence,
                );
                match strategy {
                    SessionRecoveryStrategy::Loaded | SessionRecoveryStrategy::Resumed => {
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
                remove_side_row(
                    side_rows,
                    deleted_rows,
                    AGENT_CONNECTION_RECOVERING_NOTICE_ROW_ID,
                    record.sequence,
                );
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
                if let Some(notice) = host_note_notice(&label, payload.as_ref()) {
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
        rows.extend(self.side_rows.iter().cloned());
        for turn_id in &self.turn_order {
            if let Some(turn) = self.turns.get(turn_id) {
                rows.extend(message_rows(turn));
            }
        }
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
    let closed_phase = turn.effective_user_phase();
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


#[cfg(test)]
#[path = "rows_tests.rs"]
pub(super) mod tests;
