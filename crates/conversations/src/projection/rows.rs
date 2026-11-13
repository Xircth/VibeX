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
        for turn_id in &self.turn_order {
            if let Some(turn) = self.turns.get(turn_id) {
                rows.extend(message_rows(turn));
            }
        }
        rows.extend(self.side_rows.iter().cloned());
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
    // Only User / Assistant message rows are projected; anything else maps to the
    // assistant side (there is no System row in a conversation turn).
    let message = match role {
        TurnRole::User => turn.user.clone(),
        _ => turn.assistant.clone(),
    };
    TimelineRow {
        row_id: message.id.clone(),
        revision: turn.revision,
        row: ConversationTimelineRow::MessageTurn {
            turn: message,
            phase: turn.phase.clone(),
            fork_point_status: None,
        },
    }
}

pub(super) fn message_rows(turn: &ProjectedTurn) -> Vec<TimelineRow> {
    let mut rows = Vec::with_capacity(2 + turn.prefix_segments.len());
    if !turn.user.blocks.is_empty() {
        rows.push(message_row(turn, TurnRole::User));
    }
    for segment in &turn.prefix_segments {
        if segment.blocks.is_empty() {
            continue;
        }
        rows.push(TimelineRow {
            row_id: segment.id.clone(),
            revision: turn.revision,
            row: ConversationTimelineRow::MessageTurn {
                turn: segment.clone(),
                phase: turn.phase.clone(),
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
pub(super) mod tests {
    use std::str::FromStr;

    use agents::{
        AgentId, AgentPermissionId, AgentPermissionOption, AgentPermissionOptionKind,
        AgentPermissionRequest, AgentPermissionResponse, AgentSessionId,
        conversation::{
            ContentBlock, ConversationArtifactReference, ConversationDelegation,
            ConversationDelegationResult, ConversationError, ConversationEvent,
            ConversationFeedbackRequest, ConversationFeedbackResponse, ConversationInputBlock,
            ConversationInputEvent, ConversationInputPayload, ConversationPermissionRequest,
            ConversationPermissionResponse, ConversationPlanEntry, ConversationQuestionRequest,
            ConversationQuestionResponse, ConversationTimelineRow, ConversationToolCallPatch,
            ConversationUsage, TurnRole,
        },
    };
    use db::models::{
        conversation::{
            ConversationAgentBindingRecord, ConversationRecord, CreateConversationAgentBinding,
            CreateConversationRecord,
        },
        conversation_event::{
            AppendConversationEvent, CURRENT_EVENT_VERSION, ConversationEventRecord,
        },
        conversation_input::ConversationInputRecord,
        conversation_relation::ConversationRelationRecord,
        conversation_snapshot::ConversationProjectionSnapshotRecord,
        conversation_tool::ConversationToolCallRecord,
        conversation_turn::{ConversationTurnRecord, CreateConversationTurn},
        session::Session,
    };
    use sqlx::{
        SqlitePool,
        sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    };
    use uuid::Uuid;

    use super::{ConversationSessionNotice, side_row};
    use crate::{
        CreateDelegatedConversation, create_delegated_conversation,
        projection::{
            CONVERSATION_PROJECTION_VERSION, ConversationEventAppender, ConversationProjector,
            ProjectionFold, ProjectionSnapshotState,
        },
    };
    pub(in crate::projection) fn record_of(
        conversation_id: Uuid,
        sequence: i64,
        event: ConversationEvent,
    ) -> ConversationEventRecord {
        ConversationEventRecord {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: None,
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            sequence,
            source: "acp".into(),
            event_kind: "test".into(),
            event_version: CURRENT_EVENT_VERSION,
            normalized_json: serde_json::to_string(&event).expect("event json"),
            raw_json: None,
            idempotency_key: None,
            created_at: chrono::Utc::now(),
        }
    }

    pub(in crate::projection) async fn setup_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    pub(in crate::projection) async fn setup_temp_pool() -> (tempfile::TempDir, SqlitePool) {
        let dir = tempfile::tempdir().expect("temp db dir");
        let options = SqliteConnectOptions::new()
            .filename(dir.path().join("conversations.sqlite"))
            .create_if_missing(true)
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect temp db");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        (dir, pool)
    }

    pub(in crate::projection) async fn seed_turn(pool: &SqlitePool) -> (Uuid, Uuid) {
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create conversation");
        let turn = ConversationTurnRecord::create_pending(
            pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-1"),
                text_preview: Some("hello"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn");
        (conversation_id, turn.id)
    }

    pub(in crate::projection) fn diagnostic_record(
        conversation_id: Uuid,
        sequence: i64,
        event: &ConversationEvent,
    ) -> ConversationEventRecord {
        ConversationEventRecord {
            id: Uuid::new_v4(),
            conversation_id,
            turn_id: None,
            binding_id: None,
            connection_id: None,
            prompt_id: None,
            sequence,
            source: "acp".into(),
            event_kind: "raw_diagnostic_recorded".into(),
            event_version: CURRENT_EVENT_VERSION,
            normalized_json: serde_json::to_string(event).expect("diagnostic json"),
            raw_json: None,
            idempotency_key: None,
            created_at: chrono::Utc::now(),
        }
    }

    pub(in crate::projection) async fn append_event(
        pool: &SqlitePool,
        conversation_id: Uuid,
        turn_id: Option<Uuid>,
        source: &'static str,
        event: ConversationEvent,
        idempotency_key: Option<&'static str>,
    ) -> ConversationEventRecord {
        let value = serde_json::to_value(&event).expect("event value");
        let event_kind = value["kind"].as_str().expect("event kind").to_string();
        let normalized_json = serde_json::to_string(&event).expect("event json");
        ConversationEventAppender::append(
            pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id,
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source,
                event_kind: &event_kind,
                normalized_json: &normalized_json,
                raw_json: None,
                idempotency_key,
            },
        )
        .await
        .expect("append event")
    }

    pub(in crate::projection) fn test_input_payload(text: &str) -> ConversationInputPayload {
        ConversationInputPayload {
            agent_id: AgentId::parse("codex").expect("agent id"),
            workspace_id: Uuid::new_v4(),
            executor_profile_id: None,
            text: text.to_string(),
            display_text: None,
            images: Vec::new(),
            mode_override: None,
            config_overrides: Vec::new(),
            workflow_refs: Vec::new(),
            file_refs: Vec::new(),
            internal_prompt_contributions: Vec::new(),
            collaboration_origin: None,
        }
    }

    pub(in crate::projection) async fn seed_durable_input_turn(
        pool: &SqlitePool,
        conversation_id: Uuid,
        text: &str,
    ) -> (Uuid, Uuid) {
        let input_id = Uuid::new_v4();
        let claim_token = Uuid::new_v4();
        let payload = test_input_payload(text);
        append_event(
            pool,
            conversation_id,
            None,
            "user",
            ConversationEvent::ConversationInput {
                event: ConversationInputEvent::Submitted {
                    input_id,
                    operation_id: Uuid::new_v4(),
                    revision: 1,
                    sort_key: ConversationInputRecord::next_sort_key(pool, conversation_id)
                        .await
                        .expect("sort key"),
                    payload_digest: format!("digest-{input_id}"),
                    payload,
                    principal: serde_json::json!({ "kind": "test" }),
                },
            },
            None,
        )
        .await;
        append_event(
            pool,
            conversation_id,
            None,
            "system",
            ConversationEvent::ConversationInput {
                event: ConversationInputEvent::Claimed {
                    input_id,
                    claim_token,
                    claim_deadline: chrono::Utc::now() + chrono::Duration::seconds(30),
                },
            },
            None,
        )
        .await;
        let turn = ConversationTurnRecord::create_pending(
            pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt"),
                text_preview: Some(text),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn");
        append_event(
            pool,
            conversation_id,
            Some(turn.id),
            "system",
            ConversationEvent::ConversationInput {
                event: ConversationInputEvent::Dispatched {
                    input_id,
                    claim_token,
                    turn_id: turn.id,
                },
            },
            None,
        )
        .await;
        append_event(
            pool,
            conversation_id,
            Some(turn.id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: text.into() }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        (input_id, turn.id)
    }

    #[tokio::test]
    async fn artifact_revision_event_projects_reference_without_file_bytes() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let artifact_id = Uuid::new_v4();

        let record = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::ArtifactRevisionRecorded {
                artifact: ConversationArtifactReference {
                    artifact_id,
                    workspace_id: Some(Uuid::new_v4()),
                    relative_path: "reports/quarter.xlsx".into(),
                    media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        .into(),
                    content_hash: "a".repeat(64),
                    revision: 1,
                    plugin_id: "builtin.office".into(),
                    plugin_version: "2.0.0".into(),
                    provider_id: "officecli".into(),
                    tool_lock_id: "officecli:test:1.0.140".into(),
                },
            },
            Some("artifact-revision-1"),
        )
        .await;

        assert_eq!(record.event_kind, "artifact_revision_recorded");
        assert!(record.normalized_json.contains(&artifact_id.to_string()));
        assert!(!record.normalized_json.contains("\"bytes\""));
        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project artifact event");
        assert_eq!(timeline.last_sequence, record.sequence);
        let artifact_row = timeline
            .rows
            .iter()
            .find(|row| {
                matches!(
                    &row.row,
                    ConversationTimelineRow::ArtifactRevision { artifact }
                        if artifact.artifact_id == artifact_id
                )
            })
            .expect("artifact revision row");
        assert_eq!(artifact_row.row_id, format!("artifact:{artifact_id}:1"));

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::ArtifactRevisionRecorded {
                artifact: ConversationArtifactReference {
                    artifact_id,
                    workspace_id: Some(Uuid::new_v4()),
                    relative_path: "reports/quarter.xlsx".into(),
                    media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                        .into(),
                    content_hash: "b".repeat(64),
                    revision: 2,
                    plugin_id: "builtin.office".into(),
                    plugin_version: "2.0.0".into(),
                    provider_id: "officecli".into(),
                    tool_lock_id: "officecli:test:1.0.140".into(),
                },
            },
            Some("artifact-revision-2"),
        )
        .await;
        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project both artifact revisions");
        assert_eq!(
            timeline
                .rows
                .iter()
                .filter(|row| matches!(
                    &row.row,
                    ConversationTimelineRow::ArtifactRevision { artifact }
                        if artifact.artifact_id == artifact_id
                ))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn artifact_projection_rebuilds_a_v3_snapshot_that_skipped_artifacts() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let artifact_id = Uuid::new_v4();
        let record = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::ArtifactRevisionRecorded {
                artifact: ConversationArtifactReference {
                    artifact_id,
                    workspace_id: Some(Uuid::new_v4()),
                    relative_path: "reports/history.pptx".into(),
                    media_type:
                        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                            .into(),
                    content_hash: "b".repeat(64),
                    revision: 1,
                    plugin_id: "builtin.office".into(),
                    plugin_version: "2.0.0".into(),
                    provider_id: "officecli".into(),
                    tool_lock_id: "officecli:test:1.0.140".into(),
                },
            },
            Some("artifact-v3-snapshot"),
        )
        .await;

        let skipped_artifact_snapshot = serde_json::to_string(&ProjectionSnapshotState {
            turns: Vec::new(),
            side_rows: Vec::new(),
            last_sequence: record.sequence,
            auto_permission_approvals: 0,
        })
        .expect("serialize v3 snapshot");
        ConversationProjectionSnapshotRecord::upsert(
            &pool,
            conversation_id,
            3,
            record.sequence,
            &skipped_artifact_snapshot,
            0,
            None,
        )
        .await
        .expect("seed stale v3 snapshot");

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("rebuild artifact projection");
        assert!(
            timeline.rows.iter().any(|row| {
                matches!(
                    &row.row,
                    ConversationTimelineRow::ArtifactRevision { artifact }
                        if artifact.artifact_id == artifact_id
                )
            }),
            "a predecessor v3 snapshot that skipped Artifact events must be rebuilt"
        );
    }

    #[tokio::test]
    async fn unknown_event_renders_placeholder_row_and_timeline_still_loads() {
        // Acceptance for 批次A: a forward-incompatible event surrounded by normal
        // events must not break timeline loading — it shows as a single placeholder
        // row while every other event folds as usual.
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnStarted,
            None,
        )
        .await;

        // A bogus event whose payload no known variant can parse, inserted through the
        // real append path (idempotency/sequence/side-effects all exercised).
        ConversationEventAppender::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source: "acp",
                event_kind: "bogus_kind",
                normalized_json: r#"{"kind":"bogus_kind","from_the_future":true}"#,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append bogus event");

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "hello".into(),
                message_id: None,
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline still loads despite the unknown event");

        let placeholders: Vec<_> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::SessionNotice { notice }
                    if notice.title == "部分会话记录无法显示" =>
                {
                    Some(notice)
                }
                _ => None,
            })
            .collect();
        assert_eq!(placeholders.len(), 1, "exactly one placeholder row");
        assert_eq!(
            placeholders[0].message.as_deref(),
            Some("VibeX 无法读取其中一条历史记录，其余会话内容不受影响。")
        );

        // The normal assistant text still folded through, proving the unknown event
        // did not abort the rest of the timeline.
        let has_assistant_text = timeline.rows.iter().any(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. } => turn
                .blocks
                .iter()
                .any(|block| matches!(block, ContentBlock::Text { text } if text == "hello")),
            _ => false,
        });
        assert!(has_assistant_text, "surrounding events still fold");
    }

    #[tokio::test]
    async fn stale_snapshot_version_replays_events_instead_of_cached_notices() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        ConversationEventAppender::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source: "acp",
                event_kind: "agent_binding_started",
                normalized_json: r#"{
                    "kind":"agent_binding_started",
                    "agent_type":"codex",
                    "working_dir":"/tmp/project"
                }"#,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append legacy event");

        let mut stale_fold = ProjectionFold {
            last_sequence: 1,
            ..ProjectionFold::default()
        };
        stale_fold.side_rows.push(side_row(
            1,
            ConversationTimelineRow::SessionNotice {
                notice: ConversationSessionNotice {
                    title: "cached stale notice".into(),
                    message: None,
                    severity: "warning".into(),
                    ..Default::default()
                },
            },
        ));
        let fold_json = serde_json::to_string(&stale_fold.to_snapshot_state())
            .expect("serialize stale snapshot");
        ConversationProjectionSnapshotRecord::upsert(
            &pool,
            conversation_id,
            i64::from(CONVERSATION_PROJECTION_VERSION) - 1,
            1,
            &fold_json,
            0,
            None,
        )
        .await
        .expect("persist stale snapshot");

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("stale snapshot should be rebuilt");
        assert!(
            timeline
                .rows
                .iter()
                .all(|row| !matches!(row.row, ConversationTimelineRow::SessionNotice { .. }))
        );
    }

    #[tokio::test]
    async fn legacy_capability_snapshot_does_not_render_unknown_event_notice() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        ConversationEventAppender::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source: "acp",
                event_kind: "agent_binding_ready",
                normalized_json: r#"{
                    "kind":"agent_binding_ready",
                    "acp_session_id":"legacy-session",
                    "capabilities":{
                        "prompt":{"text":true,"image":true,"resource":false},
                        "load_session":true,
                        "resume_session":false,
                        "close_session":true,
                        "terminal":true,
                        "additional_directories":false,
                        "filesystem_requests":false,
                        "mcp_servers":false,
                        "permission_requests":false,
                        "modes":[],
                        "config_options":[],
                        "available_commands":[]
                    }
                }"#,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append legacy capability snapshot");

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project legacy capability snapshot");

        assert!(
            timeline
                .rows
                .iter()
                .all(|row| !matches!(row.row, ConversationTimelineRow::SessionNotice { .. })),
            "same-version legacy capabilities should remain readable"
        );
    }

    #[tokio::test]
    async fn legacy_agent_binding_field_does_not_render_unknown_event_notice() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        ConversationEventAppender::append(
            &pool,
            AppendConversationEvent {
                id: Uuid::new_v4(),
                conversation_id,
                turn_id: Some(turn_id),
                binding_id: None,
                connection_id: Some("connection-1"),
                prompt_id: Some("prompt-1"),
                source: "acp",
                event_kind: "agent_binding_started",
                normalized_json: r#"{
                    "kind":"agent_binding_started",
                    "agent_type":"codex",
                    "working_dir":"/tmp/project"
                }"#,
                raw_json: None,
                idempotency_key: None,
            },
        )
        .await
        .expect("append legacy agent binding");

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project legacy agent binding");

        assert!(
            timeline
                .rows
                .iter()
                .all(|row| !matches!(row.row, ConversationTimelineRow::SessionNotice { .. })),
            "renamed same-version fields should remain readable"
        );
    }

    #[tokio::test]
    async fn accepted_steering_splits_the_assistant_bubble() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let steering_id = Uuid::new_v4();
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "write it".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::AssistantTextDelta {
                text: "first half".into(),
                message_id: Some("msg_1".into()),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::ConversationSteering {
                event: agents::conversation::ConversationSteeringEvent::Requested {
                    steering_id,
                    operation_id: Uuid::new_v4(),
                    expected_turn_id: turn_id,
                    payload_digest: "d".into(),
                    blocks: vec![ConversationInputBlock::Text {
                        text: "stop".into(),
                    }],
                    principal: serde_json::json!({}),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::ConversationSteering {
                event: agents::conversation::ConversationSteeringEvent::Accepted {
                    steering_id,
                    expected_turn_id: turn_id,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::AssistantTextDelta {
                text: "second half".into(),
                message_id: None,
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project steered turn");
        let texts: Vec<(TurnRole, String)> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. } => {
                    let text = turn.blocks.iter().find_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.clone()),
                        _ => None,
                    })?;
                    Some((turn.role, text))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            texts,
            vec![
                (TurnRole::User, "write it".into()),
                (TurnRole::Assistant, "first half".into()),
                (TurnRole::User, "stop".into()),
                (TurnRole::Assistant, "second half".into()),
            ]
        );
        let assistant_ids: Vec<String> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some(turn.id.clone())
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            assistant_ids,
            vec![
                format!("{turn_id}:assistant"),
                format!("{turn_id}:assistant:2"),
            ]
        );
        let first_agent_id = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. }
                if turn.id == format!("{turn_id}:assistant") =>
            {
                turn.agent_message_id.clone()
            }
            _ => None,
        });
        assert_eq!(first_agent_id.as_deref(), Some("msg_1"));
    }

    #[tokio::test]
    async fn submitted_feedback_splits_the_assistant_bubble_like_steering() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let note_id = Uuid::new_v4();
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "write it".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::AssistantTextDelta {
                text: "first half".into(),
                message_id: Some("msg_1".into()),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserSubmittedFeedback {
                note_id,
                operation_id: Uuid::new_v4(),
                text: "stop".into(),
                turn_id: Some(turn_id),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::AssistantTextDelta {
                text: "second half".into(),
                message_id: None,
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project feedback turn");
        let texts: Vec<(TurnRole, String)> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. } => {
                    let text = turn.blocks.iter().find_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.clone()),
                        _ => None,
                    })?;
                    Some((turn.role, text))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            texts,
            vec![
                (TurnRole::User, "write it".into()),
                (TurnRole::Assistant, "first half".into()),
                (TurnRole::User, "stop".into()),
                (TurnRole::Assistant, "second half".into()),
            ]
        );
        let assistant_ids: Vec<String> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some(turn.id.clone())
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            assistant_ids,
            vec![
                format!("{turn_id}:assistant"),
                format!("{turn_id}:assistant:2"),
            ]
        );
        let first_agent_id = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. }
                if turn.id == format!("{turn_id}:assistant") =>
            {
                turn.agent_message_id.clone()
            }
            _ => None,
        });
        assert_eq!(first_agent_id.as_deref(), Some("msg_1"));
    }

    #[tokio::test]
    async fn turn_interrupted_marks_status_and_phase() {
        // 批次B / ADR-0001: a TurnInterrupted event is the fourth terminal state. It
        // must drive the durable turn status to 'interrupted' (side-effect table) and
        // the projected turn phase to 'interrupted' (so the timeline renders the
        // 因重启中断 treatment).
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "hello".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnStarted,
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnInterrupted {
                reason: Some("host restarted".into()),
            },
            None,
        )
        .await;

        let turn = ConversationTurnRecord::find_by_id(&pool, turn_id)
            .await
            .expect("find turn")
            .expect("turn");
        assert_eq!(turn.status, "interrupted");

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let user_phase = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, phase, .. }
                if turn.role == TurnRole::User =>
            {
                Some(phase.clone())
            }
            _ => None,
        });
        assert_eq!(user_phase.as_deref(), Some("interrupted"));
    }

    #[tokio::test]
    async fn failed_and_cancelled_turns_keep_distinct_projected_phases() {
        for (terminal_event, expected_phase) in [
            (
                ConversationEvent::TurnFailed {
                    error: ConversationError {
                        message: "agent failed".into(),
                        code: Some("fixture_failure".into()),
                        raw: None,
                        kind: Default::default(),
                        plan_usage: None,
                    },
                },
                "failed",
            ),
            (
                ConversationEvent::TurnCancelled {
                    reason: Some("user stopped the turn".into()),
                },
                "cancelled",
            ),
        ] {
            let pool = setup_pool().await;
            let (conversation_id, turn_id) = seed_turn(&pool).await;
            append_event(
                &pool,
                conversation_id,
                Some(turn_id),
                "user",
                ConversationEvent::UserTurnCreated {
                    blocks: vec![ConversationInputBlock::Text {
                        text: "do work".into(),
                    }],
                    workflow_refs: Vec::new(),
                },
                None,
            )
            .await;
            append_event(
                &pool,
                conversation_id,
                Some(turn_id),
                "runtime",
                ConversationEvent::AssistantTextDelta {
                    text: "working".into(),
                    message_id: None,
                },
                None,
            )
            .await;
            append_event(
                &pool,
                conversation_id,
                Some(turn_id),
                "runtime",
                terminal_event,
                None,
            )
            .await;

            let timeline = ConversationProjector::project(&pool, conversation_id)
                .await
                .expect("timeline");
            let user_phase = timeline.rows.iter().find_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, phase, .. }
                    if turn.role == TurnRole::User =>
                {
                    Some(phase.as_str())
                }
                _ => None,
            });
            assert_eq!(user_phase, Some(expected_phase));
            let assistant_metrics = timeline.rows.iter().find_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some((turn.duration_ms, turn.completed_at))
                }
                _ => None,
            });
            assert!(
                matches!(assistant_metrics, Some((Some(_), Some(_)))),
                "assistant metrics: {assistant_metrics:?}"
            );
        }
    }

    #[tokio::test]
    async fn turn_failure_does_not_keep_error_text_as_an_assistant_message() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let error_text =
            "Failed to authenticate. API Error: 401 Model deepseek-v4.1-flash is not supported";
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "你是谁".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::AssistantTextDelta {
                text: error_text.into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnFailed {
                error: ConversationError {
                    message: format!("Internal error: {error_text}"),
                    code: Some("internal_error".into()),
                    raw: Some(serde_json::json!({
                        "errorKind": "authentication_failed"
                    })),
                    kind: Default::default(),
                    plan_usage: None,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let assistant_text = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. }
                if turn.role == TurnRole::Assistant =>
            {
                Some(
                    turn.blocks
                        .iter()
                        .filter_map(|block| match block {
                            ContentBlock::Text { text } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join(""),
                )
            }
            _ => None,
        });
        assert_eq!(assistant_text.as_deref(), None);
        assert!(
            timeline
                .rows
                .iter()
                .any(|row| matches!(row.row, ConversationTimelineRow::TurnError { .. }))
        );
    }

    #[tokio::test]
    async fn rows_since_returns_only_changed_rows() {
        // 批次C gap backfill: rows_since returns rows whose revision advanced past the
        // cursor, so the frontend upserts only what changed.
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "hi".into() }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        let cutoff = append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "a".into(),
                message_id: None,
            },
            None,
        )
        .await;
        // A later terminal event bumps the turn's rows past `cutoff`.
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted { stop_reason: None },
            None,
        )
        .await;

        let (rows, last_sequence) =
            ConversationProjector::rows_since(&pool, conversation_id, cutoff.sequence)
                .await
                .expect("rows since");
        assert!(last_sequence > cutoff.sequence);
        assert!(
            rows.iter().all(|row| row.revision > cutoff.sequence),
            "only rows changed after the cursor are returned"
        );
        assert!(
            rows.iter()
                .any(|row| row.row_id == format!("{turn_id}:assistant")),
            "the assistant row (bumped by turn completion) is included"
        );
    }

    #[tokio::test]
    async fn project_open_keeps_the_tail_without_shipping_the_full_row_vec() {
        let pool = setup_pool().await;
        let (conversation_id, _) = seed_turn(&pool).await;
        for index in 0..12 {
            let turn = ConversationTurnRecord::create_pending(
                &pool,
                Uuid::new_v4(),
                CreateConversationTurn {
                    conversation_id,
                    prompt_id: Some("prompt-1"),
                    text_preview: Some("hello"),
                    input_blocks_json: "[]",
                },
            )
            .await
            .expect("create turn");
            append_event(
                &pool,
                conversation_id,
                Some(turn.id),
                "user",
                ConversationEvent::UserTurnCreated {
                    blocks: vec![ConversationInputBlock::Text {
                        text: format!("turn {index}"),
                    }],
                    workflow_refs: Vec::new(),
                },
                None,
            )
            .await;
        }
        let full = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("full project");
        let open = ConversationProjector::project_open(&pool, conversation_id, 5)
            .await
            .expect("open project");
        assert!(full.rows.len() > 5);
        assert_eq!(open.timeline.rows.len(), 5);
        assert!(open.timeline.truncated_from_start);
        assert_eq!(
            open.timeline.older_cursor,
            Some((full.rows.len() - 5).to_string())
        );
        assert_eq!(
            open.timeline.rows.last().map(|row| row.row_id.as_str()),
            full.rows.last().map(|row| row.row_id.as_str())
        );
        let window = ConversationProjector::project_row_window(&pool, conversation_id, 2, 3)
            .await
            .expect("window");
        assert_eq!(window.total_rows, full.rows.len());
        assert_eq!(window.rows.len(), 3);
        assert_eq!(window.rows[0].row_id, full.rows[2].row_id);
    }

    #[tokio::test]
    async fn project_open_and_row_window_read_materialized_rows_without_fold_json() {
        let pool = setup_pool().await;
        let (conversation_id, _) = seed_turn(&pool).await;
        for index in 0..12 {
            let turn = ConversationTurnRecord::create_pending(
                &pool,
                Uuid::new_v4(),
                CreateConversationTurn {
                    conversation_id,
                    prompt_id: Some("prompt-1"),
                    text_preview: Some("hello"),
                    input_blocks_json: "[]",
                },
            )
            .await
            .expect("create turn");
            append_event(
                &pool,
                conversation_id,
                Some(turn.id),
                "user",
                ConversationEvent::UserTurnCreated {
                    blocks: vec![ConversationInputBlock::Text {
                        text: format!("turn {index}"),
                    }],
                    workflow_refs: Vec::new(),
                },
                None,
            )
            .await;
            append_event(
                &pool,
                conversation_id,
                Some(turn.id),
                "runtime",
                ConversationEvent::TurnCompleted { stop_reason: None },
                None,
            )
            .await;
        }

        let full = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("full project");
        let snapshot = ConversationProjectionSnapshotRecord::find(&pool, conversation_id)
            .await
            .expect("load snapshot")
            .expect("snapshot after settle");
        assert!(
            snapshot.total_rows > 5,
            "settle must persist open-window metadata"
        );
        let blank = serde_json::to_string(&ProjectionSnapshotState {
            last_sequence: snapshot.last_sequence,
            ..ProjectionSnapshotState::default()
        })
        .expect("blank fold");
        sqlx::query(
            "UPDATE conversation_projection_snapshots SET fold_json = ? WHERE conversation_id = ?",
        )
        .bind(&blank)
        .bind(conversation_id)
        .execute(&pool)
        .await
        .expect("wipe fold json");

        let open = ConversationProjector::project_open(&pool, conversation_id, 5)
            .await
            .expect("open from row table");
        assert_eq!(open.timeline.rows.len(), 5);
        assert!(open.timeline.truncated_from_start);
        assert_eq!(
            open.timeline.rows.last().map(|row| row.row_id.as_str()),
            full.rows.last().map(|row| row.row_id.as_str())
        );
        let window = ConversationProjector::project_row_window(&pool, conversation_id, 2, 3)
            .await
            .expect("window from row table");
        assert_eq!(window.total_rows, full.rows.len());
        assert_eq!(window.rows.len(), 3);
        assert_eq!(window.rows[0].row_id, full.rows[2].row_id);
        let (changed, last_sequence) = ConversationProjector::rows_since(&pool, conversation_id, 0)
            .await
            .expect("rows since from row table");
        assert_eq!(last_sequence, snapshot.last_sequence);
        assert_eq!(changed.len(), full.rows.len());
    }

    #[tokio::test]
    async fn permission_responded_folds_status_onto_row() {
        // 批次B: a responded (or recovery-voided) permission must reload as 'responded',
        // matching the live store — not perpetually 'pending'.
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::PermissionRequested {
                request: ConversationPermissionRequest {
                    permission_id: "perm-1".into(),
                    request: AgentPermissionRequest {
                        id: AgentPermissionId::new(),
                        session_id: AgentSessionId::new(),
                        title: "Allow edit?".into(),
                        details: None,
                        options: vec![AgentPermissionOption {
                            id: "allow".into(),
                            label: "Allow".into(),
                            kind: AgentPermissionOptionKind::AllowOnce,
                            description: None,
                        }],
                    },
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::PermissionResponded {
                permission_id: "perm-1".into(),
                response: ConversationPermissionResponse {
                    response: AgentPermissionResponse::Cancelled,
                    auto: true,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let status = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::PermissionRequest { request } => Some(request.status.clone()),
            _ => None,
        });
        assert_eq!(status.as_deref(), Some("responded"));
    }

    #[tokio::test]
    async fn auto_allowed_permissions_fold_into_a_count_notice() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::PermissionRequested {
                request: ConversationPermissionRequest {
                    permission_id: "perm-auto-1".into(),
                    request: AgentPermissionRequest {
                        id: AgentPermissionId::new(),
                        session_id: AgentSessionId::new(),
                        title: "Edit file".into(),
                        details: None,
                        options: vec![AgentPermissionOption {
                            id: "allow".into(),
                            label: "Allow".into(),
                            kind: AgentPermissionOptionKind::AllowOnce,
                            description: None,
                        }],
                    },
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::PermissionResponded {
                permission_id: "perm-auto-1".into(),
                response: ConversationPermissionResponse {
                    response: AgentPermissionResponse::selected("allow"),
                    auto: true,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::PermissionResponded {
                permission_id: "perm-auto-2".into(),
                response: ConversationPermissionResponse {
                    response: AgentPermissionResponse::selected("allow"),
                    auto: true,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let permission_cards = timeline
            .rows
            .iter()
            .filter(|row| matches!(row.row, ConversationTimelineRow::PermissionRequest { .. }))
            .count();
        assert_eq!(permission_cards, 0);
        let notice = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::SessionNotice { notice }
                if notice.title == "已自动批准权限" =>
            {
                Some(notice)
            }
            _ => None,
        });
        let notice = notice.expect("auto-permission notice");
        assert_eq!(notice.severity, "info");
        assert_eq!(notice.message.as_deref(), Some("已自动批准 2 项权限请求"));
        assert_eq!(
            timeline
                .rows
                .iter()
                .find(|row| row.row_id == "notice:auto-permission-approved")
                .map(|row| row.row_id.as_str()),
            Some("notice:auto-permission-approved")
        );
    }

    #[tokio::test]
    async fn timeline_preserves_reported_tool_status_independently_of_output() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        for (call_id, reported_status, output, expected_status, expected_error) in [
            (
                "running",
                Some("in_progress"),
                Some("partial output"),
                "in_progress",
                false,
            ),
            ("success", Some("completed"), None, "completed", false),
            ("failure", Some("failed"), None, "failed", true),
            ("failure", None, Some("late error output"), "failed", true),
        ] {
            append_event(
                &pool,
                conversation_id,
                Some(turn_id),
                "acp",
                ConversationEvent::ToolCallUpsert {
                    tool_call: ConversationToolCallPatch {
                        tool_call_id: call_id.into(),
                        title: Some("Running view_file".into()),
                        kind: Some("read".into()),
                        status: reported_status.map(str::to_string),
                        raw_input: Some(serde_json::json!({"AbsolutePath": "/workspace/main.rs"})),
                        raw_output: output.map(|text| serde_json::Value::String(text.into())),
                        raw_output_append: None,
                        content: None,
                        locations: None,
                        metadata: None,
                        images: Vec::new(),
                    },
                },
                None,
            )
            .await;

            let timeline = ConversationProjector::project(&pool, conversation_id)
                .await
                .expect("project tool status");
            let tools = ConversationToolCallRecord::list_for_turn(&pool, turn_id)
                .await
                .expect("stored tools");
            let stored = tools
                .iter()
                .find(|tool| tool.tool_call_id == call_id)
                .expect("stored tool");
            assert_eq!(
                stored.status,
                if expected_status == "in_progress" {
                    "running"
                } else {
                    expected_status
                }
            );
            let blocks: Vec<_> = timeline
                .rows
                .iter()
                .filter_map(|row| match &row.row {
                    ConversationTimelineRow::MessageTurn { turn, .. }
                        if turn.role == TurnRole::Assistant =>
                    {
                        Some(&turn.blocks)
                    }
                    _ => None,
                })
                .flatten()
                .collect();
            let statuses: Vec<_> = blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::ToolUse {
                        tool_use_id: Some(id),
                        status,
                        ..
                    } if id == call_id => Some(status.as_deref()),
                    _ => None,
                })
                .collect();
            assert_eq!(
                statuses,
                vec![Some(expected_status)],
                "one card with the reported status"
            );
            let results: Vec<_> = blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::ToolResult {
                        tool_use_id: Some(id),
                        is_error,
                        output_preview,
                        ..
                    } if id == call_id => Some((*is_error, output_preview.as_deref())),
                    _ => None,
                })
                .collect();
            assert_eq!(
                results.len(),
                1,
                "one result even for status-only completion"
            );
            assert_eq!(results[0].0, expected_error);
            if let Some(output) = output {
                assert!(results[0].1.expect("output preview").contains(output));
            }
        }
    }

    #[tokio::test]
    async fn antigravity_view_file_failures_settle_as_completed_reads() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let agent_id = AgentId::parse("antigravity").unwrap();
        ConversationAgentBindingRecord::create(
            &pool,
            Uuid::new_v4(),
            CreateConversationAgentBinding {
                conversation_id,
                agent_id: &agent_id,
                working_dir: "C:/workspace",
                acp_session_id: None,
                acp_protocol_version: None,
                runtime_version: None,
                acp_version: None,
                load_supported: false,
                resume_supported: false,
                close_supported: false,
                terminal_supported: false,
                additional_directories_supported: false,
                prompt_capabilities_json:
                    r#"{"text":true,"image":false,"audio":false,"resource":false,"resource_link":true}"#,
                session_capabilities_json: "{}",
                client_capabilities_json: "{}",
                mcp_servers_json: "[]",
                modes_json: "[]",
                config_options_json: "[]",
                current_mode: None,
                config_selection_json: "{}",
                status: db::models::conversation::BindingStatus::Ready,
            },
        )
        .await
        .expect("antigravity binding");

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "view-1".into(),
                    title: Some("Running view_file".into()),
                    kind: Some("read".into()),
                    status: Some("in_progress".into()),
                    raw_input: Some(serde_json::json!({"AbsolutePath": "C:/workspace/index.css"})),
                    raw_output: None,
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: None,
                    images: Vec::new(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "view-1".into(),
                    title: Some("view-1".into()),
                    kind: None,
                    status: Some("failed".into()),
                    raw_input: None,
                    raw_output: Some(serde_json::Value::String(
                        "Encountered retryable error from model provider: Error 502".into(),
                    )),
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: None,
                    images: Vec::new(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "run-1".into(),
                    title: Some("Running command".into()),
                    kind: Some("execute".into()),
                    status: Some("failed".into()),
                    raw_input: Some(serde_json::json!({"command":"npm test"})),
                    raw_output: Some(serde_json::Value::String(
                        "error executing cascade step: scratch missing".into(),
                    )),
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: None,
                    images: Vec::new(),
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project");
        let blocks: Vec<_> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some(&turn.blocks)
                }
                _ => None,
            })
            .flatten()
            .collect();
        let view_status = blocks.iter().find_map(|block| match block {
            ContentBlock::ToolUse {
                tool_use_id: Some(id),
                status,
                kind,
                ..
            } if id == "view-1" => Some((status.as_deref(), kind.as_deref())),
            _ => None,
        });
        assert_eq!(view_status, Some((Some("completed"), Some("read"))));
        let view_result = blocks.iter().find_map(|block| match block {
            ContentBlock::ToolResult {
                tool_use_id: Some(id),
                is_error,
                output_preview,
                ..
            } if id == "view-1" => Some((*is_error, output_preview.clone())),
            _ => None,
        });
        assert_eq!(view_result, Some((false, None)));
        let command_status = blocks.iter().find_map(|block| match block {
            ContentBlock::ToolUse {
                tool_use_id: Some(id),
                status,
                ..
            } if id == "run-1" => status.as_deref(),
            _ => None,
        });
        assert_eq!(command_status, Some("failed"));
    }

    #[tokio::test]
    async fn timeline_folds_tool_call_updates_into_one_block() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "tool-1".into(),
                    title: Some("Run tests".into()),
                    kind: Some("execute".into()),
                    status: Some("running".into()),
                    raw_input: Some(serde_json::json!({"command": "cargo test"})),
                    raw_output: None,
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: None,
                    images: Vec::new(),
                },
            },
            None,
        )
        .await;
        // A status/output update must fold into the existing card, not spawn a
        // second titleless block; the output attaches as an id-paired result.
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "tool-1".into(),
                    title: None,
                    kind: None,
                    status: Some("completed".into()),
                    raw_input: None,
                    raw_output: Some(serde_json::Value::String("all green".into())),
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: None,
                    images: Vec::new(),
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project");
        let blocks: Vec<_> = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some(&turn.blocks)
                }
                _ => None,
            })
            .flatten()
            .collect();

        let tool_uses: Vec<_> = blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolUse {
                    tool_use_id,
                    tool_name,
                    kind,
                    input_preview,
                    started_at,
                    ended_at,
                    ..
                } => Some((
                    tool_use_id,
                    tool_name,
                    kind,
                    input_preview,
                    started_at,
                    ended_at,
                )),
                _ => None,
            })
            .collect();
        assert_eq!(tool_uses.len(), 1, "update must not spawn a second block");
        let (tool_use_id, tool_name, kind, input_preview, started_at, ended_at) = &tool_uses[0];
        assert_eq!(tool_use_id.as_deref(), Some("tool-1"));
        assert!(
            started_at.is_some(),
            "tool start comes from the upsert event"
        );
        assert!(ended_at.is_some(), "terminal status stamps the tool end");
        assert!(ended_at.unwrap() >= started_at.unwrap());
        assert_eq!(tool_name.as_str(), "Run tests");
        assert_eq!(kind.as_deref(), Some("execute"));
        assert!(
            input_preview
                .as_deref()
                .unwrap_or("")
                .contains("cargo test"),
            "real input fields must survive"
        );

        let results: Vec<_> = blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolResult {
                    tool_use_id,
                    output_preview,
                    is_error,
                    ..
                } => Some((tool_use_id, output_preview, is_error)),
                _ => None,
            })
            .collect();
        assert_eq!(results.len(), 1);
        let (result_id, output_preview, is_error) = &results[0];
        assert_eq!(result_id.as_deref(), Some("tool-1"));
        assert_eq!(output_preview.as_deref(), Some("all green"));
        assert!(!**is_error);
    }

    #[tokio::test]
    async fn conversation_tool_projection_replaces_metadata_on_update() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "spawn-1".into(),
                    title: Some("spawn_subagent".into()),
                    kind: Some("other".into()),
                    status: Some("running".into()),
                    raw_input: Some(serde_json::json!({
                        "subagent_type": "explore",
                        "description": "Audit stream"
                    })),
                    raw_output: None,
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: None,
                    images: Vec::new(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "spawn-1".into(),
                    title: None,
                    kind: None,
                    status: None,
                    raw_input: None,
                    raw_output: None,
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: Some(serde_json::json!({
                        "subagent": {
                            "status": "running",
                            "progress": { "toolCallCount": 125, "contextUsagePct": 32 }
                        }
                    })),
                    images: Vec::new(),
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project");
        let meta = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. }
                if turn.role == TurnRole::Assistant =>
            {
                turn.blocks.iter().find_map(|block| match block {
                    ContentBlock::ToolUse { meta, .. } => meta.clone(),
                    _ => None,
                })
            }
            _ => None,
        });
        assert_eq!(
            meta.and_then(|value| value["subagent"]["progress"]["toolCallCount"].as_u64()),
            Some(125)
        );
    }

    #[tokio::test]
    async fn timeline_preserves_images_viewed_by_a_tool_call() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "view-image-1".into(),
                    title: Some("View image".into()),
                    kind: Some("read".into()),
                    status: Some("completed".into()),
                    raw_input: Some(serde_json::json!({"path": "assets/logo.png"})),
                    raw_output: None,
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: None,
                    images: vec![agents::conversation::ImageData {
                        data: "AAAA".into(),
                        mime_type: "image/png".into(),
                        uri: Some("assets/logo.png".into()),
                        width: None,
                        height: None,
                    }],
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project");
        let images = timeline
            .rows
            .iter()
            .filter_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some(&turn.blocks)
                }
                _ => None,
            })
            .flatten()
            .find_map(|block| match block {
                ContentBlock::ToolUse { images, .. } => Some(images),
                _ => None,
            })
            .expect("tool images");

        assert!(images[0].data.is_empty());
        assert_eq!(images[0].mime_type, "image/png");
        assert!(images[0].uri.as_deref().is_some_and(
            |uri| uri.starts_with("vibex-image:") && uri.len() == "vibex-image:".len() + 64
        ));
    }

    #[tokio::test]
    async fn conversation_timeline_projection_covers_interaction_side_rows() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::QuestionRequested {
                request: ConversationQuestionRequest {
                    question_id: "question-1".into(),
                    prompt: "Pick one".into(),
                    options: vec!["A".into(), "B".into()],
                    asked_at: None,
                    schema: None,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::FeedbackRequested {
                request: ConversationFeedbackRequest {
                    feedback_id: "feedback-1".into(),
                    prompt: "Was this useful?".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationStarted {
                delegation: ConversationDelegation {
                    delegation_id: "delegation-1".into(),
                    parent_tool_call_id: "tool-1".into(),
                    child_conversation_id: Uuid::new_v4(),
                    agent_id: AgentId::parse("codex").unwrap(),
                    task_preview: "Review diff".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationCompleted {
                delegation_id: "delegation-1".into(),
                result: ConversationDelegationResult::Ok {
                    text_preview: Some("done".into()),
                    duration_ms: Some(10),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::SessionConfigStale {
                stale: true,
                reason: Some("settings changed".into()),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::RawDiagnosticRecorded {
                label: "stream recovered".into(),
                payload: None,
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let kinds = timeline
            .rows
            .iter()
            .map(|row| match &row.row {
                ConversationTimelineRow::QuestionRequest { .. } => "question",
                ConversationTimelineRow::FeedbackRequest { .. } => "feedback",
                ConversationTimelineRow::Delegation { .. } => "delegation",
                ConversationTimelineRow::SessionNotice { .. } => "notice",
                _ => "other",
            })
            .collect::<Vec<_>>();

        assert!(kinds.contains(&"question"));
        assert!(kinds.contains(&"feedback"));
        // started + completed fold into a single delegation card that keeps the
        // start-event context and carries the completion result.
        assert_eq!(
            kinds.iter().filter(|kind| **kind == "delegation").count(),
            1
        );
        let delegation = timeline
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::Delegation { delegation } => Some(delegation),
                _ => None,
            })
            .expect("delegation row");
        assert_eq!(delegation.status, "completed");
        assert_eq!(delegation.task_preview.as_deref(), Some("Review diff"));
        assert!(delegation.child_conversation_id.is_some());
        assert!(matches!(
            delegation.result,
            Some(ConversationDelegationResult::Ok { .. })
        ));
        assert_eq!(kinds.iter().filter(|kind| **kind == "notice").count(), 2);
    }

    #[tokio::test]
    async fn delegation_events_rebuild_child_binding() {
        let (_dir, pool) = setup_temp_pool().await;
        let (parent_conversation_id, turn_id) = seed_turn(&pool).await;
        let child_conversation_id = Uuid::new_v4();
        let delegation_id = "delegation-call-1";
        create_delegated_conversation(
            &pool,
            CreateDelegatedConversation {
                id: child_conversation_id,
                parent_conversation_id,
                parent_tool_call_id: "tool-1".into(),
                delegation_id: delegation_id.into(),
                agent_id: AgentId::parse("codex").unwrap(),
                prompt: "Review the diff".into(),
                policy: serde_json::json!({"workspaceAccess": "write_serialized"}),
            },
        )
        .await
        .expect("persist delegated child");
        append_event(
            &pool,
            parent_conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationStarted {
                delegation: ConversationDelegation {
                    delegation_id: delegation_id.into(),
                    parent_tool_call_id: "tool-1".into(),
                    child_conversation_id,
                    agent_id: AgentId::parse("codex").unwrap(),
                    task_preview: "Review the diff".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            parent_conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationCompleted {
                delegation_id: delegation_id.into(),
                result: ConversationDelegationResult::Ok {
                    text_preview: Some("done".into()),
                    duration_ms: Some(10),
                },
            },
            None,
        )
        .await;

        let before = ConversationProjector::project(&pool, parent_conversation_id)
            .await
            .expect("project before rebuild");
        ConversationProjector::rebuild_projection(&pool, parent_conversation_id)
            .await
            .expect("rebuild projection");
        let after = ConversationProjector::project(&pool, parent_conversation_id)
            .await
            .expect("project after rebuild");
        assert_eq!(after, before);
        let delegation = after
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::Delegation { delegation } => Some(delegation),
                _ => None,
            })
            .expect("delegation row");
        assert_eq!(delegation.delegation_id, delegation_id);
        assert_eq!(
            delegation.child_conversation_id,
            Some(child_conversation_id)
        );
        assert_eq!(delegation.status, "completed");
        let child = Session::find_by_delegation_call_id(&pool, delegation_id)
            .await
            .expect("find child")
            .expect("child exists");
        assert_eq!(child.parent_session_id, Some(parent_conversation_id));
        assert_eq!(child.parent_tool_use_id.as_deref(), Some("tool-1"));
        let relation = ConversationRelationRecord::find(
            &pool,
            parent_conversation_id,
            child_conversation_id,
            "delegation",
        )
        .await
        .expect("find relation")
        .expect("relation exists");
        let metadata: serde_json::Value =
            serde_json::from_str(&relation.metadata_json).expect("relation metadata");
        assert_eq!(metadata["policy"]["workspaceAccess"], "write_serialized");
    }

    #[tokio::test]
    async fn canceled_delegation_remains_canceled_after_projection_rebuild() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        let delegation_id = "delegation-canceled-1";
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationStarted {
                delegation: ConversationDelegation {
                    delegation_id: delegation_id.into(),
                    parent_tool_call_id: "tool-canceled-1".into(),
                    child_conversation_id: Uuid::new_v4(),
                    agent_id: AgentId::parse("codex").unwrap(),
                    task_preview: "Review cancellation behavior".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::DelegationCompleted {
                delegation_id: delegation_id.into(),
                result: ConversationDelegationResult::Err {
                    error: ConversationError {
                        message: "canceled by request".into(),
                        code: Some("canceled".into()),
                        raw: None,
                        kind: Default::default(),
                        plan_usage: None,
                    },
                },
            },
            None,
        )
        .await;

        ConversationProjector::rebuild_projection(&pool, conversation_id)
            .await
            .expect("rebuild projection");
        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project rebuilt timeline");
        let delegation = timeline
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::Delegation { delegation } => Some(delegation),
                _ => None,
            })
            .expect("delegation row");

        assert_eq!(delegation.status, "canceled");
        assert!(delegation.child_conversation_id.is_some());
    }

    #[tokio::test]
    async fn permission_view_carries_real_acp_detail_and_options() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        let request = AgentPermissionRequest {
            id: AgentPermissionId::new(),
            session_id: AgentSessionId::new(),
            title: "Edit README.md".into(),
            details: Some(serde_json::json!({
                "fields": { "kind": "edit", "content": [
                    { "type": "diff", "path": "README.md", "oldText": "a", "newText": "b" }
                ] }
            })),
            options: vec![
                AgentPermissionOption {
                    id: "allow".into(),
                    label: "Allow".into(),
                    kind: AgentPermissionOptionKind::AllowOnce,
                    description: None,
                },
                AgentPermissionOption {
                    id: "deny".into(),
                    label: "Deny".into(),
                    kind: AgentPermissionOptionKind::RejectOnce,
                    description: None,
                },
            ],
        };
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::PermissionRequested {
                request: ConversationPermissionRequest {
                    permission_id: "permission-1".into(),
                    request,
                },
            },
            None,
        )
        .await;

        // Reloading through the projection must preserve the full tool detail and
        // the selectable options — the card relies on these to show the real diff
        // and offer the real Allow/Reject answers after a refresh.
        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let permission = timeline
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::PermissionRequest { request } => Some(request),
                _ => None,
            })
            .expect("permission row");

        assert_eq!(permission.permission_id, "permission-1");
        assert_eq!(permission.status, "pending");
        assert_eq!(permission.options.len(), 2);
        assert_eq!(permission.options[0].id, "allow");
        let detail = permission.details.as_ref().expect("details preserved");
        assert_eq!(detail["fields"]["kind"], "edit");
        assert_eq!(detail["fields"]["content"][0]["path"], "README.md");
    }

    #[tokio::test]
    async fn delegated_child_assistant_deltas_without_a_turn_still_render() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: Some("introduce yourself"),
                status: None,
                executor: Some("agent"),
            },
        )
        .await
        .expect("create child conversation");

        append_event(
            &pool,
            conversation_id,
            None,
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "你好，我是 Codex".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::TurnCompleted {
                stop_reason: Some("EndTurn".into()),
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project orphan assistant stream");
        let assistant = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. }
                if turn.role == TurnRole::Assistant =>
            {
                Some(turn)
            }
            _ => None,
        });
        let assistant = assistant.expect("assistant message");
        assert!(
            assistant.blocks.iter().any(
                |block| matches!(block, ContentBlock::Text { text } if text.contains("Codex"))
            )
        );
        let user = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. } if turn.role == TurnRole::User => {
                Some(turn)
            }
            _ => None,
        });
        let user = user.expect("session prompt becomes the user message");
        assert!(user.blocks.iter().any(
            |block| matches!(block, ContentBlock::Text { text } if text == "introduce yourself")
        ));
    }

    #[tokio::test]
    async fn delegated_child_identity_is_linked_before_the_first_turn() {
        let pool = setup_pool().await;
        let (parent_conversation_id, _) = seed_turn(&pool).await;
        let child_conversation_id = Uuid::new_v4();
        create_delegated_conversation(
            &pool,
            CreateDelegatedConversation {
                id: child_conversation_id,
                parent_conversation_id,
                parent_tool_call_id: "tool-1".into(),
                delegation_id: "delegation-call-1".into(),
                agent_id: AgentId::parse("codex").unwrap(),
                prompt: "Review the diff".into(),
                policy: serde_json::json!({"workspaceAccess": "write_serialized"}),
            },
        )
        .await
        .expect("persist delegated child");

        let child = Session::find_by_id(&pool, child_conversation_id)
            .await
            .expect("load child")
            .expect("child row");
        assert_eq!(child.parent_session_id, Some(parent_conversation_id));
        assert_eq!(child.initial_prompt.as_deref(), Some("Review the diff"));
        let active_turn_id: Option<Uuid> =
            sqlx::query_scalar("SELECT active_turn_id FROM sessions WHERE id = ?")
                .bind(child_conversation_id)
                .fetch_one(&pool)
                .await
                .expect("load active turn");
        assert!(
            active_turn_id.is_none(),
            "identity must not pre-commit an in-flight Turn"
        );
        let timeline = ConversationProjector::project(&pool, child_conversation_id)
            .await
            .expect("project child");
        let user = timeline.rows.iter().find_map(|row| match &row.row {
            ConversationTimelineRow::MessageTurn { turn, .. } if turn.role == TurnRole::User => {
                Some(turn)
            }
            _ => None,
        });
        let user = user.expect("initial prompt is visible before the first turn");
        assert!(user.blocks.iter().any(
            |block| matches!(block, ContentBlock::Text { text } if text == "Review the diff")
        ));
    }

    #[tokio::test]
    async fn conversation_timeline_projection_folds_messages_and_errors() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "hello".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "he".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "llo".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::UsageUpdated {
                usage: ConversationUsage {
                    input_tokens: 1,
                    output_tokens: 2,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    context_used: Some(120),
                    context_window_max: Some(200_000),
                    cost_amount: None,
                    cost_currency: None,
                    model: None,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".into()),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnFailed {
                error: ConversationError {
                    message: "late visible error".into(),
                    code: None,
                    raw: None,
                    kind: Default::default(),
                    plan_usage: None,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project timeline");
        assert_eq!(timeline.last_sequence, 6);
        assert!(timeline.rows.len() >= 3);
        assert!(matches!(
            timeline.rows[0].row,
            ConversationTimelineRow::MessageTurn { .. }
        ));
        assert!(
            timeline
                .rows
                .iter()
                .any(|row| matches!(row.row, ConversationTimelineRow::TurnError { .. }))
        );
    }

    #[tokio::test]
    async fn rebuild_projection_matches_incremental_and_repopulates_tables() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text { text: "hi".into() }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "hello".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::ToolCallUpsert {
                tool_call: ConversationToolCallPatch {
                    tool_call_id: "tool-1".into(),
                    title: Some("Edit".into()),
                    kind: Some("edit".into()),
                    status: Some("completed".into()),
                    raw_input: Some(serde_json::json!({"path":"a.rs"})),
                    raw_output: Some(serde_json::json!({"ok":true})),
                    raw_output_append: None,
                    content: None,
                    locations: None,
                    metadata: None,
                    images: Vec::new(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "runtime",
            ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".into()),
            },
            None,
        )
        .await;

        // The snapshot path (materialized on the TurnCompleted settle) must equal a
        // pure full fold of the same events.
        let incremental = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project via snapshot");
        let all_events = ConversationEventRecord::events_since(&pool, conversation_id, 0, i64::MAX)
            .await
            .expect("events");
        let pure = ConversationProjector::project_records(conversation_id, &all_events)
            .expect("pure fold");
        assert_eq!(incremental, pure, "snapshot+tail must equal pure fold");

        let tools_before =
            db::models::conversation_tool::ConversationToolCallRecord::list_for_conversation(
                &pool,
                conversation_id,
            )
            .await
            .expect("tools")
            .len();
        assert_eq!(tools_before, 1);

        // Authoritative rebuild from the event log must reproduce both the timeline
        // and the derived projection tables (without duplicating rows).
        ConversationProjector::rebuild_projection(&pool, conversation_id)
            .await
            .expect("rebuild");
        let rebuilt = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project after rebuild");
        assert_eq!(rebuilt, pure, "rebuilt projection must equal pure fold");

        let tools_after =
            db::models::conversation_tool::ConversationToolCallRecord::list_for_conversation(
                &pool,
                conversation_id,
            )
            .await
            .expect("tools")
            .len();
        assert_eq!(
            tools_after, 1,
            "rebuild must repopulate (not duplicate) derived tables"
        );
    }

    #[tokio::test]
    async fn question_and_feedback_responses_fold_onto_rows() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;

        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::QuestionRequested {
                request: ConversationQuestionRequest {
                    question_id: "q1".into(),
                    prompt: "Pick".into(),
                    options: vec!["A".into(), "B".into()],
                    asked_at: None,
                    schema: None,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::QuestionResponded {
                question_id: "q1".into(),
                response: ConversationQuestionResponse {
                    answer: "A".into(),
                    content: None,
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::FeedbackRequested {
                request: ConversationFeedbackRequest {
                    feedback_id: "f1".into(),
                    prompt: "Rate".into(),
                },
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "host",
            ConversationEvent::FeedbackSubmitted {
                feedback_id: "f1".into(),
                response: ConversationFeedbackResponse {
                    rating: "up".into(),
                    comment: None,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project");
        let question_answered = timeline.rows.iter().any(|row| {
            matches!(
                &row.row,
                ConversationTimelineRow::QuestionRequest { response: Some(answer), .. }
                    if answer.answer == "A"
            )
        });
        assert!(
            question_answered,
            "answered question must carry its response after the fold"
        );
        let feedback_answered = timeline.rows.iter().any(|row| {
            matches!(
                &row.row,
                ConversationTimelineRow::FeedbackRequest { response: Some(resp), .. }
                    if resp.rating == "up"
            )
        });
        assert!(
            feedback_answered,
            "submitted feedback must carry its response after the fold"
        );
    }

    #[tokio::test]
    async fn truncate_to_turn_ordinal_drops_target_turn_and_tail() {
        let pool = setup_pool().await;
        let (conversation_id, turn1_id) = seed_turn(&pool).await; // ordinal 1

        // Turn 1 (ordinal 1): user → assistant → completed (sequences 1,2,3).
        append_event(
            &pool,
            conversation_id,
            Some(turn1_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "first".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn1_id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "one".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn1_id),
            "runtime",
            ConversationEvent::TurnCompleted {
                stop_reason: Some("end_turn".into()),
            },
            None,
        )
        .await;

        // Turn 2 (ordinal 2): user → assistant (sequences 4,5).
        let turn2 = ConversationTurnRecord::create_pending(
            &pool,
            Uuid::new_v4(),
            CreateConversationTurn {
                conversation_id,
                prompt_id: Some("prompt-2"),
                text_preview: Some("second"),
                input_blocks_json: "[]",
            },
        )
        .await
        .expect("create turn 2");
        assert_eq!(turn2.ordinal, 2);
        append_event(
            &pool,
            conversation_id,
            Some(turn2.id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "second".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn2.id),
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "two".into(),
                message_id: None,
            },
            None,
        )
        .await;

        let before = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project before");
        assert_eq!(before.last_sequence, 5);

        // Reset to here: drop turn 2 (ordinal 2) and everything after.
        ConversationProjector::truncate_to_turn_ordinal(&pool, conversation_id, 2)
            .await
            .expect("truncate");

        let remaining = ConversationTurnRecord::list_for_conversation(&pool, conversation_id)
            .await
            .expect("list turns");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].ordinal, 1);

        let event_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM conversation_events WHERE conversation_id = ?",
        )
        .bind(conversation_id)
        .fetch_one(&pool)
        .await
        .expect("count events");
        assert_eq!(event_count, 3, "only turn 1's three events survive");

        let after = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("project after");
        assert_eq!(after.last_sequence, 3);
    }

    #[tokio::test]
    async fn truncate_to_turn_does_not_requeue_the_truncated_turn_input() {
        let pool = setup_pool().await;
        let conversation_id = Uuid::new_v4();
        ConversationRecord::create(
            &pool,
            conversation_id,
            CreateConversationRecord {
                workspace_id: Uuid::new_v4(),
                task_id: None,
                title: None,
                initial_prompt: None,
                status: None,
                executor: Some("codex"),
            },
        )
        .await
        .expect("create conversation");

        let (kept_input_id, _) = seed_durable_input_turn(&pool, conversation_id, "first").await;
        let (resent_input_id, _) = seed_durable_input_turn(&pool, conversation_id, "hello").await;
        let queued_follow_up = Uuid::new_v4();
        append_event(
            &pool,
            conversation_id,
            None,
            "user",
            ConversationEvent::ConversationInput {
                event: ConversationInputEvent::Submitted {
                    input_id: queued_follow_up,
                    operation_id: Uuid::new_v4(),
                    revision: 1,
                    sort_key: ConversationInputRecord::next_sort_key(&pool, conversation_id)
                        .await
                        .expect("sort key"),
                    payload_digest: format!("digest-{queued_follow_up}"),
                    payload: test_input_payload("follow-up"),
                    principal: serde_json::json!({ "kind": "test" }),
                },
            },
            None,
        )
        .await;

        ConversationProjector::truncate_to_turn_ordinal(&pool, conversation_id, 2)
            .await
            .expect("truncate");

        let remaining = ConversationInputRecord::list_for_conversation(&pool, conversation_id)
            .await
            .expect("list inputs");
        assert_eq!(
            remaining.iter().map(|input| input.id).collect::<Vec<_>>(),
            vec![kept_input_id],
            "reset-to-here must drop the truncated turn input and later queued follow-ups, or resend submits a duplicate"
        );
        assert_eq!(remaining[0].status, "dispatched");
        assert!(
            ConversationInputRecord::find_by_id(&pool, resent_input_id)
                .await
                .expect("lookup resent input")
                .is_none()
        );
        assert!(
            ConversationInputRecord::find_by_id(&pool, queued_follow_up)
                .await
                .expect("lookup follow-up")
                .is_none()
        );
    }

    #[tokio::test]
    async fn usage_occupancy_and_plan_status_replace_the_turn_block() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "do work".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::PlanUpdated {
                entries: vec![ConversationPlanEntry {
                    id: "plan-0".into(),
                    content: "Write tests".into(),
                    status: "pending".into(),
                    priority: Some("high".into()),
                }],
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::PlanUpdated {
                entries: vec![ConversationPlanEntry {
                    id: "plan-0".into(),
                    content: "Write tests".into(),
                    status: "completed".into(),
                    priority: Some("high".into()),
                }],
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "acp",
            ConversationEvent::UsageUpdated {
                usage: ConversationUsage {
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    context_used: Some(12_000),
                    context_window_max: Some(200_000),
                    cost_amount: None,
                    cost_currency: None,
                    model: None,
                },
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let assistant = timeline
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some(turn)
                }
                _ => None,
            })
            .expect("assistant turn");

        let plan_blocks = assistant
            .blocks
            .iter()
            .filter(|block| matches!(block, ContentBlock::Plan { .. }))
            .count();
        assert_eq!(plan_blocks, 1, "plan updates replace the existing block");
        match assistant.blocks.iter().find_map(|block| match block {
            ContentBlock::Plan { entries } => Some(entries.as_slice()),
            _ => None,
        }) {
            Some([entry]) => {
                assert_eq!(entry.content, "Write tests");
                assert_eq!(entry.status, "completed");
                assert_eq!(entry.priority.as_deref(), Some("high"));
            }
            other => panic!("expected one completed plan entry, got {other:?}"),
        }

        let usage = assistant.usage.as_ref().expect("usage");
        assert_eq!(usage.context_used, Some(12_000));
        assert_eq!(usage.context_window_max, Some(200_000));
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
    }

    #[tokio::test]
    async fn turn_less_late_updates_attach_to_the_latest_turn() {
        let pool = setup_pool().await;
        let (conversation_id, turn_id) = seed_turn(&pool).await;
        append_event(
            &pool,
            conversation_id,
            Some(turn_id),
            "user",
            ConversationEvent::UserTurnCreated {
                blocks: vec![ConversationInputBlock::Text {
                    text: "late".into(),
                }],
                workflow_refs: Vec::new(),
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            None,
            "acp",
            ConversationEvent::AssistantTextDelta {
                text: "visible".into(),
                message_id: None,
            },
            None,
        )
        .await;
        append_event(
            &pool,
            conversation_id,
            None,
            "acp",
            ConversationEvent::AssistantContentAppended {
                block: ContentBlock::Resource {
                    uri: "file:///tmp/a.md".into(),
                    title: Some("a.md".into()),
                },
                message_id: None,
            },
            None,
        )
        .await;

        let timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline");
        let assistant = timeline
            .rows
            .iter()
            .find_map(|row| match &row.row {
                ConversationTimelineRow::MessageTurn { turn, .. }
                    if turn.role == TurnRole::Assistant =>
                {
                    Some(turn)
                }
                _ => None,
            })
            .expect("assistant row");
        assert!(
            assistant
                .blocks
                .iter()
                .any(|block| matches!(block, ContentBlock::Text { text } if text == "visible"))
        );
        assert!(assistant.blocks.iter().any(|block| matches!(
            block,
            ContentBlock::Resource { uri, .. } if uri == "file:///tmp/a.md"
        )));
    }

    #[tokio::test]
    async fn agent_binding_recovery_failed_notice_is_cleared_by_subsequent_recovery() {
        let pool = setup_pool().await;
        let (conversation_id, _turn_id) = seed_turn(&pool).await;
        append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentBindingRecoveryFailed {
                reason: "Failed to load session, starting new: Path not found.".into(),
            },
            None,
        )
        .await;
        let failed_timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline with failure");
        assert!(failed_timeline.rows.iter().any(|row| {
            matches!(
                &row.row,
                ConversationTimelineRow::SessionNotice { notice }
                    if notice.title == "Agent session recovery failed"
            )
        }));

        append_event(
            &pool,
            conversation_id,
            None,
            "runtime",
            ConversationEvent::AgentBindingRecovered {
                strategy: agents::SessionRecoveryStrategy::CreatedNewSession,
                continues_from: Some("old-sid".into()),
            },
            None,
        )
        .await;
        let recovered_timeline = ConversationProjector::project(&pool, conversation_id)
            .await
            .expect("timeline after recovery");
        assert!(
            !recovered_timeline.rows.iter().any(|row| {
                matches!(
                    &row.row,
                    ConversationTimelineRow::SessionNotice { notice }
                        if notice.title == "Agent session recovery failed"
                )
            }),
            "AgentBindingRecovered must clear the AgentBindingRecoveryFailed error banner"
        );
    }
}
