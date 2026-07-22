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
