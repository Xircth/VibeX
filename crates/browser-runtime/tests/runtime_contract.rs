use std::sync::{Arc, Mutex};

use browser_runtime::{
    BrowserDownloadState, BrowserEngine, BrowserEngineCommand, BrowserEngineEvent, BrowserEvent,
    BrowserIntent, BrowserPermissionKind, BrowserProfile, BrowserRuntime, BrowserSurface,
    CreateBrowserTab,
};
use serde_json::json;

#[derive(Clone, Default)]
struct RecordingEngine {
    commands: Arc<Mutex<Vec<BrowserEngineCommand>>>,
}

#[test]
fn navigation_intent_is_dispatched_to_the_existing_chromium_tab() {
    let engine = RecordingEngine::default();
    let runtime = BrowserRuntime::new(engine.clone());
    let tab = runtime
        .create_tab(CreateBrowserTab {
            initial_url: "https://example.com".to_string(),
            profile: BrowserProfile::Global,
            surface: BrowserSurface {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
                scale_factor: 1.0,
                visible: true,
            },
        })
        .expect("tab should be created");

    runtime
        .apply(
            &tab.id,
            BrowserIntent::Navigate {
                url: "http://localhost:3000/dashboard".to_string(),
            },
        )
        .expect("navigation should be accepted");

    assert_eq!(
        engine.commands().last(),
        Some(&BrowserEngineCommand::Navigate {
            tab_id: tab.id,
            url: "http://localhost:3000/dashboard".to_string(),
        })
    );
}

#[test]
fn standard_navigation_controls_are_dispatched_to_chromium() {
    let engine = RecordingEngine::default();
    let runtime = BrowserRuntime::new(engine.clone());
    let tab = runtime
        .create_tab(CreateBrowserTab {
            initial_url: "https://example.com".to_string(),
            profile: BrowserProfile::Global,
            surface: BrowserSurface {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
                scale_factor: 1.0,
                visible: true,
            },
        })
        .expect("tab should be created");

    for intent in [
        BrowserIntent::Back,
        BrowserIntent::Forward,
        BrowserIntent::Reload,
        BrowserIntent::Stop,
    ] {
        runtime
            .apply(&tab.id, intent)
            .expect("navigation control should be accepted");
    }

    assert_eq!(
        &engine.commands()[1..],
        &[
            BrowserEngineCommand::Back {
                tab_id: tab.id.clone(),
            },
            BrowserEngineCommand::Forward {
                tab_id: tab.id.clone(),
            },
            BrowserEngineCommand::Reload {
                tab_id: tab.id.clone(),
            },
            BrowserEngineCommand::Stop { tab_id: tab.id },
        ]
    );
}

#[test]
fn zoom_and_find_controls_are_owned_by_the_browser_runtime() {
    let engine = RecordingEngine::default();
    let runtime = BrowserRuntime::new(engine.clone());
    let mut events = runtime.subscribe();
    let tab = runtime
        .create_tab(CreateBrowserTab {
            initial_url: "https://example.com".to_string(),
            profile: BrowserProfile::Global,
            surface: BrowserSurface {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
                scale_factor: 1.0,
                visible: true,
            },
        })
        .expect("tab should be created");
    events.try_recv().expect("initial event");

    runtime
        .apply(&tab.id, BrowserIntent::SetZoom { level: 1.5 })
        .expect("zoom should be accepted");
    runtime
        .apply(
            &tab.id,
            BrowserIntent::Find {
                query: "runtime".to_string(),
                forward: true,
                match_case: false,
                find_next: false,
            },
        )
        .expect("find should be accepted");
    runtime
        .apply(&tab.id, BrowserIntent::StopFinding)
        .expect("find should stop");

    assert_eq!(
        &engine.commands()[1..],
        &[
            BrowserEngineCommand::SetZoom {
                tab_id: tab.id.clone(),
                level: 1.5,
            },
            BrowserEngineCommand::Find {
                tab_id: tab.id.clone(),
                query: "runtime".to_string(),
                forward: true,
                match_case: false,
                find_next: false,
            },
            BrowserEngineCommand::StopFinding {
                tab_id: tab.id.clone(),
            },
        ]
    );
    let BrowserEvent::TabUpdated { tab: updated } =
        events.try_recv().expect("zoom publishes tab state")
    else {
        panic!("expected tab update");
    };
    assert_eq!(updated.zoom_level, 1.5);
}

