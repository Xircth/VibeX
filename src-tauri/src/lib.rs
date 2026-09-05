use std::{
    cell::RefCell,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc::Receiver,
    },
    time::Duration,
};

use browser_cef::{
    CefBootstrap, CefRuntimeConfig, CefSession, NativeBrowserParent, PumpScheduler,
    command_channel_with_waker,
};
use browser_runtime::BrowserRuntime;
use tauri::{Emitter, Manager, image::Image};

mod app_icon;
mod app_surface;
pub mod commands;
pub mod conversation_bundle;
pub mod conversation_service;
mod crash_reports;
mod deeplink;
mod delegation;
mod error;
mod events;
mod host_client;
pub mod linux_display;
mod logging;
mod managed_artifacts;
mod oneshot_agent;
mod plugin_dev_server;
mod pr_description;
mod prompt_enhancement;
mod remote_desktop;
mod settings_watcher;
mod state;
mod tray;
mod workflow_mcp_gateway;
mod workspace_paths;
use state::AppState;

const APP_ICON_LIGHT_DEFAULT_BYTES: &[u8] =
    include_bytes!("../../frontend/src/assets/app-logo-light-default.png");
const APP_ICON_DARK_DEFAULT_BYTES: &[u8] =
    include_bytes!("../../frontend/src/assets/app-logo-dark.png");
const APP_ICON_LIGHT_LITE_BYTES: &[u8] =
    include_bytes!("../../frontend/src/assets/app-logo-light-lite.png");
const APP_ICON_DARK_LITE_BYTES: &[u8] =
    include_bytes!("../../frontend/src/assets/app-logo-dark-lite.png");
const BROWSER_EVENT: &str = "browser://event";
const CEF_COMMAND_CAPACITY: usize = 512;
static CEF_PUMP_GENERATION: AtomicU64 = AtomicU64::new(0);

struct PendingCefHost {
    bootstrap: Option<CefBootstrap>,
    config: CefRuntimeConfig,
    parent: NativeBrowserParent,
    scheduler: PumpScheduler,
    subprocess: Option<PathBuf>,
    commands: Receiver<browser_runtime::BrowserEngineCommand>,
    runtime: Arc<BrowserRuntime>,
}

enum CefHost {
    Pending(PendingCefHost),
    Ready(CefSession),
    Failed(String),
}

thread_local! {
    static CEF_HOST: RefCell<Option<CefHost>> = const { RefCell::new(None) };
}

fn pump_cef_session() {
    CEF_HOST.with(|slot| {
        let Ok(mut slot) = slot.try_borrow_mut() else {
            return;
        };
        let Some(host) = slot.take() else {
            return;
        };
        *slot = Some(match host {
            CefHost::Pending(pending) => {
                let runtime = pending.runtime.clone();
                match pending.into_session() {
                    Ok(mut session) => {
                        session.pump();
                        CefHost::Ready(session)
                    }
                    Err(error) => {
                        tracing::error!(%error, "failed to start Chromium browser runtime");
                        let _ = runtime.fail_all_tabs("browser_engine_error", &error);
                        CefHost::Failed(error)
                    }
                }
            }
            CefHost::Ready(mut session) => {
                session.pump();
                CefHost::Ready(session)
            }
            CefHost::Failed(message) => CefHost::Failed(message),
        });
    });
}

impl PendingCefHost {
    fn into_session(mut self) -> Result<CefSession, String> {
        let bootstrap = self
            .bootstrap
            .take()
            .ok_or_else(|| "Chromium bootstrap is missing".to_string())?;
        bootstrap
            .initialize(
                self.config,
                self.scheduler,
                self.subprocess.as_deref(),
                self.commands,
                self.runtime,
                self.parent,
            )
            .map_err(|error| error.to_string())
    }
}

fn shutdown_cef_session() {
    CEF_HOST.with(|slot| {
        if let Some(CefHost::Ready(session)) = slot.borrow_mut().take() {
            session.shutdown();
        }
    });
}

