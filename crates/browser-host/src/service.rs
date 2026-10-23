use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use base64::Engine as _;
use serde_json::{Value, json};
use tokio::sync::Notify;
use url::Url;
use uuid::Uuid;

use crate::{
    agent::{self, SnapshotRequest, SnapshotViewport},
    capture::{self, CaptureFormat, CaptureRegion, CaptureRequest},
    confirm::{AskRefused, EvalConsent},
    console::{ConsoleLevel, ConsoleLine, ConsoleQuery, ConsoleRing, ConsoleSource},
    error::BrowserHostError,
    eval::{self, BadCode},
    grant::{AgentGrant, GrantLevel, origin_of},
    policy::{self, BrowserPolicy, HostRule, HostRuleAction},
    types::{
        BrowserAction, BrowserBounds, BrowserCapabilities, BrowserProfileRecord,
        BrowserProxyCapability, BrowserSettings, BrowserTab, EvalApprovalMode, SurfaceOverride,
    },
};

#[async_trait]
pub trait NativeTabs: Send + Sync {
    async fn open(
        &self,
        tab_id: &str,
        url: &str,
        bounds: &BrowserBounds,
        profile_id: &str,
    ) -> Result<(), BrowserHostError>;
    async fn navigate(&self, tab_id: &str, url: &str) -> Result<(), BrowserHostError>;
    async fn close(&self, tab_id: &str) -> Result<(), BrowserHostError>;
    async fn set_bounds(
        &self,
        tab_id: &str,
        bounds: &BrowserBounds,
    ) -> Result<(), BrowserHostError>;
    async fn eval(&self, tab_id: &str, expression: &str) -> Result<String, BrowserHostError>;
    async fn current_url(&self, tab_id: &str) -> Result<String, BrowserHostError>;
    async fn go_back(&self, tab_id: &str) -> Result<(), BrowserHostError>;
    async fn go_forward(&self, tab_id: &str) -> Result<(), BrowserHostError>;
    async fn reload(&self, tab_id: &str) -> Result<(), BrowserHostError>;
    async fn set_zoom(&self, tab_id: &str, factor: f64) -> Result<(), BrowserHostError>;
    async fn open_devtools(&self, tab_id: &str) -> Result<(), BrowserHostError>;
    async fn set_device(&self, tab_id: &str, device: &str) -> Result<(), BrowserHostError>;
    async fn inject(&self, tab_id: &str, script: &str) -> Result<(), BrowserHostError>;
    async fn freeze_frame(
        &self,
        _tab_id: &str,
    ) -> Result<Option<crate::FrozenFrame>, BrowserHostError> {
        Ok(None)
    }
    async fn capture_png(&self, tab_id: &str) -> Result<Vec<u8>, BrowserHostError> {
        if let Some(frame) = self.freeze_frame(tab_id).await? {
            return base64::engine::general_purpose::STANDARD
                .decode(frame.data.trim())
                .map_err(|error| BrowserHostError::new("browser_read_failed", error.to_string()));
        }
        Err(BrowserHostError::new(
            "browser_unavailable",
            "screenshots are not available on this surface",
        ))
    }
    async fn clear_profile(&self, _profile_id: &str) -> Result<(), BrowserHostError> {
        Ok(())
    }
    async fn remove_profile(&self, _profile_id: &str) -> Result<(), BrowserHostError> {
        Ok(())
    }
    fn downloads_dir(&self) -> Option<String> {
        None
    }
    fn proxy_capability(&self) -> BrowserProxyCapability {
        BrowserProxyCapability::default()
    }
    fn supports_page_load_events(&self) -> bool {
        false
    }
    fn notify(&self, _payload: Value) {}
    async fn stop(&self, tab_id: &str) -> Result<(), BrowserHostError> {
        self.inject(tab_id, "window.stop()").await
    }
    async fn find(
        &self,
        tab_id: &str,
        query: &str,
        forward: bool,
    ) -> Result<bool, BrowserHostError> {
        let encoded = serde_json::to_string(query).unwrap_or_else(|_| "\"\"".to_string());
        let back = if forward { "false" } else { "true" };
        let script = format!(
            "(function(){{try{{if(!{encoded}){{var s=window.getSelection&&window.getSelection();if(s)s.removeAllRanges();return true;}}return window.find({encoded},false,{back},true,false,true,false);}}catch(e){{return false;}}}})()"
        );
        let raw = self.eval(tab_id, &script).await.unwrap_or_default();
        Ok(raw.trim().eq_ignore_ascii_case("true"))
    }
}

pub struct UnavailableNative;

#[async_trait]
impl NativeTabs for UnavailableNative {
    async fn open(
        &self,
        _tab_id: &str,
        _url: &str,
        _bounds: &BrowserBounds,
        _profile_id: &str,
    ) -> Result<(), BrowserHostError> {
        Err(BrowserHostError::new(
            "browser_unavailable",
            "native browser tabs are not available on this Host",
        ))
    }

    async fn navigate(&self, _tab_id: &str, _url: &str) -> Result<(), BrowserHostError> {
        self.open("", "", &BrowserBounds::default(), "").await
    }

    async fn close(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
        Ok(())
    }

    async fn set_bounds(
        &self,
        _tab_id: &str,
        _bounds: &BrowserBounds,
    ) -> Result<(), BrowserHostError> {
        Ok(())
    }

    async fn eval(&self, _tab_id: &str, _expression: &str) -> Result<String, BrowserHostError> {
        Err(BrowserHostError::new(
            "browser_unavailable",
            "native browser tabs are not available on this Host",
        ))
    }

    async fn current_url(&self, _tab_id: &str) -> Result<String, BrowserHostError> {
        Err(BrowserHostError::new(
            "browser_unavailable",
            "native browser tabs are not available on this Host",
        ))
    }

    async fn go_back(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
        Ok(())
    }
    async fn go_forward(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
        Ok(())
    }
    async fn reload(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
        Ok(())
    }
    async fn set_zoom(&self, _tab_id: &str, _factor: f64) -> Result<(), BrowserHostError> {
        Ok(())
    }
    async fn open_devtools(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
        Ok(())
    }
    async fn set_device(&self, _tab_id: &str, _device: &str) -> Result<(), BrowserHostError> {
        Ok(())
    }
    async fn inject(&self, _tab_id: &str, _script: &str) -> Result<(), BrowserHostError> {
        Ok(())
    }
}

struct TabRecord {
    tab: BrowserTab,
    bounds: BrowserBounds,
    incarnation: u64,
    nav_epoch: u64,
    /// Standing share for this tab. Origin changes rebind the grant; only
    /// `grant.set` or a `none` default turns sharing off.
    share_level: GrantLevel,
    console: ConsoleRing,
}

pub struct BrowserService {
    occupant: Mutex<Option<String>>,
    tabs: Mutex<HashMap<String, TabRecord>>,
    evals: EvalConsent,
    native: Arc<dyn NativeTabs>,
    available: bool,
    policy: BrowserPolicy,
    settings: Mutex<BrowserSettings>,
    load_notify: Notify,
}

impl BrowserService {
    pub fn new(native: Arc<dyn NativeTabs>, available: bool) -> Self {
        Self {
            occupant: Mutex::new(None),
            tabs: Mutex::new(HashMap::new()),
            evals: EvalConsent::new(),
            native,
            available,
            policy: BrowserPolicy::load(),
            settings: Mutex::new(BrowserSettings::default()),
            load_notify: Notify::new(),
        }
    }

    pub fn unavailable() -> Self {
        Self::new(Arc::new(UnavailableNative), false)
    }

    pub fn policy(&self) -> &BrowserPolicy {
        &self.policy
    }

