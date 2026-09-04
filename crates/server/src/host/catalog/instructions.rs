use std::{collections::HashMap, path::PathBuf};

use application::ApplicationError;
use db::models::tag::{CreateTag, Tag, UpdateTag};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use services::services::config::{
    COMMIT_CHANGES_INSTRUCTION_CONTENT, COMMIT_CHANGES_INSTRUCTION_DESCRIPTION,
    COMMIT_CHANGES_INSTRUCTION_ID,
};
use uuid::Uuid;

use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

const METADATA_FILE_NAME: &str = "instructions-metadata.json";
const ALL_AGENT_TYPES: &[&str] = &[
    "claude_code",
    "codex",
    "antigravity",
    "open_claw",
    "open_code",
    "cline",
    "hermes",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Instruction {
    id: String,
    name: String,
    content: String,
    agent_types: Vec<String>,
    source: String,
    description: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct CreateInstructionPayload {
    name: String,
    content: String,
    agent_types: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
struct UpdateInstructionPayload {
    name: Option<String>,
    content: Option<String>,
    agent_types: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListArgs {
    search: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateArgs {
    payload: CreateInstructionPayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateArgs {
    instruction_id: Uuid,
    payload: UpdateInstructionPayload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteArgs {
    instruction_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallOfficialArgs {
    official_id: String,
    agent_types: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
struct OfficialInstruction {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    content: &'static str,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct InstructionMetadata {
    #[serde(default)]
    agent_types_by_tag_id: HashMap<String, Vec<String>>,
}

fn metadata_path() -> PathBuf {
    utils::assets::asset_dir().join(METADATA_FILE_NAME)
}

fn default_agents() -> Vec<String> {
    ALL_AGENT_TYPES
        .iter()
        .map(|value| (*value).to_string())
        .collect()
}

fn validate_name(name: &str) -> Result<String, ApplicationError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(ApplicationError::bad_request(
            "Instruction name cannot be empty.",
        ));
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err(ApplicationError::bad_request(
            "Instruction name cannot contain whitespace.",
        ));
    }
    Ok(trimmed.to_string())
}

fn validate_content(content: &str) -> Result<String, ApplicationError> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(ApplicationError::bad_request(
            "Instruction content cannot be empty.",
        ));
    }
    Ok(trimmed.to_string())
}

fn normalize_agents(agent_types: Option<Vec<String>>) -> Vec<String> {
    let Some(agent_types) = agent_types else {
        return default_agents();
    };
    let mut selected = Vec::new();
    for agent in agent_types {
        if ALL_AGENT_TYPES.contains(&agent.as_str()) && !selected.contains(&agent) {
            selected.push(agent);
        }
    }
    if selected.is_empty() {
        default_agents()
    } else {
        selected
    }
}

async fn load_metadata() -> Result<InstructionMetadata, ApplicationError> {
    let path = metadata_path();
    if !path.exists() {
        return Ok(InstructionMetadata::default());
    }
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(internal_error)?;
    serde_json::from_str(&content).map_err(internal_error)
}

async fn save_metadata(metadata: &InstructionMetadata) -> Result<(), ApplicationError> {
    let path = metadata_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(internal_error)?;
    }
    tokio::fs::write(
        &path,
        serde_json::to_string_pretty(metadata).map_err(internal_error)?,
    )
    .await
    .map_err(internal_error)
}

fn tag_to_instruction(tag: Tag, metadata: &InstructionMetadata) -> Instruction {
    let id = tag.id.to_string();
    let agent_types = metadata
        .agent_types_by_tag_id
        .get(&id)
        .cloned()
        .unwrap_or_else(default_agents);
    Instruction {
        id,
        name: tag.tag_name,
        content: tag.content,
        agent_types,
        source: "local".to_string(),
        description: None,
        created_at: Some(tag.created_at.to_rfc3339()),
        updated_at: Some(tag.updated_at.to_rfc3339()),
    }
}

fn official_instructions() -> Vec<OfficialInstruction> {
    vec![
        OfficialInstruction {
            id: COMMIT_CHANGES_INSTRUCTION_ID,
            name: COMMIT_CHANGES_INSTRUCTION_ID,
            description: COMMIT_CHANGES_INSTRUCTION_DESCRIPTION,
            content: COMMIT_CHANGES_INSTRUCTION_CONTENT,
        },
        OfficialInstruction {
            id: "review_changes",
            name: "review_changes",
            description: "审查当前变更，优先指出风险、回归和缺失验证。",
            content: "请审查当前变更，优先列出具体问题、风险和缺失验证。若没有发现问题，请明确说明剩余风险。",
        },
        OfficialInstruction {
            id: "write_tests",
            name: "write_tests",
            description: "为当前改动补充聚焦的测试计划或测试用例。",
            content: "请基于当前改动补充必要测试。优先覆盖用户可见行为、边界条件和回归路径，保持测试范围聚焦。",
        },
        OfficialInstruction {
            id: "summarize_pr",
            name: "summarize_pr",
            description: "生成适合 PR 的变更摘要和验证说明。",
            content: "请根据当前 diff 生成 PR 描述，包含变更摘要、关键实现点和已完成验证。不要夸大未验证的内容。",
        },
    ]
}

fn official_to_instruction(item: OfficialInstruction) -> Instruction {
    Instruction {
        id: item.id.to_string(),
        name: item.name.to_string(),
        content: item.content.to_string(),
        agent_types: default_agents(),
        source: "official".to_string(),
        description: Some(item.description.to_string()),
        created_at: None,
        updated_at: None,
    }
}

pub(super) async fn list_local(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: ListArgs = parse(args).unwrap_or(ListArgs { search: None });
    let metadata = load_metadata().await?;
    let mut tags = Tag::find_all(&domains.pool).await.map_err(internal_error)?;
    if let Some(search) = args.search {
        let query = search.to_lowercase();
        tags.retain(|tag| {
            tag.tag_name.to_lowercase().contains(&query)
                || tag.content.to_lowercase().contains(&query)
        });
    }
    serialize(
        tags.into_iter()
            .map(|tag| tag_to_instruction(tag, &metadata))
            .collect::<Vec<_>>(),
    )
}

pub(super) fn list_official() -> Result<Value, ApplicationError> {
    serialize(
        official_instructions()
            .into_iter()
            .map(official_to_instruction)
            .collect::<Vec<_>>(),
    )
}

pub(super) async fn create(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: CreateArgs = parse(args)?;
    create_from_payload(domains, args.payload).await
}

async fn create_from_payload(
    domains: &ServerApplicationDomains,
    payload: CreateInstructionPayload,
) -> Result<Value, ApplicationError> {
    let name = validate_name(&payload.name)?;
    let content = validate_content(&payload.content)?;
    let tag = Tag::create(
        &domains.pool,
        &CreateTag {
            tag_name: name,
            content,
        },
    )
    .await
    .map_err(internal_error)?;
    let mut metadata = load_metadata().await?;
    metadata
        .agent_types_by_tag_id
        .insert(tag.id.to_string(), normalize_agents(payload.agent_types));
    save_metadata(&metadata).await?;
    serialize(tag_to_instruction(tag, &metadata))
}

pub(super) async fn update(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: UpdateArgs = parse(args)?;
    let update = UpdateTag {
        tag_name: match args.payload.name {
            Some(name) => Some(validate_name(&name)?),
            None => None,
        },
        content: match args.payload.content {
            Some(content) => Some(validate_content(&content)?),
            None => None,
        },
    };
    let tag = Tag::update(&domains.pool, args.instruction_id, &update)
        .await
        .map_err(internal_error)?;
    let mut metadata = load_metadata().await?;
    if let Some(agent_types) = args.payload.agent_types {
        metadata
            .agent_types_by_tag_id
            .insert(tag.id.to_string(), normalize_agents(Some(agent_types)));
        save_metadata(&metadata).await?;
    }
    serialize(tag_to_instruction(tag, &metadata))
}

pub(super) async fn delete(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: DeleteArgs = parse(args)?;
    let rows_affected = Tag::delete(&domains.pool, args.instruction_id)
        .await
        .map_err(internal_error)?;
    if rows_affected == 0 {
        return Err(ApplicationError::not_found(format!(
            "Instruction {} not found",
            args.instruction_id
        )));
    }
    let mut metadata = load_metadata().await?;
    metadata
        .agent_types_by_tag_id
        .remove(&args.instruction_id.to_string());
    save_metadata(&metadata).await?;
    Ok(Value::Null)
}

pub(super) async fn install_official(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: InstallOfficialArgs = parse(args)?;
    let official = official_instructions()
        .into_iter()
        .find(|item| item.id == args.official_id)
        .ok_or_else(|| {
            ApplicationError::not_found(format!(
                "Official instruction {} not found",
                args.official_id
            ))
        })?;
    create_from_payload(
        domains,
        CreateInstructionPayload {
            name: official.name.to_string(),
            content: official.content.to_string(),
            agent_types: args.agent_types,
        },
    )
    .await
}