#[cfg(target_os = "macos")]
fn native_browser_parent(window: &tauri::WebviewWindow) -> Result<NativeBrowserParent, String> {
    let raw = window.ns_view().map_err(|error| error.to_string())? as usize;
    // SAFETY: Tauri owns this NSView for the lifetime of the main window and
    // setup runs on the UI thread before CEF creates any child view.
    unsafe { NativeBrowserParent::from_raw(raw) }.map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn native_browser_parent(window: &tauri::WebviewWindow) -> Result<NativeBrowserParent, String> {
    let raw = window.hwnd().map_err(|error| error.to_string())?.0 as usize;
    // SAFETY: Tauri owns this HWND for the lifetime of the main window.
    unsafe { NativeBrowserParent::from_raw(raw) }.map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
fn native_browser_parent(window: &tauri::WebviewWindow) -> Result<NativeBrowserParent, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let raw = match window
        .window_handle()
        .map_err(|error| error.to_string())?
        .as_raw()
    {
        RawWindowHandle::Xlib(handle) => handle.window as usize,
        RawWindowHandle::Xcb(handle) => usize::try_from(handle.window.get())
            .map_err(|_| "XCB window handle does not fit in usize".to_string())?,
        _ => return Err(linux_display::XWAYLAND_REQUIRED_MESSAGE.to_string()),
    };
    // SAFETY: Tauri owns this X11 window for the lifetime of the main window.
    unsafe { NativeBrowserParent::from_raw(raw) }.map_err(|error| error.to_string())
}

fn cef_subprocess_path_from(resource_dir: Option<&std::path::Path>) -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let directory = executable.parent()?;
    #[cfg(target_os = "macos")]
    {
        let bundled = directory.join("../Frameworks/vibex Helper.app/Contents/MacOS/vibex Helper");
        if bundled.is_file() {
            return Some(bundled);
        }
        let staged = directory.join(
            "../Frameworks/Chromium Embedded Framework.framework/Helpers/vibex Helper.app/Contents/MacOS/vibex Helper",
        );
        if staged.is_file() {
            return Some(staged);
        }
        let development_helper = directory.join("vibex_cef_helper");
        if development_helper.is_file() {
            return Some(development_helper);
        }
        if let Some(resource_dir) = resource_dir {
            let helper = resource_dir.join("vibex_cef_helper");
            if helper.is_file() {
                return Some(helper);
            }
        }
        Some(executable)
    }
    #[cfg(target_os = "windows")]
    {
        let helper_name = "vibex_cef_helper.exe";
        let helper = directory.join(helper_name);
        if helper.is_file() {
            return Some(helper);
        }
        if let Some(resource_dir) = resource_dir {
            let helper = resource_dir.join(helper_name);
            if helper.is_file() {
                return Some(helper);
            }
        }
        Some(executable)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let helper_name = "vibex_cef_helper";
        let helper = directory.join(helper_name);
        if helper.is_file() {
            return Some(helper);
        }
        if let Some(resource_dir) = resource_dir {
            let helper = resource_dir.join(helper_name);
            if helper.is_file() {
                return Some(helper);
            }
        }
        Some(executable)
    }
}

fn setup_browser_runtime(
    app: &mut tauri::App,
    bootstrap: CefBootstrap,
) -> Result<(), Box<dyn std::error::Error>> {
    let main_window = app
        .get_webview_window("main")
        .ok_or("main window is unavailable for CEF")?;
    let parent = native_browser_parent(&main_window)?;
    let app_data_dir = app.path().app_data_dir()?;
    let resource_dir = app.path().resource_dir()?;
    let subprocess = cef_subprocess_path_from(Some(&resource_dir));
    let nested_resources = resource_dir.join("cef");
    let runtime_resources = if nested_resources.join("icudtl.dat").is_file() {
        Some(nested_resources)
    } else if resource_dir.join("icudtl.dat").is_file() {
        Some(resource_dir)
    } else {
        None
    };
    let runtime_config = match runtime_resources {
        Some(runtime_resources) => {
            CefRuntimeConfig::new(app_data_dir).with_runtime_resources(runtime_resources)
        }
        None => CefRuntimeConfig::new(app_data_dir),
    };
    let app_handle = app.handle().clone();
    let scheduler: PumpScheduler = Arc::new(move |delay_ms| {
        if delay_ms < 0 {
            CEF_PUMP_GENERATION.fetch_add(1, Ordering::Relaxed);
            return;
        }
        let generation = CEF_PUMP_GENERATION.load(Ordering::Relaxed);
        let app_handle = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            if delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(delay_ms as u64)).await;
                if CEF_PUMP_GENERATION.load(Ordering::Relaxed) != generation {
                    return;
                }
            }
            let _ = app_handle.run_on_main_thread(pump_cef_session);
        });
    });
    let wake_scheduler = scheduler.clone();
    let (engine, commands) =
        command_channel_with_waker(CEF_COMMAND_CAPACITY, Arc::new(move || wake_scheduler(0)));
    let runtime = Arc::new(BrowserRuntime::new(engine));

    let mut browser_events = runtime.subscribe();
    let browser_event_app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match browser_events.recv().await {
                Ok(event) => {
                    let _ = browser_event_app.emit(BROWSER_EVENT, event);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    tracing::warn!(skipped, "browser event consumer lagged");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    app.manage(commands::browser::BrowserCommandState {
        runtime: runtime.clone(),
    });
    CEF_HOST.with(|stored| {
        *stored.borrow_mut() = Some(CefHost::Pending(PendingCefHost {
            bootstrap: Some(bootstrap),
            config: runtime_config,
            parent,
            scheduler,
            subprocess,
            commands,
            runtime,
        }));
    });
    Ok(())
}

fn setup_unavailable_browser_runtime(app: &mut tauri::App, message: String) {
    tracing::error!(error = %message, "Chromium browser runtime is unavailable");
    let runtime = Arc::new(commands::browser::unavailable_runtime(message));
    app.manage(commands::browser::BrowserCommandState { runtime });
}

fn install_rustls_crypto_provider() {
    // The workspace uses reqwest's no-provider rustls mode, so the application
    // must select a process-wide crypto provider before any TLS client is built.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
}

pub(crate) fn load_app_icon() -> Result<Image<'static>, String> {
    app_icon::icon_from_png_bytes(
        native_app_icon_bytes("default", "light").expect("default app icon exists"),
    )
}

