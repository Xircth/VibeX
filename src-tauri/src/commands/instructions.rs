use std::{collections::HashMap, path::PathBuf};

use db::models::tag::{CreateTag, Tag, UpdateTag};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

const METADATA_FILE_NAME: &str = "instructions-metadata.json";
const ALL_AGENT_TYPES: &[&str] = &[
    "claude_code",
    "codex",
    "gemini",
    "open_claw",
    "open_code",
    "cline",
    "hermes",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Instruction {
    pub id: String,
    pub name: String,
    pub content: String,
    pub agent_types: Vec<String>,
    pub source: String,
    pub description: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateInstructionPayload {
    pub name: String,
    pub content: String,
    pub agent_types: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpdateInstructionPayload {
    pub name: Option<String>,
    pub content: Option<String>,
    pub agent_types: Option<Vec<String>>,
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

fn validate_name(name: &str) -> Result<String, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest(
            "Instruction name cannot be empty.".to_string(),
        ));
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err(AppError::BadRequest(
            "Instruction name cannot contain whitespace.".to_string(),
        ));
    }
    Ok(trimmed.to_string())
}

fn validate_content(content: &str) -> Result<String, AppError> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest(
            "Instruction content cannot be empty.".to_string(),
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

async fn load_metadata() -> Result<InstructionMetadata, AppError> {
    let path = metadata_path();
    if !path.exists() {
        return Ok(InstructionMetadata::default());
    }

    let content = tokio::fs::read_to_string(&path).await.map_err(|error| {
        AppError::Internal(format!(
            "Failed to read instruction metadata {}: {error}",
            path.display()
        ))
    })?;

    serde_json::from_str(&content).map_err(|error| {
        AppError::Internal(format!(
            "Invalid instruction metadata {}: {error}",
            path.display()
        ))
    })
}

async fn save_metadata(metadata: &InstructionMetadata) -> Result<(), AppError> {
    let path = metadata_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            AppError::Internal(format!(
                "Failed to create instruction metadata directory {}: {error}",
                parent.display()
            ))
        })?;
    }

    let content = serde_json::to_string_pretty(metadata).map_err(|error| {
        AppError::Internal(format!("Failed to serialize instruction metadata: {error}"))
    })?;
    tokio::fs::write(&path, content).await.map_err(|error| {
        AppError::Internal(format!(
            "Failed to write instruction metadata {}: {error}",
            path.display()
        ))
    })
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

#[tauri::command]
pub async fn list_instructions(
    state: tauri::State<'_, AppState>,
    search: Option<String>,
) -> Result<Vec<Instruction>, AppError> {
    let metadata = load_metadata().await?;
    let mut tags = Tag::find_all(&state.deployment.db().pool).await?;

    if let Some(search) = search {
        let query = search.to_lowercase();
        tags.retain(|tag| {
            tag.tag_name.to_lowercase().contains(&query)
                || tag.content.to_lowercase().contains(&query)
        });
    }

    Ok(tags
        .into_iter()
        .map(|tag| tag_to_instruction(tag, &metadata))
        .collect())
}

#[tauri::command]
pub async fn list_official_instructions() -> Result<Vec<Instruction>, AppError> {
    Ok(official_instructions()
        .into_iter()
        .map(official_to_instruction)
        .collect())
}

#[tauri::command]
pub async fn create_instruction(
    state: tauri::State<'_, AppState>,
    payload: CreateInstructionPayload,
) -> Result<Instruction, AppError> {
    let name = validate_name(&payload.name)?;
    let content = validate_content(&payload.content)?;
    let tag = Tag::create(
        &state.deployment.db().pool,
        &CreateTag {
            tag_name: name,
            content,
        },
    )
    .await?;

    let mut metadata = load_metadata().await?;
    metadata
        .agent_types_by_tag_id
        .insert(tag.id.to_string(), normalize_agents(payload.agent_types));
    save_metadata(&metadata).await?;

    Ok(tag_to_instruction(tag, &metadata))
}

#[tauri::command]
pub async fn update_instruction(
    state: tauri::State<'_, AppState>,
    instruction_id: Uuid,
    payload: UpdateInstructionPayload,
) -> Result<Instruction, AppError> {
    let update = UpdateTag {
        tag_name: match payload.name {
            Some(name) => Some(validate_name(&name)?),
            None => None,
        },
        content: match payload.content {
            Some(content) => Some(validate_content(&content)?),
            None => None,
        },
    };

    let tag = Tag::update(&state.deployment.db().pool, instruction_id, &update).await?;
    let mut metadata = load_metadata().await?;
    if let Some(agent_types) = payload.agent_types {
        metadata
            .agent_types_by_tag_id
            .insert(tag.id.to_string(), normalize_agents(Some(agent_types)));
        save_metadata(&metadata).await?;
    }

    Ok(tag_to_instruction(tag, &metadata))
}

#[tauri::command]
pub async fn delete_instruction(
    state: tauri::State<'_, AppState>,
    instruction_id: Uuid,
) -> Result<(), AppError> {
    let rows_affected = Tag::delete(&state.deployment.db().pool, instruction_id).await?;
    if rows_affected == 0 {
        return Err(AppError::NotFound(format!(
            "Instruction {} not found",
            instruction_id
        )));
    }

    let mut metadata = load_metadata().await?;
    metadata
        .agent_types_by_tag_id
        .remove(&instruction_id.to_string());
    save_metadata(&metadata).await?;
    Ok(())
}

#[tauri::command]
pub async fn install_official_instruction(
    state: tauri::State<'_, AppState>,
    official_id: String,
    agent_types: Option<Vec<String>>,
) -> Result<Instruction, AppError> {
    let official = official_instructions()
        .into_iter()
        .find(|item| item.id == official_id)
        .ok_or_else(|| {
            AppError::NotFound(format!("Official instruction {official_id} not found"))
        })?;

    create_instruction(
        state,
        CreateInstructionPayload {
            name: official.name.to_string(),
            content: official.content.to_string(),
            agent_types,
        },
    )
    .await
}
