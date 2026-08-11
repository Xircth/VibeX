use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::PluginError;

const MANIFEST_SCHEMA_V2: &str = "vibex-plugin/v2";

macro_rules! stable_id {
    ($name:ident) => {
        #[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }
    };
}

stable_id!(PluginId);
stable_id!(ToolId);
stable_id!(SkillId);
stable_id!(ActionId);

impl PluginId {
    pub(crate) fn from_string(value: String) -> Self {
        Self(value)
    }
}

impl ToolId {
    pub(crate) fn from_string(value: String) -> Self {
        Self(value)
    }
}

impl SkillId {
    pub(crate) fn from_string(value: String) -> Self {
        Self(value)
    }
}

impl ActionId {
    pub(crate) fn from_string(value: String) -> Self {
        Self(value)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ManifestSource {
    Bundled,
    External,
    LegacyMigration,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginMembership {
    Builtin,
    Added,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManifestV2 {
    #[serde(rename = "$schema")]
    schema: String,
    id: PluginId,
    version: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    console: Option<ConsoleBinding>,
    #[serde(default)]
    builtin: Option<bool>,
    #[serde(default)]
    dependencies: Vec<ToolDependency>,
    #[serde(default)]
    skills: Vec<SkillDeclaration>,
    #[serde(default)]
    actions: Vec<PluginAction>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PluginManifest {
    pub id: PluginId,
    pub version: String,
    pub name: String,
    pub description: Option<String>,
    pub author: Option<String>,
    pub icon: Option<String>,
    pub console: Option<ConsoleBinding>,
    pub membership: PluginMembership,
    pub dependencies: Vec<ToolDependency>,
    pub skills: Vec<SkillDeclaration>,
    pub actions: Vec<PluginAction>,
}

impl ManifestV2 {
    pub(crate) fn parse(json: &str, source: ManifestSource) -> Result<PluginManifest, PluginError> {
        let schema = serde_json::from_str::<serde_json::Value>(json)
            .map_err(|error| PluginError::invalid_manifest(error.to_string()))?
            .get("$schema")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| PluginError::invalid_manifest("missing string `$schema`"))?
            .to_owned();

        if schema != MANIFEST_SCHEMA_V2 {
            return Err(PluginError::unsupported_major(&schema));
        }

        let raw: Self = serde_json::from_str(json)
            .map_err(|error| PluginError::invalid_manifest(error.to_string()))?;
        debug_assert_eq!(raw.schema, MANIFEST_SCHEMA_V2);

        let membership = match source {
            ManifestSource::Bundled => PluginMembership::Builtin,
            ManifestSource::External | ManifestSource::LegacyMigration => PluginMembership::Added,
        };

        // `builtin` is accepted for schema compatibility but is deliberately not
        // trusted. Installation provenance is the only source of membership.
        let _untrusted_builtin_claim = raw.builtin;

        let manifest = PluginManifest {
            id: raw.id,
            version: raw.version,
            name: raw.name,
            description: raw.description,
            author: raw.author,
            icon: raw.icon,
            console: raw.console,
            membership,
            dependencies: raw.dependencies,
            skills: raw.skills,
            actions: raw.actions,
        };
        let declared_tools = manifest
            .dependencies
            .iter()
            .map(|dependency| dependency.id.as_str())
            .collect::<BTreeSet<_>>();
        for action in &manifest.actions {
            if let Some(artifact_intent) = &action.artifact_intent
                && !declared_tools.contains(artifact_intent.provider.as_str())
            {
                return Err(PluginError::unknown_provider(
                    manifest.id.as_str(),
                    &artifact_intent.provider,
                ));
            }
        }
        Ok(manifest)
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConsoleBinding {
    /// A preview address template. Console processes remain agent-driven;
    /// Plugin v2 never treats this field as an executable command.
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolKind {
    Binary,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ToolDependency {
    pub id: ToolId,
    pub kind: ToolKind,
    pub version: String,
    pub distributions: BTreeMap<String, Distribution>,
    pub probe: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Distribution {
    pub url: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillSource {
    Bundled,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SkillDeclaration {
    pub id: SkillId,
    pub source: SkillSource,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PluginAction {
    pub id: ActionId,
    pub label: String,
    pub required_skills: Vec<SkillId>,
    pub required_tools: Vec<ToolId>,
    pub prompt_blocks: Vec<PromptBlock>,
    #[serde(default)]
    pub artifact_intent: Option<ArtifactIntent>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum PromptBlock {
    Text { text: String },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ArtifactIntent {
    pub media_types: Vec<String>,
    pub provider: String,
}
