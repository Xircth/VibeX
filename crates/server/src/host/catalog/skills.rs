use std::path::PathBuf;

use agents::skills::{self, AgentSkillScope, CustomAgentSkillStorage};
use application::ApplicationError;
use db::models::agent_management::UserAgentDefinitionRepository;
use serde::Deserialize;
use serde_json::Value;

use super::saved_agent_environment;
use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSkillArgs {
    agent_type: String,
    scope: AgentSkillScope,
    skill_id: String,
    workspace_path: Option<String>,
    content: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillIdArgs {
    skill_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketSearchArgs {
    query: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketDetailArgs {
    source: String,
    skill_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallMarketArgs {
    source: String,
    skill_id: String,
    global: bool,
    apps: Vec<String>,
    link: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostingArgs {
    skill_id: String,
    global: bool,
    apps: Vec<String>,
    link: bool,
}

async fn custom_targets(
    domains: &ServerApplicationDomains,
) -> Result<Vec<CustomAgentSkillStorage>, ApplicationError> {
    UserAgentDefinitionRepository::new(domains.pool.clone())
        .list()
        .await
        .map_err(internal_error)
        .map(|definitions| {
            definitions
                .into_iter()
                .filter(|definition| {
                    definition.skills_shared_store
                        || definition
                            .skills_directory
                            .as_ref()
                            .is_some_and(|directory| PathBuf::from(directory).is_absolute())
                })
                .map(|definition| CustomAgentSkillStorage {
                    agent_id: definition.agent_id.to_string(),
                    shared_store: definition.skills_shared_store,
                    directory: definition
                        .skills_directory
                        .map(PathBuf::from)
                        .filter(|directory| directory.is_absolute()),
                })
                .collect()
        })
}

async fn custom_target(
    domains: &ServerApplicationDomains,
    agent_type: &str,
) -> Result<Option<CustomAgentSkillStorage>, ApplicationError> {
    Ok(custom_targets(domains)
        .await?
        .into_iter()
        .find(|target| target.agent_id == agent_type))
}

pub(crate) async fn list_agent_skills(
    domains: &ServerApplicationDomains,
    agent_type: String,
    workspace_path: Option<String>,
) -> Result<Value, ApplicationError> {
    let storage = custom_target(domains, &agent_type).await?;
    let environment = saved_agent_environment(&domains.pool, Some(&agent_type)).await?;
    serialize(
        skills::with_saved_agent_environment(
            environment,
            skills::list_agent_skills_with_storage(agent_type, workspace_path, storage),
        )
        .await
        .map_err(internal_error)?,
    )
}

pub(super) async fn scan_local(
    domains: &ServerApplicationDomains,
) -> Result<Value, ApplicationError> {
    serialize(
        skills::with_saved_agent_environment(
            saved_agent_environment(&domains.pool, None).await?,
            skills::scan_local_skills_with_custom_targets(custom_targets(domains).await?),
        )
        .await
        .map_err(internal_error)?,
    )
}

pub(super) async fn read_local(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: SkillIdArgs = parse(args)?;
    serialize(
        skills::with_saved_agent_environment(
            saved_agent_environment(&domains.pool, None).await?,
            skills::read_local_skill_with_custom_targets(
                args.skill_id,
                custom_targets(domains).await?,
            ),
        )
        .await
        .map_err(internal_error)?,
    )
}

pub(super) async fn search_market(args: Value) -> Result<Value, ApplicationError> {
    let args: MarketSearchArgs = parse(args).unwrap_or(MarketSearchArgs { query: None });
    serialize(
        skills::search_skill_market(args.query)
            .await
            .map_err(internal_error)?,
    )
}

pub(super) async fn market_detail(args: Value) -> Result<Value, ApplicationError> {
    let args: MarketDetailArgs = parse(args)?;
    serialize(
        skills::get_market_skill_detail(args.source, args.skill_id)
            .await
            .map_err(internal_error)?,
    )
}

pub(super) async fn install_market(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: InstallMarketArgs = parse(args)?;
    serialize(
        skills::with_saved_agent_environment(
            saved_agent_environment(&domains.pool, None).await?,
            skills::install_market_skill_with_custom_targets(
                args.source,
                args.skill_id,
                args.global,
                args.apps,
                args.link,
                custom_targets(domains).await?,
            ),
        )
        .await
        .map_err(internal_error)?,
    )
}

pub(super) async fn set_hosting(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: HostingArgs = parse(args)?;
    serialize(
        skills::with_saved_agent_environment(
            saved_agent_environment(&domains.pool, None).await?,
            skills::set_skill_hosting_with_custom_targets(
                args.skill_id,
                args.global,
                args.apps,
                args.link,
                custom_targets(domains).await?,
            ),
        )
        .await
        .map_err(internal_error)?,
    )
}

pub(super) async fn uninstall(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: SkillIdArgs = parse(args)?;
    serialize(
        skills::with_saved_agent_environment(
            saved_agent_environment(&domains.pool, None).await?,
            skills::uninstall_skill_with_custom_targets(
                args.skill_id,
                custom_targets(domains).await?,
            ),
        )
        .await
        .map_err(internal_error)?,
    )
}

pub(super) async fn read_agent(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: AgentSkillArgs = parse(args)?;
    let storage = custom_target(domains, &args.agent_type).await?;
    serialize(
        skills::with_saved_agent_environment(
            saved_agent_environment(&domains.pool, Some(&args.agent_type)).await?,
            skills::read_agent_skill_with_storage(
                args.agent_type,
                args.scope,
                args.skill_id,
                args.workspace_path,
                storage,
            ),
        )
        .await
        .map_err(internal_error)?,
    )
}

pub(super) async fn save_agent(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: AgentSkillArgs = parse(args)?;
    let content = args
        .content
        .ok_or_else(|| ApplicationError::bad_request("content required"))?;
    let storage = custom_target(domains, &args.agent_type).await?;
    serialize(
        skills::with_saved_agent_environment(
            saved_agent_environment(&domains.pool, Some(&args.agent_type)).await?,
            skills::save_agent_skill_with_storage(
                args.agent_type,
                args.scope,
                args.skill_id,
                content,
                args.workspace_path,
                storage,
            ),
        )
        .await
        .map_err(internal_error)?,
    )
}

pub(super) async fn delete_agent(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: AgentSkillArgs = parse(args)?;
    let storage = custom_target(domains, &args.agent_type).await?;
    skills::with_saved_agent_environment(
        saved_agent_environment(&domains.pool, Some(&args.agent_type)).await?,
        skills::delete_agent_skill_with_storage(
            args.agent_type,
            args.scope,
            args.skill_id,
            args.workspace_path,
            storage,
        ),
    )
    .await
    .map_err(internal_error)?;
    Ok(Value::Null)
}
