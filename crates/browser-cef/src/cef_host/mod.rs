use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::CString,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{Arc, mpsc::Receiver},
};

use browser_runtime::{
    BrowserEngineCommand, BrowserEngineEvent, BrowserProfile, BrowserRuntime, BrowserSurface,
    BrowserTabId,
};
use cef::{self, args::Args, *};
use thiserror::Error;

use crate::CefRuntimeConfig;

#[cfg(target_os = "macos")]
mod macos;
mod native;

pub type PumpScheduler = Arc<dyn Fn(i64) + Send + Sync + 'static>;

#[derive(Debug, Error)]
pub enum CefHostError {
    #[error("failed to resolve the current executable: {0}")]
    CurrentExecutable(#[source] std::io::Error),
    #[error("Chromium Embedded Framework was not found")]
    FrameworkNotFound,
    #[error("failed to load Chromium Embedded Framework from {0}")]
    FrameworkLoad(PathBuf),
    #[error("failed to prepare CEF cache directory: {0}")]
    CacheDirectory(#[source] std::io::Error),
    #[error("failed to integrate CEF with the host application: {0}")]
    ApplicationIntegration(String),
    #[error("CEF initialization failed")]
    Initialization,
    #[error("the native browser parent handle is invalid")]
    InvalidParent,
    #[error("CEF request context creation failed")]
    RequestContext,
    #[error("CEF rejected browser creation")]
    BrowserCreation,
    #[error("CEF tab is unavailable: {0}")]
    TabUnavailable(BrowserTabId),
    #[error("failed to update native Chromium surface: {0}")]
    NativeSurface(String),
    #[error("CEF rejected DevTools Protocol message: {0}")]
    DevTools(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeBrowserParent(usize);

impl NativeBrowserParent {
    /// # Safety
    ///
    /// `raw` must remain a valid native parent view/window for the lifetime of
    /// the CEF session and must belong to the current UI thread.
    pub unsafe fn from_raw(raw: usize) -> Result<Self, CefHostError> {
        if raw == 0 {
            Err(CefHostError::InvalidParent)
        } else {
            Ok(Self(raw))
        }
    }
}

pub enum CefProcess {
    Browser(CefBootstrap),
    Child(i32),
}

pub struct CefBootstrap {
    library: CefLibrary,
}

pub fn bootstrap() -> Result<CefProcess, CefHostError> {
    let library = CefLibrary::load()?;
    let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
    let args = Args::new();
    let exit_code = cef::execute_process(Some(args.as_main_args()), None, std::ptr::null_mut());
    if exit_code >= 0 {
        Ok(CefProcess::Child(exit_code))
    } else {
        Ok(CefProcess::Browser(CefBootstrap { library }))
    }
}

cef::wrap_browser_process_handler! {
    struct VibeXBrowserProcessHandler {
        scheduler: PumpScheduler,
    }

    impl BrowserProcessHandler {
        fn on_schedule_message_pump_work(&self, delay_ms: i64) {
            (self.scheduler)(delay_ms);
        }
    }
}

cef::wrap_app! {
    struct VibeXCefApp {
        process_handler: cef::BrowserProcessHandler,
    }

    impl App {
        fn browser_process_handler(&self) -> Option<cef::BrowserProcessHandler> {
            Some(self.process_handler.clone())
        }
    }
}

impl CefBootstrap {
    pub fn initialize(
        self,
        config: CefRuntimeConfig,
        scheduler: PumpScheduler,
        browser_subprocess_path: Option<&Path>,
        commands: Receiver<BrowserEngineCommand>,
        runtime: Arc<BrowserRuntime>,
        parent: NativeBrowserParent,
    ) -> Result<CefSession, CefHostError> {
        std::fs::create_dir_all(config.root_cache_path()).map_err(CefHostError::CacheDirectory)?;

        #[cfg(target_os = "macos")]
        macos::install_cef_application_protocols().map_err(CefHostError::ApplicationIntegration)?;

        let process_handler = VibeXBrowserProcessHandler::new(scheduler);
        let mut application = VibeXCefApp::new(process_handler);
        let args = Args::new();
        let cache_path = config
            .profile_cache_path(&browser_runtime::BrowserProfile::Global)
            .expect("global profile always has a cache path");
        let settings = Settings {
            no_sandbox: 1,
            external_message_pump: 1,
            root_cache_path: path_to_cef_string(config.root_cache_path()),
            cache_path: path_to_cef_string(&cache_path),
            persist_session_cookies: 1,
            browser_subprocess_path: browser_subprocess_path
                .map(path_to_cef_string)
                .unwrap_or_default(),
            resources_dir_path: config
                .runtime_resources_path()
                .map(path_to_cef_string)
                .unwrap_or_default(),
            locales_dir_path: config
                .runtime_locales_path()
                .as_deref()
                .map(path_to_cef_string)
                .unwrap_or_default(),
            log_file: path_to_cef_string(&config.root_cache_path().join("chromium.log")),
            ..Default::default()
        };

        if cef::initialize(
            Some(args.as_main_args()),
            Some(&settings),
            Some(&mut application),
            std::ptr::null_mut(),
        ) != 1
        {
            return Err(CefHostError::Initialization);
        }

        Ok(CefSession {
            _application: application,
            _library: self.library,
            config,
            commands,
            runtime,
            parent,
            registry: Rc::new(RefCell::new(BrowserRegistry::default())),
            request_contexts: HashMap::new(),
            initialized: true,
        })
    }
}

#[derive(Default)]
struct BrowserRegistry {
    browsers: HashMap<BrowserTabId, Browser>,
    devtools: HashMap<BrowserTabId, Registration>,
    surfaces: HashMap<BrowserTabId, BrowserSurface>,
    pending: HashMap<BrowserTabId, Vec<BrowserEngineCommand>>,
}

pub struct CefSession {
    _application: cef::App,
    _library: CefLibrary,
    config: CefRuntimeConfig,
    commands: Receiver<BrowserEngineCommand>,
    runtime: Arc<BrowserRuntime>,
    parent: NativeBrowserParent,
    registry: Rc<RefCell<BrowserRegistry>>,
    request_contexts: HashMap<String, RequestContext>,
    initialized: bool,
}

impl CefSession {
    pub fn config(&self) -> &CefRuntimeConfig {
        &self.config
    }

    pub fn pump(&mut self) {
        while let Ok(command) = self.commands.try_recv() {
            let tab_id = command_tab_id(&command).clone();
            if let Err(error) = self.execute(command) {
                let _ = self.runtime.apply_engine_event(BrowserEngineEvent::Failed {
                    tab_id,
                    code: "CEF_HOST_ERROR".to_string(),
                    message: error.to_string(),
                });
            }
        }
        cef::do_message_loop_work();
    }

    pub fn shutdown(mut self) {
        self.shutdown_inner();
    }

    fn shutdown_inner(&mut self) {
        if self.initialized {
            let browsers = self
                .registry
                .borrow()
                .browsers
                .values()
                .cloned()
                .collect::<Vec<_>>();
            for browser in browsers {
                if let Some(host) = browser.host() {
                    host.close_browser(1);
                }
            }
            for _ in 0..10 {
                cef::do_message_loop_work();
            }
            cef::shutdown();
            self.initialized = false;
        }
    }

    fn execute(&mut self, command: BrowserEngineCommand) -> Result<(), CefHostError> {
        match command {
            BrowserEngineCommand::Create {
                tab_id,
                initial_url,
                profile,
                surface,
            } => self.create_browser(tab_id, initial_url, profile, surface),
            command => {
                let tab_id = command_tab_id(&command).clone();
                let browser = self.registry.borrow().browsers.get(&tab_id).cloned();
                if let Some(browser) = browser {
                    execute_browser_command(&browser, &command)?;
                } else {
                    self.registry
                        .borrow_mut()
                        .pending
                        .entry(tab_id)
                        .or_default()
                        .push(command);
                }
                Ok(())
            }
        }
    }

    fn create_browser(
        &mut self,
        tab_id: BrowserTabId,
        initial_url: String,
        profile: BrowserProfile,
        surface: BrowserSurface,
    ) -> Result<(), CefHostError> {
        let mut request_context = self.request_context(&profile, &tab_id)?;
        let window_info = WindowInfo::default().set_as_child(
            native::parent_handle(self.parent.0),
            &native::surface_rect(&surface),
        );
        let mut client =
            VibeXClient::new(tab_id.clone(), self.runtime.clone(), self.registry.clone());
        let url = CefString::from(initial_url.as_str());
        self.registry.borrow_mut().surfaces.insert(tab_id, surface);
        if browser_host_create_browser(
            Some(&window_info),
            Some(&mut client),
            Some(&url),
            Some(&BrowserSettings::default()),
            None,
            Some(&mut request_context),
        ) != 1
        {
            return Err(CefHostError::BrowserCreation);
        }
        Ok(())
    }

    fn request_context(
        &mut self,
        profile: &BrowserProfile,
        tab_id: &BrowserTabId,
    ) -> Result<RequestContext, CefHostError> {
        if matches!(profile, BrowserProfile::Global) {
            return request_context_get_global_context().ok_or(CefHostError::RequestContext);
        }
        let key = match profile {
            BrowserProfile::Workspace { workspace_id } => format!("workspace:{workspace_id}"),
            BrowserProfile::Ephemeral => format!("ephemeral:{tab_id}"),
            BrowserProfile::Global => unreachable!(),
        };
        if let Some(context) = self.request_contexts.get(&key) {
            return Ok(context.clone());
        }
        let settings = RequestContextSettings {
            cache_path: self
                .config
                .profile_cache_path(profile)
                .as_deref()
                .map(path_to_cef_string)
                .unwrap_or_default(),
            persist_session_cookies: i32::from(!matches!(profile, BrowserProfile::Ephemeral)),
            ..Default::default()
        };
        let context = request_context_create_context(Some(&settings), None)
            .ok_or(CefHostError::RequestContext)?;
        self.request_contexts.insert(key, context.clone());
        Ok(context)
    }
}

impl Drop for CefSession {
    fn drop(&mut self) {
        self.shutdown_inner();
    }
}

fn command_tab_id(command: &BrowserEngineCommand) -> &BrowserTabId {
    match command {
        BrowserEngineCommand::Create { tab_id, .. }
        | BrowserEngineCommand::Navigate { tab_id, .. }
        | BrowserEngineCommand::Back { tab_id }
        | BrowserEngineCommand::Forward { tab_id }
        | BrowserEngineCommand::Reload { tab_id }
        | BrowserEngineCommand::Stop { tab_id }
        | BrowserEngineCommand::SetSurface { tab_id, .. }
        | BrowserEngineCommand::Close { tab_id }
        | BrowserEngineCommand::Focus { tab_id }
        | BrowserEngineCommand::OpenDevTools { tab_id }
        | BrowserEngineCommand::ExecuteDevTools { tab_id, .. } => tab_id,
    }
}

fn execute_browser_command(
    browser: &Browser,
    command: &BrowserEngineCommand,
) -> Result<(), CefHostError> {
    match command {
        BrowserEngineCommand::Navigate { url, .. } => {
            let frame = browser
                .main_frame()
                .ok_or_else(|| CefHostError::TabUnavailable(command_tab_id(command).clone()))?;
            frame.load_url(Some(&CefString::from(url.as_str())));
        }
        BrowserEngineCommand::Back { .. } => browser.go_back(),
        BrowserEngineCommand::Forward { .. } => browser.go_forward(),
        BrowserEngineCommand::Reload { .. } => browser.reload(),
        BrowserEngineCommand::Stop { .. } => browser.stop_load(),
        BrowserEngineCommand::SetSurface { surface, .. } => {
            native::apply_surface(browser, surface).map_err(CefHostError::NativeSurface)?;
        }
        BrowserEngineCommand::Close { .. } => {
            browser
                .host()
                .ok_or_else(|| CefHostError::TabUnavailable(command_tab_id(command).clone()))?
                .close_browser(0);
        }
        BrowserEngineCommand::Focus { .. } => {
            browser
                .host()
                .ok_or_else(|| CefHostError::TabUnavailable(command_tab_id(command).clone()))?
                .set_focus(1);
        }
        BrowserEngineCommand::OpenDevTools { .. } => {
            browser
                .host()
                .ok_or_else(|| CefHostError::TabUnavailable(command_tab_id(command).clone()))?
                .show_dev_tools(None, None, Some(&BrowserSettings::default()), None);
        }
        BrowserEngineCommand::ExecuteDevTools {
            request_id,
            method,
            params,
            ..
        } => {
            let payload = serde_json::to_vec(&serde_json::json!({
                "id": request_id,
                "method": method,
                "params": params,
            }))
            .map_err(|error| CefHostError::DevTools(error.to_string()))?;
            let accepted = browser
                .host()
                .ok_or_else(|| CefHostError::TabUnavailable(command_tab_id(command).clone()))?
                .send_dev_tools_message(Some(&payload));
            if accepted != 1 {
                return Err(CefHostError::DevTools(method.clone()));
            }
        }
        BrowserEngineCommand::Create { .. } => {}
    }
    Ok(())
}

cef::wrap_dev_tools_message_observer! {
    struct VibeXDevToolsObserver {
        tab_id: BrowserTabId,
        runtime: Arc<BrowserRuntime>,
    }

    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(
            &self,
            _browser: Option<&mut Browser>,
            message_id: i32,
            success: i32,
            result: Option<&[u8]>,
        ) {
            let result = result
                .and_then(|bytes| serde_json::from_slice(bytes).ok())
                .unwrap_or(serde_json::Value::Null);
            let _ = self.runtime.apply_engine_event(BrowserEngineEvent::DevToolsResult {
                tab_id: self.tab_id.clone(),
                request_id: message_id.max(0) as u32,
                success: success != 0,
                result,
            });
        }

        fn on_dev_tools_event(
            &self,
            _browser: Option<&mut Browser>,
            method: Option<&CefString>,
            params: Option<&[u8]>,
        ) {
            let Some(method) = method.map(CefString::to_string) else {
                return;
            };
            let params = params
                .and_then(|bytes| serde_json::from_slice(bytes).ok())
                .unwrap_or(serde_json::Value::Null);
            let _ = self.runtime.apply_engine_event(BrowserEngineEvent::DevToolsEvent {
                tab_id: self.tab_id.clone(),
                method,
                params,
            });
        }
    }
}

cef::wrap_client! {
    struct VibeXClient {
        tab_id: BrowserTabId,
        runtime: Arc<BrowserRuntime>,
        registry: Rc<RefCell<BrowserRegistry>>,
    }

    impl Client {
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(VibeXDisplayHandler::new(self.tab_id.clone(), self.runtime.clone()))
        }

        fn download_handler(&self) -> Option<DownloadHandler> {
            Some(VibeXDownloadHandler::new())
        }

        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(VibeXLifeSpanHandler::new(
                self.tab_id.clone(),
                self.runtime.clone(),
                self.registry.clone(),
            ))
        }

        fn load_handler(&self) -> Option<LoadHandler> {
            Some(VibeXLoadHandler::new(self.tab_id.clone(), self.runtime.clone()))
        }

        fn permission_handler(&self) -> Option<PermissionHandler> {
            Some(VibeXPermissionHandler::new())
        }
    }
}

cef::wrap_download_handler! {
    struct VibeXDownloadHandler;

    impl DownloadHandler {
        fn can_download(
            &self,
            _browser: Option<&mut Browser>,
            _url: Option<&CefString>,
            _request_method: Option<&CefString>,
        ) -> i32 {
            1
        }

        fn on_before_download(
            &self,
            _browser: Option<&mut Browser>,
            _download_item: Option<&mut DownloadItem>,
            _suggested_name: Option<&CefString>,
            callback: Option<&mut BeforeDownloadCallback>,
        ) -> i32 {
            if let Some(callback) = callback {
                callback.cont(None, 1);
                1
            } else {
                0
            }
        }
    }
}

cef::wrap_permission_handler! {
    struct VibeXPermissionHandler;

    impl PermissionHandler {
        fn on_request_media_access_permission(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _requesting_origin: Option<&CefString>,
            _requested_permissions: u32,
            callback: Option<&mut MediaAccessCallback>,
        ) -> i32 {
            if let Some(callback) = callback {
                callback.cont(0);
            }
            1
        }

        fn on_show_permission_prompt(
            &self,
            _browser: Option<&mut Browser>,
            _prompt_id: u64,
            _requesting_origin: Option<&CefString>,
            _requested_permissions: u32,
            callback: Option<&mut PermissionPromptCallback>,
        ) -> i32 {
            if let Some(callback) = callback {
                callback.cont(PermissionRequestResult::DENY);
            }
            1
        }
    }
}

cef::wrap_life_span_handler! {
    struct VibeXLifeSpanHandler {
        tab_id: BrowserTabId,
        runtime: Arc<BrowserRuntime>,
        registry: Rc<RefCell<BrowserRegistry>>,
    }

    impl LifeSpanHandler {
        fn on_before_popup(
            &self,
            browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _popup_id: i32,
            target_url: Option<&CefString>,
            _target_frame_name: Option<&CefString>,
            _target_disposition: WindowOpenDisposition,
            _user_gesture: i32,
            _popup_features: Option<&PopupFeatures>,
            _window_info: Option<&mut WindowInfo>,
            _client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            _no_javascript_access: Option<&mut i32>,
        ) -> i32 {
            if let (Some(frame), Some(target_url)) =
                (browser.and_then(|browser| browser.main_frame()), target_url)
            {
                frame.load_url(Some(target_url));
            }
            1
        }

        fn on_after_created(&self, browser: Option<&mut Browser>) {
            let Some(browser) = browser.cloned() else {
                return;
            };
            let registration = browser.host().and_then(|host| {
                let mut observer = VibeXDevToolsObserver::new(
                    self.tab_id.clone(),
                    self.runtime.clone(),
                );
                host.add_dev_tools_message_observer(Some(&mut observer))
            });
            let (surface, pending) = {
                let mut registry = self.registry.borrow_mut();
                registry.browsers.insert(self.tab_id.clone(), browser.clone());
                if let Some(registration) = registration {
                    registry.devtools.insert(self.tab_id.clone(), registration);
                }
                (
                    registry.surfaces.get(&self.tab_id).cloned(),
                    registry.pending.remove(&self.tab_id).unwrap_or_default(),
                )
            };
            if let Some(surface) = surface {
                let _ = native::apply_surface(&browser, &surface);
            }
            for command in pending {
                let _ = execute_browser_command(&browser, &command);
            }
        }

        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            let mut registry = self.registry.borrow_mut();
            registry.browsers.remove(&self.tab_id);
            registry.devtools.remove(&self.tab_id);
            registry.surfaces.remove(&self.tab_id);
            registry.pending.remove(&self.tab_id);
        }
    }
}

