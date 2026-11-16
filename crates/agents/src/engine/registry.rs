//! Pluggable native engine registry for resolving [`NativeEngineDriver`] instances
//! by agent identifier, engine identifier, or grayscale policy (`DIMO_ENGINE_MODE`)
//! without embedding vendor branches in the runner or runtime control plane.

use std::sync::Arc;

use super::{
    EngineRuntimePreference, NativeEngineDriver, NativeEngineKind, claude::ClaudeNativeDriver,
    codex::CodexNativeDriver, descriptor::effective_runtime_preference,
};

/// Ordered registry of available [`NativeEngineDriver`] implementations.
#[derive(Clone, Default)]
pub struct EngineRegistry {
    drivers: Vec<Arc<dyn NativeEngineDriver>>,
}

impl std::fmt::Debug for EngineRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let ids: Vec<&str> = self.drivers.iter().map(|d| d.engine_id()).collect();
        f.debug_struct("EngineRegistry")
            .field("drivers", &ids)
            .finish()
    }
}

impl EngineRegistry {
    /// Creates an empty registry ready for custom driver registration.
    pub fn empty() -> Self {
        Self {
            drivers: Vec::new(),
        }
    }

    /// Creates a registry pre-populated with Dimo's built-in first-party native drivers
    /// (`ClaudeNativeDriver`, `CodexNativeDriver`).
    pub fn bundled() -> Self {
        Self::empty()
            .with_driver(Arc::new(ClaudeNativeDriver::new()))
            .with_driver(Arc::new(CodexNativeDriver::new()))
    }

    /// Registers a native driver instance. Replacing any earlier driver with the same `engine_id`.
    pub fn register(&mut self, driver: Arc<dyn NativeEngineDriver>) {
        self.drivers.retain(|d| d.engine_id() != driver.engine_id());
        self.drivers.push(driver);
    }

    /// Builder-style helper returning `self` with `driver` registered.
    pub fn with_driver(mut self, driver: Arc<dyn NativeEngineDriver>) -> Self {
        self.register(driver);
        self
    }

    /// Resolves the active native engine driver for `agent_kind_or_id`, honoring
    /// `preference` and `DIMO_ENGINE_MODE` (`acp` vs `native`) grayscale overrides.
    pub fn resolve_driver_for_agent(
        &self,
        agent_kind_or_id: &str,
        preference: EngineRuntimePreference,
        mode_env: Option<&str>,
    ) -> Option<Arc<dyn NativeEngineDriver>> {
        if effective_runtime_preference(preference, mode_env) == EngineRuntimePreference::AcpOnly {
            return None;
        }
        self.drivers
            .iter()
            .find(|driver| driver.supports_agent(agent_kind_or_id))
            .cloned()
    }

    /// Looks up a registered driver by its canonical `engine_id` (e.g. `"claude-native"`).
    pub fn for_engine_id(&self, engine_id: &str) -> Option<Arc<dyn NativeEngineDriver>> {
        self.drivers
            .iter()
            .find(|driver| driver.engine_id() == engine_id)
            .cloned()
    }

    /// Looks up the built-in driver matching a typed [`NativeEngineKind`].
    pub fn for_kind(&self, kind: NativeEngineKind) -> Option<Arc<dyn NativeEngineDriver>> {
        self.for_engine_id(kind.engine_id())
    }

    /// Returns all registered driver instances in resolution order.
    pub fn drivers(&self) -> &[Arc<dyn NativeEngineDriver>] {
        &self.drivers
    }

    /// Invalidates cached driver resources for any driver serving `agent_kind_or_id`.
    pub async fn invalidate_agent(&self, agent_kind_or_id: &str) -> usize {
        let mut evicted = 0usize;
        for driver in &self.drivers {
            if driver.supports_agent(agent_kind_or_id) {
                evicted += driver.invalidate_caches().await;
            }
        }
        evicted
    }
}

