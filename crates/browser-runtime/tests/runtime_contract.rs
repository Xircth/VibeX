use std::sync::{Arc, Mutex};

use browser_runtime::{
    BrowserEngine, BrowserEngineCommand, BrowserEngineEvent, BrowserEvent, BrowserIntent,
    BrowserProfile, BrowserRuntime, BrowserSurface, CreateBrowserTab,
};

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
