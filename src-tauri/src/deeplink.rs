//! `vibex://` deep links (P2-5). Opens the app on a specific project/session from
//! an OS URL. Recognizes `vibex://<any>?project=<id>&workspace=<id>&session=<id>`
//! and reuses the existing project-session activation channel
//! (`desktop-toast-activated`, handled by ProjectWindowManager).
//!
//! macOS delivers URLs via `on_open_url` to the running app (scheme registered in
//! the bundle Info.plist). Windows/Linux launch a new process with the URL as an
//! arg; the single-instance plugin forwards those args into the running instance,
//! where [`route_deep_link_args`] parses them.

use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicU64, Ordering},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::{commands::settings_window::open_local_settings_window_at, tray::show_main_window};

const ACTIVATION_EVENT: &str = "desktop-toast-activated";
pub const MODEL_ROUTER_IMPORT_EVENT: &str = "vibex://modelrouter-import";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingModelRouterImport {
    pub id: u64,
    pub ticket: String,
    pub agent_id: Option<String>,
}

static NEXT_IMPORT_ID: AtomicU64 = AtomicU64::new(1);
static PENDING_MODEL_ROUTER_IMPORT: OnceLock<Mutex<Option<PendingModelRouterImport>>> =
    OnceLock::new();

fn pending_model_router_import_slot() -> &'static Mutex<Option<PendingModelRouterImport>> {
    PENDING_MODEL_ROUTER_IMPORT.get_or_init(|| Mutex::new(None))
}

pub fn store_pending_model_router_import(
    ticket: String,
    agent_id: Option<String>,
) -> PendingModelRouterImport {
    let payload = PendingModelRouterImport {
        id: NEXT_IMPORT_ID.fetch_add(1, Ordering::Relaxed),
        ticket,
        agent_id,
    };
    if let Ok(mut guard) = pending_model_router_import_slot().lock() {
        *guard = Some(payload.clone());
    }
    payload
}

#[tauri::command]
pub fn take_pending_model_router_import() -> Option<PendingModelRouterImport> {
    pending_model_router_import_slot()
        .lock()
        .ok()
        .and_then(|mut guard| guard.take())
}

pub fn parse_model_router_import(url: &url::Url) -> Option<(String, Option<String>)> {
    if url.scheme() != "vibex" {
        return None;
    }
    let host = url.host_str().unwrap_or_default();
    let path = url.path().trim_matches('/');
    let is_model_router_import = (host.eq_ignore_ascii_case("modelrouter")
        && (path.is_empty() || path.eq_ignore_ascii_case("import")))
        || host.eq_ignore_ascii_case("import-modelrouter")
        || path.eq_ignore_ascii_case("modelrouter/import");
    if !is_model_router_import {
        return None;
    }

    let mut ticket = None;
    let mut agent_id = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "ticket" => {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    ticket = Some(trimmed.to_string());
                }
            }
            "agent" | "agentId" | "agent_id" => {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    agent_id = Some(trimmed.to_string());
                }
            }
            _ => {}
        }
    }

    ticket.map(|t| (t, agent_id))
}

/// Route already-parsed deep-link URLs (macOS `on_open_url` path).
pub fn route_deep_link_urls(app: &AppHandle, urls: &[url::Url]) {
    for url in urls {
        route_one(app, url);
    }
}

/// Route deep links found in process args (Windows/Linux single-instance path).
pub fn route_deep_link_args(app: &AppHandle, args: &[String]) {
    let urls: Vec<url::Url> = args
        .iter()
        .filter_map(|arg| url::Url::parse(arg).ok())
        .filter(|url| url.scheme() == "vibex")
        .collect();
    if urls.is_empty() {
        // A plain second launch (no deep link) — just surface the window.
        show_main_window(app);
    } else {
        route_deep_link_urls(app, &urls);
    }
}

/// Route any `vibex://` deep links present in initial startup args.
pub fn route_startup_deep_link_args(app: &AppHandle) {
    let urls: Vec<url::Url> = std::env::args()
        .filter_map(|arg| url::Url::parse(&arg).ok())
        .filter(|url| url.scheme() == "vibex")
        .collect();
    if !urls.is_empty() {
        route_deep_link_urls(app, &urls);
    }
}

fn route_one(app: &AppHandle, url: &url::Url) {
    if url.scheme() != "vibex" {
        return;
    }
    // Always bring the app forward for any vibex:// link.
    show_main_window(app);

    if let Some((ticket, agent_id)) = parse_model_router_import(url) {
        let payload = store_pending_model_router_import(ticket, agent_id);
        let app_for_settings = app.clone();
        let payload_for_emit = payload.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = open_local_settings_window_at(&app_for_settings, Some("/settings/agents"));
            let _ = app_for_settings.emit(MODEL_ROUTER_IMPORT_EVENT, payload_for_emit);
        });
        let _ = app.emit(MODEL_ROUTER_IMPORT_EVENT, payload);
        return;
    }

    let mut project = None;
    let mut workspace = None;
    let mut session = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "project" => project = Some(value.into_owned()),
            "workspace" => workspace = Some(value.into_owned()),
            "session" => session = Some(value.into_owned()),
            _ => {}
        }
    }

    if let (Some(project), Some(workspace), Some(session)) = (project, workspace, session) {
        let _ = app.emit(
            ACTIVATION_EVENT,
            serde_json::json!({
                "projectId": project,
                "workspaceId": workspace,
                "sessionId": session,
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{
        parse_model_router_import, store_pending_model_router_import,
        take_pending_model_router_import,
    };

    #[test]
    fn parses_model_router_import_deep_link_with_ticket_and_agent() {
        let url =
            url::Url::parse("vibex://modelrouter/import?ticket=tkt_123&agent=claude_code").unwrap();
        assert_eq!(
            parse_model_router_import(&url),
            Some(("tkt_123".to_string(), Some("claude_code".to_string())))
        );
    }

    #[test]
    fn parses_model_router_import_deep_link_without_agent() {
        let url = url::Url::parse("vibex://modelrouter/import?ticket=tkt_456").unwrap();
        assert_eq!(
            parse_model_router_import(&url),
            Some(("tkt_456".to_string(), None))
        );
    }

    #[test]
    fn ignores_non_import_deep_links_or_missing_tickets() {
        let missing_ticket =
            url::Url::parse("vibex://modelrouter/import?agent=claude_code").unwrap();
        assert_eq!(parse_model_router_import(&missing_ticket), None);

        let project_url =
            url::Url::parse("vibex://open?project=p1&workspace=w1&session=s1").unwrap();
        assert_eq!(parse_model_router_import(&project_url), None);
    }

    #[test]
    fn stores_and_takes_pending_model_router_import_once() {
        let _ = take_pending_model_router_import();
        let stored =
            store_pending_model_router_import("tkt_abc".to_string(), Some("codex".to_string()));
        assert_eq!(stored.ticket, "tkt_abc");
        assert_eq!(stored.agent_id.as_deref(), Some("codex"));

        let taken = take_pending_model_router_import().expect("stored import");
        assert_eq!(taken, stored);
        assert!(take_pending_model_router_import().is_none());
    }
}
