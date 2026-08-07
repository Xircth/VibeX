//! 外部安装组件变更的官方验证与自动采纳(ADR-0038 方向 B)。
//!
//! 外部组件的文件由外部所有者(npm、系统包管理器、用户)维护,VibeX 不修改
//! 它们。当锁定的指纹与磁盘内容不一致时,本模块用官方来源(npm
//! `dist.integrity` / ACP Registry binary `sha256`)验证新内容;验证通过则自动
//! 更新 Installation lock(旧 lock 转 rollback)并放行,否则保持 fail-closed:
//! 由 `refresh_component_integrity` 置 `needs_repair` 并记录诊断。

use std::path::PathBuf;

use sha2::{Digest, Sha256};
use tauri::AppHandle;
use uuid::Uuid;

use super::*;

struct ExternalInstallRow {
    agent_id: String,
    lock_id: String,
    distribution_kind: String,
    resolved_json: String,
}

struct ComponentRow {
    component_kind: String,
    absolute_path: PathBuf,
    version: String,
    sha256: Option<String>,
}

/// resolved_json 中与 agents.rs / 本模块读取一致的结构。
#[derive(serde::Deserialize)]
struct FrozenLockPayload {
    #[serde(default)]
    frozen_plan: Option<agents::ResolvedInstallPlan>,
    #[serde(default)]
    absolute_acp_program: Option<PathBuf>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    runtime_version: Option<String>,
    #[serde(default)]
    acp_version: Option<String>,
}

