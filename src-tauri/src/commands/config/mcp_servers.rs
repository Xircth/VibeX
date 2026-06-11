use std::collections::HashMap;

use agents::{
    AgentMcpConfig, agent_type_from_executor_key, default_mcp_config_path, mcp_file_config,
    read_agent_mcp_config, write_agent_mcp_config,
};
use executors::executors::BaseCodingAgent;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::fs;

use crate::{error::AppError, state::AppState};

#[derive(Debug, Serialize, Deserialize)]
pub struct GetMcpServerResponse {
    pub mcp_config: AgentMcpConfig,
    pub config_path: String,
}

fn agent_type_from_executor(executor: BaseCodingAgent) -> Result<agents::AgentType, AppError> {
    agent_type_from_executor_key(&executor.to_string()).ok_or_else(|| {
        AppError::BadRequest(format!("{executor} does not have an ACP registry entry"))
    })
}

pub(crate) async fn get_mcp_servers(
    state: tauri::State<'_, AppState>,
    executor: BaseCodingAgent,
) -> Result<GetMcpServerResponse, AppError> {
    let _ = state;

    let agent_type = agent_type_from_executor(executor)?;

    let config_path = match default_mcp_config_path(agent_type) {
        Some(path) => path,
        None => {
            return Err(AppError::BadRequest(
                "This agent does not support file-based MCP configuration".to_string(),
            ));
        }
    };

    let mut mcpc = mcp_file_config(agent_type).ok_or_else(|| {
        AppError::BadRequest("This agent does not support file-based MCP configuration".to_string())
    })?;
    let raw_config = read_agent_mcp_config(&config_path, &mcpc)
        .await
        .map_err(|error| AppError::Internal(error.to_string()))?;
    let servers = get_mcp_servers_from_config_path(&raw_config, &mcpc.servers_path);
    mcpc.set_servers(servers);

    Ok(GetMcpServerResponse {
        mcp_config: mcpc,
        config_path: config_path.to_string_lossy().to_string(),
    })
}

pub(crate) async fn update_mcp_servers(
    state: tauri::State<'_, AppState>,
    executor: BaseCodingAgent,
    servers: HashMap<String, Value>,
) -> Result<String, AppError> {
    let _ = state;

    let agent_type = agent_type_from_executor(executor)?;

    let config_path = match default_mcp_config_path(agent_type) {
        Some(path) => path,
        None => {
            return Err(AppError::BadRequest(
                "This agent does not support file-based MCP configuration".to_string(),
            ));
        }
    };

    let mcpc = mcp_file_config(agent_type).ok_or_else(|| {
        AppError::BadRequest("This agent does not support file-based MCP configuration".to_string())
    })?;
    update_mcp_servers_in_config(&config_path, &mcpc, servers)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to update MCP servers: {}", e)))
}

fn get_mcp_servers_from_config_path(raw_config: &Value, path: &[String]) -> HashMap<String, Value> {
    let mut current = raw_config;
    for part in path {
        current = match current.get(part) {
            Some(val) => val,
            None => return HashMap::new(),
        };
    }

    match current.as_object() {
        Some(servers) => servers
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        None => HashMap::new(),
    }
}

fn set_mcp_servers_in_config_path(
    raw_config: &mut Value,
    path: &[String],
    servers: &HashMap<String, Value>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if path.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "MCP servers path cannot be empty",
        )
        .into());
    }

    if !raw_config.is_object() {
        *raw_config = serde_json::json!({});
    }

    let mut current = raw_config;
    for part in &path[..path.len() - 1] {
        let object = current.as_object_mut().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "MCP config path traversal reached a non-object value",
            )
        })?;
        let next = object
            .entry(part.to_string())
            .or_insert_with(|| serde_json::json!({}));
        if !next.is_object() {
            *next = serde_json::json!({});
        }
        current = next;
    }

    let final_attr = path.last().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "MCP servers path cannot be empty",
        )
    })?;
    let object = current.as_object_mut().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "MCP config path target parent is not an object",
        )
    })?;
    object.insert(final_attr.to_string(), serde_json::to_value(servers)?);

    Ok(())
}

async fn update_mcp_servers_in_config(
    config_path: &std::path::Path,
    mcpc: &AgentMcpConfig,
    new_servers: HashMap<String, Value>,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    let mut config = read_agent_mcp_config(config_path, mcpc).await?;
    let old_servers = get_mcp_servers_from_config_path(&config, &mcpc.servers_path).len();

    set_mcp_servers_in_config_path(&mut config, &mcpc.servers_path, &new_servers)?;
    write_agent_mcp_config(config_path, mcpc, &config).await?;

    let new_count = new_servers.len();
    let message = match (old_servers, new_count) {
        (0, 0) => "No MCP servers configured".to_string(),
        (0, count) => format!("Added {} MCP server(s)", count),
        (old, new) if old == new => {
            format!("Updated MCP server configuration ({} server(s))", new)
        }
        (old, new) => format!(
            "Updated MCP server configuration (was {}, now {})",
            old, new
        ),
    };

    Ok(message)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn set_mcp_servers_rejects_empty_path_without_panic() {
        let mut raw_config = json!({});
        let servers = HashMap::new();

        let err = set_mcp_servers_in_config_path(&mut raw_config, &[], &servers)
            .expect_err("empty path should be rejected");

        assert!(err.to_string().contains("MCP servers path"));
    }

    #[test]
    fn set_mcp_servers_replaces_non_object_intermediate_path() {
        let mut raw_config = json!({
            "mcp": "not-an-object"
        });
        let mut servers = HashMap::new();
        servers.insert("filesystem".to_string(), json!({ "command": "npx" }));

        set_mcp_servers_in_config_path(
            &mut raw_config,
            &["mcp".to_string(), "servers".to_string()],
            &servers,
        )
        .expect("nested MCP server path should be written");

        assert_eq!(raw_config["mcp"]["servers"], json!(servers));
    }
}