    pub fn settings(&self) -> BrowserSettings {
        self.settings
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    pub fn apply_settings(&self, mut next: BrowserSettings) -> BrowserSettings {
        next.host_rules
            .retain(|rule| policy::valid_pattern(&rule.pattern));
        if !next.profiles.iter().any(|p| p.id == "default") {
            next.profiles.insert(0, BrowserProfileRecord::default());
        }
        if next.new_tab_profile != "ephemeral"
            && !next.profiles.iter().any(|p| p.id == next.new_tab_profile)
        {
            next.new_tab_profile = "default".to_owned();
        }
        self.policy.set_user_rules(next.host_rules.clone());
        *self.settings.lock().unwrap_or_else(|p| p.into_inner()) = next.clone();
        next
    }

    pub fn can_navigate(&self, raw_url: &str) -> bool {
        if !self.policy.enabled() {
            return false;
        }
        let Ok(parsed) = Url::parse(raw_url) else {
            return false;
        };
        if !(policy::navigation_allowed(&parsed) || policy::subframe_navigation_allowed(&parsed)) {
            return false;
        }
        !self.policy.blocked(&parsed)
    }

    /// A site rule says this URL must leave the built-in browser.
    pub fn prefers_system_browser(&self, raw_url: &str) -> bool {
        let Ok(parsed) = Url::parse(raw_url) else {
            return false;
        };
        self.policy
            .rule_for(&parsed)
            .is_some_and(|rule| rule.action == HostRuleAction::System)
    }

    pub fn begin_navigation(&self, tab_id: &str, url: &str) -> bool {
        if !self.can_navigate(url) {
            return false;
        }
        if let Ok(parsed) = Url::parse(url)
            && policy::navigation_allowed(&parsed)
            && let Some(record) = self
                .tabs
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get_mut(tab_id)
        {
            record.tab.loading = parsed.as_str() != "about:blank";
        }
        true
    }

    pub fn push_console_line(&self, tab_id: &str, line: ConsoleLine) {
        if let Some(record) = self
            .tabs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get_mut(tab_id)
        {
            record.console.push(line);
        }
    }

    pub fn update_chrome(
        &self,
        tab_id: &str,
        url: Option<&str>,
        title: Option<&str>,
        favicon: Option<&str>,
    ) {
        let mut tabs = self.tabs.lock().unwrap_or_else(|p| p.into_inner());
        let Some(record) = tabs.get_mut(tab_id) else {
            return;
        };
        if let Some(title) = title.map(str::trim).filter(|t| !t.is_empty()) {
            record.tab.title = title.to_owned();
        }
        if let Some(favicon) = favicon.map(str::trim).filter(|f| !f.is_empty()) {
            record.tab.favicon = Some(favicon.to_owned());
        }
        if let Some(url) = url.map(str::trim).filter(|u| !u.is_empty())
            && let Ok(parsed) = Url::parse(url)
            && policy::navigation_allowed(&parsed)
            && !self.policy.blocked(&parsed)
        {
            let next_origin = origin_of(&parsed);
            if let Some(origin) = next_origin
                && record.tab.origin.as_deref() != Some(origin.as_str())
            {
                record.tab.origin = Some(origin);
                Self::apply_grant(&mut record.tab, record.share_level);
                record.console.clear();
            }
            if record.tab.url != url {
                record.tab.url = url.to_owned();
                record.nav_epoch = record.nav_epoch.saturating_add(1);
            }
        }
    }

    fn claim(&self, plugin_id: &str) -> Result<(), BrowserHostError> {
        let mut occupant = self.occupant.lock().unwrap_or_else(|p| p.into_inner());
        match occupant.as_deref() {
            None => {
                *occupant = Some(plugin_id.to_owned());
                Ok(())
            }
            Some(current) if current == plugin_id => Ok(()),
            Some(_) => Err(BrowserHostError::new(
                "browser_provider_denied",
                "another plugin currently owns the browser runtime",
            )),
        }
    }

    pub fn release_occupant(&self, plugin_id: &str) {
        let mut occupant = self.occupant.lock().unwrap_or_else(|p| p.into_inner());
        if occupant.as_deref() == Some(plugin_id) {
            occupant.take();
        }
    }

    /// Register a native surface the engine already created for a page-initiated
    /// window (`target=_blank` / `window.open`). The host does not navigate it.
    pub fn adopt_tab(
        &self,
        tab_id: String,
        url: String,
        profile_id: String,
        bounds: BrowserBounds,
    ) -> BrowserTab {
        let parsed = Url::parse(&url).ok();
        let mut tab = BrowserTab {
            tab_id: tab_id.clone(),
            url: url.clone(),
            title: parsed
                .as_ref()
                .and_then(|value| value.host_str())
                .unwrap_or("Browser")
                .to_owned(),
            loading: true,
            origin: parsed.as_ref().and_then(origin_of),
            grant: None,
            profile_id,
            favicon: None,
        };
        let share_level = GrantLevel::Control;
        Self::apply_grant(&mut tab, share_level);
        let mut tabs = self.tabs.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(existing) = tabs.get(&tab_id) {
            return existing.tab.clone();
        }
        tabs.insert(
            tab_id,
            TabRecord {
                tab: tab.clone(),
                bounds,
                incarnation: 1,
                nav_epoch: 0,
                share_level,
                console: ConsoleRing::default(),
            },
        );
        tab
    }

    pub fn commit_url(&self, tab_id: &str, url: &str) {
        let Ok(parsed) = Url::parse(url) else {
            self.load_notify.notify_waiters();
            return;
        };
        if !policy::navigation_allowed(&parsed) || self.policy.blocked(&parsed) {
            self.load_notify.notify_waiters();
            return;
        }
        let mut tabs = self.tabs.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(record) = tabs.get_mut(tab_id) {
            record.tab.loading = false;
            let next_origin = origin_of(&parsed);
            let Some(origin) = next_origin else {
                drop(tabs);
                self.load_notify.notify_waiters();
                return;
            };
            if record.tab.origin.as_deref() != Some(origin.as_str()) {
                record.tab.origin = Some(origin);
                Self::apply_grant(&mut record.tab, record.share_level);
                record.console.clear();
            }
            if record.tab.url != url {
                record.console.clear();
            }
            record.tab.url = url.to_owned();
            record.nav_epoch = record.nav_epoch.saturating_add(1);
        }
        drop(tabs);
        self.load_notify.notify_waiters();
    }

    pub fn capabilities(&self) -> BrowserCapabilities {
        let settings = self.settings();
        let default_surface = if cfg!(target_os = "linux") {
            "window"
        } else {
            "child"
        };
        let surface = match settings.surface_override {
            SurfaceOverride::Window => "window",
            SurfaceOverride::Auto => default_surface,
        };
        BrowserCapabilities {
            available: self.available && self.policy.enabled(),
            platform: std::env::consts::OS.to_owned(),
            surface: surface.into(),
            profiles: true,
            doc_guest: !cfg!(target_os = "linux"),
            proxy: self.native.proxy_capability(),
            downloads_dir: self.native.downloads_dir(),
            policy: self.policy.status(),
        }
    }

    fn enforce_url_policy(&self, parsed: &Url) -> Result<(), BrowserHostError> {
        if !self.policy.enabled() {
            return Err(BrowserHostError::new(
                "browser_disabled_by_policy",
                "the built-in browser is disabled by administrator policy",
            ));
        }
        if let Some(rule) = self.policy.rule_for(parsed) {
            if rule.action == HostRuleAction::Block {
                return Err(BrowserHostError::new(
                    "browser_blocked_by_policy",
                    format!(
                        "navigation to {} is blocked by site rules (matching {})",
                        parsed, rule.pattern
                    ),
                ));
            }
            if rule.action == HostRuleAction::System {
                return Err(BrowserHostError::new(
                    "browser_use_system_browser",
                    format!(
                        "site rules open {} in the system browser (matching {})",
                        parsed, rule.pattern
                    ),
                ));
            }
        }
        Ok(())
    }

    async fn create_tab(
        &self,
        url: Option<&str>,
        profile_id: Option<&str>,
        bounds: BrowserBounds,
        grant: Option<GrantLevel>,
    ) -> Result<BrowserTab, BrowserHostError> {
        if !self.available {
            return Err(BrowserHostError::new(
                "browser_unavailable",
                "native browser tabs are not available on this Host",
            ));
        }
        let url = url.unwrap_or("about:blank");
        let parsed = Url::parse(url)
            .map_err(|error| BrowserHostError::new("browser_bad_address", error.to_string()))?;
        if !policy::open_url_allowed(&parsed) {
            return Err(BrowserHostError::new(
                "browser_bad_address",
                "only http(s) addresses or about:blank can open in a tab",
            ));
        }
        self.enforce_url_policy(&parsed)?;
        let tab_id = Uuid::new_v4().to_string();
        let settings = self.settings();
        let profile_id = profile_id
            .filter(|id| !id.trim().is_empty())
            .unwrap_or(&settings.new_tab_profile)
            .to_owned();
        self.native.open(&tab_id, url, &bounds, &profile_id).await?;
        let origin = origin_of(&parsed);
        let share_level = if !settings.tools_enabled {
            GrantLevel::None
        } else {
            grant.unwrap_or_else(|| {
                origin
                    .as_deref()
                    .and_then(|o| settings.origin_grants.get(o).copied())
                    .unwrap_or(settings.default_grant)
            })
        };
        let mut tab = BrowserTab {
            tab_id: tab_id.clone(),
            url: url.to_owned(),
            title: parsed.host_str().unwrap_or("Browser").to_owned(),
            loading: parsed.as_str() != "about:blank",
            origin,
            grant: None,
            profile_id,
            favicon: None,
        };
        Self::apply_grant(&mut tab, share_level);
        self.tabs.lock().unwrap_or_else(|p| p.into_inner()).insert(
            tab_id,
            TabRecord {
                tab: tab.clone(),
                bounds,
                incarnation: 1,
                nav_epoch: 0,
                share_level,
                console: ConsoleRing::default(),
            },
        );
        Ok(tab)
    }

    async fn wait_for_tab_settle(&self, tab_id: &str, max_wait: Duration) {
        if !self.native.supports_page_load_events() {
            return;
        }
        let deadline = tokio::time::Instant::now() + max_wait;
        loop {
            let notified = self.load_notify.notified();
            let is_loading = {
                let tabs = self.tabs.lock().unwrap_or_else(|p| p.into_inner());
                tabs.get(tab_id).is_some_and(|record| record.tab.loading)
            };
            if !is_loading {
                break;
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                break;
            }
            if tokio::time::timeout(deadline - now, notified)
                .await
                .is_err()
            {
                break;
            }
        }
        // Give SPA routers / DOMContentLoaded listeners a brief grace window to render.
        tokio::time::sleep(Duration::from_millis(60)).await;
        if let Ok(raw) = self
            .native
            .eval(
                tab_id,
                "JSON.stringify({ url: String(location.href || ''), title: String(document.title || '') })",
            )
            .await
        {
            let decoded = agent::decode_eval_result(&raw);
            if let Ok(val) = serde_json::from_str::<Value>(&decoded) {
                let page_url = val.get("url").and_then(Value::as_str);
                let page_title = val.get("title").and_then(Value::as_str);
                self.update_chrome(tab_id, page_url, page_title, None);
            }
        }
        {
            let mut tabs = self.tabs.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(record) = tabs.get_mut(tab_id) {
                record.tab.loading = false;
            }
        }
    }

    fn tab(&self, tab_id: &str) -> Result<BrowserTab, BrowserHostError> {
        self.tabs
            .lock()
            .expect("browser tabs")
            .get(tab_id)
            .map(|record| record.tab.clone())
            .ok_or_else(|| BrowserHostError::new("browser_no_such_tab", format!("no tab {tab_id}")))
    }

    fn resolve_tab_id(&self, explicit: Option<&str>) -> Result<String, BrowserHostError> {
        if let Some(tab_id) = explicit.map(str::trim).filter(|id| !id.is_empty()) {
            let _ = self.tab(tab_id)?;
            return Ok(tab_id.to_owned());
        }
        let tabs = self.tabs.lock().unwrap_or_else(|p| p.into_inner());
        if tabs.len() == 1 {
            return Ok(tabs.keys().next().expect("single tab").clone());
        }
        if tabs.is_empty() {
            return Err(BrowserHostError::new(
                "browser_no_such_tab",
                "no browser tab is open; open a tab first",
            ));
        }
        Err(BrowserHostError::new(
            "browser_invalid",
            "more than one browser tab is open; pass tabId (see browser_list_tabs)",
        ))
    }

    fn require_grant(
        &self,
        tab: &BrowserTab,
        required: GrantLevel,
        action: &str,
    ) -> Result<(), BrowserHostError> {
        let level = tab.grant_level();
        if !level.allows(GrantLevel::Read) {
            self.note_activity(&tab.tab_id, action, "refused");
            return Err(BrowserHostError::new(
                "browser_grant_required",
                format!(
                    "Browser tab {} is not shared. Share it from the address bar.",
                    tab.tab_id
                ),
            ));
        }
        if !level.allows(required) {
            self.note_activity(&tab.tab_id, action, "refused");
            return Err(BrowserHostError::new(
                "browser_control_required",
                format!(
                    "Browser tab {} is shared for reading only. Allow actions from the address bar.",
                    tab.tab_id
                ),
            ));
        }
        Ok(())
    }

    fn ensure_tools(&self) -> Result<(), BrowserHostError> {
        if self.settings().tools_enabled {
            Ok(())
        } else {
            Err(BrowserHostError::new(
                "browser_tools_disabled",
                "Agent browser tools are disabled in Settings → Browser.",
            ))
        }
    }

    fn ensure_eval(&self) -> Result<(), BrowserHostError> {
        self.ensure_tools()?;
        if self.settings().eval_enabled {
            Ok(())
        } else {
            Err(BrowserHostError::new(
                "browser_eval_disabled",
                "Running page JavaScript is disabled in Settings → Browser.",
            ))
        }
    }

    fn note_activity(&self, tab_id: &str, action: &str, outcome: &str) {
        self.native.notify(json!({
            "kind": "agent.activity",
            "tabId": tab_id,
            "action": action,
            "outcome": outcome,
            "at": now_ms(),
        }));
    }

    fn apply_grant(tab: &mut BrowserTab, level: GrantLevel) {
        let origin = tab.origin.clone();
        tab.grant = if level == GrantLevel::None || origin.is_none() {
            None
        } else {
            Some(AgentGrant {
                level,
                origin: origin.unwrap_or_default(),
                granted_at: now_ms(),
            })
        };
    }
}

pub async fn dispatch(
    service: &BrowserService,
    plugin_id: &str,
    operation: &str,
    input: Value,
) -> Result<Value, BrowserHostError> {
    service.claim(plugin_id)?;
    match operation {
        "capabilities" => serde_json::to_value(service.capabilities())
            .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string())),
        "settings.get" => serde_json::to_value(service.settings())
            .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string())),
        "settings.set" => {
            let current = service.settings();
            let mut merged = serde_json::to_value(&current)
                .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))?;
            if let (Some(base), Some(patch)) = (merged.as_object_mut(), input.as_object()) {
                for (k, v) in patch {
                    base.insert(k.clone(), v.clone());
                }
            }
            let next: BrowserSettings = serde_json::from_value(merged)
                .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))?;
            let saved = service.apply_settings(next);
            serde_json::to_value(saved)
                .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))
        }
        "policy.setRules" => {
            let rules: Vec<HostRule> = input
                .get("rules")
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))?
                .unwrap_or_default();
            let mut settings = service.settings();
            settings.host_rules = rules;
            service.apply_settings(settings);
            serde_json::to_value(service.policy.status())
                .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))
        }
        "profile.list" => {
            let settings = service.settings();
            Ok(json!({
                "profiles": settings.profiles,
                "newTabProfile": settings.new_tab_profile,
            }))
        }
        "profile.create" => {
            let label = required_string(&input, "label")?;
            let mut settings = service.settings();
            let base_slug = slugify_profile_id(
                input
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or(label.as_str()),
            );
            let mut candidate = base_slug.clone();
            let mut seq = 2usize;
            while settings.profiles.iter().any(|p| p.id == candidate) {
                candidate = format!("{base_slug}-{seq}");
                seq += 1;
            }
            let record = BrowserProfileRecord {
                id: candidate,
                label,
            };
            settings.profiles.push(record.clone());
            service.apply_settings(settings);
            serde_json::to_value(record)
                .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))
        }
        "profile.clear" => {
            let profile_id = required_string(&input, "profileId")?;
            let tab_ids: Vec<String> = {
                let tabs = service.tabs.lock().unwrap_or_else(|p| p.into_inner());
                tabs.values()
                    .filter(|record| record.tab.profile_id == profile_id)
                    .map(|record| record.tab.tab_id.clone())
                    .collect()
            };
            for tab_id in tab_ids {
                let _ = service.native.close(&tab_id).await;
                let mut tabs = service.tabs.lock().unwrap_or_else(|p| p.into_inner());
                tabs.remove(&tab_id);
            }
            service.native.clear_profile(&profile_id).await?;
            Ok(json!({ "cleared": true, "profileId": profile_id }))
        }
        "profile.remove" => {
            let profile_id = required_string(&input, "profileId")?;
            if profile_id == "default" {
                return Err(BrowserHostError::new(
                    "browser_invalid",
                    "the default profile cannot be removed",
                ));
            }
            let tab_ids: Vec<String> = {
                let tabs = service.tabs.lock().unwrap_or_else(|p| p.into_inner());
                tabs.values()
                    .filter(|record| record.tab.profile_id == profile_id)
                    .map(|record| record.tab.tab_id.clone())
                    .collect()
            };
            for tab_id in tab_ids {
                let _ = service.native.close(&tab_id).await;
                let mut tabs = service.tabs.lock().unwrap_or_else(|p| p.into_inner());
                tabs.remove(&tab_id);
            }
            let mut settings = service.settings();
            settings.profiles.retain(|p| p.id != profile_id);
            let saved = service.apply_settings(settings);
            service.native.remove_profile(&profile_id).await?;
            Ok(json!({
                "removed": true,
                "profileId": profile_id,
                "profiles": saved.profiles,
                "newTabProfile": saved.new_tab_profile,
            }))
        }
        "tab.create" => {
            let url = input.get("url").and_then(Value::as_str);
            let profile_id = input.get("profileId").and_then(Value::as_str);
            let bounds = match input.get("bounds") {
                None => BrowserBounds::default(),
                Some(value) => serde_json::from_value(value.clone()).map_err(|error| {
                    BrowserHostError::new("browser_invalid", format!("bounds: {error}"))
                })?,
            };
            let grant = input
                .get("grant")
                .and_then(Value::as_str)
                .and_then(|value| serde_json::from_value(Value::String(value.to_string())).ok());
            let open_in_ui = !bounds.visible || bounds.width < 32.0 || bounds.height < 32.0;
            let wait_for_load = input
                .get("waitForLoad")
                .and_then(Value::as_bool)
                .unwrap_or(open_in_ui);
            let tab = service.create_tab(url, profile_id, bounds, grant).await?;
            if open_in_ui {
                service.native.notify(json!({
                    "kind": "tab.open",
                    "url": tab.url,
                    "tabId": tab.tab_id,
                }));
            }
            if wait_for_load && tab.url != "about:blank" {
                service
                    .wait_for_tab_settle(&tab.tab_id, Duration::from_millis(3500))
                    .await;
            }
            let final_tab = service.tab(&tab.tab_id).unwrap_or(tab);
            serde_json::to_value(final_tab)
                .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))
        }
        "tab.close" => {
            let tab_id = required_string(&input, "tabId")?;
            service.native.close(&tab_id).await?;
            {
                let mut tabs = service.tabs.lock().unwrap_or_else(|p| p.into_inner());
                tabs.remove(&tab_id);
            }
            Ok(json!({ "ok": true, "tabId": tab_id }))
        }
        "tab.list" => {
            let tabs: Vec<BrowserTab> = {
                let guard = service.tabs.lock().unwrap_or_else(|p| p.into_inner());
                guard.values().map(|record| record.tab.clone()).collect()
            };
            Ok(json!({ "tabs": tabs }))
        }
        "tab.navigate" => {
            let tab_id = service.resolve_tab_id(input.get("tabId").and_then(Value::as_str))?;
            let url = required_string(&input, "url")?;
            let parsed = Url::parse(&url)
                .map_err(|error| BrowserHostError::new("browser_bad_address", error.to_string()))?;
            if !policy::navigation_allowed(&parsed) {
                return Err(BrowserHostError::new(
                    "browser_bad_address",
                    "this address cannot load in a tab",
                ));
            }
            service.enforce_url_policy(&parsed)?;
            let _ = service.tab(&tab_id)?;
            service.native.navigate(&tab_id, &url).await?;
            {
                let mut tabs = service.tabs.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(record) = tabs.get_mut(&tab_id) {
                    let next_origin = origin_of(&parsed);
                    if record.tab.origin.as_deref() != next_origin.as_deref() {
                        record.tab.origin = next_origin;
                        BrowserService::apply_grant(&mut record.tab, record.share_level);
                    }
                    record.tab.url = url;
                    record.tab.loading = parsed.as_str() != "about:blank";
                    record.console.clear();
                    record.nav_epoch = record.nav_epoch.saturating_add(1);
                }
            }
            let wait_for_load = input
                .get("waitForLoad")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if wait_for_load && parsed.as_str() != "about:blank" {
                service
                    .wait_for_tab_settle(&tab_id, Duration::from_millis(3500))
                    .await;
            }
            serde_json::to_value(service.tab(&tab_id)?)
                .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))
        }
        "tab.back" => {
            let tab_id = required_string(&input, "tabId")?;
            let _ = service.tab(&tab_id)?;
            service.native.go_back(&tab_id).await?;
            Ok(json!({ "ok": true }))
        }
        "tab.forward" => {
            let tab_id = required_string(&input, "tabId")?;
            let _ = service.tab(&tab_id)?;
            service.native.go_forward(&tab_id).await?;
            Ok(json!({ "ok": true }))
        }
        "tab.reload" => {
            let tab_id = required_string(&input, "tabId")?;
            let _ = service.tab(&tab_id)?;
            {
                let mut tabs = service.tabs.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(record) = tabs.get_mut(&tab_id) {
                    record.console.clear();
                }
            }
            service.native.reload(&tab_id).await?;
            Ok(json!({ "ok": true }))
        }
        "tab.stop" => {
            let tab_id = required_string(&input, "tabId")?;
            let _ = service.tab(&tab_id)?;
            service.native.stop(&tab_id).await?;
            Ok(json!({ "ok": true }))
        }
        "tab.find" => {
            let tab_id = required_string(&input, "tabId")?;
            let query = input
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let forward = input
                .get("forward")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let _ = service.tab(&tab_id)?;
            let found = service.native.find(&tab_id, &query, forward).await?;
            Ok(json!({ "found": found }))
        }
        "tab.zoom" => {
            let tab_id = required_string(&input, "tabId")?;
            let factor = input
                .get("factor")
                .and_then(Value::as_f64)
                .filter(|value| *value > 0.0)
                .ok_or_else(|| BrowserHostError::new("browser_invalid", "factor is required"))?;
            let _ = service.tab(&tab_id)?;
            service.native.set_zoom(&tab_id, factor).await?;
            Ok(json!({ "ok": true, "factor": factor }))
        }
        "surface.freeze" => {
            let tab_id = required_string(&input, "tabId")?;
            let _ = service.tab(&tab_id)?;
            match service.native.freeze_frame(&tab_id).await? {
                Some(frame) => serde_json::to_value(frame)
                    .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string())),
                None => Ok(json!({ "mime": null, "data": null })),
            }
        }
        "tab.devtools" => {
            if !service.settings().devtools {
                return Err(BrowserHostError::new(
                    "browser_devtools_disabled",
                    "developer tools are disabled in browser settings",
                ));
            }
            let tab_id = required_string(&input, "tabId")?;
            let _ = service.tab(&tab_id)?;
            service.native.open_devtools(&tab_id).await?;
            Ok(json!({ "ok": true }))
        }
        "tab.chrome" => {
            let tab_id = required_string(&input, "tabId")?;
            let _ = service.tab(&tab_id)?;
            let raw = service
                .native
                .eval(
                    &tab_id,
                    r#"(function(){
  var icon = document.querySelector('link[rel="icon"]')
    || document.querySelector('link[rel="shortcut icon"]')
    || document.querySelector('link[rel*="icon"]');
  var favicon = icon && icon.href ? icon.href : (location.origin + '/favicon.ico');
  return { favicon: favicon, url: location.href, title: document.title || '' };
})()"#,
                )
                .await
                .unwrap_or_else(|_| "{}".into());
            let value: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
            service.update_chrome(
                &tab_id,
                value.get("url").and_then(Value::as_str),
                value.get("title").and_then(Value::as_str),
                value.get("favicon").and_then(Value::as_str),
            );
            Ok(value)
        }
        "tab.title" => {
            let tab_id = required_string(&input, "tabId")?;
            let _ = service.tab(&tab_id)?;
            let raw = service
                .native
                .eval(&tab_id, "document.title || ''")
                .await
                .unwrap_or_default();
            let title = crate::agent::decode_eval_result(&raw).trim().to_owned();
            service.update_chrome(&tab_id, None, Some(&title), None);
            Ok(json!({ "title": title }))
        }
        "tab.device" => {
            let tab_id = required_string(&input, "tabId")?;
            let device = required_string(&input, "device")?;
            if !matches!(device.as_str(), "desktop" | "phone" | "tablet") {
                return Err(BrowserHostError::new(
                    "browser_invalid",
                    "device must be desktop, phone, or tablet",
                ));
            }
            let _ = service.tab(&tab_id)?;
            service.native.set_device(&tab_id, &device).await?;
            Ok(json!({ "ok": true, "device": device }))
        }
        "surface.set" => {
            let tab_id = required_string(&input, "tabId")?;
            let bounds: BrowserBounds =
                serde_json::from_value(input.get("bounds").cloned().ok_or_else(|| {
                    BrowserHostError::new("browser_invalid", "bounds is required")
                })?)
                .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))?;
            let _ = service.tab(&tab_id)?;
            service.native.set_bounds(&tab_id, &bounds).await?;
            {
                let mut tabs = service.tabs.lock().unwrap_or_else(|p| p.into_inner());
                if let Some(record) = tabs.get_mut(&tab_id) {
                    record.bounds = bounds;
                }
            }
            Ok(json!({ "ok": true }))
        }
        "grant.set" => {
            let tab_id = required_string(&input, "tabId")?;
            let level: GrantLevel =
                serde_json::from_value(input.get("level").cloned().ok_or_else(|| {
                    BrowserHostError::new("browser_invalid", "level is required")
                })?)
                .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))?;
            let mut tabs = service.tabs.lock().unwrap_or_else(|p| p.into_inner());
            let record = tabs.get_mut(&tab_id).ok_or_else(|| {
                BrowserHostError::new("browser_no_such_tab", format!("no tab {tab_id}"))
            })?;
            let origin = record.tab.origin.clone().ok_or_else(|| {
                BrowserHostError::new("browser_not_grantable", "this tab has no origin to share")
            })?;
            record.share_level = level;
            record.tab.grant = if level == GrantLevel::None {
                None
            } else {
                Some(AgentGrant {
                    level,
                    origin: origin.clone(),
                    granted_at: now_ms(),
                })
            };
            let result = serde_json::to_value(&record.tab)
                .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))?;
            drop(tabs);
            let mut settings = service.settings();
            if level == GrantLevel::None {
                settings.origin_grants.remove(&origin);
            } else {
                settings.origin_grants.insert(origin.clone(), level);
            }
            service.apply_settings(settings);
            service.native.notify(json!({
                "kind": "tab.grant",
                "tabId": tab_id,
                "origin": origin,
                "level": level,
                "grant": result.get("grant").cloned().unwrap_or(Value::Null),
            }));
            Ok(result)
        }
        "snapshot" => {
            service.ensure_tools()?;
            snapshot(service, &input).await
        }
        "act" => {
            service.ensure_tools()?;
            act(service, &input).await
        }
        "console.read" => {
            service.ensure_tools()?;
            console_read(service, &input)
        }
        "console.push" => console_push(service, &input),
        "screenshot" | "tab.capture" => {
            service.ensure_tools()?;
            screenshot(service, &input).await
        }
        "eval.request" => {
            service.ensure_eval()?;
            let tab_id = service.resolve_tab_id(input.get("tabId").and_then(Value::as_str))?;
            let code = required_string(&input, "code")?;
            eval::validate_code(&code).map_err(|bad| {
                BrowserHostError::new(
                    match bad {
                        BadCode::Empty => "browser_invalid",
                        BadCode::TooLong => "browser_invalid",
                    },
                    bad.message(),
                )
            })?;
            let tab = service.tab(&tab_id)?;
            service.require_grant(&tab, GrantLevel::Control, "eval")?;
            eval_ask(service, &tab, &code).await
        }
        "eval.run" => {
            service.ensure_eval()?;
            let tab_id = service.resolve_tab_id(input.get("tabId").and_then(Value::as_str))?;
            let code = required_string(&input, "code")?;
            eval::validate_code(&code).map_err(|bad| {
                BrowserHostError::new(
                    match bad {
                        BadCode::Empty => "browser_invalid",
                        BadCode::TooLong => "browser_invalid",
                    },
                    bad.message(),
                )
            })?;
            let tab = service.tab(&tab_id)?;
            service.require_grant(&tab, GrantLevel::Control, "eval")?;
            let silent = service.settings().eval_approval == EvalApprovalMode::Silent;
            eval_run(service, &tab, &code, silent).await
        }
        "eval.decide" => {
            let request_id = required_string(&input, "requestId")?;
            let allow = input.get("allow").and_then(Value::as_bool).unwrap_or(false);
            service.evals.decide(&request_id, allow);
            if !allow {
                return Ok(json!({
                    "error": "browser_eval_declined",
                    "inserted": false
                }));
            }
            Ok(json!({ "ok": true }))
        }
        "pick.start" => {
            let tab_id = required_string(&input, "tabId")?;
            let _ = service.tab(&tab_id)?;
            let request_id = Uuid::new_v4().to_string();
            let id_json = serde_json::to_string(&request_id)
                .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))?;
            let script = format!(
                r#"
if (typeof globalThis.__codegSend !== "function") {{
  globalThis.__codegSend = function (s) {{
    try {{ window.ipc.postMessage(s); }} catch (e) {{}}
  }};
}}
{}
window.__codegPicker && window.__codegPicker.start({id_json});
"#,
                include_str!("../js/picker.js")
            );
            service.native.inject(&tab_id, &script).await?;
            Ok(json!({ "requestId": request_id, "tabId": tab_id }))
        }
        "pick.element" => {
            let tab_id = required_string(&input, "tabId")?;
            let _ = service.tab(&tab_id)?;
            let request_id = Uuid::new_v4().to_string();
            let id_json = serde_json::to_string(&request_id)
                .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))?;
            let script = format!(
                r#"
if (typeof globalThis.__codegSend !== "function") {{
  globalThis.__codegSend = function (s) {{
    try {{ window.ipc.postMessage(s); }} catch (e) {{}}
  }};
}}
{}
window.__codegPicker && window.__codegPicker.start({id_json});
"#,
                include_str!("../js/picker.js")
            );
            service.native.inject(&tab_id, &script).await?;
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
            loop {
                if tokio::time::Instant::now() > deadline {
                    let _ = service
                        .native
                        .inject(
                            &tab_id,
                            "window.__codegPicker && window.__codegPicker.stop();",
                        )
                        .await;
                    return Ok(json!({ "cancelled": true }));
                }
                tokio::time::sleep(std::time::Duration::from_millis(40)).await;
                let raw = service
                    .native
                    .eval(
                        &tab_id,
                        r#"(function(){var q=window.__vibexPickQueue||[];window.__vibexPickQueue=[];return q;})()"#,
                    )
                    .await
                    .unwrap_or_else(|_| "[]".into());
                let messages: Vec<Value> =
                    serde_json::from_str(&raw).unwrap_or_else(|_| Vec::new());
                for message in messages {
                    let parsed = if let Some(text) = message.as_str() {
                        serde_json::from_str::<Value>(text).unwrap_or(message.clone())
                    } else {
                        message
                    };
                    if parsed.get("kind").and_then(Value::as_str) != Some("pick") {
                        continue;
                    }
                    let payload = parsed.get("payload").cloned().unwrap_or(json!({}));
                    if payload.get("cancelled").and_then(Value::as_bool) == Some(true) {
                        return Ok(json!({ "cancelled": true }));
                    }
                    return Ok(json!({
                        "cancelled": false,
                        "payload": payload
                    }));
                }
            }
        }
        "pick.take" => {
            let tab_id = required_string(&input, "tabId")?;
            let _ = service.tab(&tab_id)?;
            let raw = service
                .native
                .eval(
                    &tab_id,
                    r#"(function(){var q=window.__vibexPickQueue||[];window.__vibexPickQueue=[];return q;})()"#,
                )
                .await
                .unwrap_or_else(|_| "[]".into());
            let messages: Vec<Value> = serde_json::from_str(&raw).unwrap_or_else(|_| Vec::new());
            Ok(json!({ "messages": messages }))
        }
        "pick.cancel" => {
            let tab_id = required_string(&input, "tabId")?;
            let _ = service
                .native
                .inject(
                    &tab_id,
                    "window.__codegPicker && window.__codegPicker.stop();",
                )
                .await;
            Ok(json!({ "ok": true }))
        }
        "pick.cloak" => {
            let tab_id = required_string(&input, "tabId")?;
            let hidden = input
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let script = if hidden {
                "window.__codegPicker && window.__codegPicker.cloak(true);"
            } else {
                "window.__codegPicker && window.__codegPicker.cloak(false);"
            };
            let _ = service.native.inject(&tab_id, script).await;
            Ok(json!({ "ok": true, "hidden": hidden }))
        }
        other => Err(BrowserHostError::new(
            "capability_unimplemented",
            format!("browser.{other} is not implemented"),
        )),
    }
}

