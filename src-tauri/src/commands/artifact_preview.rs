use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ArtifactPreviewLeaseDto {
    pub lease_id: uuid::Uuid,
    pub artifact_id: uuid::Uuid,
    pub provider_id: String,
    pub loopback_port: u16,
    pub capability_token: String,
    pub expires_at_unix_ms: u64,
    pub preview_url: String,
    pub docx_fallback_supported: bool,
}
