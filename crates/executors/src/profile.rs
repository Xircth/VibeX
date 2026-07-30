use std::{
    collections::HashMap,
    fs,
    str::FromStr,
    sync::{LazyLock, RwLock},
};

use api_types::AgentId;
use convert_case::{Case, Casing};
use serde::{Deserialize, Deserializer, Serialize, de::Error as DeError};
use thiserror::Error;
use ts_rs::TS;

use crate::{
    executors::{AgentKind, CodingAgent},
    model_selector::PermissionPolicy,
};

/// Return the canonical form for variant keys.
/// – "DEFAULT" is kept as-is  
/// – everything else is converted to SCREAMING_SNAKE_CASE
pub fn canonical_variant_key<S: AsRef<str>>(raw: S) -> String {
    let key = raw.as_ref();
    if key.eq_ignore_ascii_case("DEFAULT") {
        "DEFAULT".to_string()
    } else {
        // Convert to SCREAMING_SNAKE_CASE by first going to snake_case then uppercase
        key.to_case(Case::Snake).to_case(Case::ScreamingSnake)
    }
}

#[derive(Error, Debug)]
pub enum ProfileError {
    #[error("Built-in executor '{executor}' cannot be deleted")]
    CannotDeleteExecutor { executor: AgentKind },

    #[error("Built-in configuration '{executor}:{variant}' cannot be deleted")]
    CannotDeleteBuiltInConfig {
        executor: AgentKind,
        variant: String,
    },

    #[error("Validation error: {0}")]
    Validation(String),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(transparent)]
    Serde(#[from] serde_json::Error),
}

static EXECUTOR_PROFILES_CACHE: LazyLock<RwLock<ExecutorConfigs>> =
    LazyLock::new(|| RwLock::new(ExecutorConfigs::load()));

// New format default profiles (v3 - flattened)
const DEFAULT_PROFILES_JSON: &str = include_str!("../default_profiles.json");

// Executor-centric profile identifier
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, Hash, Eq)]
pub struct ExecutorProfileId {
    /// Open Agent identity. Legacy built-in spellings remain accepted by the
    /// AgentId grammar; new Registry ids are no longer constrained by an enum.
    #[serde(alias = "profile", deserialize_with = "de_agent_id_compat")]
    pub executor: AgentId,
    /// Optional variant name (e.g., "PLAN", "ROUTER")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    /// Optional model override carried by UI/runtime selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Optional Codex fast mode override carried by UI/runtime selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_mode: Option<bool>,
    /// Optional reasoning effort override carried by UI/runtime selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}

fn de_agent_id_compat<'de, D>(de: D) -> Result<AgentId, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = String::deserialize(de)?;
    let normalized = AgentKind::from_lenient(&raw)
        .map(|kind| kind.as_str().to_string())
        .unwrap_or(raw);
    AgentId::parse(normalized).map_err(D::Error::custom)
}

// Persisted profile payloads may still contain kebab-case executor ids.
// Keep this reader-side normalization unless a migration proves old config,
// scratch, and DB action payloads can no longer reach these serde boundaries.
fn de_base_coding_agent_kebab<'de, D>(de: D) -> Result<AgentKind, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = String::deserialize(de)?;
    // kebab-case -> SCREAMING_SNAKE_CASE
    let norm = raw.replace('-', "_").to_ascii_uppercase();
    AgentKind::from_str(&norm)
        .map_err(|_| D::Error::custom(format!("unknown executor '{raw}' (normalized to '{norm}')")))
}

impl ExecutorProfileId {
    /// Create a new executor profile ID with default variant
    pub fn new(executor: AgentKind) -> Self {
        Self {
            executor: AgentId::parse(executor.as_str())
                .expect("built-in AgentKind values are valid AgentIds"),
            variant: None,
            model: None,
            fast_mode: None,
            reasoning_effort: None,
        }
    }

