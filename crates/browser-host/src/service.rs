use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use serde_json::{Value, json};
use url::Url;
use uuid::Uuid;

use crate::{
    agent::{self, SnapshotRequest},
    confirm::{AskRefused, EvalConsent},
    error::BrowserHostError,
    eval::{self, BadCode},
    grant::{AgentGrant, GrantLevel, origin_of},
    policy::{self, HostRuleAction},
    types::{BrowserAction, BrowserBounds, BrowserCapabilities, BrowserTab},
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
}

pub struct BrowserService {
    occupant: Mutex<Option<String>>,
    tabs: Mutex<HashMap<String, TabRecord>>,
    evals: EvalConsent,
    native: Arc<dyn NativeTabs>,
    available: bool,
}

impl BrowserService {
    pub fn new(native: Arc<dyn NativeTabs>, available: bool) -> Self {
        Self {
            occupant: Mutex::new(None),
            tabs: Mutex::new(HashMap::new()),
            evals: EvalConsent::new(),
            native,
            available,
        }
    }

    pub fn unavailable() -> Self {
        Self::new(Arc::new(UnavailableNative), false)
    }

    fn claim(&self, plugin_id: &str) -> Result<(), BrowserHostError> {
        let mut occupant = self.occupant.lock().expect("browser occupant");
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
        let mut occupant = self.occupant.lock().expect("browser occupant");
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
        let tab = BrowserTab {
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
        };
        let mut tabs = self.tabs.lock().expect("browser tabs");
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
            },
        );
        tab
    }

    pub fn commit_url(&self, tab_id: &str, url: &str) {
        let Ok(parsed) = Url::parse(url) else {
            return;
        };
        if !policy::navigation_allowed(&parsed) {
            return;
        }
        let mut tabs = self.tabs.lock().expect("browser tabs");
        if let Some(record) = tabs.get_mut(tab_id) {
            record.tab.loading = false;
            let next_origin = origin_of(&parsed);
            let Some(origin) = next_origin else {
                return;
            };
            if record.tab.origin.as_deref() != Some(origin.as_str()) {
                if record.tab.origin.is_some() {
                    record.tab.grant = None;
                }
                record.tab.origin = Some(origin);
            }
            record.tab.url = url.to_owned();
            record.nav_epoch = record.nav_epoch.saturating_add(1);
        }
    }

    pub fn capabilities(&self) -> BrowserCapabilities {
        BrowserCapabilities {
            available: self.available,
            platform: std::env::consts::OS.to_owned(),
            surface: if cfg!(target_os = "linux") {
                "window".into()
            } else {
                "child".into()
            },
            profiles: true,
            doc_guest: !cfg!(target_os = "linux"),
        }
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
        let _ = HostRuleAction::Builtin;
        let tab_id = Uuid::new_v4().to_string();
        let profile_id = profile_id.unwrap_or("default").to_owned();
        self.native.open(&tab_id, url, &bounds, &profile_id).await?;
        let mut tab = BrowserTab {
            tab_id: tab_id.clone(),
            url: url.to_owned(),
            title: parsed.host_str().unwrap_or("Browser").to_owned(),
            loading: true,
            origin: origin_of(&parsed),
            grant: None,
            profile_id,
        };
        if let Some(level) = grant {
            Self::apply_grant(&mut tab, level);
        }
        self.tabs.lock().expect("browser tabs").insert(
            tab_id,
            TabRecord {
                tab: tab.clone(),
                bounds,
                incarnation: 1,
                nav_epoch: 0,
            },
        );
        Ok(tab)
    }

    fn tab(&self, tab_id: &str) -> Result<BrowserTab, BrowserHostError> {
        self.tabs
            .lock()
            .expect("browser tabs")
            .get(tab_id)
            .map(|record| record.tab.clone())
            .ok_or_else(|| BrowserHostError::new("browser_no_such_tab", format!("no tab {tab_id}")))
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
            let tab = service
                .create_tab(url, profile_id, bounds, grant)
                .await?;
            if open_in_ui {
                service.native.notify(json!({
                    "kind": "tab.open",
                    "url": tab.url,
                    "tabId": tab.tab_id,
                }));
            }
            serde_json::to_value(tab)
                .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))
        }
        "tab.close" => {
            let tab_id = required_string(&input, "tabId")?;
            service.native.close(&tab_id).await?;
            service.tabs.lock().expect("browser tabs").remove(&tab_id);
            Ok(json!({ "ok": true }))
        }
        "tab.list" => {
            let tabs: Vec<BrowserTab> = service
                .tabs
                .lock()
                .expect("browser tabs")
                .values()
                .map(|record| record.tab.clone())
                .collect();
            Ok(json!({ "tabs": tabs }))
        }
        "tab.navigate" => {
            let tab_id = required_string(&input, "tabId")?;
            let url = required_string(&input, "url")?;
            let parsed = Url::parse(&url)
                .map_err(|error| BrowserHostError::new("browser_bad_address", error.to_string()))?;
            if !policy::navigation_allowed(&parsed) {
                return Err(BrowserHostError::new(
                    "browser_bad_address",
                    "this address cannot load in a tab",
                ));
            }
            let _ = service.tab(&tab_id)?;
            service.native.navigate(&tab_id, &url).await?;
            let mut tabs = service.tabs.lock().expect("browser tabs");
            if let Some(record) = tabs.get_mut(&tab_id) {
                let next_origin = origin_of(&parsed);
                if record.tab.origin.as_deref() != next_origin.as_deref() {
                    record.tab.grant = None;
                }
                record.tab.url = url;
                record.tab.origin = next_origin;
                record.nav_epoch = record.nav_epoch.saturating_add(1);
            }
            drop(tabs);
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
            Ok(serde_json::from_str(&raw).unwrap_or_else(|_| json!({})))
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
            if let Some(record) = service.tabs.lock().expect("browser tabs").get_mut(&tab_id) {
                record.bounds = bounds;
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
            let mut tabs = service.tabs.lock().expect("browser tabs");
            let record = tabs.get_mut(&tab_id).ok_or_else(|| {
                BrowserHostError::new("browser_no_such_tab", format!("no tab {tab_id}"))
            })?;
            let origin = record.tab.origin.clone().ok_or_else(|| {
                BrowserHostError::new("browser_not_grantable", "this tab has no origin to share")
            })?;
            record.tab.grant = if level == GrantLevel::None {
                None
            } else {
                Some(AgentGrant {
                    level,
                    origin,
                    granted_at: now_ms(),
                })
            };
            serde_json::to_value(&record.tab)
                .map_err(|error| BrowserHostError::new("browser_invalid", error.to_string()))
        }
        "snapshot" => snapshot(service, &input).await,
        "act" => act(service, &input).await,
        "eval.request" => {
            let tab_id = required_string(&input, "tabId")?;
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
            let tab_id = required_string(&input, "tabId")?;
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
            eval_run(service, &tab, &code).await
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
        other => Err(BrowserHostError::new(
            "capability_unimplemented",
            format!("browser.{other} is not implemented"),
        )),
    }
}