pub(crate) fn apply_app_icon(window: &tauri::WebviewWindow) -> Result<(), String> {
    let icon = load_app_icon()?;
    window.set_icon(icon).map_err(|error| error.to_string())
}

#[tauri::command]
async fn set_app_icon(app: tauri::AppHandle, style: String, theme: String) -> Result<(), String> {
    let bytes = native_app_icon_bytes(&style, &theme)?;
    let window_icon = app_icon::icon_from_png_bytes(bytes)?;
    let tray_icon = Image::from_bytes(bytes)
        .map(|icon| icon.to_owned())
        .map_err(|error| error.to_string())?;

    for window in app.webview_windows().values() {
        window
            .set_icon(window_icon.clone())
            .map_err(|error| error.to_string())?;
    }
    if let Some(tray) = app.tray_by_id(tray::TRAY_ICON_ID) {
        tray.set_icon(Some(tray_icon))
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn native_app_icon_bytes(style: &str, theme: &str) -> Result<&'static [u8], String> {
    match (style, theme) {
        ("default", "light") => Ok(APP_ICON_LIGHT_DEFAULT_BYTES),
        ("default", "dark") => Ok(APP_ICON_DARK_DEFAULT_BYTES),
        ("lite", "light") => Ok(APP_ICON_LIGHT_LITE_BYTES),
        ("lite", "dark") => Ok(APP_ICON_DARK_LITE_BYTES),
        _ => Err("Unsupported application icon style or theme".to_string()),
    }
}

#[tauri::command]
async fn health_check() -> Result<String, String> {
    Ok("ok".to_string())
}

#[tauri::command]
async fn exit_app(app: tauri::AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

pub fn run(cef_bootstrap: Result<CefBootstrap, String>) {
    // Install the file+stderr tracing subscriber first so startup is logged. The
    // guard flushes the non-blocking writer on drop; we drop it from RunEvent::Exit
    // (tao's process::exit doesn't unwind, so a scope-drop would never flush) (P2-8).
    let mut log_guard = Some(logging::init_logging());
    // Persist panics as local crash reports (opt-in surfacing happens in the UI).
    crash_reports::install_panic_hook();
    install_rustls_crypto_provider();
    utils::shell::bootstrap_desktop_path();

    {
        let mut builder = tauri::Builder::default();
        if cfg!(debug_assertions) {
            builder = builder
                .plugin(tauri_plugin_redline::init())
                .plugin(tauri_plugin_vibex_inspector::init());
        }
        builder
    }
    // single-instance MUST come first and before deep-link (P2-5): it forwards
    // a second launch's args (carrying the vibex:// URL on Windows/Linux) into
    // the running instance.
    .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        deeplink::route_deep_link_args(app, &args);
    }))
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .setup(move |app| {
        match cef_bootstrap {
            Ok(bootstrap) => {
                if let Err(error) = setup_browser_runtime(app, bootstrap) {
                    setup_unavailable_browser_runtime(app, error.to_string());
                }
            }
            Err(error) => setup_unavailable_browser_runtime(app, error),
        }
        // Apply the saved system-proxy setting to process env FIRST, before any
        // reqwest client is built or any ACP agent is spawned — otherwise the
        // proxy never reaches them (agents inherit it via merged_agent_env) and
        // e.g. codex-acp can't reach OpenAI.
        tauri::async_runtime::block_on(commands::system_settings::init_system_proxy());

        let state = tauri::async_runtime::block_on(AppState::new(app.handle().clone()))
            .expect("Failed to initialize app state");
        let _workflow_mcp_ready = match tauri::async_runtime::block_on(
            workflow_mcp_gateway::start(&state),
        ) {
            Ok(connection) => {
                tracing::info!(
                    endpoint = %connection.endpoint,
                    "Workflow Plugin MCP gateway is ready"
                );
                app.manage(connection);
                true
            }
            Err(error) => {
                tracing::error!(%error, "Workflow Plugin MCP gateway failed to start");
                false
            }
        };
        tauri::async_runtime::block_on(
            commands::plugin_control::refresh_enabled_plugin_projections(&state),
        );
        let preview_proxy = tauri::async_runtime::block_on(
            plugin_dev_server::DesktopPreviewProxy::start(),
        )
        .expect("Failed to start the capability-checked Desktop preview proxy");
        app.manage(preview_proxy);
        let plugin_candidate_root = app
            .path()
            .app_data_dir()
            .expect("Failed to resolve app data directory")
            .join("plugins")
            .join("dev-candidates");
        let plugin_runtime_root = managed_artifacts::directory(app.handle())
            .expect("Failed to resolve managed executable directory")
            .join("plugins")
            .join("runtimes");
        match tauri::async_runtime::block_on(plugin_dev_server::start(
            state.plugin_control_plane.clone(),
            state.deployment.db().pool.clone(),
            state.plugin_capability_broker.clone(),
            state.plugin_worker_runtime.clone(),
            plugin_runtime_root,
            plugin_candidate_root,
        )) {
            Ok(connection) => {
                tracing::info!(
                    endpoint = %connection.endpoint,
                    "Plugin Dev control server is ready; retrieve its token through the local app session"
                );
                app.manage(connection);
            }
            Err(error) => tracing::error!(%error, "Plugin Dev control server failed to start"),
        }
        // Startup crash-recovery (ADR-0001): reconcile turns orphaned by a prior
        // process lifecycle before the UI connects. Best-effort — a failure here
        // must not block app launch; the worst case is a stale in-flight turn.
        if let Err(error) = tauri::async_runtime::block_on(
            conversation_service::ConversationSessionService::new(state.conversation_context())
                .recover_interrupted_turns(),
        ) {
            tracing::error!("startup crash-recovery failed: {}", error);
        }
        if let Err(error) = tauri::async_runtime::block_on(
            application::WorkflowStoreExecutionPort::new(state.deployment.db().pool.clone())
                .reconcile_interrupted(),
        ) {
            tracing::error!("workflow startup reconciliation failed: {}", error);
        }
        let workflow_dispatcher =
            application::WorkflowAgentDispatcher::new(state.conversation_context());
        tauri::async_runtime::spawn(async move {
            loop {
                match workflow_dispatcher.tick().await {
                    Ok(true) => continue,
                    Ok(false) => tokio::time::sleep(std::time::Duration::from_secs(2)).await,
                    Err(error) => {
                        tracing::warn!(%error, "workflow dispatcher tick failed");
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    }
                }
            }
        });
        logging::attach_emitter(app.handle().clone());
        events::start_host_event_forwarding(&app.handle().clone());
        events::start_event_forwarding(&app.handle().clone(), &state);
        events::start_agent_event_forwarding(&app.handle().clone(), &state);
        events::start_agent_terminal_forwarding(&app.handle().clone(), &state);
        let relation_pool = state.deployment.db().pool.clone();
        let relation_publisher = state.conversation_context().event_publisher;
        tauri::async_runtime::spawn(async move {
            match conversations::ConversationRelationControl::with_publisher(
                relation_pool,
                relation_publisher,
            )
            .backfill_legacy_delegations()
            .await
            {
                Ok(created) if created > 0 => {
                    tracing::info!(created, "backfilled legacy conversation relations")
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(%error, "conversation relation backfill failed")
                }
            }
        });
        let queued_input_context = state.conversation_context();
        tauri::async_runtime::spawn(async move {
            if let Err(error) =
                conversation_service::ConversationSessionService::new(queued_input_context)
                    .dispatch_queued_inputs()
                    .await
            {
                tracing::warn!(%error, "failed to resume durable conversation inputs");
            }
        });
        settings_watcher::start(app.handle().clone());

        // Backfill the conversation full-text index for any conversation not
        // yet indexed (first run after the FTS migration, imported histories).
        // Background + best-effort so it never delays launch (P1-2).
        let search_pool = state.deployment.db().pool.clone();
        tauri::async_runtime::spawn(async move {
            match conversations::backfill_missing(&search_pool).await {
                Ok(indexed) if indexed > 0 => {
                    tracing::info!("indexed {indexed} conversations for search")
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!("conversation search backfill failed: {error}")
                }
            }
        });

        app.manage(state);
        {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = commands::plugin_control::import_cli_inbox(handle).await {
                    tracing::warn!(%error, "CLI marketplace inbox import failed");
                }
            });
        }
        // Recover Agent management, publish stable terminal commands, and
        // warm slow installation evidence without making Settings → Agent
        // responsible for startup work.
        {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let pool = handle
                    .state::<state::AppState>()
                    .deployment
                    .db()
                    .pool
                    .clone();
                let agent_management_runtime = handle
                    .state::<state::AppState>()
                    .agent_management_runtime
                    .clone();
                let local_discovery = commands::agent_management::warm_local_runtime_discovery(
                    &handle,
                    &pool,
                    &agent_management_runtime,
                );
                let recovery_and_warmup = async {
                    commands::agent_management::recover_interrupted_agent_operations(
                        &handle, &pool,
                    )
                    .await;
                    commands::agent_management::reconcile_managed_cli_exposures(&handle, &pool)
                        .await;
                    commands::agent_management::warm_agent_management(
                        &handle,
                        &pool,
                        &agent_management_runtime,
                    )
                    .await;
                };
                tokio::join!(local_discovery, recovery_and_warmup);
            });
        }
        // Bidirectional IM channels: run inbound loops + conversation command dispatch.
        commands::chat_channel::set_audit_pool(
            app.state::<state::AppState>().deployment.db().pool.clone(),
        );
        let host_state = app.state::<state::AppState>();
        let inbound_pool = host_state.deployment.db().pool.clone();
        let inbound_conversations = host_state.conversation_context();
        tauri::async_runtime::spawn(async move {
            server::start_chat_inbound(inbound_pool, inbound_conversations);
        });

        // One durable Automation v2 Engine owns this data directory. Startup
        // reconciliation and catch-up happen behind the owner lease.
        commands::automation::start_automation_engine(app.handle().clone());

        if let Err(error) = tauri::async_runtime::block_on(
            commands::web_service::ensure_web_service_autostart(app.handle().clone()),
        ) {
            tracing::warn!("Failed to autostart web service: {}", error);
        }

        if let Some(main_window) = app.get_webview_window("main") {
            if let Err(error) = apply_app_icon(&main_window) {
                tracing::warn!("Failed to apply app icon to main window: {}", error);
            }

            let app_handle = app.handle().clone();
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    tray::hide_main_window(&app_handle);
                }
            });
        }

        // System tray (P2-5). Best-effort: on Linux the tray may be absent
        // (no StatusNotifierWatcher) even on success, so log and continue.
        if let Err(error) = tray::install_tray_icon(app.handle()) {
            tracing::warn!("Failed to install tray icon: {}", error);
        }

        // Deep links (P2-5). macOS delivers URLs here; register the scheme at
        // runtime too so it works in dev on Linux/Windows (best-effort).
        {
            use tauri_plugin_deep_link::DeepLinkExt;
            let deep_link_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                deeplink::route_deep_link_urls(&deep_link_handle, &event.urls());
            });
            let _ = app.deep_link().register_all();
        }

        Ok(())
    })
    .on_menu_event(|app, event| {
        // Tray menu clicks (Show / Hide / Quit) share this dispatcher (P2-5).
        tray::handle_menu_event(app, event.id().as_ref());
    })
    .invoke_handler(tauri::generate_handler![
        health_check,
        exit_app,
        set_app_icon,
        commands::browser::browser_create_tab,
        commands::browser::browser_apply_intent,
        commands::browser::browser_close_tab,
        commands::browser::browser_get_tab,
        commands::projects::open_project_in_editor,
        commands::workspaces::open_workspace_in_editor,
        commands::tauri_inspector::get_tauri_inspector_status,
        commands::tauri_inspector::install_tauri_inspector,
        commands::tauri_inspector::control_tauri_inspector,
        commands::tauri_inspector::take_tauri_inspector_capture,
        commands::conversations::application_call,
        commands::conversations::conversation_attach,
        commands::remote_desktop::remote_desktop_connect,
        commands::remote_desktop::remote_desktop_disconnect,
        commands::remote_desktop::remote_desktop_call,
        commands::remote_desktop::remote_desktop_capabilities,
        commands::remote_desktop::remote_desktop_listen,
        commands::remote_desktop::remote_desktop_subscribe,
        commands::terminal::open_external_terminal,
        commands::filesystem::reveal_in_file_manager,
        tray::update_tray_badge,
        commands::repos::open_repo_in_editor,
        commands::desktop_toast::show_desktop_toast,
        commands::desktop_toast::is_main_window_focused,
        commands::desktop_toast::activate_desktop_toast,
        commands::desktop_toast::desktop_toast_window_ready,
        commands::backup::backup_create,
        commands::backup::backup_inspect,
        commands::backup::backup_restore_stage,
        commands::backup::backup_cancel,
        commands::web_service::get_web_service_config,
        commands::web_service::update_web_service_config,
        commands::web_service::get_web_server_status,
        commands::web_service::start_web_server,
        commands::web_service::stop_web_server,
        commands::web_service::probe_web_service_port,
        commands::web_service::generate_web_service_token,
        commands::web_service::create_host_device_pairing,
        commands::web_service::list_host_devices,
        commands::web_service::revoke_host_device,
        commands::host_tunnel::get_host_tunnel,
        commands::host_tunnel::set_host_tunnel_enabled,
        commands::host_tunnel::check_existing_host_tunnel,
        commands::host_tunnel::select_saved_host_tunnel,
        commands::host_tunnel::start_create_host_tunnel,
        commands::host_tunnel::confirm_create_host_tunnel,
        commands::host_tunnel::cancel_create_host_tunnel,
        commands::host_tunnel::remove_saved_host_tunnel,
        commands::host_client::host_client_status,
        commands::host_client::host_client_discover,
        commands::host_client::host_client_connect,
        commands::host_client::host_client_disconnect,
        commands::host_client::host_client_delete,
        commands::settings_window::open_settings_window,
        commands::file_tree::trash_item,
        commands::plugin_control::plugin_control_import_cli,
        plugin_dev_server::plugin_dev_connection,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(move |_app_handle, event| {
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } = &event
        {
            let remote_desktop = _app_handle
                .state::<state::AppState>()
                .remote_desktop
                .clone();
            let label = label.clone();
            tauri::async_runtime::spawn(async move {
                remote_desktop.disconnect_window(&label).await;
            });
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = &event {
            tray::show_main_window(_app_handle);
        }
        // Flush the non-blocking log writer on exit before the process leaves.
        if let tauri::RunEvent::Exit = event {
            shutdown_cef_session();
            log_guard.take();
        }
    });
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use tauri::image::Image;

    use super::install_rustls_crypto_provider;
    #[cfg(target_os = "macos")]
    use super::native_app_icon_bytes;

    #[cfg(target_os = "macos")]
    #[test]
    fn default_macos_icons_keep_transparent_corners() {
        for theme in ["light", "dark"] {
            let bytes = native_app_icon_bytes("default", theme).expect("default icon exists");
            let icon = Image::from_bytes(bytes).expect("default icon is a valid PNG");
            let rgba = icon.rgba();
            let width = icon.width() as usize;
            let height = icon.height() as usize;
            let corner_pixels = [0, width - 1, (height - 1) * width, height * width - 1];

            for pixel in corner_pixels {
                assert_eq!(rgba[pixel * 4 + 3], 0, "{theme} icon corner is opaque");
            }
            let center = ((height / 2) * width + width / 2) * 4;
            assert_ne!(rgba[center + 3], 0, "{theme} icon center is transparent");
        }
    }

    #[test]
    fn installs_rustls_crypto_provider_for_reqwest_clients() {
        install_rustls_crypto_provider();

        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
    }
}