    /// Create a new executor profile ID with specific variant
    pub fn with_variant(executor: AgentKind, variant: String) -> Self {
        Self {
            executor: AgentId::parse(executor.as_str())
                .expect("built-in AgentKind values are valid AgentIds"),
            variant: Some(variant),
            model: None,
            fast_mode: None,
            reasoning_effort: None,
        }
    }

    /// Get cache key for this executor profile
    pub fn cache_key(&self) -> String {
        match &self.variant {
            Some(variant) => format!("{}:{}", self.executor, variant),
            None => self.executor.clone().to_string(),
        }
    }
}

impl std::fmt::Display for ExecutorProfileId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.variant {
            Some(variant) => write!(f, "{}:{}", self.executor, variant),
            None => write!(f, "{}", self.executor),
        }
    }
}

/// Unified executor identity + user-selectable overrides.
///
/// This is the single object that flows through API requests, action types,
/// scratch persistence, and frontend state whenever an executor is used.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct ExecutorConfig {
    /// The executor type (e.g., CLAUDE_CODE, AMP)
    #[serde(alias = "profile", deserialize_with = "de_base_coding_agent_kebab")]
    pub executor: AgentKind,
    /// Optional variant/preset name (e.g., "PLAN", "ROUTER")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    /// Model override (e.g., "anthropic/claude-sonnet-4-20250514")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// Agent mode override
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Reasoning effort override (e.g., "high", "medium")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_id: Option<String>,
    /// Permission policy override
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_policy: Option<PermissionPolicy>,
}

impl ExecutorConfig {
    /// Create from just an executor (default variant, no overrides)
    pub fn new(executor: AgentKind) -> Self {
        Self {
            executor,
            variant: None,
            model_id: None,
            agent_id: None,
            reasoning_id: None,
            permission_policy: None,
        }
    }

    /// Extract the profile identity portion for profile lookup
    pub fn profile_id(&self) -> ExecutorProfileId {
        ExecutorProfileId {
            executor: AgentId::parse(self.executor.as_str())
                .expect("built-in AgentKind values are valid AgentIds"),
            variant: self.variant.clone(),
            model: self.model_id.clone(),
            fast_mode: None,
            reasoning_effort: self.reasoning_id.clone(),
        }
    }

    /// Returns true if any override field is set
    pub fn has_overrides(&self) -> bool {
        self.model_id.is_some()
            || self.agent_id.is_some()
            || self.reasoning_id.is_some()
            || self.permission_policy.is_some()
    }
}

impl TryFrom<ExecutorProfileId> for ExecutorConfig {
    type Error = ProfileError;

    fn try_from(id: ExecutorProfileId) -> Result<Self, Self::Error> {
        let executor = AgentKind::from_lenient(id.executor.as_str()).ok_or_else(|| {
            ProfileError::Validation(format!(
                "Agent '{}' has no legacy executor configuration profile",
                id.executor
            ))
        })?;
        Ok(Self {
            executor,
            variant: id.variant,
            model_id: id.model,
            agent_id: None,
            reasoning_id: id.reasoning_effort,
            permission_policy: None,
        })
    }
}

impl std::fmt::Display for ExecutorConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.profile_id().fmt(f)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct ExecutorProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recently_used_models: Option<ExecutorRecentModels>,
    #[serde(flatten)]
    pub configurations: HashMap<String, CodingAgent>,
}

impl ExecutorProfile {
    /// Get variant configuration by name, or None if not found
    pub fn get_variant(&self, variant: &str) -> Option<&CodingAgent> {
        self.configurations.get(variant)
    }

    /// Get the default configuration for this executor
    pub fn get_default(&self) -> Option<&CodingAgent> {
        self.configurations.get("DEFAULT")
    }

    /// Create a new executor profile with just a default configuration
    pub fn new_with_default(default_config: CodingAgent) -> Self {
        let mut configurations = HashMap::new();
        configurations.insert("DEFAULT".to_string(), default_config);
        Self {
            recently_used_models: None,
            configurations,
        }
    }