#[test]
fn surface_changes_update_state_and_the_native_chromium_child_view() {
    let engine = RecordingEngine::default();
    let runtime = BrowserRuntime::new(engine.clone());
    let mut events = runtime.subscribe();
    let tab = runtime
        .create_tab(CreateBrowserTab {
            initial_url: "https://example.com".to_string(),
            profile: BrowserProfile::Global,
            surface: BrowserSurface {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
                scale_factor: 1.0,
                visible: true,
            },
        })
        .expect("tab should be created");
    events.try_recv().expect("initial event");
    let surface = BrowserSurface {
        x: 24,
        y: 96,
        width: 1440,
        height: 900,
        scale_factor: 2.0,
        visible: false,
    };

    runtime
        .apply(
            &tab.id,
            BrowserIntent::SetSurface {
                surface: surface.clone(),
            },
        )
        .expect("surface change should be accepted");

    assert_eq!(
        engine.commands().last(),
        Some(&BrowserEngineCommand::SetSurface {
            tab_id: tab.id.clone(),
            surface: surface.clone(),
        })
    );
    assert_eq!(
        events.try_recv().expect("tab-updated event"),
        BrowserEvent::TabUpdated {
            tab: browser_runtime::BrowserTab { surface, ..tab }
        }
    );
}

#[test]
fn closing_a_tab_closes_chromium_before_removing_runtime_state() {
    let engine = RecordingEngine::default();
    let runtime = BrowserRuntime::new(engine.clone());
    let mut events = runtime.subscribe();
    let tab = runtime
        .create_tab(CreateBrowserTab {
            initial_url: "https://example.com".to_string(),
            profile: BrowserProfile::Global,
            surface: BrowserSurface {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
                scale_factor: 1.0,
                visible: true,
            },
        })
        .expect("tab should be created");
    events.try_recv().expect("initial event");

    runtime.close_tab(&tab.id).expect("tab should close");

    assert_eq!(
        engine.commands().last(),
        Some(&BrowserEngineCommand::Close {
            tab_id: tab.id.clone(),
        })
    );
    assert_eq!(
        runtime.tab(&tab.id).expect("state should be readable"),
        None
    );
    assert_eq!(
        events.try_recv().expect("tab-closed event"),
        BrowserEvent::TabClosed { tab_id: tab.id }
    );
}

#[test]
fn focus_and_devtools_intents_target_the_native_browser() {
    let engine = RecordingEngine::default();
    let runtime = BrowserRuntime::new(engine.clone());
    let tab = runtime
        .create_tab(CreateBrowserTab {
            initial_url: "https://example.com".to_string(),
            profile: BrowserProfile::Global,
            surface: BrowserSurface {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
                scale_factor: 1.0,
                visible: true,
            },
        })
        .expect("tab should be created");

    runtime
        .apply(&tab.id, BrowserIntent::Focus)
        .expect("focus should be accepted");
    runtime
        .apply(&tab.id, BrowserIntent::OpenDevTools)
        .expect("devtools should be accepted");

    assert_eq!(
        &engine.commands()[1..],
        &[
            BrowserEngineCommand::Focus {
                tab_id: tab.id.clone(),
            },
            BrowserEngineCommand::OpenDevTools { tab_id: tab.id },
        ]
    );
}

#[test]
fn devtools_protocol_requests_and_events_cross_the_runtime_boundary() {
    let engine = RecordingEngine::default();
    let runtime = BrowserRuntime::new(engine.clone());
    let mut events = runtime.subscribe();
    let tab = runtime
        .create_tab(CreateBrowserTab {
            initial_url: "https://example.com".to_string(),
            profile: BrowserProfile::Ephemeral,
            surface: BrowserSurface {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
                scale_factor: 1.0,
                visible: true,
            },
        })
        .expect("tab should be created");
    events.try_recv().expect("initial event");

    runtime
        .apply(
            &tab.id,
            BrowserIntent::ExecuteDevTools {
                request_id: 42,
                method: "Runtime.evaluate".to_string(),
                params: json!({ "expression": "document.title" }),
            },
        )
        .expect("CDP request should be accepted");

    assert_eq!(
        engine.commands().last(),
        Some(&BrowserEngineCommand::ExecuteDevTools {
            tab_id: tab.id.clone(),
            request_id: 42,
            method: "Runtime.evaluate".to_string(),
            params: json!({ "expression": "document.title" }),
        })
    );

    runtime
        .apply_engine_event(BrowserEngineEvent::DevToolsEvent {
            tab_id: tab.id.clone(),
            method: "Runtime.consoleAPICalled".to_string(),
            params: json!({ "type": "log" }),
        })
        .expect("CDP event should be published");
    runtime
        .apply_engine_event(BrowserEngineEvent::DevToolsResult {
            tab_id: tab.id.clone(),
            request_id: 42,
            success: true,
            result: json!({ "result": { "type": "string", "value": "Example" } }),
        })
        .expect("CDP result should be published");

    assert_eq!(
        events.try_recv().expect("CDP event"),
        BrowserEvent::DevToolsEvent {
            tab_id: tab.id.clone(),
            method: "Runtime.consoleAPICalled".to_string(),
            params: json!({ "type": "log" }),
        }
    );
    assert_eq!(
        events.try_recv().expect("CDP result"),
        BrowserEvent::DevToolsResult {
            tab_id: tab.id,
            request_id: 42,
            success: true,
            result: json!({ "result": { "type": "string", "value": "Example" } }),
        }
    );
}