cef::wrap_display_handler! {
    struct VibeXDisplayHandler {
        tab_id: BrowserTabId,
        runtime: Arc<BrowserRuntime>,
    }

    impl DisplayHandler {
        fn on_address_change(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            url: Option<&CefString>,
        ) {
            if frame.is_some_and(|frame| frame.is_main() != 0) {
                publish_navigation_state(
                    &self.runtime,
                    &self.tab_id,
                    url.map(CefString::to_string),
                    None,
                    None,
                    None,
                    None,
                );
            }
        }

        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            publish_navigation_state(
                &self.runtime,
                &self.tab_id,
                None,
                title.map(CefString::to_string),
                None,
                None,
                None,
            );
        }
    }
}

cef::wrap_load_handler! {
    struct VibeXLoadHandler {
        tab_id: BrowserTabId,
        runtime: Arc<BrowserRuntime>,
    }

    impl LoadHandler {
        fn on_loading_state_change(
            &self,
            _browser: Option<&mut Browser>,
            is_loading: i32,
            can_go_back: i32,
            can_go_forward: i32,
        ) {
            publish_navigation_state(
                &self.runtime,
                &self.tab_id,
                None,
                None,
                Some(is_loading != 0),
                Some(can_go_back != 0),
                Some(can_go_forward != 0),
            );
        }

        fn on_load_error(
            &self,
            _browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            error_code: Errorcode,
            error_text: Option<&CefString>,
            _failed_url: Option<&CefString>,
        ) {
            if frame.is_some_and(|frame| frame.is_main() != 0) {
                let _ = self.runtime.apply_engine_event(BrowserEngineEvent::Failed {
                    tab_id: self.tab_id.clone(),
                    code: format!("{error_code:?}"),
                    message: error_text.map(CefString::to_string).unwrap_or_default(),
                });
            }
        }
    }
}