/// 官方验证与自动采纳入口。在 `refresh_component_integrity` 之前调用:
/// 成功采纳的组件哈希已随新 lock 更新,剩余不匹配仍由完整性刷新置
/// `needs_repair`,保持 fail-closed。
pub(super) async fn reconcile_external_component_changes(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
) -> anyhow::Result<()> {
    let installs = sqlx::query_as::<_, (String, String, String, String)>(
        r#"SELECT i.agent_id, l.id, l.distribution_kind, l.resolved_json
           FROM agent_installation i
           JOIN agent_install_lock l ON l.id = i.current_lock_id
           WHERE i.ownership = 'external'
             AND i.current_lock_id IS NOT NULL
             AND i.active_operation IS NULL"#,
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(
        |(agent_id, lock_id, distribution_kind, resolved_json)| ExternalInstallRow {
            agent_id,
            lock_id,
            distribution_kind,
            resolved_json,
        },
    )
    .collect::<Vec<_>>();
    let npm_fetcher = agents::NpmRegistryHttpFetcher::new();
    let mut adopted_any = false;
    for install in installs {
        match reconcile_one_install(pool, &npm_fetcher, &install).await {
            Ok(true) => adopted_any = true,
            Ok(false) => {}
            Err(message) => mark_repair_with_diagnostic(pool, &install.agent_id, &message).await,
        }
    }
    if adopted_any {
        let _ = app.emit(MANAGEMENT_INVALIDATED_EVENT, ());
    }
    Ok(())
}

async fn reconcile_one_install(
    pool: &sqlx::SqlitePool,
    npm_fetcher: &dyn agents::RegistryFetcher,
    install: &ExternalInstallRow,
) -> Result<bool, String> {
    let mut components = sqlx::query_as::<_, (String, String, String, Option<String>)>(
        r#"SELECT component_kind, absolute_path, version, sha256
           FROM agent_install_component
           WHERE lock_id = ?
           ORDER BY component_kind, absolute_path"#,
    )
    .bind(&install.lock_id)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("failed to read external components: {error}"))?
    .into_iter()
    .map(
        |(component_kind, absolute_path, version, sha256)| ComponentRow {
            component_kind,
            absolute_path: PathBuf::from(absolute_path),
            version,
            sha256,
        },
    )
    .collect::<Vec<_>>();

    let payload: FrozenLockPayload = serde_json::from_str(&install.resolved_json)
        .map_err(|error| format!("invalid lock payload: {error}"))?;
    let mut changed = false;
    for component in &mut components {
        let bytes = match tokio::fs::read(&component.absolute_path).await {
            Ok(bytes) => bytes,
            Err(_) => continue, // 缺失由 refresh_component_integrity 置 needs_repair
        };
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if component.sha256.as_deref() == Some(actual.as_str()) {
            continue;
        }
        // 验证类型以 Profile 声明的组件分发为权威:存量 external lock 的
        // distribution_kind 可能被旧版本 external 采纳写成 binary(硬编码),
        // 导致 npx 组件(如 codex-acp)走错验证路径。
        let catalog = agents::BuiltInProfileCatalog::bundled();
        let profile = AgentId::parse(&install.agent_id)
            .ok()
            .and_then(|agent_id| catalog.profile(&agent_id));
        let component_distribution_kind = profile
            .map(|profile| {
                match profile_component_distribution_kind(profile, &component.component_kind) {
                    PlannedDistributionKind::Npx => "npx",
                    PlannedDistributionKind::Uvx => "uvx",
                    PlannedDistributionKind::Binary => "binary",
                }
            })
            .unwrap_or_else(|| install.distribution_kind.as_str());
        // npx 组件的包名来自 Profile 的 install_sources,版本用磁盘实际探测值
        // (外部包可能已被 npm 升级,Profile 锁版本只是安装基线)。
        let probed_version = probe_component_version(&component.absolute_path).await;
        let package_spec = if component_distribution_kind == "npx" {
            profile
                .and_then(|profile| profile_npm_package(profile, &component.component_kind))
                .and_then(|package| {
                    probed_version
                        .as_ref()
                        .map(|version| format!("{package}@{version}"))
                })
        } else {
            payload
                .frozen_plan
                .as_ref()
                .and_then(|plan| {
                    plan.components
                        .iter()
                        .find(|candidate| candidate.component_id == component.component_kind)
                })
                .map(|candidate| candidate.resolved_source.clone())
        };
        let registry_sha256 = if component_distribution_kind == "binary" {
            registry_binary_sha256(pool, &install.agent_id).await
        } else {
            None
        };
        let verdict = agents::verify_external_component_change(
            npm_fetcher,
            component_distribution_kind,
            package_spec.as_deref(),
            registry_sha256.as_deref(),
            &actual,
        )
        .await;
        match verdict {
            agents::ExternalChangeVerdict::Verified => {
                component.sha256 = Some(actual);
                if let Some(version) = probed_version {
                    component.version = version;
                }
                changed = true;
            }
            agents::ExternalChangeVerdict::NotVerified => {
                return Err(format!(
                    "external component `{}` changed and is NOT the official `{}` distribution (fingerprint mismatch)",
                    component.component_kind, component_distribution_kind
                ));
            }
            agents::ExternalChangeVerdict::Unverifiable(message) => {
                return Err(format!(
                    "external component `{}` changed but cannot be verified against the official source: {message}",
                    component.component_kind
                ));
            }
        }
    }
    if !changed {
        return Ok(false);
    }

    // 自动采纳:以磁盘上的官方内容生成新 lock,旧 lock 转 rollback。
    let plan = build_adoption_plan(&install.agent_id, &payload, &components);
    let installed_components = components
        .iter()
        .map(|component| InstalledComponent {
            kind: component.component_kind.clone(),
            absolute_path: component.absolute_path.clone(),
            version: component.version.clone(),
            sha256: component.sha256.clone(),
            trust_state: "verified_integrity".to_string(),
            ownership: "external".to_string(),
            shared_resource_key: None,
        })
        .collect::<Vec<_>>();
    let installation = InstalledPlan {
        launch_lock: SessionLaunchLock {
            agent_id: plan.agent_id.clone(),
            absolute_acp_program: payload
                .absolute_acp_program
                .unwrap_or_else(|| PathBuf::from("")),
            args: payload.args,
            env: payload.env,
            runtime_version: component_version(&components, &["agent_runtime", "combined_runtime"])
                .unwrap_or_else(|| payload.runtime_version.unwrap_or_default()),
            acp_version: component_version(&components, &["acp_adapter"])
                .or(payload.acp_version)
                .unwrap_or_default(),
        },
        components: installed_components,
    };
    persist_installed_lock(pool, Uuid::new_v4(), &plan, &installation, "external")
        .await
        .map_err(|error| format!("failed to persist adopted external lock: {error}"))?;
    Ok(true)
}

fn build_adoption_plan(
    agent_id: &str,
    payload: &FrozenLockPayload,
    components: &[ComponentRow],
) -> agents::ResolvedInstallPlan {
    let mut plan = payload
        .frozen_plan
        .clone()
        .unwrap_or_else(|| agents::ResolvedInstallPlan {
            agent_id: AgentId::parse(agent_id)
                .expect("external installation always has a valid AgentId"),
            source: agents::LockedInstallSource::BuiltInProfile,
            version: String::new(),
            platform: agents::current_platform(),
            components: Vec::new(),
        });
    if let Some(version) = component_version(components, &["agent_runtime", "combined_runtime"]) {
        plan.version = version;
    }
    plan
}

fn component_version(components: &[ComponentRow], kinds: &[&str]) -> Option<String> {
    components
        .iter()
        .find(|component| kinds.contains(&component.component_kind.as_str()))
        .map(|component| component.version.clone())
}

