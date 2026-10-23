//! Crash report DTOs exported to TypeScript.

use serde::Serialize;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportMeta {
    pub id: String,
    #[ts(type = "number | null")]
    pub created_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportsInfo {
    /// `owner/repo` used to prefill a GitHub issue; None when unresolvable.
    pub repository: Option<String>,
    pub reports: Vec<CrashReportMeta>,
}
