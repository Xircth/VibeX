use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SystemProxySettings {
    pub enabled: bool,
    pub proxy_url: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AppLocale {
    #[default]
    En,
    ZhCn,
    ZhTw,
    Ja,
    Ko,
    Es,
    De,
    Fr,
    Pt,
    Ar,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum LanguageMode {
    #[default]
    System,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct SystemLanguageSettings {
    pub mode: LanguageMode,
    pub language: AppLocale,
}