fn publish_navigation_state(
    runtime: &BrowserRuntime,
    tab_id: &BrowserTabId,
    url: Option<String>,
    title: Option<String>,
    loading: Option<bool>,
    can_go_back: Option<bool>,
    can_go_forward: Option<bool>,
) {
    let Ok(Some(tab)) = runtime.tab(tab_id) else {
        return;
    };
    let _ = runtime.apply_engine_event(BrowserEngineEvent::NavigationStateChanged {
        tab_id: tab_id.clone(),
        url: url.unwrap_or(tab.url),
        title: title.unwrap_or(tab.title),
        loading: loading.unwrap_or(tab.loading),
        can_go_back: can_go_back.unwrap_or(tab.can_go_back),
        can_go_forward: can_go_forward.unwrap_or(tab.can_go_forward),
    });
}

fn path_to_cef_string(path: &Path) -> CefString {
    CefString::from(path.to_string_lossy().as_ref())
}

#[cfg(target_os = "macos")]
struct CefLibrary;

#[cfg(target_os = "macos")]
impl CefLibrary {
    fn load() -> Result<Self, CefHostError> {
        let current_executable =
            std::env::current_exe().map_err(CefHostError::CurrentExecutable)?;
        let bundled = current_executable.parent().map(|parent| {
            parent.join(
                "../Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework",
            )
        });
        let bundled_helper = current_executable.parent().map(|parent| {
            parent
                .join("../../../Chromium Embedded Framework.framework/Chromium Embedded Framework")
        });
        let nested_framework_helper = current_executable
            .parent()
            .map(|parent| parent.join("../../../../Chromium Embedded Framework"));
        let development = cef::sys::get_cef_dir().map(|root| {
            root.join("Chromium Embedded Framework.framework/Chromium Embedded Framework")
        });
        let framework = bundled
            .into_iter()
            .chain(bundled_helper)
            .chain(nested_framework_helper)
            .chain(development)
            .find(|candidate| candidate.is_file())
            .ok_or(CefHostError::FrameworkNotFound)?;
        let framework_c = CString::new(framework.to_string_lossy().as_bytes())
            .map_err(|_| CefHostError::FrameworkLoad(framework.clone()))?;
        if cef::load_library(Some(unsafe { &*framework_c.as_ptr().cast() })) != 1 {
            return Err(CefHostError::FrameworkLoad(framework));
        }
        Ok(Self)
    }
}

#[cfg(target_os = "macos")]
impl Drop for CefLibrary {
    fn drop(&mut self) {
        let _ = cef::unload_library();
    }
}

#[cfg(not(target_os = "macos"))]
struct CefLibrary;

#[cfg(not(target_os = "macos"))]
impl CefLibrary {
    fn load() -> Result<Self, CefHostError> {
        Ok(Self)
    }
}
