//! Bounded installation orchestration over an already validated immutable plan.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
};

use api_types::AgentId;
use regex::Regex;
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::{
    InstallInvocation, InstallRunner, PlannedDistributionKind, ResolvedInstallPlan,
    management_state::ManagementOperationState,
};

const DIAGNOSTIC_LIMIT: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrchestratorAgentSnapshot {
    pub membership_present: bool,
    pub current: Option<ResolvedInstallPlan>,
    pub rollback: Option<ResolvedInstallPlan>,
    pub operation: Option<ManagementOperationState>,
}

#[derive(Debug, Default)]
struct OrchestratorAgentState {
    membership_present: bool,
    current: Option<ResolvedInstallPlan>,
    rollback: Option<ResolvedInstallPlan>,
    operation: Option<ManagementOperationState>,
    diagnostics: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum InstallOperationError {
    #[error("Agent is not added")]
    MembershipMissing,
    #[error("operation canceled")]
    Canceled,
    #[error("installer boundary failed: {0}")]
    Boundary(String),
    #[error("installer exited with status {status}")]
    Failed { status: i32 },
}

pub struct InstallOrchestrator {
    runner: Arc<dyn InstallRunner>,
    global_jobs: Arc<Semaphore>,
    per_agent: Mutex<HashMap<AgentId, Arc<AsyncMutex<()>>>>,
    shared_resources: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    states: AsyncMutex<HashMap<AgentId, OrchestratorAgentState>>,
}

impl InstallOrchestrator {
    pub fn new(runner: Arc<dyn InstallRunner>) -> Self {
        Self {
            runner,
            global_jobs: Arc::new(Semaphore::new(2)),
            per_agent: Mutex::new(HashMap::new()),
            shared_resources: Mutex::new(HashMap::new()),
            states: AsyncMutex::new(HashMap::new()),
        }
    }

    pub async fn add_membership(&self, agent_id: AgentId) {
        self.states
            .lock()
            .await
            .entry(agent_id)
            .or_default()
            .membership_present = true;
    }

    pub async fn seed_current(&self, plan: ResolvedInstallPlan) {
        let mut states = self.states.lock().await;
        let state = states.entry(plan.agent_id.clone()).or_default();
        state.membership_present = true;
        state.current = Some(plan);
    }

    pub async fn snapshot(&self, agent_id: &AgentId) -> Option<OrchestratorAgentSnapshot> {
        self.states
            .lock()
            .await
            .get(agent_id)
            .map(|state| OrchestratorAgentSnapshot {
                membership_present: state.membership_present,
                current: state.current.clone(),
                rollback: state.rollback.clone(),
                operation: state.operation,
            })
    }

    pub async fn diagnostics(&self, agent_id: &AgentId) -> Vec<String> {
        self.states
            .lock()
            .await
            .get(agent_id)
            .map(|state| state.diagnostics.clone())
            .unwrap_or_default()
    }

    pub async fn execute(
        &self,
        plan: ResolvedInstallPlan,
        cancellation: CancellationToken,
    ) -> Result<(), InstallOperationError> {
        if cancellation.is_cancelled() {
            return Err(InstallOperationError::Canceled);
        }
        if !self
            .states
            .lock()
            .await
            .get(&plan.agent_id)
            .is_some_and(|state| state.membership_present)
        {
            return Err(InstallOperationError::MembershipMissing);
        }

        let _global = self
            .global_jobs
            .acquire()
            .await
            .expect("orchestrator semaphore remains open");
        let agent_lock = self.agent_lock(&plan.agent_id);
        let _agent = agent_lock.lock().await;
        if cancellation.is_cancelled() {
            return Err(InstallOperationError::Canceled);
        }

        let resource_keys = resource_keys(&plan);
        let resource_locks = resource_keys
            .iter()
            .map(|key| self.resource_lock(key))
            .collect::<Vec<_>>();
        let mut resource_guards = Vec::with_capacity(resource_locks.len());
        for lock in &resource_locks {
            resource_guards.push(lock.lock().await);
        }

        self.set_operation(&plan.agent_id, Some(operation_for(&plan)))
            .await;
        let result = self.run_staged(&plan, &resource_keys, &cancellation).await;
        match &result {
            Ok(()) => {
                let mut states = self.states.lock().await;
                let state = states
                    .get_mut(&plan.agent_id)
                    .expect("membership checked above");
                state.rollback = state.current.take();
                state.current = Some(plan.clone());
                state.operation = None;
                append_diagnostic(state, "installation completed".to_string());
            }
            Err(error) => {
                let mut states = self.states.lock().await;
                let state = states
                    .get_mut(&plan.agent_id)
                    .expect("membership checked above");
                state.operation = None;
                append_diagnostic(state, redact(&error.to_string()));
            }
        }
        drop(resource_guards);
        result
    }