    /// Add or update a variant configuration
    pub fn set_variant(
        &mut self,
        variant_name: String,
        config: CodingAgent,
    ) -> Result<(), &'static str> {
        let key = canonical_variant_key(&variant_name);
        if key == "DEFAULT" {
            return Err(
                "Cannot override 'DEFAULT' variant using set_variant, use set_default instead",
            );
        }
        self.configurations.insert(key, config);
        Ok(())
    }

    /// Set the default configuration
    pub fn set_default(&mut self, config: CodingAgent) {
        self.configurations.insert("DEFAULT".to_string(), config);
    }

    /// Get all variant names (excluding "DEFAULT")
    pub fn variant_names(&self) -> Vec<&String> {
        self.configurations
            .keys()
            .filter(|k| *k != "DEFAULT")
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, Default)]
pub struct ExecutorRecentModels {
    /// Ordered list of recently used model keys (most recent last).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
    /// Last-used reasoning effort per model
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub reasoning_by_model: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
pub struct ExecutorConfigs {
    pub executors: HashMap<AgentKind, ExecutorProfile>,
}

impl ExecutorConfigs {
    /// Normalise all variant keys in-place
    fn canonicalise(&mut self) {
        for profile in self.executors.values_mut() {
            let mut replacements = Vec::new();
            for key in profile.configurations.keys().cloned().collect::<Vec<_>>() {
                let canon = canonical_variant_key(&key);
                if canon != key {
                    replacements.push((key, canon));
                }
            }
            for (old, new) in replacements {
                if let Some(cfg) = profile.configurations.remove(&old) {
                    // If both lowercase and canonical forms existed, keep canonical one
                    profile.configurations.entry(new).or_insert(cfg);
                }
            }
        }
    }

    /// Get cached executor profiles
    pub fn get_cached() -> ExecutorConfigs {
        EXECUTOR_PROFILES_CACHE.read().unwrap().clone()
    }

    /// Reload executor profiles cache
    pub fn reload() {
        let mut cache = EXECUTOR_PROFILES_CACHE.write().unwrap();
        *cache = Self::load();
    }

    /// Load executor profiles from file or defaults
    pub fn load() -> Self {
        let profiles_path = workspace_utils::assets::profiles_path();

        // Load defaults first
        let mut defaults = Self::from_defaults();
        defaults.canonicalise();

        // Try to load user overrides
        let content = match fs::read_to_string(&profiles_path) {
            Ok(content) => content,
            Err(_) => {
                tracing::info!("No user profiles.json found, using defaults only");
                return defaults;
            }
        };

        // Parse user overrides
        match serde_json::from_str::<Self>(&content) {
            Ok(mut user_overrides) => {
                tracing::info!("Loaded user profile overrides from profiles.json");
                user_overrides.canonicalise();
                Self::merge_with_defaults(defaults, user_overrides)
            }
            Err(e) => {
                tracing::error!(
                    "Failed to parse user profiles.json: {}, using defaults only",
                    e
                );
                defaults
            }
        }
    }

    /// Save user profile overrides to file (only saves what differs from defaults)
    pub fn save_overrides(&self) -> Result<(), ProfileError> {
        let profiles_path = workspace_utils::assets::profiles_path();
        let mut defaults = Self::from_defaults();
        defaults.canonicalise();

        // Canonicalise current config before computing overrides
        let mut self_clone = self.clone();
        self_clone.canonicalise();

        // Compute differences from defaults
        let overrides = Self::compute_overrides(&defaults, &self_clone)?;

        // Validate the merged result would be valid
        let merged = Self::merge_with_defaults(defaults, overrides.clone());
        Self::validate_merged(&merged)?;

        // Write overrides directly to file
        let content = serde_json::to_string_pretty(&overrides)?;
        fs::write(&profiles_path, content)?;

        tracing::info!("Saved profile overrides to {:?}", profiles_path);
        Ok(())
    }

