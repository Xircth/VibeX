//! Application boundary for reading an Agent's subscription usage.
//!
//! The pool path uses the ACP installation and the Settings environment the
//! subscription login already saved. Probes without a pool keep the process
//! environment and default credential homes.

use std::{collections::HashMap, path::PathBuf};

use agents::{AgentId, PlanProbeContext, PlanUsageResult};
use serde_json::Value;
use sqlx::SqlitePool;

pub struct AgentPlanUsageApplicationService;

impl AgentPlanUsageApplicationService {
    pub async fn read(agent_id: &AgentId) -> PlanUsageResult {
        agents::probe_plan_usage(agent_id).await
    }

    pub async fn read_with_pool(pool: &SqlitePool, agent_id: &AgentId) -> PlanUsageResult {
        let context = plan_probe_context(pool, agent_id).await;
        agents::probe_plan_usage_with(agent_id, &context).await
    }
}

async fn plan_probe_context(pool: &SqlitePool, agent_id: &AgentId) -> PlanProbeContext {
    let environment = saved_agent_environment(pool, agent_id).await;
    let claude_config_dir = environment
        .get("CLAUDE_CONFIG_DIR")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let codex_executable = if agent_id.as_str() == "codex" {
        installed_program(pool, agent_id, "codex").await
    } else {
        None
    };
    PlanProbeContext {
        codex_executable,
        claude_config_dir,
        environment,
    }
}

async fn saved_agent_environment(pool: &SqlitePool, agent_id: &AgentId) -> HashMap<String, String> {
    let env_json = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .flatten();
    let Some(raw) = env_json else {
        return HashMap::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return HashMap::new();
    };
    let Some(object) = value.as_object() else {
        return HashMap::new();
    };
    object
        .iter()
        .filter_map(|(key, item)| {
            item.as_str()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(|text| (key.clone(), text.to_string()))
        })
        .collect()
}

async fn installed_program(
    pool: &SqlitePool,
    agent_id: &AgentId,
    program: &str,
) -> Option<PathBuf> {
    let components = sqlx::query_scalar::<_, String>(
        r#"SELECT component.absolute_path
           FROM agent_installation installation
           JOIN agent_install_component component
             ON component.lock_id = installation.current_lock_id
           WHERE installation.agent_id = ?
           ORDER BY CASE component.component_kind WHEN 'agent_runtime' THEN 0 ELSE 1 END"#,
    )
    .bind(agent_id.as_str())
    .fetch_all(pool)
    .await
    .ok()?;
    for component in components {
        let path = PathBuf::from(component);
        if executable_matches(&path, program) {
            return Some(path);
        }
        if let Some(parent) = path.parent() {
            for candidate in [
                parent.join(program),
                parent.join(format!("{program}.cmd")),
                parent.join(format!("{program}.exe")),
            ] {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn executable_matches(path: &std::path::Path, program: &str) -> bool {
    path.file_stem()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(program))
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(program))
}