async fn snapshot(service: &BrowserService, input: &Value) -> Result<Value, BrowserHostError> {
    let tab_id = service.resolve_tab_id(input.get("tabId").and_then(Value::as_str))?;
    let tab = service.tab(&tab_id)?;
    service.require_grant(&tab, GrantLevel::Read, "read")?;
    if tab.loading && tab.url != "about:blank" {
        service
            .wait_for_tab_settle(&tab_id, Duration::from_millis(2500))
            .await;
    }
    let max_chars = input
        .get("maxChars")
        .and_then(Value::as_u64)
        .map(|n| n as usize);
    let request = SnapshotRequest { max_chars };
    let (incarnation, nav_epoch) = {
        let tabs = service.tabs.lock().unwrap_or_else(|p| p.into_inner());
        let record = tabs.get(&tab_id).ok_or_else(|| {
            BrowserHostError::new("browser_no_such_tab", format!("no tab {tab_id}"))
        })?;
        (record.incarnation, record.nav_epoch)
    };
    let epoch = agent::epoch(incarnation, nav_epoch);
    let probed = service
        .native
        .eval(&tab_id, &agent::probe_and_snapshot(&request, &epoch))
        .await?;
    let raw = if agent::decode_eval_result(&probed) == agent::ENGINE_ABSENT {
        service
            .native
            .eval(&tab_id, &agent::install_and_snapshot(&request, &epoch))
            .await?
    } else {
        probed
    };
    let page = agent::parse_snapshot(&raw)?;
    service.update_chrome(&tab_id, Some(&page.url), Some(&page.title), None);
    service.note_activity(&tab_id, "read", "done");
    Ok(json!({
        "tabId": tab_id,
        "generation": page.generation,
        "url": page.url,
        "title": page.title,
        "viewport": page.viewport,
        "snapshot": page.tree,
        "tree": page.tree,
        "refsCount": page.refs_count,
        "truncated": page.truncated,
    }))
}

