use std::path::{Path, PathBuf};

use agents::pi_trust;
use api_types::{
    PiProjectResourceView, PiProjectTrustStateView, PiTrustEntryView, PiTrustSetRequest,
    PiTrustWorkspaceRequest,
};

use super::pi_configuration;

pub async fn state(
    pool: &sqlx::SqlitePool,
    home: &Path,
    request: PiTrustWorkspaceRequest,
) -> Result<PiProjectTrustStateView, String> {
    let env = pi_configuration::read_pi_env(pool).await?;
    let agent_dir = pi_configuration::pi_agent_dir(home, &env);
    let workspace = PathBuf::from(request.workspace);
    Ok(to_state_view(pi_trust::project_trust_state(
        &agent_dir.join("trust.json"),
        &pi_trust::default_ack_path(),
        &workspace,
        home,
    )))
}

pub async fn set(
    pool: &sqlx::SqlitePool,
    home: &Path,
    request: PiTrustSetRequest,
) -> Result<PiProjectTrustStateView, String> {
    let env = pi_configuration::read_pi_env(pool).await?;
    let agent_dir = pi_configuration::pi_agent_dir(home, &env);
    let workspace = PathBuf::from(request.workspace);
    pi_trust::write_trust_decision(&agent_dir.join("trust.json"), &workspace, request.trusted)?;
    pi_trust::set_acknowledged(
        &pi_trust::default_ack_path(),
        &workspace,
        request.trusted == Some(true),
    )?;
    Ok(to_state_view(pi_trust::project_trust_state(
        &agent_dir.join("trust.json"),
        &pi_trust::default_ack_path(),
        &workspace,
        home,
    )))
}

pub async fn acknowledge(
    pool: &sqlx::SqlitePool,
    home: &Path,
    request: PiTrustWorkspaceRequest,
) -> Result<PiProjectTrustStateView, String> {
    let env = pi_configuration::read_pi_env(pool).await?;
    let workspace = PathBuf::from(request.workspace);
    pi_trust::set_acknowledged(&pi_trust::default_ack_path(), &workspace, true)?;
    let agent_dir = pi_configuration::pi_agent_dir(home, &env);
    Ok(to_state_view(pi_trust::project_trust_state(
        &agent_dir.join("trust.json"),
        &pi_trust::default_ack_path(),
        &workspace,
        home,
    )))
}

pub async fn entries(
    pool: &sqlx::SqlitePool,
    home: &Path,
) -> Result<Vec<PiTrustEntryView>, String> {
    let env = pi_configuration::read_pi_env(pool).await?;
    let agent_dir = pi_configuration::pi_agent_dir(home, &env);
    Ok(pi_trust::list_entries(&agent_dir.join("trust.json"))?
        .into_iter()
        .map(|entry| PiTrustEntryView {
            path: entry.path,
            trusted: entry.trusted,
        })
        .collect())
}

fn to_state_view(state: pi_trust::PiProjectTrustState) -> PiProjectTrustStateView {
    PiProjectTrustStateView {
        workspace: state.workspace,
        resources: state
            .resources
            .into_iter()
            .map(|resource| PiProjectResourceView {
                path: resource.path,
                kind: resource.kind,
                executes_code: resource.executes_code,
            })
            .collect(),
        decision: state.decision,
        decided_at: state.decided_at,
        trust_file: state.trust_file,
        acknowledged: state.acknowledged,
    }
}