#[test]
fn chromium_navigation_state_becomes_the_authoritative_tab_snapshot() {
    let engine = RecordingEngine::default();
    let runtime = BrowserRuntime::new(engine);
    let mut events = runtime.subscribe();
    let tab = runtime
        .create_tab(CreateBrowserTab {
            initial_url: "https://example.com".to_string(),
            profile: BrowserProfile::Ephemeral,
            surface: BrowserSurface {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
                scale_factor: 1.0,
                visible: true,
            },
        })
        .expect("tab should be created");
    events.try_recv().expect("initial event");

    runtime
        .apply_engine_event(BrowserEngineEvent::NavigationStateChanged {
            tab_id: tab.id.clone(),
            url: "https://example.com/docs".to_string(),
            title: "Documentation".to_string(),
            loading: false,
            can_go_back: true,
            can_go_forward: false,
        })
        .expect("engine state should be accepted");

    let BrowserEvent::TabUpdated { tab: updated } = events.try_recv().expect("tab-updated event")
    else {
        panic!("expected a tab-updated event");
    };
    assert_eq!(updated.id, tab.id);
    assert_eq!(updated.url, "https://example.com/docs");
    assert_eq!(updated.title, "Documentation");
    assert!(!updated.loading);
    assert!(updated.can_go_back);
    assert!(!updated.can_go_forward);
}

#[test]
fn chromium_failures_stop_loading_and_are_published_with_stable_details() {
    let engine = RecordingEngine::default();
    let runtime = BrowserRuntime::new(engine);
    let mut events = runtime.subscribe();
    let tab = runtime
        .create_tab(CreateBrowserTab {
            initial_url: "https://unreachable.invalid".to_string(),
            profile: BrowserProfile::Ephemeral,
            surface: BrowserSurface {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
                scale_factor: 1.0,
                visible: true,
            },
        })
        .expect("tab should be created");
    events.try_recv().expect("initial event");

    runtime
        .apply_engine_event(BrowserEngineEvent::Failed {
            tab_id: tab.id.clone(),
            code: "ERR_NAME_NOT_RESOLVED".to_string(),
            message: "The host could not be resolved".to_string(),
        })
        .expect("engine failure should be accepted");

    assert_eq!(
        events.try_recv().expect("tab-failed event"),
        BrowserEvent::TabFailed {
            tab: browser_runtime::BrowserTab {
                loading: false,
                ..tab
            },
            code: "ERR_NAME_NOT_RESOLVED".to_string(),
            message: "The host could not be resolved".to_string(),
        }
    );
}

impl RecordingEngine {
    fn commands(&self) -> Vec<BrowserEngineCommand> {
        self.commands.lock().expect("commands lock").clone()
    }
}

impl BrowserEngine for RecordingEngine {
    fn dispatch(&self, command: BrowserEngineCommand) -> Result<(), browser_runtime::BrowserError> {
        self.commands.lock().expect("commands lock").push(command);
        Ok(())
    }
}

#[test]
fn creating_a_tab_dispatches_chromium_work_and_publishes_initial_state() {
    let engine = RecordingEngine::default();
    let runtime = BrowserRuntime::new(engine.clone());
    let mut events = runtime.subscribe();
    let surface = BrowserSurface {
        x: 16,
        y: 80,
        width: 1280,
        height: 720,
        scale_factor: 2.0,
        visible: true,
    };

    let tab = runtime
        .create_tab(CreateBrowserTab {
            initial_url: "http://127.0.0.1:5173".to_string(),
            profile: BrowserProfile::Workspace {
                workspace_id: "workspace-1".to_string(),
            },
            surface: surface.clone(),
        })
        .expect("tab should be accepted");

    assert_eq!(tab.url, "http://127.0.0.1:5173");
    assert!(tab.loading);
    assert_eq!(
        engine.commands(),
        vec![BrowserEngineCommand::Create {
            tab_id: tab.id.clone(),
            initial_url: tab.url.clone(),
            profile: tab.profile.clone(),
            surface,
        }]
    );
    assert_eq!(
        events.try_recv().expect("tab-created event"),
        BrowserEvent::TabCreated { tab }
    );
}