async fn act(service: &BrowserService, input: &Value) -> Result<Value, BrowserHostError> {
    let tab_id = service.resolve_tab_id(input.get("tabId").and_then(Value::as_str))?;
    let tab = service.tab(&tab_id)?;
    let action: BrowserAction = serde_json::from_value(input.clone())
        .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))?;
    let kind = if action.kind.trim().is_empty() {
        "click"
    } else {
        action.kind.trim()
    };
    service.require_grant(&tab, GrantLevel::Control, kind)?;
    let generation = action
        .generation
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty());
    let generation = generation.ok_or_else(|| {
        BrowserHostError::new(
            "browser_invalid",
            "act requires generation from the last snapshot",
        )
    })?;
    if action.kind != "press" && action.r#ref.as_deref().unwrap_or("").is_empty() {
        return Err(BrowserHostError::new(
            "browser_invalid",
            "act requires a snapshot ref",
        ));
    }
    let current_epoch = {
        let tabs = service.tabs.lock().unwrap_or_else(|p| p.into_inner());
        let record = tabs.get(&tab_id).ok_or_else(|| {
            BrowserHostError::new("browser_no_such_tab", format!("no tab {tab_id}"))
        })?;
        agent::epoch(record.incarnation, record.nav_epoch)
    };
    if generation.split('.').count() == 4 && !agent::ref_is_current(generation, &current_epoch) {
        return Err(BrowserHostError::new(
            "browser_stale_ref",
            "the page has navigated since that snapshot; take a new snapshot",
        ));
    }
    let payload = agent::action_payload(&action)?;
    let raw = service
        .native
        .eval(
            &tab_id,
            &agent::act_call(generation, action.r#ref.as_deref(), &payload),
        )
        .await?;
    let outcome = agent::parse_act(&raw)?;
    if !outcome.url.is_empty() {
        service.update_chrome(&tab_id, Some(&outcome.url), None, None);
    }
    let ok = outcome.ok && outcome.error.is_none();
    service.note_activity(&tab_id, kind, if ok { "done" } else { "failed" });
    Ok(json!({
        "tabId": tab_id,
        "ok": ok,
        "url": outcome.url,
        "scrolled": outcome.scrolled,
        "fidelity": "synthetic",
        "error": outcome.error,
    }))
}

