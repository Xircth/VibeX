use application::ApplicationError;
use serde::Deserialize;
use serde_json::Value;
use services::services::mcp::{self, McpAppType};

use super::saved_agent_environment;
use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchArgs {
    provider_id: String,
    query: Option<String>,
    limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DetailArgs {
    provider_id: String,
    server_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallArgs {
    provider_id: String,
    server_id: String,
    global: bool,
    apps: Vec<McpAppType>,
    option_id: Option<String>,
    parameter_values: Option<Value>,
    spec_override: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertArgs {
    server_id: String,
    spec: Value,
    global: bool,
    apps: Vec<McpAppType>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerIdArgs {
    server_id: String,
}

async fn with_env<T, F, Fut>(
    domains: &ServerApplicationDomains,
    work: F,
) -> Result<T, ApplicationError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T, mcp::McpError>>,
{
    mcp::with_saved_agent_environment(saved_agent_environment(&domains.pool, None).await?, work())
        .await
        .map_err(internal_error)
}

pub(super) async fn scan_local(
    domains: &ServerApplicationDomains,
) -> Result<Value, ApplicationError> {
    serialize(with_env(domains, mcp::scan_local).await?)
}

pub(super) async fn list_marketplaces() -> Result<Value, ApplicationError> {
    serialize(mcp::list_marketplaces().await.map_err(internal_error)?)
}

pub(super) async fn search(args: Value) -> Result<Value, ApplicationError> {
    let args: SearchArgs = parse(args)?;
    serialize(
        mcp::search_marketplace(args.provider_id, args.query, args.limit)
            .await
            .map_err(internal_error)?,
    )
}

pub(super) async fn detail(args: Value) -> Result<Value, ApplicationError> {
    let args: DetailArgs = parse(args)?;
    serialize(
        mcp::get_marketplace_server_detail(args.provider_id, args.server_id)
            .await
            .map_err(internal_error)?,
    )
}

pub(super) async fn install(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: InstallArgs = parse(args)?;
    serialize(
        with_env(domains, || {
            mcp::install_marketplace_server(
                args.provider_id,
                args.server_id,
                args.global,
                args.apps,
                args.option_id,
                args.parameter_values,
                args.spec_override,
            )
        })
        .await?,
    )
}

pub(super) async fn upsert(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: UpsertArgs = parse(args)?;
    serialize(
        with_env(domains, || {
            mcp::upsert_local_server(args.server_id, args.spec, args.global, args.apps)
        })
        .await?,
    )
}

pub(super) async fn uninstall(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: ServerIdArgs = parse(args)?;
    serialize(with_env(domains, || mcp::uninstall_server(args.server_id)).await?)
}