#[test]
fn popup_requests_create_a_managed_sibling_tab_in_the_same_profile() {
    let engine = RecordingEngine::default();
    let runtime = BrowserRuntime::new(engine.clone());
    let mut events = runtime.subscribe();
    let opener = runtime
        .create_tab(CreateBrowserTab {
            initial_url: "https://example.com".to_string(),
            profile: BrowserProfile::Workspace {
                workspace_id: "workspace-1".to_string(),
            },
            surface: BrowserSurface {
                x: 10,
                y: 20,
                width: 800,
                height: 600,
                scale_factor: 2.0,
                visible: true,
            },
        })
        .expect("opener should be created");
    events.try_recv().expect("initial event");

    runtime
        .apply_engine_event(BrowserEngineEvent::PopupRequested {
            opener_tab_id: opener.id.clone(),
            url: "https://example.com/popup".to_string(),
        })
        .expect("popup should be managed");

    let BrowserEvent::PopupCreated {
        opener_tab_id,
        tab: popup,
    } = events.try_recv().expect("popup event")
    else {
        panic!("expected popup-created event");
    };
    assert_eq!(opener_tab_id, opener.id);
    assert_eq!(popup.profile, opener.profile);
    assert_eq!(popup.url, "https://example.com/popup");
    assert!(!popup.surface.visible);
    assert_eq!(
        engine.commands().last(),
        Some(&BrowserEngineCommand::Create {
            tab_id: popup.id,
            initial_url: "https://example.com/popup".to_string(),
            profile: opener.profile,
            surface: BrowserSurface {
                visible: false,
                ..opener.surface
            },
        })
    );
}

#[test]
fn permission_requests_wait_for_an_explicit_user_decision() {
    let engine = RecordingEngine::default();
    let runtime = BrowserRuntime::new(engine.clone());
    let mut events = runtime.subscribe();
    let tab = runtime
        .create_tab(CreateBrowserTab {
            initial_url: "https://example.com".to_string(),
            profile: BrowserProfile::Ephemeral,
            surface: BrowserSurface {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
                scale_factor: 1.0,
                visible: true,
            },
        })
        .expect("tab should be created");
    events.try_recv().expect("initial event");

    runtime
        .apply_engine_event(BrowserEngineEvent::PermissionRequested {
            tab_id: tab.id.clone(),
            request_id: 7,
            origin: "https://example.com".to_string(),
            kind: BrowserPermissionKind::Media,
            requested_permissions: 3,
        })
        .expect("permission should be published");
    assert_eq!(
        events.try_recv().expect("permission event"),
        BrowserEvent::PermissionRequested {
            tab_id: tab.id.clone(),
            request_id: 7,
            origin: "https://example.com".to_string(),
            kind: BrowserPermissionKind::Media,
            requested_permissions: 3,
        }
    );

    runtime
        .apply(
            &tab.id,
            BrowserIntent::ResolvePermission {
                request_id: 7,
                allow: true,
            },
        )
        .expect("decision should reach CEF");
    assert_eq!(
        engine.commands().last(),
        Some(&BrowserEngineCommand::ResolvePermission {
            tab_id: tab.id,
            request_id: 7,
            allow: true,
        })
    );
}

#[test]
fn download_progress_is_visible_and_cancelable() {
    let engine = RecordingEngine::default();
    let runtime = BrowserRuntime::new(engine.clone());
    let mut events = runtime.subscribe();
    let tab = runtime
        .create_tab(CreateBrowserTab {
            initial_url: "https://example.com".to_string(),
            profile: BrowserProfile::Global,
            surface: BrowserSurface {
                x: 0,
                y: 0,
                width: 800,
                height: 600,
                scale_factor: 1.0,
                visible: true,
            },
        })
        .expect("tab should be created");
    events.try_recv().expect("initial event");

    runtime
        .apply_engine_event(BrowserEngineEvent::DownloadUpdated {
            tab_id: tab.id.clone(),
            download_id: 11,
            url: "https://example.com/archive.zip".to_string(),
            file_name: "archive.zip".to_string(),
            received_bytes: 512,
            total_bytes: 1024,
            percent_complete: 50,
            state: BrowserDownloadState::InProgress,
        })
        .expect("download should be published");
    assert!(matches!(
        events.try_recv().expect("download event"),
        BrowserEvent::DownloadUpdated {
            download_id: 11,
            percent_complete: 50,
            state: BrowserDownloadState::InProgress,
            ..
        }
    ));

    runtime
        .apply(&tab.id, BrowserIntent::CancelDownload { download_id: 11 })
        .expect("cancel should reach CEF");
    assert_eq!(
        engine.commands().last(),
        Some(&BrowserEngineCommand::CancelDownload {
            tab_id: tab.id,
            download_id: 11,
        })
    );
}
