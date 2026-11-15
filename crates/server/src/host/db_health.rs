//! Host commands for SQLite storage telemetry, non-blocking WAL checkpointing,
//! and on-demand lossless historical event folding.

use application::ApplicationError;
use serde_json::Value;

use crate::domains::{ServerApplicationDomains, internal_error, serialize};

pub(crate) async fn db_health_report(
    domains: &ServerApplicationDomains,
) -> Result<Value, ApplicationError> {
    let report = db::check_db_service_health(domains.db_service(), Some(&domains.runtime_root))
        .await
        .map_err(internal_error)?;
    serialize(report)
}

pub(crate) async fn db_optimize(
    domains: &ServerApplicationDomains,
) -> Result<Value, ApplicationError> {
    let report = db::optimize_wal(domains.db_service().writer(), Some(&domains.runtime_root))
        .await
        .map_err(internal_error)?;
    serialize(report)
}

pub(crate) async fn trigger_event_folding(
    domains: &ServerApplicationDomains,
) -> Result<Value, ApplicationError> {
    let report = conversations::EventFolder::fold_all_settled(domains.db_service().writer())
        .await
        .map_err(internal_error)?;
    serialize(report)
}