/// 从 `--version` 输出中提取纯 semver 版本。外部组件的版本输出格式不统一
/// (如 `@agentclientprotocol/codex-acp 1.1.9`、`codex-cli 0.146.0`、
/// `kimi, version 1.49.0`),整段输出不能直接当作版本号——拼进 npx spec 后
/// `split_npm_spec` 会把最后一个 `@` 当成分隔符,产生带尾 `@` 的畸形包名,
/// npm metadata 请求因此 404。提取失败返回 `None`,调用方保持 fail-closed。
fn extract_version_from_output(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|token| {
        let token = token.trim_matches(|character: char| {
            !(character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+'))
        });
        let token = token
            .strip_prefix('v')
            .or_else(|| token.strip_prefix('V'))
            .unwrap_or(token);
        if token.is_empty() || !token.as_bytes()[0].is_ascii_digit() {
            return None;
        }
        semver::Version::parse(token)
            .ok()
            .map(|version| version.to_string())
    })
}

async fn probe_component_version(executable: &std::path::Path) -> Option<String> {
    let mut command = agent_process_command(executable);
    command.arg("--version");
    let output = command.output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    extract_version_from_output(&String::from_utf8_lossy(&output.stdout))
}

/// 本地 ACP Registry snapshot 中该 Agent 当前平台 binary 分发的官方 SHA-256。
/// snapshot 缺失、条目缺失或该平台无 binary 分发时返回 `None`(保持 fail-closed)。
async fn registry_binary_sha256(pool: &sqlx::SqlitePool, agent_id: &str) -> Option<String> {
    let repository = db::models::agent_management::RegistrySnapshotRepository::new(pool.clone());
    let (_, entries) = repository.current().await.ok()??;
    let entry = entries
        .iter()
        .find(|entry| entry.agent_id.as_str() == agent_id)?;
    let distributions =
        agents::parse_registry_distributions_json(&entry.distributions_json).ok()?;
    let Some(binary) = &distributions.binary else {
        return None;
    };
    let target = binary.get(agents::current_platform().as_str())?;
    target.sha256.clone()
}

/// Profile 的 `install_sources` 中该组件对应的 npx 包名。
fn profile_npm_package(
    profile: &agents::BuiltInProfile,
    component_kind: &str,
) -> Option<&'static str> {
    profile
        .install_sources
        .iter()
        .find_map(|source| match source {
            agents::ProfileInstallSource::Npx {
                component, package, ..
            } if profile_component_key(*component) == component_kind => Some(*package),
            _ => None,
        })
}

async fn mark_repair_with_diagnostic(pool: &sqlx::SqlitePool, agent_id: &str, message: &str) {
    let _ = sqlx::query(
        r#"UPDATE agent_installation
           SET lifecycle = 'needs_repair', updated_at = CURRENT_TIMESTAMP
           WHERE agent_id = ? AND current_lock_id IS NOT NULL
             AND active_operation IS NULL"#,
    )
    .bind(agent_id)
    .execute(pool)
    .await;
    let Ok(agent_id) = AgentId::parse(agent_id) else {
        return;
    };
    let _ = db::models::agent_management::DiagnosticRepository::new(pool.clone())
        .append_bounded(&db::models::agent_management::DiagnosticRecord {
            id: Uuid::new_v4(),
            agent_id,
            operation_kind: "launch_gate".to_string(),
            severity: "error".to_string(),
            message: "外部组件变更未能通过官方验证".to_string(),
            redacted_output: Some(message.to_string()),
            created_at: chrono::Utc::now().to_rfc3339(),
        })
        .await;
}

#[cfg(test)]
mod tests {
    use super::extract_version_from_output;

    #[test]
    fn extracts_a_clean_semver_from_mixed_version_outputs() {
        // codex-acp 输出包名 + 版本两个 token;整段输出会被 split_npm_spec
        // 误解析成带尾 `@` 的畸形包名,必须只取纯 semver。
        assert_eq!(
            extract_version_from_output("@agentclientprotocol/codex-acp 1.1.9"),
            Some("1.1.9".to_string())
        );
        assert_eq!(
            extract_version_from_output("codex-cli 0.146.0"),
            Some("0.146.0".to_string())
        );
        assert_eq!(
            extract_version_from_output("grok 0.2.115 (dd16b5eb7d50)"),
            Some("0.2.115".to_string())
        );
        assert_eq!(
            extract_version_from_output("kimi, version 1.49.0"),
            Some("1.49.0".to_string())
        );
        assert_eq!(
            extract_version_from_output("2.1.211 (Claude Code)"),
            Some("2.1.211".to_string())
        );
        assert_eq!(
            extract_version_from_output("1.18.2"),
            Some("1.18.2".to_string())
        );
    }

    #[test]
    fn returns_none_when_no_semver_version_is_present() {
        assert_eq!(extract_version_from_output("no version here"), None);
        assert_eq!(extract_version_from_output(""), None);
        assert_eq!(
            extract_version_from_output("v1.2.3"),
            Some("1.2.3".to_string())
        );
    }
}