    /// Deep merge defaults with user overrides
    fn merge_with_defaults(mut defaults: Self, overrides: Self) -> Self {
        for (executor_key, override_profile) in overrides.executors {
            match defaults.executors.get_mut(&executor_key) {
                Some(default_profile) => {
                    // Merge configurations (user configs override defaults, new ones are added)
                    for (config_name, config) in override_profile.configurations {
                        default_profile.configurations.insert(config_name, config);
                    }
                    if override_profile.recently_used_models.is_some() {
                        default_profile.recently_used_models =
                            override_profile.recently_used_models;
                    }
                }
                None => {
                    // New executor, add completely
                    defaults.executors.insert(executor_key, override_profile);
                }
            }
        }

        defaults
    }

    /// Compute what overrides are needed to transform defaults into current config
    fn compute_overrides(defaults: &Self, current: &Self) -> Result<Self, ProfileError> {
        let mut overrides = Self {
            executors: HashMap::new(),
        };

        // Fast scan for any illegal deletions BEFORE allocating/cloning
        for (executor_key, default_profile) in &defaults.executors {
            // Check if executor was removed entirely
            if !current.executors.contains_key(executor_key) {
                return Err(ProfileError::CannotDeleteExecutor {
                    executor: *executor_key,
                });
            }

            let current_profile = &current.executors[executor_key];

            // Check if ANY built-in configuration was removed
            for config_name in default_profile.configurations.keys() {
                if !current_profile.configurations.contains_key(config_name) {
                    return Err(ProfileError::CannotDeleteBuiltInConfig {
                        executor: *executor_key,
                        variant: config_name.clone(),
                    });
                }
            }
        }

        for (executor_key, current_profile) in &current.executors {
            if let Some(default_profile) = defaults.executors.get(executor_key) {
                let mut override_configurations = HashMap::new();

                // Check each configuration in current profile
                for (config_name, current_config) in &current_profile.configurations {
                    if let Some(default_config) = default_profile.configurations.get(config_name) {
                        // Only include if different from default
                        if current_config != default_config {
                            override_configurations
                                .insert(config_name.clone(), current_config.clone());
                        }
                    } else {
                        // New configuration, always include
                        override_configurations.insert(config_name.clone(), current_config.clone());
                    }
                }

                let mut override_profile = ExecutorProfile {
                    recently_used_models: None,
                    configurations: override_configurations,
                };

                if current_profile.recently_used_models != default_profile.recently_used_models {
                    override_profile.recently_used_models = current_profile
                        .recently_used_models
                        .clone()
                        .or_else(|| Some(ExecutorRecentModels::default()));
                }

                if !override_profile.configurations.is_empty()
                    || override_profile.recently_used_models.is_some()
                {
                    overrides.executors.insert(*executor_key, override_profile);
                }
            } else {
                // New executor, include completely
                overrides
                    .executors
                    .insert(*executor_key, current_profile.clone());
            }
        }

        Ok(overrides)
    }

    /// Validate that merged profiles are consistent and valid
    fn validate_merged(merged: &Self) -> Result<(), ProfileError> {
        for (executor_key, profile) in &merged.executors {
            // Ensure default configuration exists
            let default_config = profile.configurations.get("DEFAULT").ok_or_else(|| {
                ProfileError::Validation(format!(
                    "Executor '{executor_key}' is missing required 'default' configuration"
                ))
            })?;

            // Validate that the default agent type matches the executor key
            if AgentKind::from(default_config) != *executor_key {
                return Err(ProfileError::Validation(format!(
                    "Executor key '{executor_key}' does not match the agent variant '{default_config}'"
                )));
            }

            // Ensure configuration names don't conflict with reserved words
            for config_name in profile.configurations.keys() {
                if config_name.starts_with("__") {
                    return Err(ProfileError::Validation(format!(
                        "Configuration name '{config_name}' is reserved (starts with '__')"
                    )));
                }
            }
        }
        Ok(())
    }

