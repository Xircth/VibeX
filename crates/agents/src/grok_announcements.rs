//! Grok's `x.ai/announcements/update` product banners.
//!
//! These are session-agnostic host notices (release notes, outages, CLI
//! updates), not conversation turns. Empty lists mean "nothing to show".

use serde::Deserialize;
use serde_json::Value;

use crate::{
    AgentId,
    conversation::{ConversationNoticeAction, ConversationSessionNotice},
};

pub const ANNOUNCEMENTS_UPDATE_METHOD: &str = "x.ai/announcements/update";

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AnnouncementsUpdate {
    #[serde(default, rename = "gen")]
    pub generation: u64,
    #[serde(default)]
    pub announcements: Vec<RemoteAnnouncement>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RemoteAnnouncement {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub severity: Option<String>,
    #[serde(default)]
    pub cta: Option<AnnouncementCta>,
    #[serde(default)]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct AnnouncementCta {
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

pub fn is_announcements_method(method: &str) -> bool {
    crate::grok_ask::normalize_method(method) == ANNOUNCEMENTS_UPDATE_METHOD
}

pub fn parse_update(params: &Value) -> Option<AnnouncementsUpdate> {
    let payload = params
        .get("params")
        .filter(|inner| inner.get("announcements").is_some() || inner.get("gen").is_some())
        .unwrap_or(params);
    serde_json::from_value(payload.clone()).ok()
}

pub fn notices_from_update(
    update: &AnnouncementsUpdate,
    agent_id: &AgentId,
) -> Vec<ConversationSessionNotice> {
    update
        .announcements
        .iter()
        .filter_map(|announcement| notice_from_announcement(announcement, agent_id))
        .collect()
}

fn notice_from_announcement(
    announcement: &RemoteAnnouncement,
    agent_id: &AgentId,
) -> Option<ConversationSessionNotice> {
    let message = announcement
        .message
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())?;
    if is_expired(announcement.expires_at.as_deref()) {
        return None;
    }
    let title = announcement
        .title
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("通知")
        .to_string();
    let announcement_id = announcement_id(announcement, &title, message);
    Some(ConversationSessionNotice {
        title,
        message: Some(message.to_string()),
        severity: notice_severity(announcement.severity.as_deref()),
        announcement_id: Some(announcement_id),
        action: notice_action(announcement, agent_id),
    })
}

fn announcement_id(announcement: &RemoteAnnouncement, title: &str, message: &str) -> String {
    announcement
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("content:{title}\u{1f}{message}"))
}

fn notice_severity(severity: Option<&str>) -> String {
    match severity.map(str::to_ascii_lowercase).as_deref() {
        Some("error" | "critical" | "danger") => "error",
        Some("warning" | "warn") => "warning",
        _ => "info",
    }
    .to_string()
}

fn notice_action(
    announcement: &RemoteAnnouncement,
    agent_id: &AgentId,
) -> Option<ConversationNoticeAction> {
    let fallback_url = announcement
        .cta
        .as_ref()
        .and_then(|cta| cta.url.as_deref())
        .map(str::trim)
        .filter(|url| is_http_url(url))
        .map(ToOwned::to_owned);
    if looks_like_cli_update(announcement) {
        return Some(ConversationNoticeAction::UpdateAgent {
            agent_id: agent_id.clone(),
            fallback_url,
        });
    }
    let cta = announcement.cta.as_ref()?;
    let url = fallback_url?;
    let label = cta
        .label
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .unwrap_or("打开")
        .to_string();
    Some(ConversationNoticeAction::OpenUrl { url, label })
}

fn looks_like_cli_update(announcement: &RemoteAnnouncement) -> bool {
    if announcement
        .cta
        .as_ref()
        .and_then(|cta| cta.label.as_deref())
        .map(str::trim)
        .is_some_and(|label| {
            matches!(
                label.to_ascii_lowercase().as_str(),
                "update" | "upgrade" | "install" | "更新"
            )
        })
    {
        return true;
    }
    let haystack = [
        announcement.id.as_deref(),
        announcement.title.as_deref(),
        announcement.message.as_deref(),
        announcement
            .cta
            .as_ref()
            .and_then(|cta| cta.label.as_deref()),
        announcement.cta.as_ref().and_then(|cta| cta.url.as_deref()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n")
    .to_ascii_lowercase();
    const MARKERS: &[&str] = &[
        "update the cli",
        "update cli",
        "upgrade cli",
        "cli update",
        "new version",
        "update available",
        "install.sh",
        "install.ps1",
        "/cli/install",
        "更新 grok",
        "更新 cli",
        "新版本",
    ];
    MARKERS.iter().any(|marker| haystack.contains(marker))
}

fn is_http_url(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

fn is_expired(expires_at: Option<&str>) -> bool {
    let Some(raw) = expires_at.filter(|value| !value.trim().is_empty()) else {
        return false;
    };
    chrono::DateTime::parse_from_rfc3339(raw)
        .map(|expiry| expiry <= chrono::Utc::now())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> AgentId {
        AgentId::parse("grok").expect("grok id")
    }

    #[test]
    fn recognizes_both_method_forms() {
        assert!(is_announcements_method("x.ai/announcements/update"));
        assert!(is_announcements_method("_x.ai/announcements/update"));
        assert!(!is_announcements_method("x.ai/ask_user_question"));
    }

    #[test]
    fn hides_empty_and_expired_announcements() {
        let update = parse_update(&serde_json::json!({
            "gen": 2,
            "announcements": [
                { "id": "blank", "title": "Hi" },
                {
                    "id": "old",
                    "message": "gone",
                    "expires_at": "2000-01-01T00:00:00Z"
                }
            ]
        }))
        .expect("update");
        assert!(notices_from_update(&update, &agent()).is_empty());
    }

    #[test]
    fn maps_cli_update_to_agent_update_action() {
        let update = parse_update(&serde_json::json!({
            "params": {
                "gen": 4,
                "announcements": [{
                    "id": "cli-update",
                    "title": "Grok CLI",
                    "message": "A new version is available.",
                    "cta": {
                        "label": "Update",
                        "url": "https://x.ai/cli/install"
                    }
                }]
            }
        }))
        .expect("update");
        let notices = notices_from_update(&update, &agent());
        assert_eq!(notices.len(), 1);
        assert_eq!(notices[0].title, "Grok CLI");
        match &notices[0].action {
            Some(ConversationNoticeAction::UpdateAgent {
                agent_id,
                fallback_url,
            }) => {
                assert_eq!(agent_id.as_str(), "grok");
                assert_eq!(fallback_url.as_deref(), Some("https://x.ai/cli/install"));
            }
            other => panic!("expected update action, got {other:?}"),
        }
    }

    #[test]
    fn maps_promo_cta_to_open_url() {
        let update = parse_update(&serde_json::json!({
            "announcements": [{
                "message": "Try SuperGrok Heavy.",
                "cta": { "label": "Get SuperGrok", "url": "https://x.ai/grok" }
            }]
        }))
        .expect("update");
        let notices = notices_from_update(&update, &agent());
        assert!(matches!(
            notices[0].action,
            Some(ConversationNoticeAction::OpenUrl { .. })
        ));
    }
}
