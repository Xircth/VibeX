use serde::Serialize;
use ts_rs::TS;

use crate::{crash_reports, error::AppError};

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

#[tauri::command]
pub async fn crash_reports_list() -> Result<CrashReportsInfo, AppError> {
    let reports = crash_reports::list_report_ids()
        .into_iter()
        .map(|id| CrashReportMeta {
            created_at_ms: crash_reports::report_created_at_ms(&id),
            id,
        })
        .collect();
    Ok(CrashReportsInfo {
        repository: super::system_maintenance::update_repository(),
        reports,
    })
}

fn checked_report_path(id: &str) -> Result<std::path::PathBuf, AppError> {
    if !crash_reports::is_valid_report_id(id) {
        return Err(AppError::BadRequest(format!(
            "Invalid crash report id: {id}"
        )));
    }
    Ok(crash_reports::crashes_dir().join(id))
}

#[tauri::command]
pub async fn crash_report_read(id: String) -> Result<String, AppError> {
    let path = checked_report_path(&id)?;
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|error| AppError::NotFound(format!("Crash report unavailable: {error}")))
}

#[tauri::command]
pub async fn crash_report_delete(id: String) -> Result<(), AppError> {
    let path = checked_report_path(&id)?;
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::Internal(format!(
            "Failed to delete crash report: {error}"
        ))),
    }
}