/// Invalidates driver-owned cached runtimes (such as Codex workspace app-servers)
/// for `agent_id` through [`EngineRegistry::bundled`].
pub async fn invalidate_engine_caches_for_agent(agent_id: &str) -> usize {
    EngineRegistry::bundled().invalidate_agent(agent_id).await
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::atomic::{AtomicUsize, Ordering}};

    use async_trait::async_trait;
    use futures::stream;
    use serde_json::{Value, json};
    use uuid::Uuid;

    use super::*;
    use crate::engine::{
        EngineCacheStatus, EngineCapabilities, EngineCheckpoint, EngineCommandSpec,
        EngineEffortSpec, EngineError, EngineEventStream, EngineHandle, EngineModeSpec,
        EnginePromptRequest, EngineRateLimits, EngineSelectChoice, EngineStartSpec,
        EngineSteerReceipt, EngineSteerRequest, descriptor::normalize_agent_token,
    };

    struct SyntheticOpenCodeDriver {
        invalidations: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl NativeEngineDriver for SyntheticOpenCodeDriver {
        fn engine_id(&self) -> &str {
            "opencode-native"
        }

        fn supports_agent(&self, agent_kind_or_id: &str) -> bool {
            matches!(
                normalize_agent_token(agent_kind_or_id).as_str(),
                "opencode" | "opencode_native"
            )
        }

        fn capabilities(&self) -> EngineCapabilities {
            EngineCapabilities {
                engine_id: self.engine_id().to_string(),
                supports_native_steer: true,
                supports_native_revert: false,
                supports_native_fork: false,
                supports_rate_limit_push: false,
                supports_prompt_cache_ttl: false,
                records_idle_compaction_activity: false,
                modes: EngineModeSpec {
                    modes: vec![
                        EngineSelectChoice {
                            id: "build".to_string(),
                            label: "Build".to_string(),
                            description: None,
                        },
                        EngineSelectChoice {
                            id: "yolo".to_string(),
                            label: "Auto".to_string(),
                            description: None,
                        },
                    ],
                    default_mode_id: "build".to_string(),
                    yolo_mode_id: "yolo".to_string(),
                },
                effort: Some(EngineEffortSpec {
                    choices: vec![EngineSelectChoice {
                        id: "medium".to_string(),
                        label: "Medium".to_string(),
                        description: None,
                    }],
                    default_value: "medium".to_string(),
                }),
                default_commands: vec![EngineCommandSpec {
                    name: "compact".to_string(),
                    description: "Compact session".to_string(),
                }],
            }
        }

        fn resolve_default_model(&self, _env: &HashMap<String, String>) -> Option<String> {
            Some("opencode/default-model".to_string())
        }

        async fn invalidate_caches(&self) -> usize {
            self.invalidations.fetch_add(1, Ordering::SeqCst) + 1
        }

        async fn start(&self, spec: EngineStartSpec) -> Result<EngineHandle, EngineError> {
            Ok(EngineHandle::for_engine(
                Uuid::new_v4(),
                self.engine_id(),
                spec.workspace_id,
                spec.working_dir,
                true,
                None,
            ))
        }

        async fn send_prompt(
            &self,
            _handle: &EngineHandle,
            _request: EnginePromptRequest,
        ) -> Result<EngineEventStream, EngineError> {
            Ok(Box::pin(stream::empty()))
        }

        async fn steer(
            &self,
            _handle: &EngineHandle,
            _request: EngineSteerRequest,
        ) -> Result<EngineSteerReceipt, EngineError> {
            Ok(EngineSteerReceipt::Rejected {
                code: "unsupported".into(),
                message: "not active".into(),
            })
        }

        async fn interrupt(&self, _handle: &EngineHandle) -> Result<(), EngineError> {
            Ok(())
        }

        async fn revert_to(
            &self,
            _handle: &EngineHandle,
            _checkpoint: EngineCheckpoint,
        ) -> Result<(), EngineError> {
            Err(EngineError::Unsupported("revert_to".into()))
        }

        fn rate_limits(&self, _handle: &EngineHandle) -> Option<EngineRateLimits> {
            None
        }

        fn cache_status(&self, _handle: &EngineHandle) -> Option<EngineCacheStatus> {
            None
        }

        async fn shutdown(&self, _handle: EngineHandle) -> Result<(), EngineError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn registry_routes_bundled_and_pluggable_third_party_drivers() {
        let invalidations = Arc::new(AtomicUsize::new(0));
        let registry = EngineRegistry::bundled().with_driver(Arc::new(SyntheticOpenCodeDriver {
            invalidations: Arc::clone(&invalidations),
        }));

        let claude = registry
            .resolve_driver_for_agent("claude_code", EngineRuntimePreference::NativeFirst, None)
            .expect("claude driver resolved");
        assert_eq!(claude.engine_id(), "claude-native");
        assert_eq!(claude.kind(), Some(NativeEngineKind::ClaudeNative));

        let codex = registry
            .resolve_driver_for_agent("codex", EngineRuntimePreference::NativeFirst, None)
            .expect("codex driver resolved");
        assert_eq!(codex.engine_id(), "codex-native");
        assert_eq!(codex.kind(), Some(NativeEngineKind::CodexNative));

        let opencode = registry
            .resolve_driver_for_agent("builtin:opencode", EngineRuntimePreference::NativeFirst, None)
            .expect("pluggable third driver resolved without runner enum changes");
        assert_eq!(opencode.engine_id(), "opencode-native");
        assert_eq!(opencode.kind(), None);
        assert!(opencode.descriptor().is_none());
        assert_eq!(
            opencode.resolve_default_model(&HashMap::new()).as_deref(),
            Some("opencode/default-model")
        );
        assert_eq!(opencode.normalize_mode("build").as_deref(), Some("build"));
        assert_eq!(opencode.normalize_mode("yolo").as_deref(), Some("yolo"));

        // Grayscale override still forces ACP when DIMO_ENGINE_MODE=acp.
        assert!(
            registry
                .resolve_driver_for_agent(
                    "opencode",
                    EngineRuntimePreference::NativeFirst,
                    Some("acp")
                )
                .is_none()
        );

        let evicted = registry.invalidate_agent("opencode").await;
        assert_eq!(evicted, 1);
        assert_eq!(invalidations.load(Ordering::SeqCst), 1);

        // Unregistered long-tail agent cleanly returns None (falls back to ACP).
        assert!(
            registry
                .resolve_driver_for_agent("grok", EngineRuntimePreference::NativeFirst, None)
                .is_none()
        );
    }

    #[test]
    fn claude_and_codex_drivers_own_tool_classification_and_question_encoding() {
        let claude = ClaudeNativeDriver::new();
        let codex = CodexNativeDriver::new();

        let claude_tool = claude.classify_tool_call(
            "Bash",
            &json!({ "command": "cargo test" }),
            Some("parent-99"),
        );
        assert_eq!(claude_tool.semantic_kind, "execute");
        assert_eq!(claude_tool.title, "cargo test");
        assert_eq!(
            claude_tool.meta.as_ref().and_then(|m| m.get("claudeCode")),
            Some(&json!({ "toolName": "Bash", "parentToolUseId": "parent-99" }))
        );

        let codex_tool = codex.classify_tool_call(
            "commandExecution",
            &json!({ "command": ["git", "status"] }),
            Some("parent-99"),
        );
        assert_eq!(codex_tool.semantic_kind, "execute");
        assert_eq!(codex_tool.title, "git status");
        assert!(codex_tool.meta.is_none());

        let entries = vec![("q_0".to_string(), vec!["web".to_string(), "cli".to_string()])];
        let keys = vec![("q_0".to_string(), "Target platform?".to_string())];
        assert_eq!(
            claude.encode_question_answers(&entries, &keys),
            json!({ "Target platform?": "web, cli" })
        );
        assert_eq!(
            codex.encode_question_answers(&entries, &keys),
            json!({ "q_0": { "answers": ["web", "cli"] } })
        );

        let val: Value = claude.encode_question_answers(&entries, &keys);
        assert!(val.is_object());
    }
}