fn console_read(service: &BrowserService, input: &Value) -> Result<Value, BrowserHostError> {
    let tab_id = service.resolve_tab_id(input.get("tabId").and_then(Value::as_str))?;
    let tab = service.tab(&tab_id)?;
    service.require_grant(&tab, GrantLevel::Read, "read")?;
    let since = input.get("since").and_then(Value::as_u64).unwrap_or(0);
    let min_level = match input
        .get("minLevel")
        .or_else(|| input.get("level"))
        .and_then(Value::as_str)
    {
        Some(raw) => Some(ConsoleLevel::parse(raw).ok_or_else(|| {
            BrowserHostError::new("browser_invalid", format!("unknown console level {raw:?}"))
        })?),
        None => None,
    };
    let limit = input
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| n as usize);
    let query = ConsoleQuery {
        since,
        min_level,
        limit,
    };
    let read = {
        let tabs = service.tabs.lock().unwrap_or_else(|p| p.into_inner());
        let record = tabs.get(&tab_id).ok_or_else(|| {
            BrowserHostError::new("browser_no_such_tab", format!("no tab {tab_id}"))
        })?;
        let origin = record.tab.origin.as_deref().unwrap_or("");
        record.console.read(&record.tab.url, origin, &query)
    };
    service.note_activity(&tab_id, "read", "done");
    serde_json::to_value(read)
        .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))
}