    async fn run_staged(
        &self,
        plan: &ResolvedInstallPlan,
        resources: &[String],
        cancellation: &CancellationToken,
    ) -> Result<(), InstallOperationError> {
        for component in &plan.components {
            if cancellation.is_cancelled() {
                return Err(InstallOperationError::Canceled);
            }
            let resource = resource_for(component.distribution_kind).unwrap_or("none");
            let mut env = HashMap::new();
            env.insert("VIBEX_AGENT_ID".to_string(), plan.agent_id.to_string());
            env.insert("VIBEX_SHARED_RESOURCE".to_string(), resource.to_string());
            let mut args = vec![component.resolved_source.clone()];
            args.extend(component.args.clone());
            let output = self
                .runner
                .run(InstallInvocation {
                    program: PathBuf::from(&component.command),
                    args,
                    env,
                    cwd: None,
                })
                .await
                .map_err(|error| InstallOperationError::Boundary(redact(&error.to_string())))?;
            let output_text = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            if output.status_code != 0 {
                let message = format!(
                    "installer exited with status {}: {}",
                    output.status_code,
                    redact(&output_text)
                );
                return Err(InstallOperationError::Boundary(message));
            }
        }
        let _ = resources;
        if cancellation.is_cancelled() {
            return Err(InstallOperationError::Canceled);
        }
        Ok(())
    }

    async fn set_operation(&self, agent_id: &AgentId, operation: Option<ManagementOperationState>) {
        if let Some(state) = self.states.lock().await.get_mut(agent_id) {
            state.operation = operation;
        }
    }

    fn agent_lock(&self, agent_id: &AgentId) -> Arc<AsyncMutex<()>> {
        self.per_agent
            .lock()
            .unwrap()
            .entry(agent_id.clone())
            .or_default()
            .clone()
    }

    fn resource_lock(&self, key: &str) -> Arc<AsyncMutex<()>> {
        self.shared_resources
            .lock()
            .unwrap()
            .entry(key.to_string())
            .or_default()
            .clone()
    }
}

fn operation_for(plan: &ResolvedInstallPlan) -> ManagementOperationState {
    let _ = plan;
    ManagementOperationState::Installing
}

fn resource_for(kind: PlannedDistributionKind) -> Option<&'static str> {
    match kind {
        PlannedDistributionKind::Npx => Some("node"),
        PlannedDistributionKind::Uvx => Some("python"),
        PlannedDistributionKind::Binary => None,
    }
}

fn resource_keys(plan: &ResolvedInstallPlan) -> Vec<String> {
    let mut keys = plan
        .components
        .iter()
        .filter_map(|component| resource_for(component.distribution_kind))
        .map(ToString::to_string)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    keys.sort();
    keys
}

fn append_diagnostic(state: &mut OrchestratorAgentState, message: String) {
    state.diagnostics.push(redact(&message));
    if state.diagnostics.len() > DIAGNOSTIC_LIMIT {
        let overflow = state.diagnostics.len() - DIAGNOSTIC_LIMIT;
        state.diagnostics.drain(..overflow);
    }
}

fn redact(value: &str) -> String {
    let secret = Regex::new(r"(?i)\b(api[_-]?key|access[_-]?token|token|secret)\s*[:=]\s*[^\s]+")
        .expect("static diagnostic redaction regex");
    secret.replace_all(value, "$1=[REDACTED]").into_owned()
}
