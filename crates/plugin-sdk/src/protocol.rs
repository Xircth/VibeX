use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PLUGIN_API_VERSION: &str = "1.0";
pub const PLUGIN_PROTOCOL_VERSION: &str = "1.1";
pub const PLUGIN_SDK_VERSION: &str = "1.0.0";
pub const MAX_FRAME_BYTES: usize = 1_048_576;

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PackageClass {
    #[default]
    FullTrust,
    Isolated,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginIdentity {
    pub publisher: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolLimits {
    pub max_frame_bytes: u64,
    pub request_timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub id: String,
    pub version: String,
    pub target: String,
    pub digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_range: Vec<String>,
    pub host_version: String,
    pub plugin_identity: PluginIdentity,
    pub package_version: String,
    pub package_digest: String,
    pub generation_id: u64,
    pub declared_contributions: Vec<String>,
    pub package_class: PackageClass,
    #[serde(default)]
    pub features: Vec<String>,
    pub limits: ProtocolLimits,
    pub runtime: RuntimeInfo,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializedResult {
    pub protocol_version: String,
    pub sdk_version: String,
    pub registrations: Vec<String>,
    pub requested_features: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginContext {
    pub plugin_id: String,
    pub plugin_version: String,
    pub generation: u64,
    #[serde(default)]
    pub package_class: PackageClass,
    #[serde(default = "default_granted_capabilities")]
    pub granted_capabilities: Vec<String>,
}

fn default_granted_capabilities() -> Vec<String> {
    vec!["*".to_owned()]
}

impl PluginContext {
    pub fn from_initialize(params: &InitializeParams) -> Self {
        Self {
            plugin_id: params.plugin_identity.id.clone(),
            plugin_version: params.package_version.clone(),
            generation: params.generation_id,
            package_class: params.package_class.clone(),
            granted_capabilities: vec!["*".to_owned()],
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WireInbound {
    pub id: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub ok: Option<bool>,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<ProtocolError>,
}

pub fn error_response(id: impl Into<String>, code: &str, message: impl Into<String>) -> Value {
    serde_json::json!({
        "id": id.into(),
        "ok": false,
        "error": { "code": code, "message": message.into() }
    })
}

pub fn ok_response(id: impl Into<String>, result: Value) -> Value {
    serde_json::json!({
        "id": id.into(),
        "ok": true,
        "result": result
    })
}