fn console_push(service: &BrowserService, input: &Value) -> Result<Value, BrowserHostError> {
    let tab_id = required_string(input, "tabId")?;
    let level_raw = input.get("level").and_then(Value::as_str).unwrap_or("log");
    let level = ConsoleLevel::parse(level_raw).unwrap_or(ConsoleLevel::Log);
    let source = input
        .get("source")
        .and_then(Value::as_str)
        .map(ConsoleSource::parse)
        .unwrap_or(ConsoleSource::Console);
    let text = input
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let url = input.get("url").and_then(Value::as_str).map(str::to_owned);
    let line = input
        .get("line")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok());
    let column = input
        .get("column")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok());
    let at = input
        .get("at")
        .and_then(Value::as_i64)
        .unwrap_or_else(now_ms);
    service.push_console_line(
        &tab_id,
        ConsoleLine {
            level,
            source,
            text,
            url,
            line,
            column,
            at,
            top: true,
            frame_origin: None,
        },
    );
    Ok(json!({ "ok": true }))
}

async fn screenshot(service: &BrowserService, input: &Value) -> Result<Value, BrowserHostError> {
    let tab_id = service.resolve_tab_id(input.get("tabId").and_then(Value::as_str))?;
    let tab = service.tab(&tab_id)?;
    service.require_grant(&tab, GrantLevel::Read, "read")?;
    if tab.loading && tab.url != "about:blank" {
        service
            .wait_for_tab_settle(&tab_id, Duration::from_millis(2000))
            .await;
    }
    let generation = input
        .get("generation")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let target = input
        .get("ref")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    if generation.is_some() != target.is_some() {
        return Err(BrowserHostError::new(
            "browser_invalid",
            "element screenshot requires both generation and ref",
        ));
    }
    let max_width = input
        .get("maxWidth")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok());
    let format = match input.get("format").and_then(Value::as_str) {
        Some(raw) => CaptureFormat::parse(raw).ok_or_else(|| {
            BrowserHostError::new(
                "browser_invalid",
                format!("unknown screenshot format {raw:?}"),
            )
        })?,
        None => CaptureFormat::Png,
    };
    let request = CaptureRequest {
        generation: generation.clone(),
        target: target.clone(),
        max_width,
        format,
    };
    let (url, viewport, region) = if let (Some(gen_token), Some(r)) = (&generation, &target) {
        let current_epoch = {
            let tabs = service.tabs.lock().unwrap_or_else(|p| p.into_inner());
            let record = tabs.get(&tab_id).ok_or_else(|| {
                BrowserHostError::new("browser_no_such_tab", format!("no tab {tab_id}"))
            })?;
            agent::epoch(record.incarnation, record.nav_epoch)
        };
        if gen_token.split('.').count() == 4 && !agent::ref_is_current(gen_token, &current_epoch) {
            return Err(BrowserHostError::new(
                "browser_stale_ref",
                "the page has navigated since that snapshot; take a new snapshot",
            ));
        }
        let raw = service
            .native
            .eval(&tab_id, &agent::rect_call(gen_token, r))
            .await?;
        let rect = agent::parse_rect(&raw)?;
        if rect.scrolled {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        (
            if rect.url.is_empty() {
                tab.url.clone()
            } else {
                rect.url
            },
            rect.viewport.unwrap_or_default(),
            Some(CaptureRegion {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            }),
        )
    } else {
        let vp = match service.native.eval(&tab_id, agent::viewport_call()).await {
            Ok(raw) => agent::parse_viewport(&raw)
                .map(|ans| {
                    let url = if ans.url.is_empty() {
                        tab.url.clone()
                    } else {
                        ans.url
                    };
                    (url, ans.viewport)
                })
                .unwrap_or_else(|_| (tab.url.clone(), SnapshotViewport::default())),
            Err(_) => (tab.url.clone(), SnapshotViewport::default()),
        };
        (vp.0, vp.1, None)
    };
    let png_bytes = service.native.capture_png(&tab_id).await?;
    let captured = capture::finish_capture(&png_bytes, url, &viewport, region, &request)
        .map_err(|error| BrowserHostError::new("browser_read_failed", error))?;
    service.note_activity(&tab_id, "read", "done");
    serde_json::to_value(captured)
        .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))
}

async fn eval_ask(
    service: &BrowserService,
    tab: &BrowserTab,
    code: &str,
) -> Result<Value, BrowserHostError> {
    let request_id = Uuid::new_v4().to_string();
    let _rx = service
        .evals
        .arm(&tab.tab_id, request_id.clone())
        .map_err(|refused| {
            BrowserHostError::new(
                match refused {
                    AskRefused::Busy => "browser_eval_busy",
                    AskRefused::CoolingDown => "browser_eval_busy",
                },
                "another snippet is waiting for approval",
            )
        })?;
    let expires_at = now_ms() + crate::confirm::EVAL_CONFIRM_TIMEOUT.as_millis() as i64;
    let plugin_id = service
        .occupant
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    service.native.notify(json!({
        "kind": "eval.request",
        "pluginId": plugin_id,
        "requestId": request_id,
        "tabId": tab.tab_id,
        "origin": tab.origin,
        "title": tab.title,
        "code": code,
        "expiresAt": expires_at,
    }));
    Ok(json!({
        "requestId": request_id,
        "tabId": tab.tab_id,
        "origin": tab.origin,
        "title": tab.title,
        "code": code,
        "pending": true,
        "expiresAt": expires_at,
    }))
}

async fn eval_run(
    service: &BrowserService,
    tab: &BrowserTab,
    code: &str,
    silent: bool,
) -> Result<Value, BrowserHostError> {
    if !silent {
        let request_id = Uuid::new_v4().to_string();
        let rx = service
            .evals
            .arm(&tab.tab_id, request_id.clone())
            .map_err(|refused| {
                BrowserHostError::new(
                    match refused {
                        AskRefused::Busy => "browser_eval_busy",
                        AskRefused::CoolingDown => "browser_eval_busy",
                    },
                    "another snippet is waiting for approval",
                )
            })?;
        let expires_at = now_ms() + crate::confirm::EVAL_CONFIRM_TIMEOUT.as_millis() as i64;
        let plugin_id = service
            .occupant
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        service.native.notify(json!({
            "kind": "eval.request",
            "pluginId": plugin_id,
            "requestId": request_id,
            "tabId": tab.tab_id,
            "origin": tab.origin,
            "title": tab.title,
            "code": code,
            "expiresAt": expires_at,
        }));
        let allow = match tokio::time::timeout(crate::confirm::EVAL_CONFIRM_TIMEOUT, rx).await {
            Ok(Ok(value)) => value,
            Ok(Err(_)) | Err(_) => {
                service.evals.abandon(&request_id);
                false
            }
        };
        if !allow {
            service.note_activity(&tab.tab_id, "eval", "refused");
            return Err(BrowserHostError::new(
                "browser_eval_declined",
                "the snippet was not approved. Do not send the same snippet again.",
            ));
        }
    }
    let raw = service
        .native
        .eval(&tab.tab_id, &eval::eval_call(code))
        .await?;
    let decoded = agent::decode_eval_result(&raw);
    let answer: eval::EvalAnswer = serde_json::from_str(&decoded).unwrap_or(eval::EvalAnswer {
        ok: false,
        error: Some(decoded),
        ..eval::EvalAnswer::default()
    });
    let url = service
        .native
        .current_url(&tab.tab_id)
        .await
        .unwrap_or_else(|_| tab.url.clone());
    let outcome = eval::EvalOutcome::from_answer(&answer, url);
    service.note_activity(
        &tab.tab_id,
        "eval",
        if outcome.kind == eval::EVAL_KIND_EXCEPTION {
            "failed"
        } else {
            "done"
        },
    );
    serde_json::to_value(json!({
        "tabId": tab.tab_id,
        "result": outcome,
    }))
    .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))
}

fn slugify_profile_id(raw: &str) -> String {
    let mut slug = String::new();
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if (ch == '-' || ch == '_' || ch.is_whitespace()) && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "profile".to_owned()
    } else {
        trimmed.chars().take(40).collect()
    }
}