async fn snapshot(service: &BrowserService, input: &Value) -> Result<Value, BrowserHostError> {
    let tab_id = required_string(input, "tabId")?;
    let tab = service.tab(&tab_id)?;
    service.require_grant(&tab, GrantLevel::Read, "read")?;
    let max_chars = input
        .get("maxChars")
        .and_then(Value::as_u64)
        .map(|n| n as usize);
    let request = SnapshotRequest { max_chars };
    let (incarnation, nav_epoch) = {
        let tabs = service.tabs.lock().expect("browser tabs");
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
    service.note_activity(&tab_id, "read", "done");
    Ok(json!({
        "tabId": tab_id,
        "generation": page.generation,
        "url": page.url,
        "title": page.title,
        "snapshot": page.tree,
        "refsCount": page.refs_count,
        "truncated": page.truncated,
    }))
}

async fn act(service: &BrowserService, input: &Value) -> Result<Value, BrowserHostError> {
    let tab_id = required_string(input, "tabId")?;
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
    let payload = agent::action_payload(&action)?;
    let raw = service
        .native
        .eval(
            &tab_id,
            &agent::act_call(generation, action.r#ref.as_deref(), &payload),
        )
        .await?;
    let outcome = agent::parse_act(&raw)?;
    let ok = outcome.ok && outcome.error.is_none();
    service.note_activity(&tab_id, kind, if ok { "done" } else { "failed" });
    Ok(json!({
        "tabId": tab_id,
        "ok": ok,
        "url": outcome.url,
        "fidelity": "synthetic",
        "error": outcome.error,
    }))
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
    service.native.notify(json!({
        "kind": "eval.request",
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
) -> Result<Value, BrowserHostError> {
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
    service.native.notify(json!({
        "kind": "eval.request",
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
        assert!(other_origin.get("grant").is_none() || other_origin["grant"].is_null());
        let snap = dispatch(
            &service,
            "vibex.browser",
            "snapshot",
            json!({ "tabId": tab_id }),
        )
        .await
        .expect_err("agent still needs a share");
        assert_eq!(snap.code(), "browser_grant_required");
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
        assert!(other.grant.is_none());
        assert_eq!(other.origin.as_deref(), Some("https://other.test"));
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
            json!({ "url": "https://example.test/" }),
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
}
