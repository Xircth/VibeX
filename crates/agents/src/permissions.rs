use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ids::{AgentPermissionId, AgentSessionId};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentAutoApproveMode {
    #[default]
    Off,
    AllowAlways,
    Yolo,
}

impl AgentAutoApproveMode {
    pub fn from_setting(value: &str) -> Self {
        match value {
            "allow_always" => Self::AllowAlways,
            "yolo" => Self::Yolo,
            _ => Self::Off,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
#[ts(export)]
pub enum AgentPermissionOptionKind {
    AllowOnce,
    AllowAlways,
    RejectOnce,
    RejectAlways,
    #[default]
    Unknown,
}

impl AgentPermissionOptionKind {
    pub fn is_allow(self) -> bool {
        matches!(self, Self::AllowOnce | Self::AllowAlways)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPermissionOption {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub kind: AgentPermissionOptionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AgentPermissionRequest {
    pub id: AgentPermissionId,
    pub session_id: AgentSessionId,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    pub options: Vec<AgentPermissionOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum AgentPermissionResponse {
    Selected { option_id: String },
    Cancelled,
}

/// A human's explicit approval intent, expressed out-of-band (e.g. an IM
/// `/approve` / `/deny` command) rather than through the desktop permission UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemotePermissionIntent {
    ApproveOnce,
    ApproveAlways,
    Deny,
}

/// Map an explicit remote approval intent onto one of a request's agent-supplied
/// options.
///
/// - Approve resolves to the most specific matching allow option, falling back
///   to any allow option; if the request exposes no allow option it is not
///   actionable (`None`) so the caller can report it rather than mis-reject.
/// - Deny resolves to a reject option when one exists, otherwise cancels the
///   request outright — deny must never fall through to an allow.
pub fn decide_remote_permission_response(
    intent: RemotePermissionIntent,
    options: &[AgentPermissionOption],
) -> Option<AgentPermissionResponse> {
    let select = |option: &AgentPermissionOption| AgentPermissionResponse::Selected {
        option_id: option.id.clone(),
    };
    match intent {
        RemotePermissionIntent::ApproveOnce => options
            .iter()
            .find(|option| option.kind == AgentPermissionOptionKind::AllowOnce)
            .or_else(|| options.iter().find(|option| option.kind.is_allow()))
            .map(select),
        RemotePermissionIntent::ApproveAlways => options
            .iter()
            .find(|option| option.kind == AgentPermissionOptionKind::AllowAlways)
            .or_else(|| options.iter().find(|option| option.kind.is_allow()))
            .map(select),
        RemotePermissionIntent::Deny => Some(
            options
                .iter()
                .find(|option| option.kind == AgentPermissionOptionKind::RejectOnce)
                .or_else(|| {
                    options
                        .iter()
                        .find(|option| option.kind == AgentPermissionOptionKind::RejectAlways)
                })
                .map(select)
                .unwrap_or(AgentPermissionResponse::Cancelled),
        ),
    }
}

pub fn decide_auto_permission_response(
    mode: AgentAutoApproveMode,
    request: &AgentPermissionRequest,
) -> Option<AgentPermissionResponse> {
    match mode {
        AgentAutoApproveMode::Off => None,
        AgentAutoApproveMode::AllowAlways => request
            .options
            .iter()
            .find(|option| option.kind == AgentPermissionOptionKind::AllowAlways)
            .or_else(|| request.options.iter().find(|option| option.kind.is_allow()))
            .map(|option| AgentPermissionResponse::Selected {
                option_id: option.id.clone(),
            }),
        AgentAutoApproveMode::Yolo => request
            .options
            .iter()
            .find(|option| option.kind.is_allow())
            .map(|option| AgentPermissionResponse::Selected {
                option_id: option.id.clone(),
            }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request_with_options(options: Vec<AgentPermissionOption>) -> AgentPermissionRequest {
        AgentPermissionRequest {
            id: AgentPermissionId::new(),
            session_id: AgentSessionId::new(),
            title: "Run tool".to_string(),
            details: None,
            options,
        }
    }

    fn option(id: &str, kind: AgentPermissionOptionKind) -> AgentPermissionOption {
        AgentPermissionOption {
            id: id.to_string(),
            label: id.to_string(),
            kind,
            description: None,
        }
    }

    #[test]
    fn auto_permission_off_never_selects() {
        let request =
            request_with_options(vec![option("allow", AgentPermissionOptionKind::AllowOnce)]);

        assert_eq!(
            decide_auto_permission_response(AgentAutoApproveMode::Off, &request),
            None
        );
    }

    #[test]
    fn auto_permission_yolo_selects_first_allow_option() {
        let request = request_with_options(vec![
            option("reject", AgentPermissionOptionKind::RejectOnce),
            option("allow-once", AgentPermissionOptionKind::AllowOnce),
            option("allow-always", AgentPermissionOptionKind::AllowAlways),
        ]);

        assert_eq!(
            decide_auto_permission_response(AgentAutoApproveMode::Yolo, &request),
            Some(AgentPermissionResponse::Selected {
                option_id: "allow-once".to_string()
            })
        );
    }

    #[test]
    fn auto_permission_allow_always_prefers_persistent_allow() {
        let request = request_with_options(vec![
            option("allow-once", AgentPermissionOptionKind::AllowOnce),
            option("allow-always", AgentPermissionOptionKind::AllowAlways),
        ]);

        assert_eq!(
            decide_auto_permission_response(AgentAutoApproveMode::AllowAlways, &request),
            Some(AgentPermissionResponse::Selected {
                option_id: "allow-always".to_string()
            })
        );
    }

    #[test]
    fn auto_permission_does_not_select_reject_only_requests() {
        let request = request_with_options(vec![option(
            "reject",
            AgentPermissionOptionKind::RejectAlways,
        )]);

        assert_eq!(
            decide_auto_permission_response(AgentAutoApproveMode::Yolo, &request),
            None
        );
    }

    // ── Remote (IM) approval intent → option selection (P0-1) ──

    #[test]
    fn remote_approve_once_prefers_allow_once() {
        let request = request_with_options(vec![
            option("reject", AgentPermissionOptionKind::RejectOnce),
            option("allow-once", AgentPermissionOptionKind::AllowOnce),
            option("allow-always", AgentPermissionOptionKind::AllowAlways),
        ]);
        assert_eq!(
            decide_remote_permission_response(
                RemotePermissionIntent::ApproveOnce,
                &request.options
            ),
            Some(AgentPermissionResponse::Selected {
                option_id: "allow-once".to_string()
            })
        );
    }

    #[test]
    fn remote_approve_always_prefers_persistent_allow() {
        let request = request_with_options(vec![
            option("allow-once", AgentPermissionOptionKind::AllowOnce),
            option("allow-always", AgentPermissionOptionKind::AllowAlways),
        ]);
        assert_eq!(
            decide_remote_permission_response(
                RemotePermissionIntent::ApproveAlways,
                &request.options
            ),
            Some(AgentPermissionResponse::Selected {
                option_id: "allow-always".to_string()
            })
        );
    }

    #[test]
    fn remote_approve_once_falls_back_to_any_allow() {
        let request = request_with_options(vec![option(
            "only-always",
            AgentPermissionOptionKind::AllowAlways,
        )]);
        assert_eq!(
            decide_remote_permission_response(
                RemotePermissionIntent::ApproveOnce,
                &request.options
            ),
            Some(AgentPermissionResponse::Selected {
                option_id: "only-always".to_string()
            })
        );
    }

    #[test]
    fn remote_deny_prefers_reject_once() {
        let request = request_with_options(vec![
            option("allow", AgentPermissionOptionKind::AllowOnce),
            option("reject-once", AgentPermissionOptionKind::RejectOnce),
            option("reject-always", AgentPermissionOptionKind::RejectAlways),
        ]);
        assert_eq!(
            decide_remote_permission_response(RemotePermissionIntent::Deny, &request.options),
            Some(AgentPermissionResponse::Selected {
                option_id: "reject-once".to_string()
            })
        );
    }

    // Denying a request that exposes no reject option still stops the tool by
    // cancelling the permission — deny must never fall through to an allow.
    #[test]
    fn remote_deny_without_reject_option_cancels() {
        let request =
            request_with_options(vec![option("allow", AgentPermissionOptionKind::AllowOnce)]);
        assert_eq!(
            decide_remote_permission_response(RemotePermissionIntent::Deny, &request.options),
            Some(AgentPermissionResponse::Cancelled)
        );
    }

    // Approving a request that exposes no allow option is not actionable —
    // return None so the caller reports it rather than silently rejecting.
    #[test]
    fn remote_approve_without_allow_option_is_unactionable() {
        let request = request_with_options(vec![option(
            "reject",
            AgentPermissionOptionKind::RejectOnce,
        )]);
        assert_eq!(
            decide_remote_permission_response(
                RemotePermissionIntent::ApproveOnce,
                &request.options
            ),
            None
        );
    }
}
