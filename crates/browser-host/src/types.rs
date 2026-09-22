use serde::{Deserialize, Serialize};

use crate::grant::{AgentGrant, GrantLevel};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FrozenFrame {
    pub mime: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
}

impl BrowserTab {
    pub fn grant_level(&self) -> GrantLevel {
        crate::grant::level_of(self.grant.as_ref())
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAction {
    pub kind: String,
    pub generation: Option<String>,
    pub r#ref: Option<String>,
    pub text: Option<String>,
    pub key: Option<String>,
    pub values: Option<Vec<String>>,
    pub button: Option<String>,
    pub double_click: Option<bool>,
}