    /// Load from the new v3 defaults
    pub fn from_defaults() -> Self {
        serde_json::from_str(DEFAULT_PROFILES_JSON).unwrap_or_else(|e| {
            tracing::error!("Failed to parse embedded default_profiles.json: {}", e);
            panic!("Default profiles v3 JSON is invalid")
        })
    }
}

pub fn to_default_variant(id: &ExecutorProfileId) -> ExecutorProfileId {
    ExecutorProfileId {
        executor: id.executor.clone(),
        variant: None,
        model: id.model.clone(),
        fast_mode: id.fast_mode,
        reasoning_effort: id.reasoning_effort.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executors::AgentKind;

    #[test]
    fn default_profiles_include_frontier_codex_variants() {
        let defaults = ExecutorConfigs::from_defaults();
        let codex = defaults
            .executors
            .get(&AgentKind::Codex)
            .expect("codex defaults should exist");

        assert!(codex.configurations.contains_key("GPT_5_5"));
        assert!(codex.configurations.contains_key("GPT_5_5_APPROVALS"));
        assert!(codex.configurations.contains_key("GPT_5_4"));
        assert!(codex.configurations.contains_key("GPT_5_4_APPROVALS"));
    }

    #[test]
    fn executor_profile_id_accepts_an_open_generic_agent_id() {
        let id: ExecutorProfileId = serde_json::from_value(serde_json::json!({
            "executor": "vendor.agent",
            "variant": null
        }))
        .expect("generic Registry Agent ids must cross the session profile seam");

        assert_eq!(id.executor.to_string(), "vendor.agent");
    }

    #[test]
    fn executor_profile_id_deserializes_legacy_kebab_executor() {
        let profile: ExecutorProfileId =
            serde_json::from_str(r#"{"executor":"claude-code","variant":"PLAN"}"#)
                .expect("legacy kebab executor should deserialize");

        assert_eq!(profile.executor.as_str(), "claude_code");
        assert_eq!(profile.variant.as_deref(), Some("PLAN"));
    }

    #[test]
    fn executor_profile_id_deserializes_legacy_profile_alias() {
        let profile: ExecutorProfileId =
            serde_json::from_str(r#"{"profile":"opencode","model":"gpt-5.4"}"#)
                .expect("legacy profile alias should deserialize");

        assert_eq!(profile.executor.as_str(), "opencode");
        assert_eq!(profile.model.as_deref(), Some("gpt-5.4"));
    }

    #[test]
    fn executor_config_deserializes_legacy_kebab_executor() {
        let config: ExecutorConfig =
            serde_json::from_str(r#"{"executor":"claude-code","variant":"ROUTER"}"#)
                .expect("legacy kebab executor config should deserialize");

        assert_eq!(config.executor, AgentKind::ClaudeCode);
        assert_eq!(config.variant.as_deref(), Some("ROUTER"));
    }

    #[test]
    fn executor_profile_id_deserializes_legacy_screaming_executor() {
        // 批次D2 / ADR-0002 old-DB acceptance: before AgentKind, AgentKind's serde
        // was SCREAMING_SNAKE_CASE, so `scratch.selected_profile` / ExecutorAction payloads
        // in existing databases store `"CLAUDE_CODE"` / `"OPENCODE"`. AgentKind's lenient
        // read must still load them (now normalizing to canonical snake_case on re-write).
        for (raw, expected) in [
            (r#"{"executor":"CLAUDE_CODE"}"#, AgentKind::ClaudeCode),
            (r#"{"executor":"OPENCODE"}"#, AgentKind::Opencode),
            (
                r#"{"executor":"OPENCLAW","variant":"DEFAULT"}"#,
                AgentKind::Openclaw,
            ),
        ] {
            let profile: ExecutorProfileId =
                serde_json::from_str(raw).expect("legacy SCREAMING executor should deserialize");
            assert_eq!(
                profile.executor.as_str(),
                expected.as_str(),
                "parsing {raw}"
            );
            // Re-serialization converges on the canonical snake_case form.
            let round = serde_json::to_string(&profile).expect("serialize");
            assert!(
                round.contains(&format!("\"{}\"", expected.as_str())),
                "re-serialized {round} should carry canonical key {}",
                expected.as_str()
            );
        }
    }
}