fn required_string(input: &Value, key: &str) -> Result<String, BrowserHostError> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| BrowserHostError::new("browser_invalid", format!("{key} is required")))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MemoryNative;

    #[async_trait]
    impl NativeTabs for MemoryNative {
        async fn open(
            &self,
            _tab_id: &str,
            _url: &str,
            _bounds: &BrowserBounds,
            _profile_id: &str,
        ) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn navigate(&self, _tab_id: &str, _url: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn close(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn set_bounds(
            &self,
            _tab_id: &str,
            _bounds: &BrowserBounds,
        ) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn eval(&self, _tab_id: &str, expression: &str) -> Result<String, BrowserHostError> {
            if expression.contains(".act(") {
                return Ok(r#"{"ok":true,"url":"https://example.test/"}"#.into());
            }
            Ok(
                r#"{"generation":"w.1.0","url":"https://example.test/","title":"Example","tree":"- heading \"Example\" [ref=e1]","refsCount":1,"truncated":false}"#.into(),
            )
        }
        async fn current_url(&self, _tab_id: &str) -> Result<String, BrowserHostError> {
            Ok("https://example.test/".into())
        }
        async fn go_back(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn go_forward(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn reload(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn set_zoom(&self, _tab_id: &str, _factor: f64) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn open_devtools(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn set_device(&self, _tab_id: &str, _device: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn inject(&self, _tab_id: &str, _script: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn user_address_bar_navigation_does_not_need_a_share_grant() {
        let service = BrowserService::new(Arc::new(MemoryNative), true);
        let tab = dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({ "url": "https://example.test/" }),
        )
        .await
        .expect("open");
        let tab_id = tab["tabId"].as_str().unwrap();
        let next = dispatch(
            &service,
            "vibex.browser",
            "tab.navigate",
            json!({ "tabId": tab_id, "url": "https://example.test/docs" }),
        )
        .await
        .expect("user navigation");
        assert_eq!(next["url"], "https://example.test/docs");
        dispatch(
            &service,
            "vibex.browser",
            "grant.set",
            json!({ "tabId": tab_id, "level": "control" }),
        )
        .await
        .expect("grant");
        let same_origin = dispatch(
            &service,
            "vibex.browser",
            "tab.navigate",
            json!({ "tabId": tab_id, "url": "https://example.test/about" }),
        )
        .await
        .expect("same origin");
        assert_eq!(same_origin["grant"]["level"], "control");
        let other_origin = dispatch(
            &service,
            "vibex.browser",
            "tab.navigate",
            json!({ "tabId": tab_id, "url": "https://other.test/" }),
        )
        .await
        .expect("new origin");
        assert_eq!(other_origin["grant"]["level"], "control");
        dispatch(
            &service,
            "vibex.browser",
            "snapshot",
            json!({ "tabId": tab_id }),
        )
        .await
        .expect("standing share follows the tab");
    }

    #[tokio::test]
    async fn tab_create_can_share_the_page_for_agents() {
        let service = BrowserService::new(Arc::new(MemoryNative), true);
        let tab = dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({ "url": "https://example.test/", "grant": "control" }),
        )
        .await
        .expect("open");
        assert_eq!(tab["grant"]["level"], "control");
    }

    #[tokio::test]
    async fn commit_url_keeps_a_share_across_blank_and_same_origin_loads() {
        let service = BrowserService::new(Arc::new(MemoryNative), true);
        let tab = dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({ "url": "https://example.test/", "grant": "control" }),
        )
        .await
        .expect("open");
        let tab_id = tab["tabId"].as_str().unwrap();
        service.commit_url(tab_id, "about:blank");
        let after_blank = service.tab(tab_id).expect("tab");
        assert_eq!(after_blank.url, "https://example.test/");
        assert_eq!(
            after_blank.grant.as_ref().map(|grant| grant.level),
            Some(GrantLevel::Control)
        );
        assert!(!after_blank.loading);
        service.commit_url(tab_id, "https://example.test/search");
        let same = service.tab(tab_id).expect("tab");
        assert_eq!(same.url, "https://example.test/search");
        assert_eq!(
            same.grant.as_ref().map(|grant| grant.level),
            Some(GrantLevel::Control)
        );
        service.commit_url(tab_id, "https://other.test/");
        let other = service.tab(tab_id).expect("tab");
        assert_eq!(
            other.grant.as_ref().map(|grant| grant.level),
            Some(GrantLevel::Control)
        );
        assert_eq!(other.origin.as_deref(), Some("https://other.test"));
        assert_eq!(
            other.grant.as_ref().map(|grant| grant.origin.as_str()),
            Some("https://other.test")
        );
    }

    #[tokio::test]
    async fn tab_create_defaults_to_control_share() {
        let service = BrowserService::new(Arc::new(MemoryNative), true);
        let tab = dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({ "url": "https://example.test/" }),
        )
        .await
        .expect("open");
        assert_eq!(tab["grant"]["level"], "control");
    }

    #[tokio::test]
    async fn stopping_share_survives_origin_changes() {
        let service = BrowserService::new(Arc::new(MemoryNative), true);
        let tab = dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({ "url": "https://example.test/", "grant": "control" }),
        )
        .await
        .expect("open");
        let tab_id = tab["tabId"].as_str().unwrap();
        dispatch(
            &service,
            "vibex.browser",
            "grant.set",
            json!({ "tabId": tab_id, "level": "none" }),
        )
        .await
        .expect("stop sharing");
        service.commit_url(tab_id, "https://other.test/");
        let other = service.tab(tab_id).expect("tab");
        assert!(other.grant.is_none());
        let snap = dispatch(
            &service,
            "vibex.browser",
            "snapshot",
            json!({ "tabId": tab_id }),
        )
        .await
        .expect_err("stopped share");
        assert_eq!(snap.code(), "browser_grant_required");
    }

    #[test]
    fn adopt_tab_registers_an_engine_created_popup_without_native_open() {
        let service = BrowserService::new(Arc::new(MemoryNative), true);
        let tab = service.adopt_tab(
            "opener-p1".into(),
            "https://github.com/xintaofei/codeg".into(),
            "default".into(),
            BrowserBounds::default(),
        );
        assert_eq!(tab.tab_id, "opener-p1");
        assert_eq!(tab.url, "https://github.com/xintaofei/codeg");
        assert_eq!(
            service.tab("opener-p1").expect("adopted").url,
            "https://github.com/xintaofei/codeg"
        );
        let again = service.adopt_tab(
            "opener-p1".into(),
            "https://example.test/".into(),
            "default".into(),
            BrowserBounds::default(),
        );
        assert_eq!(again.url, "https://github.com/xintaofei/codeg");
    }

    #[test]
    fn default_bounds_do_not_open_a_full_size_overlay() {
        let bounds = BrowserBounds::default();
        assert!(bounds.width <= 1.0);
        assert!(bounds.height <= 1.0);
        assert!(!bounds.visible);
    }

    struct RecordingNative {
        bounds: Mutex<Vec<BrowserBounds>>,
        events: Mutex<Vec<Value>>,
    }

    #[async_trait]
    impl NativeTabs for RecordingNative {
        async fn open(
            &self,
            _tab_id: &str,
            _url: &str,
            bounds: &BrowserBounds,
            _profile_id: &str,
        ) -> Result<(), BrowserHostError> {
            self.bounds.lock().expect("bounds").push(bounds.clone());
            Ok(())
        }
        async fn navigate(&self, _tab_id: &str, _url: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn close(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn set_bounds(
            &self,
            _tab_id: &str,
            bounds: &BrowserBounds,
        ) -> Result<(), BrowserHostError> {
            self.bounds.lock().expect("bounds").push(bounds.clone());
            Ok(())
        }
        async fn eval(&self, _tab_id: &str, _expression: &str) -> Result<String, BrowserHostError> {
            Ok("{}".into())
        }
        async fn current_url(&self, _tab_id: &str) -> Result<String, BrowserHostError> {
            Ok("https://example.test/".into())
        }
        async fn go_back(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn go_forward(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn reload(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn set_zoom(&self, _tab_id: &str, _factor: f64) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn open_devtools(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn set_device(&self, _tab_id: &str, _device: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn inject(&self, _tab_id: &str, _script: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        fn notify(&self, payload: Value) {
            self.events.lock().expect("events").push(payload);
        }
    }

    #[tokio::test]
    async fn tab_create_forwards_panel_bounds_to_the_native_surface() {
        let native = Arc::new(RecordingNative {
            bounds: Mutex::new(Vec::new()),
            events: Mutex::new(Vec::new()),
        });
        let service = BrowserService::new(native.clone(), true);
        dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({
                "url": "https://example.test/",
                "bounds": {
                    "x": 120.0,
                    "y": 80.0,
                    "width": 640.0,
                    "height": 480.0,
                    "scale": 2.0,
                    "visible": true
                }
            }),
        )
        .await
        .expect("create");
        let bounds = native.bounds.lock().expect("bounds")[0].clone();
        assert_eq!(bounds.x, 120.0);
        assert_eq!(bounds.y, 80.0);
        assert_eq!(bounds.width, 640.0);
        assert_eq!(bounds.height, 480.0);
        assert!(bounds.visible);
        assert!(native.events.lock().expect("events").is_empty());
    }

    #[tokio::test]
    async fn tab_create_without_panel_bounds_asks_the_ui_to_open_a_tab() {
        let native = Arc::new(RecordingNative {
            bounds: Mutex::new(Vec::new()),
            events: Mutex::new(Vec::new()),
        });
        let service = BrowserService::new(native.clone(), true);
        let tab = dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({ "url": "https://github.com/" }),
        )
        .await
        .expect("create");
        let events = native.events.lock().expect("events");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["kind"], "tab.open");
        assert_eq!(events[0]["url"], "https://github.com/");
        assert_eq!(events[0]["tabId"], tab["tabId"]);
    }

    #[tokio::test]
    async fn tab_create_rejects_malformed_bounds_instead_of_hiding_the_surface() {
        let service = BrowserService::new(Arc::new(MemoryNative), true);
        let error = dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({
                "url": "https://example.test/",
                "bounds": "not-a-rect"
            }),
        )
        .await
        .expect_err("malformed bounds");
        assert_eq!(error.code(), "browser_invalid");
    }

    #[tokio::test]
    async fn occupant_and_scheme_gates() {
        let service = BrowserService::new(Arc::new(MemoryNative), true);
        dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({ "url": "file:///etc/passwd" }),
        )
        .await
        .expect_err("file refused");
        let tab = dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({ "url": "https://example.test/", "grant": "none" }),
        )
        .await
        .expect("open");
        let tab_id = tab["tabId"].as_str().unwrap();
        let denied = dispatch(&service, "other.plugin", "tab.list", json!({}))
            .await
            .expect_err("other plugin");
        assert_eq!(denied.code(), "browser_provider_denied");
        let snap = dispatch(
            &service,
            "vibex.browser",
            "snapshot",
            json!({ "tabId": tab_id }),
        )
        .await
        .expect_err("unshared");
        assert_eq!(snap.code(), "browser_grant_required");
        dispatch(
            &service,
            "vibex.browser",
            "grant.set",
            json!({ "tabId": tab_id, "level": "read" }),
        )
        .await
        .expect("grant");
        let snap = dispatch(
            &service,
            "vibex.browser",
            "snapshot",
            json!({ "tabId": tab_id }),
        )
        .await
        .expect("read");
        assert_eq!(snap["snapshot"], "- heading \"Example\" [ref=e1]");
        assert_eq!(snap["generation"], "w.1.0");
        dispatch(
            &service,
            "vibex.browser",
            "grant.set",
            json!({ "tabId": tab_id, "level": "control" }),
        )
        .await
        .expect("control");
        let clicked = dispatch(
            &service,
            "vibex.browser",
            "act",
            json!({
                "tabId": tab_id,
                "kind": "click",
                "generation": "w.1.0",
                "ref": "e1"
            }),
        )
        .await
        .expect("click");
        assert_eq!(clicked["ok"], true);
        let stale = dispatch(
            &service,
            "vibex.browser",
            "act",
            json!({ "tabId": tab_id, "kind": "click", "ref": "e1" }),
        )
        .await
        .expect_err("generation required");
        assert_eq!(stale.code(), "browser_invalid");
    }

    struct EvalRecorder {
        last: Mutex<String>,
    }

    #[async_trait]
    impl NativeTabs for EvalRecorder {
        async fn open(
            &self,
            _tab_id: &str,
            _url: &str,
            _bounds: &BrowserBounds,
            _profile_id: &str,
        ) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn navigate(&self, _tab_id: &str, _url: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn close(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn set_bounds(
            &self,
            _tab_id: &str,
            _bounds: &BrowserBounds,
        ) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn eval(&self, _tab_id: &str, expression: &str) -> Result<String, BrowserHostError> {
            *self.last.lock().expect("eval") = expression.to_owned();
            Ok("started".into())
        }
        async fn current_url(&self, _tab_id: &str) -> Result<String, BrowserHostError> {
            Ok("https://example.test/".into())
        }
        async fn go_back(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn go_forward(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn reload(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn set_zoom(&self, _tab_id: &str, _factor: f64) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn open_devtools(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn set_device(&self, _tab_id: &str, _device: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn inject(&self, _tab_id: &str, script: &str) -> Result<(), BrowserHostError> {
            *self.last.lock().expect("eval") = script.to_owned();
            Ok(())
        }
    }

    #[tokio::test]
    async fn pick_start_arms_the_injected_picker() {
        let native = Arc::new(EvalRecorder {
            last: Mutex::new(String::new()),
        });
        let service = BrowserService::new(native.clone(), true);
        let tab = dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({ "url": "https://example.test/" }),
        )
        .await
        .expect("open");
        let tab_id = tab["tabId"].as_str().unwrap();
        dispatch(
            &service,
            "vibex.browser",
            "pick.start",
            json!({ "tabId": tab_id }),
        )
        .await
        .expect("pick");
        let script = native.last.lock().expect("eval").clone();
        assert!(script.contains("__codegSend"));
        assert!(script.contains("__codegPicker.start"));
    }

    #[tokio::test]
    async fn settings_profiles_and_host_rules_are_enforced() {
        let service = BrowserService::new(Arc::new(MemoryNative), true);
        let updated = dispatch(
            &service,
            "vibex.browser",
            "settings.set",
            json!({
                "hostRules": [
                    { "pattern": "blocked.example", "action": "block" }
                ],
                "evalEnabled": true,
                "evalApproval": "silent"
            }),
        )
        .await
        .expect("settings.set");
        assert_eq!(updated["evalEnabled"], true);
        assert_eq!(updated["evalApproval"], "silent");

        let blocked = dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({ "url": "https://blocked.example/path" }),
        )
        .await
        .expect_err("blocked domain refused");
        assert_eq!(blocked.code(), "browser_blocked_by_policy");

        let created_profile = dispatch(
            &service,
            "vibex.browser",
            "profile.create",
            json!({ "label": "Work Account" }),
        )
        .await
        .expect("profile.create");
        assert_eq!(created_profile["id"], "work-account");
        assert_eq!(created_profile["label"], "Work Account");

        let listed = dispatch(&service, "vibex.browser", "profile.list", json!({}))
            .await
            .expect("profile.list");
        assert_eq!(listed["profiles"].as_array().unwrap().len(), 2);

        let default_remove = dispatch(
            &service,
            "vibex.browser",
            "profile.remove",
            json!({ "profileId": "default" }),
        )
        .await
        .expect_err("default profile cannot be removed");
        assert_eq!(default_remove.code(), "browser_invalid");

        let removed = dispatch(
            &service,
            "vibex.browser",
            "profile.remove",
            json!({ "profileId": "work-account" }),
        )
        .await
        .expect("profile.remove");
        assert_eq!(removed["removed"], true);
        assert_eq!(removed["profiles"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn settings_page_values_reach_tab_create_and_agent_tools() {
        let service = BrowserService::new(Arc::new(MemoryNative), true);
        let updated = dispatch(
            &service,
            "vibex.browser",
            "settings.set",
            json!({
                "newTabProfile": "ephemeral",
                "defaultGrant": "read",
                "hostRules": [
                    { "pattern": "https://*.example.com:8443", "action": "system" },
                    { "pattern": "blocked.example", "action": "block" }
                ]
            }),
        )
        .await
        .expect("settings.set");
        assert_eq!(updated["newTabProfile"], "ephemeral");
        assert_eq!(updated["defaultGrant"], "read");
        assert_eq!(updated["devtools"], true);
        assert_eq!(updated["evalEnabled"], true);
        assert_eq!(updated["hostRules"].as_array().unwrap().len(), 2);

        let tab = dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({ "url": "https://example.test/" }),
        )
        .await
        .expect("open");
        assert_eq!(tab["grant"]["level"], "read");
        assert_eq!(tab["profileId"], "ephemeral");

        let external = dispatch(
            &service,
            "vibex.browser",
            "tab.navigate",
            json!({ "tabId": tab["tabId"], "url": "https://a.example.com:8443/login" }),
        )
        .await
        .expect_err("system rule");
        assert_eq!(external.code(), "browser_use_system_browser");

        dispatch(
            &service,
            "vibex.browser",
            "settings.set",
            json!({ "toolsEnabled": false, "evalEnabled": false }),
        )
        .await
        .expect("disable tools");
        let unshared = dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({ "url": "https://example.test/next", "grant": "control" }),
        )
        .await
        .expect("open unshared");
        assert!(unshared["grant"].is_null());
        let refused = dispatch(
            &service,
            "vibex.browser",
            "snapshot",
            json!({ "tabId": unshared["tabId"] }),
        )
        .await
        .expect_err("tools off");
        assert_eq!(refused.code(), "browser_tools_disabled");

        dispatch(
            &service,
            "vibex.browser",
            "settings.set",
            json!({ "toolsEnabled": true, "evalEnabled": false, "defaultGrant": "control" }),
        )
        .await
        .expect("eval off");
        let shared = dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({ "url": "https://example.test/eval" }),
        )
        .await
        .expect("open shared");
        let eval_off = dispatch(
            &service,
            "vibex.browser",
            "eval.run",
            json!({
                "tabId": shared["tabId"],
                "code": "1+1",
                "evalApproval": "silent"
            }),
        )
        .await
        .expect_err("eval disabled");
        assert_eq!(eval_off.code(), "browser_eval_disabled");

        dispatch(
            &service,
            "vibex.browser",
            "settings.set",
            json!({ "evalEnabled": true, "evalApproval": "silent" }),
        )
        .await
        .expect("silent eval");
        let ran = dispatch(
            &service,
            "vibex.browser",
            "eval.run",
            json!({
                "tabId": shared["tabId"],
                "code": "1+1",
                "evalApproval": "ask"
            }),
        )
        .await
        .expect("setting silent wins over the request");
        assert_eq!(ran["tabId"], shared["tabId"]);
    }

    #[tokio::test]
    async fn console_ring_reads_and_clears_on_navigation() {
        let service = BrowserService::new(Arc::new(MemoryNative), true);
        let tab = dispatch(
            &service,
            "vibex.browser",
            "tab.create",
            json!({ "url": "https://example.test/" }),
        )
        .await
        .expect("open");
        let tab_id = tab["tabId"].as_str().unwrap();

        dispatch(
            &service,
            "vibex.browser",
            "console.push",
            json!({
                "tabId": tab_id,
                "level": "warn",
                "text": "deprecation warning",
                "line": 12
            }),
        )
        .await
        .expect("push warn");
        dispatch(
            &service,
            "vibex.browser",
            "console.push",
            json!({
                "tabId": tab_id,
                "level": "error",
                "source": "error",
                "text": "ReferenceError: x is not defined",
                "line": 42
            }),
        )
        .await
        .expect("push error");

        let errors_only = dispatch(
            &service,
            "vibex.browser",
            "console.read",
            json!({ "tabId": tab_id, "minLevel": "error" }),
        )
        .await
        .expect("read errors");
        let entries = errors_only["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["text"], "ReferenceError: x is not defined");

        dispatch(
            &service,
            "vibex.browser",
            "tab.navigate",
            json!({ "tabId": tab_id, "url": "https://example.test/next" }),
        )
        .await
        .expect("navigate");
        let after_nav = dispatch(
            &service,
            "vibex.browser",
            "console.read",
            json!({ "tabId": tab_id }),
        )
        .await
        .expect("read after nav");
        assert_eq!(after_nav["entries"].as_array().unwrap().len(), 0);
    }
}
