use std::{collections::BTreeMap, path::PathBuf};

use crate::{PluginId, PluginMembership};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginActivation {
    Disabled,
    Enabled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DependencyState {
    Missing,
    Installing,
    Ready {
        version: String,
        executable_path: PathBuf,
    },
    Failed {
        code: String,
        message: String,
    },
    Incompatible {
        code: String,
        message: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SkillState {
    Missing,
    Ready,
    Failed { code: String, message: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderState {
    Unavailable,
    Ready,
    Degraded { code: String, message: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadinessIssue {
    pub component: String,
    pub id: String,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginReadiness {
    Ready,
    NotReady { issues: Vec<ReadinessIssue> },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginSnapshot {
    pub id: PluginId,
    pub membership: PluginMembership,
    pub activation: PluginActivation,
    pub dependencies: BTreeMap<String, DependencyState>,
    pub skills: BTreeMap<String, SkillState>,
    pub providers: BTreeMap<String, ProviderState>,
    pub readiness: PluginReadiness,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EnableOperationKind {
    Installing,
    Ready,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnableOperation {
    pub kind: EnableOperationKind,
    pub dependency_ids: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EnableResult {
    pub operation: EnableOperation,
    pub plugin: PluginSnapshot,
}
