use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::{
    grant::{AgentGrant, GrantLevel},
    policy::{BrowserPolicyStatus, HostRule},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrozenFrame {
    pub mime: String,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default = "default_scale")]
    pub scale: f64,
    #[serde(default = "default_visible")]
    pub visible: bool,
}

fn default_scale() -> f64 {
    1.0
}

fn default_visible() -> bool {
    true
}

impl Default for BrowserBounds {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
            scale: 1.0,
            visible: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub tab_id: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub origin: Option<String>,
    pub grant: Option<AgentGrant>,
    pub profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
}

impl BrowserTab {
    pub fn grant_level(&self) -> GrantLevel {
        crate::grant::level_of(self.grant.as_ref())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfileRecord {
    pub id: String,
    pub label: String,
}

impl Default for BrowserProfileRecord {
    fn default() -> Self {
        Self {
            id: "default".to_owned(),
            label: "Default".to_owned(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProxyCapability {
    pub supported: bool,
    pub active: Option<String>,
    pub source: String,
}

impl Default for BrowserProxyCapability {
    fn default() -> Self {
        Self {
            supported: true,
            active: None,
            source: "system".to_owned(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapabilities {
    pub available: bool,
    pub platform: String,
    pub surface: String,
    pub profiles: bool,
    pub doc_guest: bool,
    #[serde(default)]
    pub proxy: BrowserProxyCapability,
    #[serde(default)]
    pub downloads_dir: Option<String>,
    #[serde(default)]
    pub policy: BrowserPolicyStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAction {
    pub kind: String,
    pub generation: Option<String>,
    pub r#ref: Option<String>,
    pub text: Option<String>,
    pub submit: Option<bool>,
    pub key: Option<String>,
    pub values: Option<Vec<String>>,
    pub button: Option<String>,
    pub double_click: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum EvalApprovalMode {
    #[default]
    Ask,
    Silent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceAutoOpenMode {
    Off,
    #[default]
    Toast,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SurfaceOverride {
    #[default]
    Auto,
    Window,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDefaultTargets {
    #[serde(default = "default_target_builtin")]
    pub transcript: String,
    #[serde(default = "default_target_builtin")]
    pub tool_card: String,
    #[serde(default = "default_target_builtin")]
    pub terminal: String,
    #[serde(default = "default_target_builtin")]
    pub editor: String,
    #[serde(default = "default_target_system")]
    pub notification: String,
}

fn default_target_builtin() -> String {
    "builtin".to_owned()
}

fn default_target_system() -> String {
    "system".to_owned()
}

impl Default for BrowserDefaultTargets {
    fn default() -> Self {
        Self {
            transcript: default_target_builtin(),
            tool_card: default_target_builtin(),
            terminal: default_target_builtin(),
            editor: default_target_builtin(),
            notification: default_target_system(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSettings {
    #[serde(default)]
    pub default_target: BrowserDefaultTargets,
    #[serde(default)]
    pub host_rules: Vec<HostRule>,
    #[serde(default = "default_true")]
    pub tools_enabled: bool,
    #[serde(default = "default_grant_control")]
    pub default_grant: GrantLevel,
    #[serde(default)]
    pub eval_enabled: bool,
    #[serde(default)]
    pub eval_approval: EvalApprovalMode,
    #[serde(default)]
    pub service_auto_open: ServiceAutoOpenMode,
    #[serde(default = "default_true")]
    pub terminal_click_menu: bool,
    #[serde(default)]
    pub devtools: bool,
    #[serde(default)]
    pub surface_override: SurfaceOverride,
    #[serde(default = "default_true")]
    pub suspend_background_tabs: bool,
    #[serde(default = "default_true")]
    pub sign_in_user_agent: bool,
    #[serde(default = "default_profiles")]
    pub profiles: Vec<BrowserProfileRecord>,
    #[serde(default = "default_profile_id")]
    pub new_tab_profile: String,
    #[serde(default)]
    pub origin_grants: BTreeMap<String, GrantLevel>,
}

fn default_true() -> bool {
    true
}

fn default_grant_control() -> GrantLevel {
    GrantLevel::Control
}

fn default_profiles() -> Vec<BrowserProfileRecord> {
    vec![BrowserProfileRecord::default()]
}

fn default_profile_id() -> String {
    "default".to_owned()
}

impl Default for BrowserSettings {
    fn default() -> Self {
        Self {
            default_target: BrowserDefaultTargets::default(),
            host_rules: Vec::new(),
            tools_enabled: true,
            default_grant: GrantLevel::Control,
            eval_enabled: false,
            eval_approval: EvalApprovalMode::Ask,
            service_auto_open: ServiceAutoOpenMode::Toast,
            terminal_click_menu: true,
            devtools: false,
            surface_override: SurfaceOverride::Auto,
            suspend_background_tabs: true,
            sign_in_user_agent: true,
            profiles: default_profiles(),
            new_tab_profile: default_profile_id(),
            origin_grants: BTreeMap::new(),
        }
    }
}
