//! `vibex://` deep links (P2-5). Opens the app on a specific project/session from
//! an OS URL. Recognizes `vibex://<any>?project=<id>&workspace=<id>&session=<id>`
//! and reuses the existing project-session activation channel
//! (`desktop-toast-activated`, handled by ProjectWindowManager).
//!
//! macOS delivers URLs via `on_open_url` to the running app (scheme registered in
//! the bundle Info.plist). Windows/Linux launch a new process with the URL as an
//! arg; the single-instance plugin forwards those args into the running instance,
//! where [`route_deep_link_args`] parses them.

use tauri::{AppHandle, Emitter};

use crate::tray::show_main_window;

const ACTIVATION_EVENT: &str = "desktop-toast-activated";

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

fn route_one(app: &AppHandle, url: &url::Url) {
    if url.scheme() != "vibex" {
        return;
    }
    // Always bring the app forward for any vibex:// link.
    show_main_window(app);

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
