#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeMap, HashMap},
        io::Cursor,
        path::{Path, PathBuf},
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use agents::{ProfileComponent, ProfileExternalCandidate};
    use api_types::{
        AgentId, AgentLocalRuntimeView, AgentManagementErrorCode, AgentManagementErrorView,
        AgentNativeConfigPatchRequest, AgentOperationEvent, AgentOperationKind,
        AgentOperationStatus, AgentPreflightItemView, OpenCodeProviderConnectRequest,
        OpenCodeProviderModelRequest,
    };
    use sha2::Digest;

    #[cfg(target_os = "macos")]
    use super::clear_macos_quarantine;
    use super::{
        AgentManagementRuntimeState, ArtifactTrust, BuiltInProbeAction, LockedInstallSource,
        MANAGED_UV_VERSION, NativeFileRollback, OperationCancellationRegistry,
        PlannedDistributionKind, PlannedInstallComponent, ResolvedInstallPlan, RuntimeSource,
        agent_process_command, apply_codex_auth_document, apply_config_transition_then,
        apply_custom_version_override, apply_opencode_provider_connection,
        bind_profile_runtime_executable, build_launch_environment, built_in_probe_action,
        cancellable_command_output, codex_provider_config_is_projected,
        compare_and_set_agent_environment, configure_uv_tool_install_command,
        dependency_version_satisfied, detect_account_login, extract_binary_archive,
        install_locked_plan, managed_artifacts_directory, managed_install_root,
        managed_node_artifact, managed_node_executables, managed_uv_artifact,
        managed_uv_executable, managed_uv_version_matches, management_command_with_environment,
        management_error, native_auth_mode_patch, native_config_view, npm_executable,
        opencode_provider_paths, operation_event, pi_runtime_lock_env,
        preflight_component_is_healthy, probe_local_runtime_candidate, probe_system_node_runtime,
        profile_component_distribution_kind, project_agent_environment, project_auth_mode_options,
        project_codex_auth_mode, project_opencode_provider_connections,
        read_agent_environment_record, read_agent_management_snapshot,
        reconcile_grok_vibex_configuration, reconcile_kimi_vibex_configuration,
        redact_operation_output, relocate_managed_path, remove_opencode_provider_state,
        resolve_npm_package_executable, resolve_uv_tool_executable, restore_native_file_rollback,
        run_agent_management_warmup_once, run_bounded_agent_probes,
        run_local_runtime_discovery_once, runtime_preflight_facts, safe_archive_executable,
        sanitize_custom_version, seed_kimi_synthetic_credential, set_opencode_provider_enabled,
        staging_dir_is_referenced_by, sync_native_launch_preferences,
        validate_agent_environment_name, validate_native_config_patch, verify_acp_handshake,
        verify_managed_node_runtime, write_bytes_document,
    };

    #[tokio::test]
    async fn startup_management_warmup_is_shared_by_concurrent_readers() {
        let warmup = AgentManagementRuntimeState::default();
        let runs = Arc::new(AtomicUsize::new(0));

        let first_runs = runs.clone();
        let first = run_agent_management_warmup_once(&warmup, async move {
            first_runs.fetch_add(1, Ordering::SeqCst);
        });
        let second_runs = runs.clone();
        let second = run_agent_management_warmup_once(&warmup, async move {
            second_runs.fetch_add(1, Ordering::SeqCst);
        });

        tokio::join!(first, second);

        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn local_runtime_discovery_does_not_wait_for_management_warmup() {
        let runtime = Arc::new(AgentManagementRuntimeState::default());
        let warmup_started = Arc::new(tokio::sync::Notify::new());
        let release_warmup = Arc::new(tokio::sync::Semaphore::new(0));

        let warmup_runtime = runtime.clone();
        let warmup_started_task = warmup_started.clone();
        let release_warmup_task = release_warmup.clone();
        let warmup_local_runtime = runtime.clone();
        let warmup = tokio::spawn(async move {
            run_agent_management_warmup_once(&warmup_runtime, async move {
                run_local_runtime_discovery_once(&warmup_local_runtime, async {}).await;
                warmup_started_task.notify_one();
                let _permit = release_warmup_task.acquire().await.unwrap();
            })
            .await;
        });
        warmup_started.notified().await;

        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            run_local_runtime_discovery_once(&runtime, async {}),
        )
        .await
        .expect("local Runtime discovery must not share the heavyweight warmup lock");

        release_warmup.add_permits(1);
        warmup.await.unwrap();
    }

    #[tokio::test]
    async fn management_snapshot_does_not_wait_for_local_runtime_discovery() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(":memory:")
                    .create_if_missing(true),
            )
            .await
            .unwrap();
        sqlx::migrate!("../crates/db/migrations")
            .run(&pool)
            .await
            .unwrap();

        let runtime = Arc::new(AgentManagementRuntimeState::default());
        let discovery_started = Arc::new(tokio::sync::Notify::new());
        let release_discovery = Arc::new(tokio::sync::Semaphore::new(0));
        let discovery_runtime = runtime.clone();
        let started = discovery_started.clone();
        let release = release_discovery.clone();
        let discovery = tokio::spawn(async move {
            run_local_runtime_discovery_once(&discovery_runtime, async move {
                started.notify_one();
                let _permit = release.acquire().await.unwrap();
            })
            .await;
        });
        discovery_started.notified().await;

        tokio::time::timeout(
            std::time::Duration::from_millis(500),
            read_agent_management_snapshot(&pool, &runtime),
        )
        .await
        .expect("snapshot reads must not wait behind local Runtime probes")
        .unwrap();

        release_discovery.add_permits(1);
        discovery.await.unwrap();
    }

    #[tokio::test]
    async fn startup_agent_probes_use_bounded_parallelism() {
        let (started_tx, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let probe_release = release.clone();

        let jobs = (0..6)
            .map(move |probe_id| {
                let started_tx = started_tx.clone();
                let release = probe_release.clone();
                async move {
                    started_tx.send(probe_id).unwrap();
                    let _permit = release.acquire().await.unwrap();
                }
            })
            .collect();
        let runner = tokio::spawn(run_bounded_agent_probes(jobs, 4));

        for _ in 0..4 {
            tokio::time::timeout(std::time::Duration::from_secs(1), started_rx.recv())
                .await
                .expect("four probes should start concurrently")
                .expect("probe start channel should remain open");
        }
        assert!(started_rx.try_recv().is_err());

        release.add_permits(4);
        for _ in 0..2 {
            tokio::time::timeout(std::time::Duration::from_secs(1), started_rx.recv())
                .await
                .expect("queued probes should start after capacity is released")
                .expect("probe start channel should remain open");
        }
        release.add_permits(2);
        runner.await.unwrap();
    }

    #[test]
    fn startup_refreshes_existing_installation_evidence() {
        assert_eq!(
            built_in_probe_action(true, false),
            BuiltInProbeAction::RefreshExisting
        );
        assert_eq!(
            built_in_probe_action(true, true),
            BuiltInProbeAction::KeepExisting
        );
        assert_eq!(
            built_in_probe_action(false, false),
            BuiltInProbeAction::Discover
        );
    }

    #[tokio::test]
    async fn agent_process_command_runs_platform_scripts() {
        let temp = tempfile::tempdir().unwrap();

        #[cfg(windows)]
        let script = {
            let script = temp.path().join("agent probe.cmd");
            std::fs::write(&script, "@echo off\r\n<nul set /p =ok:%1\r\nexit /b 0\r\n").unwrap();
            script
        };

        #[cfg(unix)]
        let script = {
            use std::os::unix::fs::PermissionsExt;

            let script = temp.path().join("agent-probe");
            std::fs::write(&script, "#!/bin/sh\nprintf 'ok:%s' \"$1\"\n").unwrap();
            let mut permissions = std::fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&script, permissions).unwrap();
            script
        };

        let mut command = agent_process_command(&script);
        command.arg("argument");
        let output =
            cancellable_command_output(command, &tokio_util::sync::CancellationToken::new())
                .await
                .unwrap();

        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout), "ok:argument");
    }

    #[tokio::test]
    async fn local_runtime_discovery_succeeds_without_an_acp_candidate() {
        let temp = tempfile::tempdir().unwrap();

        #[cfg(windows)]
        let script = {
            let script = temp.path().join("detected-runtime.cmd");
            std::fs::write(&script, "@echo off\r\necho runtime-1.2.3\r\n").unwrap();
            script
        };

        #[cfg(unix)]
        let script = {
            use std::os::unix::fs::PermissionsExt;

            let script = temp.path().join("detected-runtime");
            std::fs::write(&script, "#!/bin/sh\nprintf 'runtime-1.2.3'\n").unwrap();
            let mut permissions = std::fs::metadata(&script).unwrap().permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&script, permissions).unwrap();
            script
        };

        let executable = Box::leak(script.to_string_lossy().into_owned().into_boxed_str());
        let evidence = probe_local_runtime_candidate(&ProfileExternalCandidate {
            component: ProfileComponent::AgentRuntime,
            executable,
            version_args: &["--version"],
        })
        .await
        .expect("the runnable CLI is independent Runtime evidence");

        assert_eq!(evidence.path, std::fs::canonicalize(script).unwrap());
        assert_eq!(evidence.version.as_deref(), Some("runtime-1.2.3"));
    }

    #[test]
    fn settings_runtime_preflight_uses_discovered_cli_without_an_install_lock() {
        let local_runtime = AgentLocalRuntimeView {
            path: r"C:\Users\developer\AppData\Roaming\npm\codex.cmd".to_string(),
            version: Some("codex-cli 0.138.0".to_string()),
        };

        let facts = runtime_preflight_facts(None, Some(&local_runtime));

        assert!(facts.available);
        assert_eq!(facts.version.as_deref(), Some("codex-cli 0.138.0"));
        assert_eq!(facts.path.as_deref(), Some(local_runtime.path.as_str()));
    }

    #[tokio::test]
    async fn atomic_document_writer_replaces_existing_file_without_residue() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("auth.json");
        tokio::fs::write(&path, b"old").await.unwrap();

        write_bytes_document(&path, b"new-secret", true)
            .await
            .unwrap();

        assert_eq!(tokio::fs::read(&path).await.unwrap(), b"new-secret");
        let names = std::fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["auth.json"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn configuration_rollback_never_overwrites_a_concurrent_external_edit() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.json");
        tokio::fs::write(&path, b"external").await.unwrap();
        let rollback = [NativeFileRollback {
            path: path.clone(),
            original: Some(b"original".to_vec()),
            expected: Some(b"vibex".to_vec()),
            sensitive: false,
        }];

        assert!(restore_native_file_rollback(&rollback).await.is_err());
        assert_eq!(tokio::fs::read(path).await.unwrap(), b"external");
    }

    #[tokio::test]
    async fn environment_compare_and_set_preserves_a_concurrent_edit() {
        let pool = sqlx::SqlitePool::connect(":memory:").await.unwrap();
        sqlx::query(
            "CREATE TABLE agent_setting (agent_type TEXT PRIMARY KEY, env_json TEXT, updated_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_setting (agent_type, env_json, updated_at) VALUES ('codex', '{}', '')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("UPDATE agent_setting SET env_json = '{\"EXTERNAL\":\"1\"}'")
            .execute(&pool)
            .await
            .unwrap();

        assert!(
            !compare_and_set_agent_environment(
                &pool,
                &AgentId::parse("codex").unwrap(),
                Some("{}"),
                "{\"VIBEX\":\"1\"}",
            )
            .await
            .unwrap()
        );
        let current: String =
            sqlx::query_scalar("SELECT env_json FROM agent_setting WHERE agent_type = 'codex'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(current, "{\"EXTERNAL\":\"1\"}");
    }

    #[tokio::test]
    async fn missing_agent_setting_row_is_created_on_environment_read() {
        let pool = sqlx::SqlitePool::connect(":memory:").await.unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_setting (
                agent_type TEXT PRIMARY KEY,
                sort_order INTEGER NOT NULL DEFAULT 0,
                env_json TEXT,
                updated_at TEXT
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        let agent_id = AgentId::parse("deepseek_harness").unwrap();

        let (raw, environment) = read_agent_environment_record(&pool, &agent_id)
            .await
            .expect("create missing settings row");
        assert!(raw.is_none());
        assert!(environment.is_empty());
        assert!(
            compare_and_set_agent_environment(
                &pool,
                &agent_id,
                None,
                r#"{"DSH_AGENT_PRESET":"code"}"#,
            )
            .await
            .unwrap()
        );
        let stored: String =
            sqlx::query_scalar("SELECT env_json FROM agent_setting WHERE agent_type = ?")
                .bind(agent_id.as_str())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored, r#"{"DSH_AGENT_PRESET":"code"}"#);
    }

    #[test]
    fn environment_projection_redacts_credentials_and_keeps_plain_values() {
        let environment = BTreeMap::from([
            ("MODEL".to_string(), "gpt-5".to_string()),
            ("OPENAI_API_KEY".to_string(), "sk-secret".to_string()),
        ]);
        let view = project_agent_environment(AgentId::parse("codex").unwrap(), &environment);
        assert_eq!(view.entries[0].value.as_deref(), Some("gpt-5"));
        assert_eq!(view.entries[1].value, None);
        assert!(view.entries[1].secret);
        assert_eq!(view.entries[1].masked_value.as_deref(), Some("••••••••"));
        assert!(validate_agent_environment_name("CODEX_HOME").is_ok());
        assert!(validate_agent_environment_name("BAD-NAME").is_err());
    }

    #[test]
    fn opencode_native_paths_prefer_the_saved_agent_environment() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("agent-data");
        let config = temp.path().join("agent-config");
        let cache = temp.path().join("agent-cache");
        let environment = HashMap::from([
            ("XDG_DATA_HOME".to_string(), data.display().to_string()),
            ("XDG_CONFIG_HOME".to_string(), config.display().to_string()),
            ("XDG_CACHE_HOME".to_string(), cache.display().to_string()),
        ]);

        let paths = opencode_provider_paths(&environment).unwrap();

        assert_eq!(paths.auth_path, data.join("opencode/auth.json"));
        assert_eq!(paths.config_path, config.join("opencode/opencode.json"));
        assert_eq!(paths.cache_dir, cache.join("opencode"));
    }

    #[test]
    fn codex_auth_modes_follow_the_native_auth_file_and_provider_binding() {
        let agent_id = AgentId::parse("codex").unwrap();
        let subscription = project_codex_auth_mode(
            agent_id.clone(),
            &serde_json::json!({
                "auth_mode": "chatgpt",
                "OPENAI_API_KEY": null,
                "tokens": { "access_token": "token" }
            }),
            false,
        );
        assert_eq!(subscription.mode, "chatgpt_subscription");
        assert_eq!(
            subscription.modes,
            ["chatgpt_subscription", "api_key", "model_provider"]
        );
        assert_eq!(subscription.options.len(), subscription.modes.len());
        assert_eq!(
            subscription.options[0].description_key,
            "agents.authDescCodexSubscription"
        );
        assert_eq!(
            subscription.options[1].credential_env.as_deref(),
            Some("OPENAI_API_KEY")
        );
        assert_eq!(
            subscription.options[1].native_config_field_id.as_deref(),
            Some("openai_api_key")
        );
        assert!(subscription.options[1].credential_required);

        let api_key = project_codex_auth_mode(
            agent_id.clone(),
            &serde_json::json!({ "OPENAI_API_KEY": "sk-local" }),
            false,
        );
        assert_eq!(api_key.mode, "api_key");
        assert!(api_key.credential_present);

        let provider = project_codex_auth_mode(
            agent_id,
            &serde_json::json!({ "OPENAI_API_KEY": "sk-provider" }),
            true,
        );
        assert_eq!(provider.mode, "model_provider");
    }

    #[test]
    fn every_built_in_auth_mode_has_a_declared_ui_policy() {
        for agent in [
            "claude_code",
            "antigravity",
            "grok",
            "cursor",
            "deepseek_harness",
        ] {
            let agent_id = AgentId::parse(agent).unwrap();
            let policy = agents::built_in_auth_mode_policy(&agent_id).unwrap();
            let options = project_auth_mode_options(&agent_id, policy.modes);
            assert_eq!(options.len(), policy.modes.len());
            for option in options {
                assert!(!option.label_key.ends_with("Unknown"));
                assert!(!option.description_key.ends_with("Unknown"));
                assert_eq!(option.credential_required, option.credential_env.is_some());
            }
        }
    }

    #[test]
    fn codex_auth_mode_switches_are_mutually_exclusive() {
        let mut document = serde_json::json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": { "access_token": "keep" }
        });
        apply_codex_auth_document(&mut document, "api_key", Some("sk-local")).unwrap();
        assert_eq!(document["OPENAI_API_KEY"], "sk-local");
        assert!(document.get("auth_mode").is_none());
        assert_eq!(document["tokens"]["access_token"], "keep");

        apply_codex_auth_document(&mut document, "chatgpt_subscription", None).unwrap();
        assert_eq!(document["auth_mode"], "chatgpt");
        assert!(document["OPENAI_API_KEY"].is_null());
    }

    #[test]
    fn management_terminal_receives_saved_home_but_never_saved_secrets() {
        let environment = HashMap::from([
            ("CODEX_HOME".to_string(), "/tmp/codex home".to_string()),
            (
                "OPENAI_BASE_URL".to_string(),
                "https://example.test".to_string(),
            ),
            ("OPENAI_API_KEY".to_string(), "sk-secret".to_string()),
        ]);
        let command = management_command_with_environment("codex login", &environment);
        assert!(command.contains("CODEX_HOME"));
        assert!(command.contains("OPENAI_BASE_URL"));
        assert!(!command.contains("OPENAI_API_KEY"));
        assert!(!command.contains("sk-secret"));
    }

    #[test]
    fn diagnostic_redaction_truncates_unicode_on_a_character_boundary() {
        let input = format!("OPENAI_API_KEY=secret {}", "界".repeat(4_000));
        let redacted = redact_operation_output(&input);
        assert!(redacted.contains("OPENAI_API_KEY=[REDACTED]"));
        assert!(redacted.is_char_boundary(redacted.len()));
        assert!(redacted.len() <= 8 * 1024);
    }

    #[test]
    fn custom_version_is_concrete_and_rewrites_only_the_runtime_component() {
        assert_eq!(
            sanitize_custom_version(" v1.2.3-beta.1 ").as_deref(),
            Some("1.2.3-beta.1")
        );
        for invalid in ["latest", "2", "1.2/../../bad", "1.2 @next", ""] {
            assert!(sanitize_custom_version(invalid).is_none(), "{invalid}");
        }

        let mut plan = ResolvedInstallPlan {
            agent_id: AgentId::parse("claude_code").unwrap(),
            source: LockedInstallSource::BuiltInProfile,
            version: "2.1.222".to_string(),
            platform: "darwin-aarch64".to_string(),
            components: vec![
                PlannedInstallComponent {
                    component_id: "agent_runtime".to_string(),
                    distribution_kind: PlannedDistributionKind::Npx,
                    version: "2.1.222".to_string(),
                    resolved_source: "@anthropic-ai/claude-code@2.1.222".to_string(),
                    command: "claude".to_string(),
                    args: Vec::new(),
                    env: BTreeMap::new(),
                    trust: ArtifactTrust::EcosystemIntegrity {
                        integrity: "sha512-old".to_string(),
                    },
                },
                PlannedInstallComponent {
                    component_id: "acp_adapter".to_string(),
                    distribution_kind: PlannedDistributionKind::Npx,
                    version: "0.64.1".to_string(),
                    resolved_source: "@agentclientprotocol/claude-agent-acp@0.64.1".to_string(),
                    command: "claude-agent-acp".to_string(),
                    args: Vec::new(),
                    env: BTreeMap::new(),
                    trust: ArtifactTrust::EcosystemIntegrity {
                        integrity: "sha512-adapter".to_string(),
                    },
                },
            ],
        };

        apply_custom_version_override(&mut plan, "2.2.0").unwrap();

        assert_eq!(plan.version, "2.2.0");
        assert_eq!(
            plan.components[0].resolved_source,
            "@anthropic-ai/claude-code@2.2.0"
        );
        assert!(matches!(
            plan.components[0].trust,
            ArtifactTrust::EcosystemIntegrityRequired
        ));
        // ADR-0038 方向 A:acp_adapter 纳入版本覆盖,与 runtime 同规则。
        assert_eq!(plan.components[1].version, "2.2.0");
        assert_eq!(
            plan.components[1].resolved_source,
            "@agentclientprotocol/claude-agent-acp@2.2.0"
        );
        assert!(matches!(
            plan.components[1].trust,
            ArtifactTrust::EcosystemIntegrityRequired
        ));
    }

    #[test]
    fn custom_version_override_replaces_the_acp_adapter_component() {
        // ADR-0038 方向 A:指定版本覆盖作用于 agent_runtime / combined_runtime /
        // acp_adapter;只有 acp_adapter 的计划也能被替换。
        let mut plan = ResolvedInstallPlan {
            agent_id: AgentId::parse("claude_code").unwrap(),
            source: LockedInstallSource::BuiltInProfile,
            version: "0.64.1".to_string(),
            platform: "darwin-aarch64".to_string(),
            components: vec![PlannedInstallComponent {
                component_id: "acp_adapter".to_string(),
                distribution_kind: PlannedDistributionKind::Npx,
                version: "0.64.1".to_string(),
                resolved_source: "@agentclientprotocol/claude-agent-acp@0.64.1".to_string(),
                command: "claude-agent-acp".to_string(),
                args: Vec::new(),
                env: BTreeMap::new(),
                trust: ArtifactTrust::EcosystemIntegrity {
                    integrity: "sha512-adapter".to_string(),
                },
            }],
        };

        apply_custom_version_override(&mut plan, "2.0.0").unwrap();
        assert_eq!(plan.version, "2.0.0");
        assert_eq!(
            plan.components[0].resolved_source,
            "@agentclientprotocol/claude-agent-acp@2.0.0"
        );
        assert!(matches!(
            plan.components[0].trust,
            ArtifactTrust::EcosystemIntegrityRequired
        ));
    }

    #[test]
    fn external_adoption_records_the_profile_declared_distribution_kind() {
        // ADR-0038 修复:external 采纳按 Profile 的真实分发记录
        // distribution_kind,不再硬编码 binary——否则 npx 组件(codex-acp)
        // 会在 reconcile 时走错验证路径。
        let catalog = agents::BuiltInProfileCatalog::bundled();
        let codex = catalog.profile(&AgentId::parse("codex").unwrap()).unwrap();
        assert_eq!(
            profile_component_distribution_kind(codex, "agent_runtime"),
            PlannedDistributionKind::Npx
        );
        assert_eq!(
            profile_component_distribution_kind(codex, "acp_adapter"),
            PlannedDistributionKind::Npx
        );
        let opencode = catalog
            .profile(&AgentId::parse("opencode").unwrap())
            .unwrap();
        assert_eq!(
            profile_component_distribution_kind(opencode, "combined_runtime"),
            PlannedDistributionKind::Binary
        );
        // 未知组件回退 binary(现状兜底)。
        assert_eq!(
            profile_component_distribution_kind(codex, "unknown_kind"),
            PlannedDistributionKind::Binary
        );
    }

    #[test]
    fn codex_provider_preflight_requires_the_complete_native_projection() {
        let complete: toml::Table = toml::from_str(
            r#"
model_provider = "vibex"
[model_providers.vibex]
wire_api = "responses"
requires_openai_auth = true
"#,
        )
        .unwrap();
        assert!(codex_provider_config_is_projected(&complete));

        let partial: toml::Table = toml::from_str(
            r#"
model_provider = "vibex"
[model_providers.vibex]
wire_api = "responses"
"#,
        )
        .unwrap();
        assert!(!codex_provider_config_is_projected(&partial));
    }

    #[tokio::test]
    async fn failed_terminal_launch_restores_the_configuration_transition() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        tokio::fs::write(&path, b"old").await.unwrap();

        let error = apply_config_transition_then(
            vec![agents::NativeFileMutation {
                path: path.clone(),
                expected: Some(b"old".to_vec()),
                replacement: Some(b"new".to_vec()),
                sensitive: false,
            }],
            || Err(super::internal_error("terminal unavailable")),
        )
        .await
        .unwrap_err();

        assert!(error.message.contains("terminal unavailable"));
        assert_eq!(tokio::fs::read(path).await.unwrap(), b"old");
    }

    #[tokio::test]
    async fn kimi_synthetic_gate_is_not_reported_as_a_subscription_account() {
        let temp = tempfile::tempdir().unwrap();
        let credential = temp.path().join("credentials/kimi-code.json");
        seed_kimi_synthetic_credential(&credential).await.unwrap();
        let environment = HashMap::from([(
            "KIMI_CODE_HOME".to_string(),
            temp.path().display().to_string(),
        )]);

        assert!(
            !detect_account_login(
                temp.path(),
                &AgentId::parse("kimi_code").unwrap(),
                &environment,
            )
            .await
        );
    }

    #[tokio::test]
    async fn managed_preflight_rejects_a_tampered_component() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("managed-agent");
        tokio::fs::write(&path, b"tampered").await.unwrap();
        let expected = format!("{:x}", sha2::Sha256::digest(b"trusted"));

        assert!(!preflight_component_is_healthy(&path, Some(&expected)).await);
    }

    #[tokio::test]
    async fn managed_preflight_accepts_an_existing_file_when_sha256_was_not_recorded() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("npx-shim");
        tokio::fs::write(&path, b"#!/bin/sh\nexec node \"$0.js\" \"$@\"\n")
            .await
            .unwrap();

        assert!(preflight_component_is_healthy(&path, None).await);
        assert!(preflight_component_is_healthy(&path, Some("")).await);
    }

    #[test]
    fn relocate_rewrites_staging_paths_onto_the_release_directory() {
        let staging = PathBuf::from("/managed/claude_code/.staging-abc");
        let release = PathBuf::from("/managed/claude_code/abc");
        let nested = staging.join("1-acp_adapter/node_modules/.bin/claude-agent-acp");

        assert_eq!(
            relocate_managed_path(&nested, &staging, &release),
            release.join("1-acp_adapter/node_modules/.bin/claude-agent-acp")
        );
        assert_eq!(
            relocate_managed_path(Path::new("/usr/local/bin/node"), &staging, &release),
            PathBuf::from("/usr/local/bin/node")
        );
    }

    #[test]
    fn recovery_cleanup_skips_a_staging_dir_referenced_by_a_live_lock() {
        let root = Path::new("/managed/agents/grok");
        let live = root.join(".staging-abc/0-combined_runtime/dist-package/grok");
        let orphaned = root.join(".staging-def/0-combined_runtime/dist-package/grok");
        assert!(staging_dir_is_referenced_by(
            &root.join(".staging-abc"),
            live.clone()
        ));
        assert!(!staging_dir_is_referenced_by(
            &root.join(".staging-abc"),
            orphaned
        ));
        assert!(!staging_dir_is_referenced_by(
            &root.join(".staging-def"),
            live
        ));
    }

    #[tokio::test]
    async fn manual_preflight_retries_a_previously_attempted_built_in_probe() {
        let agent_id = AgentId::parse("codex").unwrap();
        let runtime = AgentManagementRuntimeState::default();

        assert!(runtime.should_probe_built_in(&agent_id, false).await);
        assert!(!runtime.should_probe_built_in(&agent_id, false).await);
        assert!(runtime.should_probe_built_in(&agent_id, true).await);
    }

    #[test]
    fn pi_install_lock_keeps_runtime_paths_but_never_unrelated_secrets() {
        let projected = pi_runtime_lock_env(&HashMap::from([
            (
                "PI_ACP_PI_COMMAND".to_string(),
                "/opt/pi-preview".to_string(),
            ),
            (
                "PI_CODING_AGENT_DIR".to_string(),
                "/tmp/pi-config".to_string(),
            ),
            ("OPENAI_API_KEY".to_string(), "must-not-persist".to_string()),
            ("PI_ACP_TRUST_WORKSPACE".to_string(), "0".to_string()),
        ]));

        assert_eq!(
            projected.get("PI_ACP_PI_COMMAND").map(String::as_str),
            Some("/opt/pi-preview")
        );
        assert_eq!(
            projected.get("PI_CODING_AGENT_DIR").map(String::as_str),
            Some("/tmp/pi-config")
        );
        assert!(!projected.contains_key("OPENAI_API_KEY"));
        assert!(!projected.contains_key("PI_ACP_TRUST_WORKSPACE"));
    }

    #[test]
    fn native_config_ipc_returns_the_sensitive_file_content_for_local_hover_reveal() {
        let agent_id = AgentId::parse("hermes").unwrap();
        let view = native_config_view(
            agent_id.clone(),
            agents::NativeConfigSnapshot {
                agent_id: agent_id.clone(),
                path: PathBuf::from("/home/example/.hermes/.env"),
                paths: vec![PathBuf::from("/home/example/.hermes/.env")],
                exists: true,
                fields: Vec::new(),
                files: vec![agents::NativeConfigFileSnapshot {
                    path: PathBuf::from("/home/example/.hermes/.env"),
                    format: agents::NativeConfigFormat::Dotenv,
                    content: "OPENAI_API_KEY=sk-local-secret".to_string(),
                    sensitive: true,
                    exists: true,
                    revision: "file-revision".to_string(),
                }],
                authentication: api_types::AgentAuthenticationStatus::ApiKey,
            },
        );

        assert_eq!(view.files[0].content, "OPENAI_API_KEY=sk-local-secret");
        assert!(view.files[0].sensitive);
    }

    #[test]
    fn binary_command_must_stay_inside_the_extracted_archive() {
        let root = Path::new("/managed/agent/component");

        assert!(safe_archive_executable(root, "bin/agent").is_ok());
        assert!(safe_archive_executable(root, "../outside").is_err());
        assert!(safe_archive_executable(root, "/absolute/agent").is_err());
    }

    fn zip_with_symlink(link_target: &str) -> Vec<u8> {
        use std::io::Write;

        use zip::{ZipWriter, write::SimpleFileOptions};

        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file(
                "runtime/Python.framework/Versions/3.14/Python",
                SimpleFileOptions::default().unix_permissions(0o755),
            )
            .unwrap();
        archive.write_all(b"python runtime").unwrap();
        archive
            .add_symlink(
                "runtime/Python.framework/Versions/Current",
                link_target,
                SimpleFileOptions::default(),
            )
            .unwrap();
        archive.finish().unwrap().into_inner()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn zip_install_preserves_framework_symlinks() {
        use std::os::unix::fs::PermissionsExt;

        let destination = tempfile::tempdir().unwrap();

        extract_binary_archive(
            &zip_with_symlink("3.14"),
            "https://example.test/runtime.zip",
            destination.path(),
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
        .unwrap();

        let link = destination
            .path()
            .join("runtime/Python.framework/Versions/Current");
        assert!(
            std::fs::symlink_metadata(&link)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(std::fs::read_link(link).unwrap(), Path::new("3.14"));
        let runtime = destination
            .path()
            .join("runtime/Python.framework/Versions/3.14/Python");
        assert_ne!(
            std::fs::metadata(runtime).unwrap().permissions().mode() & 0o111,
            0
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn zip_install_rejects_framework_symlinks_that_escape_the_destination() {
        let destination = tempfile::tempdir().unwrap();
        let result = extract_binary_archive(
            &zip_with_symlink("../../../../../outside"),
            "https://example.test/runtime.zip",
            destination.path(),
            &tokio_util::sync::CancellationToken::new(),
        )
        .await;

        assert!(result.is_err());
        assert!(
            !destination
                .path()
                .parent()
                .unwrap()
                .join("outside")
                .exists()
        );
    }

    #[test]
    fn agent_management_commands_serialize_snapshots_and_errors() {
        let agent_id = AgentId::parse("vendor.agent-v2").unwrap();
        let error = management_error(
            AgentManagementErrorCode::Busy,
            "此Agent还有正在执行的进程，暂时无法卸载/移除",
            Some(agent_id.clone()),
        );
        assert_eq!(
            error,
            AgentManagementErrorView {
                code: AgentManagementErrorCode::Busy,
                message: "此Agent还有正在执行的进程，暂时无法卸载/移除".to_string(),
                agent_id: Some(agent_id.clone()),
                preflight_item_id: None,
            }
        );
        assert_eq!(serde_json::to_value(&error).unwrap()["code"], "busy");

        let event = operation_event(
            42,
            agent_id,
            "operation-1",
            AgentOperationKind::Repair,
            AgentOperationStatus::Running,
            Some(25),
            Some("checking ACP handshake".to_string()),
        );
        assert_eq!(event.sequence, 42);
        assert_eq!(event.progress_percent, Some(25));
        assert_eq!(
            serde_json::from_value::<AgentOperationEvent>(serde_json::to_value(event).unwrap())
                .unwrap()
                .status,
            AgentOperationStatus::Running
        );
    }

    #[test]
    fn preflight_component_evidence_is_structured() {
        let item = AgentPreflightItemView {
            id: "acp".to_string(),
            label: "ACP 适配器".to_string(),
            status: "pass".to_string(),
            detail: String::new(),
            version: Some("1.2.3".to_string()),
            path: Some("/opt/vibex/bin/agent-acp".to_string()),
            source: None,
            repairable: true,
        };
        let value = serde_json::to_value(item).unwrap();

        assert_eq!(value["version"], "1.2.3");
        assert_eq!(value["path"], "/opt/vibex/bin/agent-acp");
        assert_eq!(value["detail"], "");
    }

    #[test]
    fn opencode_provider_connection_updates_auth_and_config_documents() {
        let mut auth = serde_json::json!({
            "my-openai": {"refresh": "preserve"}
        });
        let mut config = serde_json::json!({
            "model": "openai/gpt-5",
            "provider": {
                "my-openai": {
                    "unknown": true,
                    "options": {"timeout": 30},
                    "models": {"gpt-5": {"name": "Custom GPT", "contextWindow": 9000}}
                }
            }
        });
        apply_opencode_provider_connection(
            &mut auth,
            &mut config,
            &OpenCodeProviderConnectRequest {
                provider_id: "my-openai".to_string(),
                name: "My OpenAI".to_string(),
                npm: Some("@ai-sdk/openai-compatible".to_string()),
                api: Some("openai.responses".to_string()),
                base_url: Some("https://example.test/v1".to_string()),
                api_key: Some("secret".to_string()),
                models: vec![
                    OpenCodeProviderModelRequest {
                        id: "gpt-5".to_string(),
                        name: "Renamed GPT".to_string(),
                        previous_id: None,
                    },
                    OpenCodeProviderModelRequest {
                        id: "gpt-5-mini".to_string(),
                        name: "GPT 5 Mini".to_string(),
                        previous_id: None,
                    },
                ],
                enabled: true,
            },
        )
        .unwrap();

        assert_eq!(auth["my-openai"]["type"], "api");
        assert_eq!(auth["my-openai"]["key"], "secret");
        assert_eq!(auth["my-openai"]["refresh"], "preserve");
        assert_eq!(
            config["provider"]["my-openai"]["options"]["baseURL"],
            "https://example.test/v1"
        );
        assert_eq!(config["model"], "openai/gpt-5");
        assert_eq!(config["provider"]["my-openai"]["api"], "openai.responses");
        assert!(config["provider"]["my-openai"]["models"]["gpt-5"].is_object());
        assert_eq!(config["provider"]["my-openai"]["unknown"], true);
        assert_eq!(config["provider"]["my-openai"]["options"]["timeout"], 30);
        assert_eq!(
            config["provider"]["my-openai"]["models"]["gpt-5"]["contextWindow"],
            9000
        );
        assert_eq!(
            config["provider"]["my-openai"]["models"]["gpt-5"]["name"],
            "Renamed GPT"
        );
    }

    #[test]
    fn opencode_builtin_connection_does_not_delete_existing_provider_options() {
        let mut auth = serde_json::json!({});
        let mut config = serde_json::json!({
            "provider": {"openai": {"options": {"timeout": 30}, "unknown": true}}
        });

        apply_opencode_provider_connection(
            &mut auth,
            &mut config,
            &OpenCodeProviderConnectRequest {
                provider_id: "openai".to_string(),
                name: "OpenAI".to_string(),
                npm: None,
                api: None,
                base_url: None,
                api_key: Some("secret".to_string()),
                models: Vec::new(),
                enabled: true,
            },
        )
        .unwrap();

        assert_eq!(config["provider"]["openai"]["options"]["timeout"], 30);
        assert_eq!(config["provider"]["openai"]["unknown"], true);
    }

    #[test]
    fn opencode_provider_edit_preserves_credential_and_renamed_model_extensions() {
        let mut auth = serde_json::json!({
            "my-openai": {"type": "api", "key": "keep-secret", "refresh": "keep"}
        });
        let mut config = serde_json::json!({
            "provider": {
                "my-openai": {
                    "models": {
                        "old-id": {"name": "Old name", "contextWindow": 42}
                    }
                }
            }
        });

        apply_opencode_provider_connection(
            &mut auth,
            &mut config,
            &OpenCodeProviderConnectRequest {
                provider_id: "my-openai".to_string(),
                name: "My OpenAI".to_string(),
                npm: Some("@ai-sdk/openai-compatible".to_string()),
                api: None,
                base_url: None,
                api_key: None,
                models: vec![OpenCodeProviderModelRequest {
                    id: "new-id".to_string(),
                    name: "New name".to_string(),
                    previous_id: Some("old-id".to_string()),
                }],
                enabled: true,
            },
        )
        .unwrap();

        assert_eq!(auth["my-openai"]["key"], "keep-secret");
        assert_eq!(auth["my-openai"]["refresh"], "keep");
        assert!(config["provider"]["my-openai"]["models"]["old-id"].is_null());
        assert_eq!(
            config["provider"]["my-openai"]["models"]["new-id"]["contextWindow"],
            42
        );
        assert_eq!(
            config["provider"]["my-openai"]["models"]["new-id"]["name"],
            "New name"
        );
    }

    #[test]
    fn opencode_new_provider_requires_a_credential() {
        let mut auth = serde_json::json!({});
        let mut config = serde_json::json!({});
        let error = apply_opencode_provider_connection(
            &mut auth,
            &mut config,
            &OpenCodeProviderConnectRequest {
                provider_id: "new-provider".to_string(),
                name: "New Provider".to_string(),
                npm: None,
                api: None,
                base_url: None,
                api_key: None,
                models: Vec::new(),
                enabled: true,
            },
        )
        .unwrap_err();

        assert!(error.contains("API Key"));
    }

    #[test]
    fn opencode_provider_enable_state_updates_both_supported_lists() {
        let auth = serde_json::json!({
            "openrouter": {"type": "api", "key": "secret"}
        });
        let mut config = serde_json::json!({
            "enabled_providers": ["anthropic", "openrouter"],
            "provider": {"openrouter": {"name": "OpenRouter"}}
        });

        set_opencode_provider_enabled(&mut config, "openrouter", false).unwrap();
        assert_eq!(
            config["enabled_providers"],
            serde_json::json!(["anthropic"])
        );
        assert_eq!(
            config["disabled_providers"],
            serde_json::json!(["openrouter"])
        );
        assert!(!project_opencode_provider_connections(&auth, &config).providers[0].enabled);

        set_opencode_provider_enabled(&mut config, "openrouter", true).unwrap();
        assert_eq!(
            config["enabled_providers"],
            serde_json::json!(["anthropic", "openrouter"])
        );
        assert!(config.get("disabled_providers").is_none());
        assert!(project_opencode_provider_connections(&auth, &config).providers[0].enabled);
    }

    #[test]
    fn disconnect_cleanup_removes_provider_from_enable_state() {
        let mut config = serde_json::json!({
            "enabled_providers": ["openrouter", "anthropic"],
            "disabled_providers": ["openrouter", "google"]
        });

        remove_opencode_provider_state(&mut config, "openrouter");

        assert_eq!(
            config["enabled_providers"],
            serde_json::json!(["anthropic"])
        );
        assert_eq!(config["disabled_providers"], serde_json::json!(["google"]));
    }

    #[test]
    fn cancel_targets_the_exact_registered_operation() {
        let registry = OperationCancellationRegistry::default();
        let first = registry.register("operation-1");
        let second = registry.register("operation-2");

        assert!(registry.cancel("operation-1"));
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert!(!registry.cancel("missing"));

        registry.remove("operation-1");
        assert!(!registry.cancel("operation-1"));
    }

    #[test]
    fn managed_install_root_is_scoped_below_the_agents_directory() {
        let root = managed_install_root(
            Path::new("/app-data"),
            &AgentId::parse("vendor.agent-v2").unwrap(),
        )
        .unwrap();
        assert_eq!(root, Path::new("/app-data/agents/vendor.agent-v2"));
    }

    #[test]
    fn adapter_launch_env_binds_the_separate_local_runtime() {
        for (agent, expected_key) in [
            ("claude_code", "CLAUDE_CODE_EXECUTABLE"),
            ("codex", "CODEX_PATH"),
        ] {
            let mut env = BTreeMap::new();
            bind_profile_runtime_executable(
                &AgentId::parse(agent).unwrap(),
                Path::new("/managed/runtime"),
                &mut env,
            );
            assert_eq!(
                env.get(expected_key).map(String::as_str),
                Some("/managed/runtime")
            );
        }

        let mut generic_env = BTreeMap::new();
        bind_profile_runtime_executable(
            &AgentId::parse("registry.generic").unwrap(),
            Path::new("/managed/runtime"),
            &mut generic_env,
        );
        assert!(generic_env.is_empty());
    }

    #[test]
    fn provider_api_keys_are_not_misreported_as_account_logins() {
        let catalog = agents::BuiltInProfileCatalog::bundled();
        let opencode = catalog
            .profile(&AgentId::parse("opencode").unwrap())
            .unwrap()
            .account_evidence
            .as_ref()
            .unwrap();
        let pi = catalog
            .profile(&AgentId::parse("pi").unwrap())
            .unwrap()
            .account_evidence
            .as_ref()
            .unwrap();

        assert!(!opencode.matches(&serde_json::json!({
            "anthropic": {"type": "api", "key": "local"}
        })));
        assert!(!pi.matches(&serde_json::json!({
            "anthropic": {"type": "api_key", "key": "local"}
        })));
        assert!(pi.matches(&serde_json::json!({
            "anthropic": {"type": "oauth", "access": "token"}
        })));
    }

    #[test]
    fn preflight_dependency_versions_enforce_profile_ranges() {
        assert_eq!(
            dependency_version_satisfied(">=22.19", "v22.20.1"),
            Some(true)
        );
        assert_eq!(
            dependency_version_satisfied(">=22.19", "node v20.18.0"),
            Some(false)
        );
        assert_eq!(
            dependency_version_satisfied(">=3.11,<3.14", "Python 3.13.7"),
            Some(true)
        );
        assert_eq!(
            dependency_version_satisfied(">=3.11,<3.14", "Python 3.14.0"),
            Some(false)
        );
    }

    #[tokio::test]
    async fn kimi_api_key_mode_routes_the_model_and_seeds_only_vibex_credentials() {
        let temp = tempfile::tempdir().unwrap();
        let kimi_home = temp.path().join(".kimi-code");
        tokio::fs::create_dir_all(&kimi_home).await.unwrap();
        tokio::fs::write(
            kimi_home.join("config.toml"),
            r#"[providers.vibex]
type = "openai"
api_key = "local-key"

[models.vibex]
model = "demo-model"
"#,
        )
        .await
        .unwrap();

        reconcile_kimi_vibex_configuration(
            temp.path(),
            &HashMap::new(),
            &BTreeMap::from([("kimi_api_key".to_string(), Some("local-key".to_string()))]),
        )
        .await
        .unwrap();

        let config: toml::Value = toml::from_str(
            &tokio::fs::read_to_string(kimi_home.join("config.toml"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(config["default_model"].as_str(), Some("vibex"));
        assert_eq!(
            config["models"]["vibex"]["provider"].as_str(),
            Some("vibex")
        );
        assert_eq!(
            config["models"]["vibex"]["max_context_size"].as_integer(),
            Some(262_144)
        );
        let credential: serde_json::Value = serde_json::from_slice(
            &tokio::fs::read(kimi_home.join("credentials/kimi-code.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(credential["_vibex_synthetic"], true);

        let real_path = kimi_home.join("credentials/real.json");
        tokio::fs::write(&real_path, br#"{"access_token":"real-oauth"}"#)
            .await
            .unwrap();
        seed_kimi_synthetic_credential(&real_path).await.unwrap();
        let preserved: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(real_path).await.unwrap()).unwrap();
        assert_eq!(preserved["access_token"], "real-oauth");
        assert!(preserved.get("_vibex_synthetic").is_none());
    }

    #[tokio::test]
    async fn kimi_env_auth_and_grok_custom_model_are_reconciled() {
        let temp = tempfile::tempdir().unwrap();
        let kimi_home = temp.path().join(".kimi-code");
        tokio::fs::create_dir_all(&kimi_home).await.unwrap();
        tokio::fs::write(
            kimi_home.join("config.toml"),
            r#"[providers.vibex]
type = "openai_responses"

[providers.vibex.env]
OPENAI_API_KEY = "local-key"

[models.vibex]
model = "demo-model"
"#,
        )
        .await
        .unwrap();
        reconcile_kimi_vibex_configuration(
            temp.path(),
            &HashMap::new(),
            &BTreeMap::from([("kimi_provider_env".to_string(), Some("{}".to_string()))]),
        )
        .await
        .unwrap();
        assert!(kimi_home.join("credentials/kimi-code.json").is_file());

        let grok_home = temp.path().join(".grok");
        tokio::fs::create_dir_all(&grok_home).await.unwrap();
        tokio::fs::write(
            grok_home.join("config.toml"),
            r#"[model.vibex]
model = "custom-model"
base_url = "https://example.test/v1"
"#,
        )
        .await
        .unwrap();
        reconcile_grok_vibex_configuration(
            temp.path(),
            &HashMap::new(),
            &BTreeMap::from([(
                "grok_custom_model_id".to_string(),
                Some("custom-model".to_string()),
            )]),
        )
        .await
        .unwrap();
        let grok: toml::Value = toml::from_str(
            &tokio::fs::read_to_string(grok_home.join("config.toml"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(grok["models"]["default"].as_str(), Some("vibex"));
    }

    #[test]
    fn grok_auto_compact_threshold_is_range_checked() {
        let request = |value: &str| AgentNativeConfigPatchRequest {
            agent_id: AgentId::parse("grok").unwrap(),
            base_field_revisions: BTreeMap::new(),
            fields: BTreeMap::from([(
                "grok_auto_compact_threshold".to_string(),
                Some(value.to_string()),
            )]),
        };

        assert!(validate_native_config_patch(&request("80")).is_ok());
        assert!(validate_native_config_patch(&request("101")).is_err());
        assert!(validate_native_config_patch(&request("invalid")).is_err());
    }

    #[tokio::test]
    async fn native_launch_preferences_preserve_unrelated_agent_environment() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_setting (
                agent_type TEXT PRIMARY KEY,
                env_json TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO agent_setting (agent_type, env_json) VALUES ('cursor', ?)")
            .bind(r#"{"UNRELATED":"keep"}"#)
            .execute(&pool)
            .await
            .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let cursor_home = temp.path().join(".cursor");
        tokio::fs::create_dir_all(&cursor_home).await.unwrap();
        tokio::fs::write(
            cursor_home.join("cli-config.json"),
            br#"{"vibex":{"model":"composer-1","force":true}}"#,
        )
        .await
        .unwrap();

        sync_native_launch_preferences(&pool, &AgentId::parse("cursor").unwrap(), temp.path())
            .await
            .unwrap();

        let env_json: String =
            sqlx::query_scalar("SELECT env_json FROM agent_setting WHERE agent_type = 'cursor'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let env: serde_json::Value = serde_json::from_str(&env_json).unwrap();
        assert_eq!(env["UNRELATED"], "keep");
        assert_eq!(env["CURSOR_MODEL"], "composer-1");
        assert_eq!(env["CURSOR_FORCE"], "1");
    }

    #[tokio::test]
    async fn codebuddy_native_configuration_reaches_the_acp_launch_environment() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_setting (
                agent_type TEXT PRIMARY KEY,
                env_json TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO agent_setting (agent_type, env_json) VALUES ('codebuddy', ?)")
            .bind(r#"{"UNRELATED":"keep","CODEBUDDY_INTERNET_ENVIRONMENT":"internal"}"#)
            .execute(&pool)
            .await
            .unwrap();
        let temp = tempfile::tempdir().unwrap();
        let codebuddy_home = temp.path().join(".codebuddy");
        tokio::fs::create_dir_all(&codebuddy_home).await.unwrap();
        tokio::fs::write(
            codebuddy_home.join(".env"),
            "CODEBUDDY_API_KEY=secret\nCODEBUDDY_BASE_URL=https://private.example\n",
        )
        .await
        .unwrap();

        sync_native_launch_preferences(&pool, &AgentId::parse("codebuddy").unwrap(), temp.path())
            .await
            .unwrap();

        let env_json: String =
            sqlx::query_scalar("SELECT env_json FROM agent_setting WHERE agent_type = 'codebuddy'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let env: serde_json::Value = serde_json::from_str(&env_json).unwrap();
        assert_eq!(env["UNRELATED"], "keep");
        assert_eq!(env["CODEBUDDY_API_KEY"], "secret");
        assert_eq!(env["CODEBUDDY_BASE_URL"], "https://private.example");
        assert!(env.get("CODEBUDDY_INTERNET_ENVIRONMENT").is_none());
    }

    #[tokio::test]
    async fn registry_npx_resolves_grok_builds_package_binary() {
        let temp = tempfile::tempdir().unwrap();
        let component_root = temp.path();
        let package_root = component_root
            .join("node_modules")
            .join("@xai-official")
            .join("grok");
        let bin_dir = component_root.join("node_modules").join(".bin");
        tokio::fs::create_dir_all(&package_root).await.unwrap();
        tokio::fs::create_dir_all(&bin_dir).await.unwrap();
        tokio::fs::write(
            package_root.join("package.json"),
            r#"{"name":"@xai-official/grok","bin":{"grok":"bin/grok"}}"#,
        )
        .await
        .unwrap();
        let grok_executable = npm_executable(&bin_dir, "grok");
        tokio::fs::write(&grok_executable, b"#!/bin/sh\n")
            .await
            .unwrap();

        let executable =
            resolve_npm_package_executable(component_root, &bin_dir, "@xai-official/grok@0.2.115")
                .await
                .unwrap();

        assert_eq!(executable, grok_executable);
    }

    #[tokio::test]
    async fn registry_npx_resolves_same_target_aliases_deterministically() {
        let temp = tempfile::tempdir().unwrap();
        let component_root = temp.path();
        let package_root = component_root
            .join("node_modules")
            .join("@tencent-ai")
            .join("codebuddy-code");
        let bin_dir = component_root.join("node_modules").join(".bin");
        tokio::fs::create_dir_all(&package_root).await.unwrap();
        tokio::fs::create_dir_all(&bin_dir).await.unwrap();
        tokio::fs::write(
            package_root.join("package.json"),
            r#"{"name":"@tencent-ai/codebuddy-code","bin":{"cbc":"bin/codebuddy","codebuddy":"bin/codebuddy"}}"#,
        )
        .await
        .unwrap();
        let cbc_executable = npm_executable(&bin_dir, "cbc");
        tokio::fs::write(&cbc_executable, b"#!/bin/sh\n")
            .await
            .unwrap();
        tokio::fs::write(npm_executable(&bin_dir, "codebuddy"), b"#!/bin/sh\n")
            .await
            .unwrap();

        let executable = resolve_npm_package_executable(
            component_root,
            &bin_dir,
            "@tencent-ai/codebuddy-code@2.106.7",
        )
        .await
        .unwrap();

        assert_eq!(executable, cbc_executable);
    }

    #[tokio::test]
    async fn registry_uv_tool_prefers_package_named_executable() {
        let temp = tempfile::tempdir().unwrap();
        let bin_dir = temp.path();
        tokio::fs::write(bin_dir.join("minion-helper"), b"#!/bin/sh\n")
            .await
            .unwrap();
        tokio::fs::write(bin_dir.join("minion-code"), b"#!/bin/sh\n")
            .await
            .unwrap();

        let executable = resolve_uv_tool_executable(bin_dir, "minion-code@0.1.44", "minion-code")
            .await
            .unwrap();

        assert_eq!(executable, bin_dir.join("minion-code"));
    }

    #[tokio::test]
    async fn uv_tool_uses_the_profile_declared_acp_entry() {
        let temp = tempfile::tempdir().unwrap();
        let bin_dir = temp.path();
        tokio::fs::write(bin_dir.join("hermes"), b"#!/bin/sh\n")
            .await
            .unwrap();
        tokio::fs::write(bin_dir.join("hermes-acp"), b"#!/bin/sh\n")
            .await
            .unwrap();

        let executable =
            resolve_uv_tool_executable(bin_dir, "hermes-agent[acp,mcp]==0.19.0", "hermes-acp")
                .await
                .unwrap();

        assert_eq!(executable, bin_dir.join("hermes-acp"));
    }

    #[test]
    fn uv_tool_install_keeps_python_and_cache_inside_the_user_environment() {
        let user_env = agents::UserEnvironmentLayout::for_home(Path::new("/tmp/home"));
        let mut command = tokio::process::Command::new("uv");

        configure_uv_tool_install_command(&mut command, &user_env, "kimi-cli==1.2.3");

        let command = command.as_std();
        let env = command
            .get_envs()
            .filter_map(|(key, value)| value.map(|value| (key, value)))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            env.get(std::ffi::OsStr::new("UV_PYTHON_INSTALL_DIR")),
            Some(&user_env.uv_python_dir.as_os_str())
        );
        assert_eq!(
            env.get(std::ffi::OsStr::new("UV_CACHE_DIR")),
            Some(&user_env.uv_cache_dir.as_os_str())
        );
        assert_eq!(
            env.get(std::ffi::OsStr::new("UV_TOOL_BIN_DIR")),
            Some(&user_env.uv_tool_bin.as_os_str())
        );
    }

    #[test]
    fn hermes_uv_install_pins_the_upstream_python_runtime() {
        let user_env = agents::UserEnvironmentLayout::for_home(Path::new("/tmp/home"));
        let mut command = tokio::process::Command::new("uv");

        configure_uv_tool_install_command(&mut command, &user_env, "hermes-agent[acp,mcp]==0.19.0");

        let args = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args.windows(2).any(|pair| pair == ["--python", "3.13"]));
    }

    #[test]
    fn managed_uv_catalog_covers_every_supported_desktop_target_with_fixed_checksums() {
        let artifacts = [
            ("darwin-aarch64", "aarch64-apple-darwin", "tar.gz"),
            ("darwin-x86_64", "x86_64-apple-darwin", "tar.gz"),
            ("linux-aarch64", "aarch64-unknown-linux-gnu", "tar.gz"),
            ("linux-x86_64", "x86_64-unknown-linux-gnu", "tar.gz"),
            ("windows-aarch64", "aarch64-pc-windows-msvc", "zip"),
            ("windows-x86_64", "x86_64-pc-windows-msvc", "zip"),
        ];

        for (platform, target, extension) in artifacts {
            let artifact = managed_uv_artifact(platform).unwrap();
            assert_eq!(artifact.target, target);
            assert_eq!(artifact.extension, extension);
            assert_eq!(artifact.sha256.len(), 64);
            assert!(
                artifact
                    .sha256
                    .chars()
                    .all(|character| character.is_ascii_hexdigit())
            );
        }
        assert!(managed_uv_artifact("freebsd-x86_64").is_none());
    }

    #[test]
    fn managed_uv_path_is_versioned_and_platform_scoped() {
        let root = Path::new("/application-data");
        let executable = managed_uv_executable(root).unwrap();
        let platform = agents::current_platform();

        assert!(executable.starts_with(root.join("agent-tools").join("uv")));
        assert!(
            executable
                .components()
                .any(|part| part.as_os_str() == MANAGED_UV_VERSION)
        );
        assert!(
            executable
                .components()
                .any(|part| part.as_os_str() == std::ffi::OsStr::new(&platform))
        );
        assert_eq!(
            executable.file_name().and_then(|name| name.to_str()),
            Some(if cfg!(windows) { "uv.exe" } else { "uv" })
        );
    }

    #[test]
    fn managed_uv_health_accepts_only_the_locked_version() {
        assert!(managed_uv_version_matches(
            "uv 0.8.10 (Homebrew 2025-08-08)"
        ));
        assert!(managed_uv_version_matches("uv 0.8.10"));
        assert!(!managed_uv_version_matches("uv 0.8.9"));
        assert!(!managed_uv_version_matches("0.8.10"));
        assert!(!managed_uv_version_matches("malformed output"));
    }

    #[test]
    fn managed_node_catalog_covers_every_supported_desktop_target_with_fixed_checksums() {
        let artifacts = [
            ("darwin-aarch64", "darwin-arm64", "tar.gz"),
            ("darwin-x86_64", "darwin-x64", "tar.gz"),
            ("linux-aarch64", "linux-arm64", "tar.gz"),
            ("linux-x86_64", "linux-x64", "tar.gz"),
            ("windows-aarch64", "win-arm64", "zip"),
            ("windows-x86_64", "win-x64", "zip"),
        ];

        for (platform, target, extension) in artifacts {
            let artifact = managed_node_artifact(platform).unwrap();
            assert_eq!(artifact.target, target);
            assert_eq!(artifact.extension, extension);
            assert_eq!(artifact.sha256.len(), 64);
            assert!(
                artifact
                    .sha256
                    .chars()
                    .all(|character| character.is_ascii_hexdigit())
            );
        }
        assert!(managed_node_artifact("freebsd-x86_64").is_none());
    }

    #[test]
    fn managed_node_paths_are_versioned_platform_scoped_and_include_npm() {
        let root = Path::new("/application-data");
        let runtime = managed_node_executables(root).unwrap();
        let platform = agents::current_platform();

        assert!(
            runtime
                .node
                .starts_with(root.join("agent-tools").join("node"))
        );
        assert!(
            runtime.node.components().any(|part| {
                part.as_os_str() == std::ffi::OsStr::new(super::MANAGED_NODE_VERSION)
            })
        );
        assert!(
            runtime
                .node
                .components()
                .any(|part| { part.as_os_str() == std::ffi::OsStr::new(&platform) })
        );
        assert_eq!(
            runtime.node.file_name().and_then(|name| name.to_str()),
            Some(if cfg!(windows) { "node.exe" } else { "node" })
        );
        assert_eq!(
            runtime.npm.file_name().and_then(|name| name.to_str()),
            Some(if cfg!(windows) { "npm.cmd" } else { "npm" })
        );
        assert_eq!(runtime.node.parent(), Some(runtime.bin_dir.as_path()));
        assert_eq!(runtime.npm.parent(), Some(runtime.bin_dir.as_path()));
    }

    #[tokio::test]
    async fn compatible_system_node_is_selected_with_its_absolute_npm_path() {
        let temp = tempfile::tempdir().unwrap();
        let runtime_dir = temp.path().join("runtime with spaces");
        std::fs::create_dir_all(&runtime_dir).unwrap();

        #[cfg(windows)]
        let (node, npm) = {
            let node = runtime_dir.join("node.cmd");
            let npm = runtime_dir.join("npm.cmd");
            std::fs::write(&node, "@echo off\r\n<nul set /p =v24.19.0\r\n").unwrap();
            std::fs::write(&npm, "@echo off\r\n<nul set /p =11.17.0\r\n").unwrap();
            (node, npm)
        };

        #[cfg(unix)]
        let (node, npm) = {
            use std::os::unix::fs::PermissionsExt;

            let node = runtime_dir.join("node");
            let npm = runtime_dir.join("npm");
            std::fs::write(&node, "#!/bin/sh\nprintf 'v24.19.0'\n").unwrap();
            std::fs::write(&npm, "#!/bin/sh\nprintf '11.17.0'\n").unwrap();
            for executable in [&node, &npm] {
                let mut permissions = std::fs::metadata(executable).unwrap().permissions();
                permissions.set_mode(0o755);
                std::fs::set_permissions(executable, permissions).unwrap();
            }
            (node, npm)
        };

        let runtime = probe_system_node_runtime(node.clone(), npm.clone(), ">=22.22.3")
            .await
            .expect("compatible system Node.js should be reusable");

        assert_eq!(runtime.source, RuntimeSource::System);
        assert_eq!(runtime.version, "24.19.0");
        assert_eq!(runtime.npm_version.as_deref(), Some("11.17.0"));
        assert_eq!(runtime.node, node);
        assert_eq!(runtime.npm, npm);
        assert_eq!(runtime.bin_dir, runtime_dir);
    }

    #[tokio::test]
    async fn incompatible_system_node_is_rejected_before_installation() {
        let temp = tempfile::tempdir().unwrap();

        #[cfg(windows)]
        let (node, npm) = {
            let node = temp.path().join("node.cmd");
            let npm = temp.path().join("npm.cmd");
            std::fs::write(&node, "@echo off\r\n<nul set /p =v20.18.0\r\n").unwrap();
            std::fs::write(&npm, "@echo off\r\n<nul set /p =10.8.2\r\n").unwrap();
            (node, npm)
        };

        #[cfg(unix)]
        let (node, npm) = {
            use std::os::unix::fs::PermissionsExt;

            let node = temp.path().join("node");
            let npm = temp.path().join("npm");
            std::fs::write(&node, "#!/bin/sh\nprintf 'v20.18.0'\n").unwrap();
            std::fs::write(&npm, "#!/bin/sh\nprintf '10.8.2'\n").unwrap();
            for executable in [&node, &npm] {
                let mut permissions = std::fs::metadata(executable).unwrap().permissions();
                permissions.set_mode(0o755);
                std::fs::set_permissions(executable, permissions).unwrap();
            }
            (node, npm)
        };

        let error = probe_system_node_runtime(node, npm, ">=22.22.3")
            .await
            .expect_err("an incompatible system Node.js must use the managed fallback");

        assert!(error.to_string().contains("does not satisfy >=22.22.3"));
    }

    #[tokio::test]
    async fn managed_node_health_rejects_a_broken_npm_executable() {
        let temp = tempfile::tempdir().unwrap();

        #[cfg(windows)]
        let (node, npm) = {
            let node = temp.path().join("node.cmd");
            let npm = temp.path().join("npm.cmd");
            std::fs::write(&node, "@echo off\r\n<nul set /p =v22.22.3\r\n").unwrap();
            std::fs::write(&npm, "@echo off\r\nexit /b 1\r\n").unwrap();
            (node, npm)
        };

        #[cfg(unix)]
        let (node, npm) = {
            use std::os::unix::fs::PermissionsExt;

            let node = temp.path().join("node");
            let npm = temp.path().join("npm");
            std::fs::write(&node, "#!/bin/sh\nprintf 'v22.22.3'\n").unwrap();
            std::fs::write(&npm, "#!/bin/sh\nexit 1\n").unwrap();
            for executable in [&node, &npm] {
                let mut permissions = std::fs::metadata(executable).unwrap().permissions();
                permissions.set_mode(0o755);
                std::fs::set_permissions(executable, permissions).unwrap();
            }
            (node, npm)
        };

        let runtime = super::NodeRuntime {
            bin_dir: temp.path().to_path_buf(),
            node,
            npm,
            version: super::MANAGED_NODE_VERSION.to_string(),
            npm_version: None,
            source: RuntimeSource::Managed,
        };

        assert!(verify_managed_node_runtime(runtime).await.is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn managed_uv_component_is_dequarantined_before_its_runtime_is_launched() {
        let temp = tempfile::tempdir().unwrap();
        let framework = temp.path().join("python/Python.framework");
        std::fs::create_dir_all(&framework).unwrap();
        let runtime = framework.join("Python");
        std::fs::write(&runtime, b"runtime").unwrap();
        xattr::set(temp.path(), "com.apple.quarantine", b"0081;0;VibeX;").unwrap();
        xattr::set(&runtime, "com.apple.quarantine", b"0081;0;VibeX;").unwrap();

        clear_macos_quarantine(temp.path()).unwrap();

        assert!(
            xattr::get(temp.path(), "com.apple.quarantine")
                .unwrap()
                .is_none()
        );
        assert!(
            xattr::get(&runtime, "com.apple.quarantine")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn managed_artifacts_use_an_executable_user_directory_on_macos() {
        let home = Path::new("/Users/developer");
        let app_data = home.join("Library/Application Support/com.vibex.app");
        let root = managed_artifacts_directory(home, &app_data);

        #[cfg(target_os = "macos")]
        assert_eq!(root, home.join(".local/share/vibex"));
        #[cfg(not(target_os = "macos"))]
        assert_eq!(root, app_data);
    }

    #[test]
    fn registry_environment_reaches_the_locked_launch_environment() {
        let component = agents::PlannedInstallComponent {
            component_id: "combined_runtime".to_string(),
            distribution_kind: agents::PlannedDistributionKind::Npx,
            version: "0.33.0".to_string(),
            resolved_source: "@augmentcode/auggie@0.33.0".to_string(),
            command: "auggie".to_string(),
            args: vec!["--acp".to_string()],
            env: BTreeMap::from([("AUGMENT_DISABLE_AUTO_UPDATE".to_string(), "1".to_string())]),
            trust: agents::ArtifactTrust::EcosystemIntegrityRequired,
        };

        let env = build_launch_environment(
            &[component],
            &[std::path::PathBuf::from("/managed/npm/bin")],
            std::ffi::OsString::from("/usr/bin"),
        )
        .unwrap();

        assert_eq!(
            env.get("AUGMENT_DISABLE_AUTO_UPDATE").map(String::as_str),
            Some("1")
        );
        assert!(
            env.get("PATH")
                .is_some_and(|path| path.starts_with("/managed/npm/bin"))
        );
    }

    #[tokio::test]
    #[ignore = "live probe requires the public npm registry"]
    async fn live_grok_build_package_installs_and_completes_acp_handshake() {
        let temp = tempfile::tempdir().unwrap();
        let agent_id = AgentId::parse("grok-build").unwrap();
        let plan = agents::ResolvedInstallPlan {
            agent_id: agent_id.clone(),
            source: agents::LockedInstallSource::OfficialRegistry {
                snapshot_id: uuid::Uuid::nil(),
                registry_id: "grok-build".to_string(),
            },
            version: "0.2.115".to_string(),
            platform: agents::current_platform(),
            components: vec![agents::PlannedInstallComponent {
                component_id: "combined_runtime".to_string(),
                distribution_kind: agents::PlannedDistributionKind::Npx,
                version: "0.2.115".to_string(),
                resolved_source: "@xai-official/grok@0.2.115".to_string(),
                command: "grok".to_string(),
                args: vec!["agent".to_string(), "stdio".to_string()],
                env: Default::default(),
                trust: agents::ArtifactTrust::EcosystemIntegrityRequired,
            }],
        };
        let cancellation = tokio_util::sync::CancellationToken::new();
        let user_env = agents::UserEnvironmentLayout::for_home(temp.path());
        let installation = install_locked_plan(
            &plan,
            temp.path(),
            &user_env,
            &cancellation,
            &std::collections::HashMap::new(),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert!(
            installation
                .launch_lock
                .absolute_acp_program
                .ends_with("grok")
        );
        verify_acp_handshake(
            &agent_id,
            &installation.launch_lock,
            temp.path(),
            &cancellation,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn claude_auth_mode_patch_enforces_custom_requirements_and_subscription_cleanup() {
        let temp = tempfile::tempdir().unwrap();
        let filesystem = Arc::new(agents::TokioNativeFileSystem);
        let provider = agents::NativeConfigProvider::bundled(filesystem, temp.path().to_path_buf());
        let agent_id = AgentId::parse("claude_code").unwrap();
        let initial = provider.read(&agent_id, false).await.unwrap();
        let selected = ["anthropic_base_url", "anthropic_api_key"];
        let configured = provider
            .save(
                &agent_id,
                agents::NativeConfigPatch {
                    base_field_revisions: initial
                        .fields
                        .iter()
                        .filter(|field| selected.contains(&field.field_id.as_str()))
                        .map(|field| (field.field_id.clone(), field.revision.clone()))
                        .collect(),
                    values: BTreeMap::from([
                        (
                            "anthropic_base_url".to_string(),
                            Some("https://gateway.example".to_string()),
                        ),
                        ("anthropic_api_key".to_string(), Some("secret".to_string())),
                    ]),
                },
                false,
            )
            .await
            .unwrap();

        native_auth_mode_patch(&agent_id, "custom", None, &configured.snapshot).unwrap();
        let official = native_auth_mode_patch(
            &agent_id,
            "official_subscription",
            None,
            &configured.snapshot,
        )
        .unwrap();
        assert_eq!(official.values["anthropic_base_url"], None);
        assert_eq!(official.values["anthropic_api_key"], None);
    }

    #[tokio::test]
    #[ignore = "live probe requires the public Python package registry"]
    async fn live_official_uv_packages_install_with_resolvable_entry() {
        for (agent, version, package, args) in [
            (
                "fast-agent",
                "0.9.27",
                "fast-agent-acp==0.9.27",
                vec!["-x".to_string()],
            ),
            (
                "minion-code",
                "0.1.44",
                "minion-code@0.1.44",
                vec!["acp".to_string()],
            ),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let agent_id = AgentId::parse(agent).unwrap();
            let plan = agents::ResolvedInstallPlan {
                agent_id: agent_id.clone(),
                source: agents::LockedInstallSource::OfficialRegistry {
                    snapshot_id: uuid::Uuid::nil(),
                    registry_id: agent.to_string(),
                },
                version: version.to_string(),
                platform: agents::current_platform(),
                components: vec![agents::PlannedInstallComponent {
                    component_id: "combined_runtime".to_string(),
                    distribution_kind: agents::PlannedDistributionKind::Uvx,
                    version: version.to_string(),
                    resolved_source: package.to_string(),
                    command: "uv".to_string(),
                    args,
                    env: Default::default(),
                    trust: agents::ArtifactTrust::EcosystemIntegrityRequired,
                }],
            };
            let cancellation = tokio_util::sync::CancellationToken::new();
            let user_env = agents::UserEnvironmentLayout::for_home(temp.path());
            let installation = install_locked_plan(
                &plan,
                temp.path(),
                &user_env,
                &cancellation,
                &std::collections::HashMap::new(),
                None,
                None,
                None,
            )
            .await
            .unwrap();

            assert!(
                tokio::fs::metadata(&installation.launch_lock.absolute_acp_program)
                    .await
                    .is_ok()
            );
        }
    }

    #[tokio::test]
    #[ignore = "live probe requires the public Python package registry"]
    async fn live_fast_agent_package_completes_acp_handshake() {
        let temp = tempfile::tempdir().unwrap();
        let agent_id = AgentId::parse("fast-agent").unwrap();
        let plan = agents::ResolvedInstallPlan {
            agent_id: agent_id.clone(),
            source: agents::LockedInstallSource::OfficialRegistry {
                snapshot_id: uuid::Uuid::nil(),
                registry_id: "fast-agent".to_string(),
            },
            version: "0.9.27".to_string(),
            platform: agents::current_platform(),
            components: vec![agents::PlannedInstallComponent {
                component_id: "combined_runtime".to_string(),
                distribution_kind: agents::PlannedDistributionKind::Uvx,
                version: "0.9.27".to_string(),
                resolved_source: "fast-agent-acp==0.9.27".to_string(),
                command: "uv".to_string(),
                args: vec!["-x".to_string()],
                env: Default::default(),
                trust: agents::ArtifactTrust::EcosystemIntegrityRequired,
            }],
        };
        let cancellation = tokio_util::sync::CancellationToken::new();
        let user_env = agents::UserEnvironmentLayout::for_home(temp.path());
        let installation = install_locked_plan(
            &plan,
            temp.path(),
            &user_env,
            &cancellation,
            &std::collections::HashMap::new(),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        verify_acp_handshake(
            &agent_id,
            &installation.launch_lock,
            temp.path(),
            &cancellation,
        )
        .await
        .unwrap();
    }
}

#[path = "agent_management/account_flow.rs"]
mod account_flow;
#[path = "agent_management/codex_device_auth.rs"]
mod codex_device_auth;
#[path = "agent_management/dsh_configuration.rs"]
mod dsh_configuration;
#[path = "agent_management/environment_diagnostics.rs"]
mod environment_diagnostics;
#[path = "agent_management/external_reconcile.rs"]
mod external_reconcile;
#[path = "agent_management/grok_plugins.rs"]
mod grok_plugins;
#[path = "agent_management/model_catalogs.rs"]
mod model_catalogs;
#[path = "agent_management/model_providers.rs"]
mod model_providers;
#[path = "agent_management/opencode_catalog.rs"]
mod opencode_catalog;
#[path = "agent_management/opencode_plugins.rs"]
mod opencode_plugins;
#[path = "agent_management/pi_configuration.rs"]
mod pi_configuration;

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    ffi::OsString,
    io::{Cursor, Read},
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
};

use agents::{
    AcpAuthenticationObservationSnapshot, AcpCapabilitySnapshot, AgentAutoApproveMode,
    AgentConnectionId, AgentConnectionLaunch, AgentConnectionManager, ArtifactTrust,
    AuthenticationObservationState, BuiltInProfileCatalog, InstallCandidateSource,
    InstallEnvironment, InstallPlanner, InstallPlanningInput, LaunchComponentEvidence, LaunchGate,
    LockedInstallSource, NativeConfigFilePatch, NativeConfigPatch, NativeConfigProvider,
    NativeFileMutation, NativeFileSystem, ObservedUserComponent, OfficialRegistryHttpFetcher,
    PlannedDistributionKind, PlannedInstallComponent, ProfileComponent, ProfileInstallSource,
    ProfileManagementActionKind, ProfileTopology, REGISTRY_REFRESH_TIMEOUT, RegistryCache,
    RegistryCacheFreshness, RegistrySnapshotClient, ResolvedInstallPlan, SessionLaunchLock,
    ShellFamily, SystemClock, TofuFingerprint, TokioNativeFileSystem, UserEnvironmentAdoptDecision,
    UserEnvironmentLayout, decide_user_environment_adopt, ensure_user_cli_path,
    npm_global_install_args, observed_satisfies_profile, plan_required_components,
    publish_managed_runtime_cli, remove_managed_runtime_cli, switch_managed_runtime_cli,
    uv_distribution_name, verify_artifact_bytes,
};
use api_types::{
    AgentAccountFlowStatus, AgentAccountFlowView, AgentAuthModeOptionView, AgentAuthModeView,
    AgentAuthenticationStatus, AgentDiagnosticView, AgentDiscoveryPhase,
    AgentDiscoveryProgressView, AgentEnvironmentDiagnosticCheckView,
    AgentEnvironmentDiagnosticLevel, AgentEnvironmentDiagnosticSectionView,
    AgentEnvironmentDiagnosticsView, AgentEnvironmentEntryView, AgentEnvironmentPatchRequest,
    AgentEnvironmentView, AgentId, AgentLifecycleState, AgentLocalRuntimeView,
    AgentManagementActionKind, AgentManagementActionReceipt, AgentManagementActionView,
    AgentManagementActionsView, AgentManagementErrorCode, AgentManagementErrorView,
    AgentManagementView, AgentModelCatalogView, AgentModelProviderSaveRequest,
    AgentModelProvidersView, AgentNativeConfigFieldKind, AgentNativeConfigFieldView,
    AgentNativeConfigFileView, AgentNativeConfigFileWriteRequest, AgentNativeConfigFormat,
    AgentNativeConfigOptionView, AgentNativeConfigPatchRequest, AgentNativeConfigSurface,
    AgentNativeConfigView, AgentOperationEvent, AgentOperationKind, AgentOperationReceipt,
    AgentOperationStatus, AgentPreflightItemView, AgentPreflightSource, AgentPreflightView,
    AgentRegistryView, AgentSource, AgentUpdateCheckView, CodexDeviceCodePollView,
    CodexDeviceCodeView, CodexModelCatalogConfigRequest, CodexModelCatalogConfigView,
    DshPluginSummaryView, DshProviderDiscoverRequest, DshProviderModelView, DshProviderSaveRequest,
    DshProvidersView, GrokPluginSummaryView, OpenCodePluginStatus, OpenCodePluginSummaryView,
    OpenCodeProviderCatalogView, OpenCodeProviderConnectRequest, OpenCodeProviderConnectionView,
    OpenCodeProviderConnectionsView, OpenCodeProviderModelRequest, OpenCodeProviderModelView,
    PiCommandValidationView, PiConfigurationView, PiCredentialsSaveRequest, PiRuntimeSaveRequest,
    UserAgentDefinitionRequest, UserAgentDefinitionView,
};
use chrono::{Duration, Utc};
use db::models::{
    agent_management::{
        AgentMembershipRepository, InstallationOperationRepository, NewInstallationOperation,
        RegistrySnapshotRepository,
    },
    agent_setting::AgentSetting,
};
use futures::StreamExt;
use services::services::{
    agent_management::AgentManagementApplicationService, agent_registry::AgentRegistrySnapshotStore,
};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{Mutex as AsyncMutex, Semaphore, mpsc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::state::{
    AgentManagementRuntimeState, AppState, LocalRuntimeDiscoveryProgress, LocalRuntimeEvidence,
};

const MANAGEMENT_EVENT: &str = "agent-management-event";
const MANAGEMENT_INVALIDATED_EVENT: &str = "agent-management-snapshot-invalidated";
const MANAGEMENT_DISCOVERY_PROGRESS_EVENT: &str = "agent-management-discovery-progress";
const MAX_AGENT_BINARY_BYTES: usize = 512 * 1024 * 1024;
const MANAGED_NODE_VERSION: &str = "22.22.3";
const MAX_MANAGED_NODE_BYTES: usize = 128 * 1024 * 1024;
const MANAGED_UV_VERSION: &str = "0.8.10";
const MAX_MANAGED_UV_BYTES: usize = 128 * 1024 * 1024;
const MAX_CONCURRENT_EXTERNAL_AGENT_PROBES: usize = 4;
const MAX_CONCURRENT_LOCAL_RUNTIME_PROBES: usize = 12;
const LOCAL_RUNTIME_VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
const LOCAL_RUNTIME_DISCOVERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const EXTERNAL_COMPONENT_VERSION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BuiltInProbeAction {
    Discover,
    RefreshExisting,
    KeepExisting,
}

fn built_in_probe_action(installed: bool, force: bool) -> BuiltInProbeAction {
    match (installed, force) {
        (false, _) => BuiltInProbeAction::Discover,
        (true, false) => BuiltInProbeAction::RefreshExisting,
        (true, true) => BuiltInProbeAction::KeepExisting,
    }
}

async fn run_agent_management_warmup_once<Fut>(runtime: &AgentManagementRuntimeState, work: Fut)
where
    Fut: std::future::Future<Output = ()>,
{
    runtime.run_warmup_once(work).await;
}

async fn run_local_runtime_discovery_once<Fut>(runtime: &AgentManagementRuntimeState, work: Fut)
where
    Fut: std::future::Future<Output = ()>,
{
    runtime.run_local_runtime_discovery_once(work).await;
}

async fn refresh_local_runtime_discovery_once<Fut>(runtime: &AgentManagementRuntimeState, work: Fut)
where
    Fut: std::future::Future<Output = ()>,
{
    runtime.refresh_local_runtime_discovery(work).await;
}

async fn run_bounded_agent_probes<Fut>(jobs: Vec<Fut>, limit: usize)
where
    Fut: std::future::Future<Output = ()>,
{
    futures::stream::iter(jobs)
        .buffer_unordered(limit)
        .collect::<Vec<_>>()
        .await;
}

fn local_runtime_discovery_progress_view(
    progress: LocalRuntimeDiscoveryProgress,
) -> AgentDiscoveryProgressView {
    let phase = if !progress.started {
        AgentDiscoveryPhase::Pending
    } else if progress.running {
        AgentDiscoveryPhase::Checking
    } else {
        AgentDiscoveryPhase::Complete
    };
    let mut checked_agent_ids = progress.checked_agent_ids.into_iter().collect::<Vec<_>>();
    checked_agent_ids.sort_by(|left, right| left.as_str().cmp(right.as_str()));
    AgentDiscoveryProgressView {
        phase,
        completed: progress.completed,
        total: progress.total,
        found: progress.found,
        checked_agent_ids,
        timed_out: progress.timed_out,
    }
}

async fn emit_local_runtime_discovery_progress(
    app: &AppHandle,
    runtime: &AgentManagementRuntimeState,
) {
    let progress =
        local_runtime_discovery_progress_view(runtime.local_runtime_discovery_progress().await);
    if let Err(error) = app.emit(MANAGEMENT_DISCOVERY_PROGRESS_EVENT, progress) {
        tracing::warn!(%error, "failed to emit local Agent discovery progress");
    }
}

struct ManagedNodeArtifact {
    target: &'static str,
    extension: &'static str,
    sha256: &'static str,
}

fn managed_node_artifact(platform: &str) -> Option<ManagedNodeArtifact> {
    let (target, extension, sha256) = match platform {
        "darwin-aarch64" => (
            "darwin-arm64",
            "tar.gz",
            "0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207",
        ),
        "darwin-x86_64" => (
            "darwin-x64",
            "tar.gz",
            "45830ba752fa0d892c6dcd640946669801293cac820a33591ded40ac075198ec",
        ),
        "linux-aarch64" => (
            "linux-arm64",
            "tar.gz",
            "cc8bc82b2dd0b595c3b95a4c3c9c8c350907cff011afbdee3d1379e812e1e3e3",
        ),
        "linux-x86_64" => (
            "linux-x64",
            "tar.gz",
            "c7a10d6816da8eaaa7534dd73c71c6e2b2c391dbbf845e364902d156615dd1b8",
        ),
        "windows-aarch64" => (
            "win-arm64",
            "zip",
            "00be129a09e8872cd52d3bb8bba12412c5733d2224123a482a2dca4a6fbf2586",
        ),
        "windows-x86_64" => (
            "win-x64",
            "zip",
            "6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33",
        ),
        _ => return None,
    };
    Some(ManagedNodeArtifact {
        target,
        extension,
        sha256,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeSource {
    System,
    Managed,
}

#[derive(Debug, Clone)]
struct NodeRuntime {
    node: PathBuf,
    npm: PathBuf,
    bin_dir: PathBuf,
    version: String,
    npm_version: Option<String>,
    source: RuntimeSource,
}

fn managed_node_executables(managed_artifacts_dir: &Path) -> Option<NodeRuntime> {
    let platform = agents::current_platform();
    let artifact = managed_node_artifact(&platform)?;
    let archive_root = managed_artifacts_dir
        .join("agent-tools")
        .join("node")
        .join(MANAGED_NODE_VERSION)
        .join(platform)
        .join(format!("node-v{MANAGED_NODE_VERSION}-{}", artifact.target));
    let bin_dir = if cfg!(windows) {
        archive_root
    } else {
        archive_root.join("bin")
    };
    Some(NodeRuntime {
        node: bin_dir.join(if cfg!(windows) { "node.exe" } else { "node" }),
        npm: bin_dir.join(if cfg!(windows) { "npm.cmd" } else { "npm" }),
        bin_dir,
        version: MANAGED_NODE_VERSION.to_string(),
        npm_version: None,
        source: RuntimeSource::Managed,
    })
}

struct ManagedUvArtifact {
    target: &'static str,
    extension: &'static str,
    sha256: &'static str,
}

fn managed_uv_artifact(platform: &str) -> Option<ManagedUvArtifact> {
    let (target, extension, sha256) = match platform {
        "darwin-aarch64" => (
            "aarch64-apple-darwin",
            "tar.gz",
            "5200278ae00b5c0822a7db7a99376b2167e8e9391b29c3de22f9e4fdebc9c0e8",
        ),
        "darwin-x86_64" => (
            "x86_64-apple-darwin",
            "tar.gz",
            "3b935381af9124a5d5da48235e149f5f0662f2717e75782d1b843d39d9265d6d",
        ),
        "linux-aarch64" => (
            "aarch64-unknown-linux-gnu",
            "tar.gz",
            "de60f5e3d69b54e6196fb8937fef4feb15e239f0fd14278e77e44dbb353214ae",
        ),
        "linux-x86_64" => (
            "x86_64-unknown-linux-gnu",
            "tar.gz",
            "2c4392591fe9469d006452ef22f32712f35087d87fb1764ec03e23544eb8770d",
        ),
        "windows-aarch64" => (
            "aarch64-pc-windows-msvc",
            "zip",
            "c51b02188c312baef71187273afa625576101e5680739eab83b1b09ca5d2f3a8",
        ),
        "windows-x86_64" => (
            "x86_64-pc-windows-msvc",
            "zip",
            "37fcd011fd22b2a569f7e583a924af2d624d99445f669752923a2fd3841f8e3d",
        ),
        _ => return None,
    };
    Some(ManagedUvArtifact {
        target,
        extension,
        sha256,
    })
}

fn managed_uv_executable(managed_artifacts_dir: &Path) -> Option<PathBuf> {
    let artifact = managed_uv_artifact(&agents::current_platform())?;
    let executable = if cfg!(windows) { "uv.exe" } else { "uv" };
    Some(
        managed_artifacts_dir
            .join("agent-tools")
            .join("uv")
            .join(MANAGED_UV_VERSION)
            .join(agents::current_platform())
            .join(format!("uv-{}", artifact.target))
            .join(executable),
    )
}
static EVENT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static OPERATION_SCHEDULER: OnceLock<OperationScheduler> = OnceLock::new();
static CLI_EXPOSURES: OnceLock<AsyncMutex<HashSet<AgentId>>> = OnceLock::new();
static HOST_INSTANCE_ID: OnceLock<String> = OnceLock::new();

fn agent_process_command(program: impl AsRef<Path>) -> tokio::process::Command {
    utils::process::new_hidden_tokio_command(program, std::iter::empty::<&str>())
}

fn host_instance_id() -> &'static str {
    HOST_INSTANCE_ID
        .get_or_init(|| Uuid::new_v4().to_string())
        .as_str()
}

pub(crate) async fn recover_interrupted_agent_operations(app: &AppHandle, pool: &sqlx::SqlitePool) {
    let repository = InstallationOperationRepository::new(pool.clone());
    let recovered = match repository.recover_interrupted(host_instance_id()).await {
        Ok(recovered) => recovered,
        Err(error) => {
            tracing::error!(%error, "failed to recover interrupted Agent operations");
            return;
        }
    };
    let Ok(managed_artifacts_dir) = app_managed_artifacts_directory(app) else {
        return;
    };
    for operation_id in recovered {
        let Ok(Some(operation)) = repository.find(operation_id).await else {
            continue;
        };
        let Some(staging_path) = operation.staging_path.map(PathBuf::from) else {
            continue;
        };
        let Ok(root) = managed_install_root(&managed_artifacts_dir, &operation.agent_id) else {
            continue;
        };
        let is_staging = staging_path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".staging-"));
        if !(staging_path.is_absolute() && staging_path.starts_with(&root) && is_staging) {
            continue;
        }
        // The crash could have happened after the install lock was persisted
        // but before the operation was marked finished. Deleting that staging
        // directory would orphan the current install (the lock keeps pointing
        // at it), so every later session fails to spawn. Skip any staging dir
        // still referenced by a persisted component path.
        let lock_references = sqlx::query_scalar::<_, String>(
            r#"SELECT absolute_path FROM agent_install_component
               WHERE lock_id IN (
                 SELECT id FROM agent_install_lock WHERE agent_id = ?
               )"#,
        )
        .bind(operation.agent_id.as_str())
        .fetch_all(pool)
        .await
        .unwrap_or_default()
        .into_iter()
        .any(|path| staging_dir_is_referenced_by(&staging_path, PathBuf::from(path)));
        if lock_references {
            continue;
        }
        let _ = tokio::fs::remove_dir_all(&staging_path).await;
    }
}

/// Whether any persisted component path lives inside `staging` — the recovery
/// cleanup must never delete a staging directory that the current install lock
/// still points at.
fn staging_dir_is_referenced_by(staging: &Path, component_path: PathBuf) -> bool {
    component_path.starts_with(staging)
}

struct OperationScheduler {
    global: Arc<Semaphore>,
    per_agent: Mutex<HashMap<AgentId, Arc<AsyncMutex<()>>>>,
    cancellations: OperationCancellationRegistry,
}

impl OperationScheduler {
    fn shared() -> &'static Self {
        OPERATION_SCHEDULER.get_or_init(|| Self {
            global: Arc::new(Semaphore::new(2)),
            per_agent: Mutex::new(HashMap::new()),
            cancellations: OperationCancellationRegistry::default(),
        })
    }

    fn agent_lock(&self, agent_id: &AgentId) -> Arc<AsyncMutex<()>> {
        self.per_agent
            .lock()
            .expect("Agent operation lock map is not poisoned")
            .entry(agent_id.clone())
            .or_default()
            .clone()
    }
}

#[derive(Default)]
struct OperationCancellationRegistry {
    tokens: Mutex<HashMap<String, CancellationToken>>,
}

impl OperationCancellationRegistry {
    fn register(&self, operation_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        self.tokens
            .lock()
            .expect("Agent cancellation registry is not poisoned")
            .insert(operation_id.to_string(), token.clone());
        token
    }

    fn cancel(&self, operation_id: &str) -> bool {
        let token = self
            .tokens
            .lock()
            .expect("Agent cancellation registry is not poisoned")
            .get(operation_id)
            .cloned();
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }

    fn remove(&self, operation_id: &str) {
        self.tokens
            .lock()
            .expect("Agent cancellation registry is not poisoned")
            .remove(operation_id);
    }
}

fn managed_install_root(
    managed_artifacts_dir: &Path,
    agent_id: &AgentId,
) -> anyhow::Result<PathBuf> {
    let agents_root = managed_artifacts_dir.join("agents");
    let root = agents_root.join(agent_id.as_str());
    if root.parent() != Some(agents_root.as_path()) {
        anyhow::bail!("invalid managed Agent installation path");
    }
    Ok(root)
}

#[cfg(target_os = "macos")]
fn managed_artifacts_directory(home_dir: &Path, _app_data_dir: &Path) -> PathBuf {
    utils::path::managed_artifacts_directory(home_dir, _app_data_dir)
}

#[cfg(not(target_os = "macos"))]
fn managed_artifacts_directory(_home_dir: &Path, app_data_dir: &Path) -> PathBuf {
    utils::path::managed_artifacts_directory(_home_dir, app_data_dir)
}

#[cfg(target_os = "macos")]
fn app_managed_artifacts_directory(app: &AppHandle) -> anyhow::Result<PathBuf> {
    let home_dir = app
        .path()
        .home_dir()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(managed_artifacts_directory(&home_dir, &app_data_dir))
}

#[cfg(not(target_os = "macos"))]
fn app_managed_artifacts_directory(app: &AppHandle) -> anyhow::Result<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|error| anyhow::anyhow!(error.to_string()))
}

fn configured_shell_family() -> ShellFamily {
    #[cfg(windows)]
    {
        return ShellFamily::Windows;
    }
    #[cfg(not(windows))]
    ShellFamily::from_shell_path(std::env::var_os("SHELL").as_deref().map(Path::new))
}

#[derive(Debug, Clone)]
struct ManagedRuntimeCli {
    runtime_executable: PathBuf,
    runtime_path_entries: Vec<PathBuf>,
}

fn deduplicated_parent_directories(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut entries = Vec::new();
    for path in paths {
        let Some(parent) = path.parent() else {
            continue;
        };
        let parent = parent.to_path_buf();
        if !entries.contains(&parent) {
            entries.push(parent);
        }
    }
    entries
}

async fn managed_runtime_cli_for_lock(
    pool: &sqlx::SqlitePool,
    lock_id: &str,
) -> anyhow::Result<Option<ManagedRuntimeCli>> {
    let runtime_executable = sqlx::query_scalar::<_, String>(
        r#"SELECT absolute_path
           FROM agent_install_component
           WHERE lock_id = ?
             AND component_kind IN ('agent_runtime', 'combined_runtime')
           ORDER BY CASE component_kind
             WHEN 'agent_runtime' THEN 0
             ELSE 1
           END
           LIMIT 1"#,
    )
    .bind(lock_id)
    .fetch_optional(pool)
    .await?
    .map(PathBuf::from);
    let Some(runtime_executable) = runtime_executable else {
        return Ok(None);
    };
    let base_runtimes = sqlx::query_scalar::<_, String>(
        r#"SELECT absolute_path
           FROM agent_install_component
           WHERE lock_id = ?
             AND component_kind IN (
               'base_runtime_node', 'base_runtime_npm', 'base_runtime_uv'
             )
           ORDER BY CASE component_kind
             WHEN 'base_runtime_node' THEN 0
             WHEN 'base_runtime_npm' THEN 1
             ELSE 2
           END, id"#,
    )
    .bind(lock_id)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(PathBuf::from);
    Ok(Some(ManagedRuntimeCli {
        runtime_executable,
        runtime_path_entries: deduplicated_parent_directories(base_runtimes),
    }))
}

async fn current_managed_runtime_cli(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> anyhow::Result<Option<ManagedRuntimeCli>> {
    let lock_id = sqlx::query_scalar::<_, String>(
        r#"SELECT current_lock_id
           FROM agent_installation
           WHERE agent_id = ?
             AND ownership = 'managed'
             AND current_lock_id IS NOT NULL"#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await?;
    match lock_id {
        Some(lock_id) => managed_runtime_cli_for_lock(pool, &lock_id).await,
        None => Ok(None),
    }
}

fn restore_managed_cli_switch(
    home_dir: &Path,
    agent_id: &AgentId,
    managed_install_root: &Path,
    previous_runtime: Option<&ManagedRuntimeCli>,
    attempted_runtime: &Path,
    shell: ShellFamily,
) -> Result<(), agents::CliExposureError> {
    match previous_runtime {
        Some(previous_runtime) => switch_managed_runtime_cli(
            home_dir,
            agent_id,
            managed_install_root,
            Some(attempted_runtime),
            &previous_runtime.runtime_executable,
            &previous_runtime.runtime_path_entries,
            shell,
        )
        .map(|_| ()),
        None => remove_managed_runtime_cli(home_dir, agent_id, attempted_runtime),
    }
}

pub(crate) async fn reconcile_managed_cli_exposures(app: &AppHandle, pool: &sqlx::SqlitePool) {
    let _ = utils::shell::refresh_process_path_after_install().await;
    let installations = match sqlx::query_scalar::<_, String>(
        r#"SELECT installation.agent_id
           FROM agent_installation installation
           WHERE installation.ownership = 'managed'
             AND installation.current_lock_id IS NOT NULL
           ORDER BY installation.agent_id"#,
    )
    .fetch_all(pool)
    .await
    {
        Ok(installations) => installations,
        Err(error) => {
            tracing::warn!(%error, "failed to load managed Agent CLI exposures");
            return;
        }
    };
    let Ok(home_dir) = app.path().home_dir() else {
        return;
    };
    let Ok(managed_artifacts_dir) = app_managed_artifacts_directory(app) else {
        return;
    };
    for agent_id in installations {
        let Ok(agent_id) = AgentId::parse(agent_id) else {
            continue;
        };
        let already_reconciled = CLI_EXPOSURES
            .get_or_init(|| AsyncMutex::new(HashSet::new()))
            .lock()
            .await
            .contains(&agent_id);
        if already_reconciled {
            continue;
        }
        let agent_lock = OperationScheduler::shared().agent_lock(&agent_id);
        let _agent_guard = agent_lock.lock().await;
        let runtime = current_managed_runtime_cli(pool, &agent_id)
            .await
            .and_then(|runtime| {
                runtime.ok_or_else(|| anyhow::anyhow!("安装记录没有本地 Runtime 组件"))
            });
        let result = runtime.and_then(|runtime| {
            let root = managed_install_root(&managed_artifacts_dir, &agent_id)?;
            publish_managed_runtime_cli(
                &home_dir,
                &agent_id,
                &root,
                &runtime.runtime_executable,
                &runtime.runtime_path_entries,
                configured_shell_family(),
            )
            .map_err(Into::into)
        });
        match result {
            Ok(_) => {
                CLI_EXPOSURES
                    .get_or_init(|| AsyncMutex::new(HashSet::new()))
                    .lock()
                    .await
                    .insert(agent_id);
            }
            Err(error) => {
                tracing::warn!(
                    agent_id = %agent_id,
                    %error,
                    "failed to reconcile managed Agent terminal command"
                );
                let redacted = redact_operation_output(&error.to_string());
                let _ = sqlx::query(
                    r#"UPDATE agent_installation
                       SET lifecycle = 'needs_repair', updated_at = CURRENT_TIMESTAMP
                       WHERE agent_id = ? AND ownership = 'managed'
                         AND current_lock_id IS NOT NULL"#,
                )
                .bind(agent_id.as_str())
                .execute(pool)
                .await;
                let _ = db::models::agent_management::DiagnosticRepository::new(pool.clone())
                    .append_bounded(&db::models::agent_management::DiagnosticRecord {
                        id: Uuid::new_v4(),
                        agent_id,
                        operation_kind: "terminal_cli".to_string(),
                        severity: "error".to_string(),
                        message: "本地终端命令发布失败".to_string(),
                        redacted_output: Some(redacted),
                        created_at: Utc::now().to_rfc3339(),
                    })
                    .await;
            }
        }
    }
    let _ = utils::shell::refresh_process_path_after_install().await;
}

async fn discover_built_in_local_runtimes(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    runtime: &AgentManagementRuntimeState,
) {
    let _ = utils::shell::refresh_process_path().await;
    if let Some(home) = dirs::home_dir() {
        for directory in UserEnvironmentLayout::for_current_user(home).path_entries() {
            utils::shell::expose_user_bin_to_process_path(&directory);
        }
    }
    let profiles = BuiltInProfileCatalog::bundled();
    let candidates = profiles.profiles().to_vec();
    runtime
        .begin_local_runtime_discovery(u32::try_from(candidates.len()).unwrap_or(u32::MAX))
        .await;
    emit_local_runtime_discovery_progress(app, runtime).await;
    let jobs = candidates
        .into_iter()
        .map(|profile| {
            let app = app.clone();
            async move {
                let local_runtime = match discover_profile_local_runtime(pool, &profile).await {
                    Ok(evidence) => Some(evidence),
                    Err(error) => {
                        tracing::debug!(
                            agent_id = %profile.agent_id,
                            %error,
                            "built-in local Runtime candidate was not discovered"
                        );
                        None
                    }
                };
                runtime
                    .replace_local_runtime(profile.agent_id.clone(), local_runtime.clone())
                    .await;
                runtime
                    .record_local_runtime_discovery(
                        profile.agent_id.clone(),
                        local_runtime.is_some(),
                    )
                    .await;
                emit_local_runtime_discovery_progress(&app, runtime).await;
            }
        })
        .collect();

    let timed_out = tokio::time::timeout(
        LOCAL_RUNTIME_DISCOVERY_TIMEOUT,
        run_bounded_agent_probes(jobs, MAX_CONCURRENT_LOCAL_RUNTIME_PROBES),
    )
    .await
    .is_err();
    if timed_out {
        tracing::warn!(
            timeout_secs = LOCAL_RUNTIME_DISCOVERY_TIMEOUT.as_secs(),
            "local Agent Runtime discovery reached its startup time budget"
        );
    }
    runtime.finish_local_runtime_discovery(timed_out).await;
    emit_local_runtime_discovery_progress(app, runtime).await;
}

async fn ensure_local_runtime_discovery(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    runtime: &AgentManagementRuntimeState,
) {
    run_local_runtime_discovery_once(
        runtime,
        discover_built_in_local_runtimes(app, pool, runtime),
    )
    .await;
}

async fn probe_built_in_external_installations(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    force: bool,
) {
    let runtime = app.state::<AppState>().agent_management_runtime.clone();
    if force {
        let _ = utils::shell::refresh_process_path_after_install().await;
        refresh_local_runtime_discovery_once(
            &runtime,
            discover_built_in_local_runtimes(app, pool, &runtime),
        )
        .await;
    } else {
        ensure_local_runtime_discovery(app, pool, &runtime).await;
    }

    let profiles = BuiltInProfileCatalog::bundled();
    let mut candidates = Vec::new();
    for profile in profiles.profiles() {
        let should_probe = runtime
            .should_probe_built_in(&profile.agent_id, force)
            .await;
        if should_probe {
            candidates.push(profile.clone());
        }
    }
    let jobs = candidates
        .into_iter()
        .map(|profile| {
            let runtime = runtime.clone();
            async move {
                let local_runtime = runtime.local_runtime(&profile.agent_id).await;
                let installed = sqlx::query_scalar::<_, bool>(
                    r#"SELECT EXISTS(
                     SELECT 1 FROM agent_installation
                     WHERE agent_id = ? AND current_lock_id IS NOT NULL
                   )"#,
                )
                .bind(profile.agent_id.as_str())
                .fetch_one(pool)
                .await
                .unwrap_or(false);
                match built_in_probe_action(installed, force) {
                    BuiltInProbeAction::Discover => {
                        let result = match local_runtime.as_ref() {
                            Some(local_runtime) => {
                                probe_one_built_in_external_installation(
                                    app,
                                    pool,
                                    &profile,
                                    local_runtime,
                                )
                                .await
                            }
                            None => Err(anyhow::anyhow!("external local Runtime is missing")),
                        };
                        if let Err(error) = result {
                            tracing::debug!(
                                agent_id = %profile.agent_id,
                                %error,
                                "built-in external Agent candidate was not adopted"
                            );
                        }
                    }
                    BuiltInProbeAction::RefreshExisting => {
                        if let Err(error) =
                            record_post_install_probe(app, pool, &profile.agent_id).await
                        {
                            tracing::debug!(
                                agent_id = %profile.agent_id,
                                %error,
                                "built-in external Agent startup evidence refresh failed"
                            );
                        }
                    }
                    BuiltInProbeAction::KeepExisting => {}
                }
            }
        })
        .collect();
    run_bounded_agent_probes(jobs, MAX_CONCURRENT_EXTERNAL_AGENT_PROBES).await;
}

async fn refresh_agent_management_evidence(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    force_external_probe: bool,
) -> Result<(), AgentManagementErrorView> {
    probe_built_in_external_installations(app, pool, force_external_probe).await;
    normalize_optional_profile_authentication(pool).await;
    // ADR-0038 方向 B:先尝试以官方指纹自动采纳外部组件变更,再对剩余不匹配
    // 组件执行 fail-closed 完整性刷新(needs_repair)。
    external_reconcile::reconcile_external_component_changes(app, pool)
        .await
        .map_err(internal_error)?;
    AgentManagementApplicationService::new(pool.clone())
        .refresh_component_integrity()
        .await
        .map_err(internal_error)?;
    revalidate_recoverable_external_installations(app, pool).await;
    refresh_authentication_probes(app, pool).await;
    Ok(())
}

async fn refresh_authentication_probes(app: &AppHandle, pool: &sqlx::SqlitePool) {
    let agent_ids = match sqlx::query_scalar::<_, String>("SELECT agent_id FROM agent_membership")
        .fetch_all(pool)
        .await
    {
        Ok(agent_ids) => agent_ids,
        Err(error) => {
            tracing::warn!(%error, "failed to load Agents for authentication refresh");
            return;
        }
    };
    for raw_agent_id in agent_ids {
        let Ok(agent_id) = AgentId::parse(raw_agent_id) else {
            continue;
        };
        if let Err(error) = refresh_one_agent_authentication(app, pool, &agent_id, true).await {
            tracing::debug!(
                agent_id = %agent_id,
                message = %error.message,
                "failed to refresh Agent authentication"
            );
        }
    }
}

async fn refresh_one_agent_authentication(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    prefer_recorded: bool,
) -> Result<(AgentAuthenticationStatus, HashMap<String, String>), AgentManagementErrorView> {
    let agent_env = read_agent_environment(pool, agent_id).await?;
    let native_authentication = observe_native_authentication(app, agent_id, &agent_env).await;
    let authentication_required_by_default = BuiltInProfileCatalog::bundled()
        .profile(agent_id)
        .is_some_and(|profile| profile.authentication_required_by_default);
    let (observed, authentication_required) = resolve_authentication_observation(
        native_authentication,
        None,
        authentication_required_by_default,
    );
    let authentication = if prefer_recorded {
        recorded_account_over_residue(pool, agent_id, observed).await
    } else {
        observed
    };
    sync_authentication_probe_with_requirement(
        pool,
        agent_id,
        authentication,
        authentication_required
            && !matches!(
                authentication,
                AgentAuthenticationStatus::Account | AgentAuthenticationStatus::ApiKey
            ),
    )
    .await?;
    Ok((authentication, agent_env))
}

async fn observe_native_authentication(
    app: &AppHandle,
    agent_id: &AgentId,
    agent_env: &HashMap<String, String>,
) -> AgentAuthenticationStatus {
    let native_authentication = if let Ok(home) = app.path().home_dir() {
        let account_logged_in = resolve_native_account_login(&home, agent_id, agent_env).await;
        let provider = NativeConfigProvider::with_environment(
            Arc::new(TokioNativeFileSystem),
            home.clone(),
            agent_env.clone().into_iter().collect(),
        );
        match provider.read(agent_id, account_logged_in).await {
            Ok(snapshot) => snapshot.authentication,
            Err(agents::NativeConfigError::Unsupported(_)) => {
                AgentAuthenticationStatus::NotRequired
            }
            Err(_) => AgentAuthenticationStatus::NotLoggedIn,
        }
    } else {
        AgentAuthenticationStatus::NotLoggedIn
    };
    if agent_id.as_str() == "deepseek_harness"
        && let Ok(home) = app.path().home_dir()
    {
        let paths = dsh_paths(&home, agent_env);
        if dsh_configuration::any_credential_present(&paths) {
            return AgentAuthenticationStatus::ApiKey;
        }
    }
    native_authentication
}

async fn revalidate_recoverable_external_installations(app: &AppHandle, pool: &sqlx::SqlitePool) {
    let agent_ids = match sqlx::query_scalar::<_, String>(
        r#"SELECT agent_id
           FROM agent_installation
           WHERE ownership = 'external'
             AND current_lock_id IS NOT NULL
             AND active_operation IS NULL
             AND (
               lifecycle = 'needs_repair'
               OR EXISTS (
                 SELECT 1 FROM agent_diagnostic diagnostic
                 WHERE diagnostic.agent_id = agent_installation.agent_id
                   AND diagnostic.read_at IS NULL
                   AND diagnostic.redacted_output LIKE
                     'terminal command `%` already resolves to `%` and is not managed by Agent `%`'
               )
             )
           ORDER BY agent_id"#,
    )
    .fetch_all(pool)
    .await
    {
        Ok(agent_ids) => agent_ids,
        Err(error) => {
            tracing::warn!(%error, "failed to load external Agent revalidation candidates");
            return;
        }
    };
    for raw_agent_id in agent_ids {
        let Ok(agent_id) = AgentId::parse(raw_agent_id) else {
            continue;
        };
        let evidence = match sqlx::query_as::<_, (String, String, Option<String>)>(
            r#"SELECT component.component_kind, component.absolute_path, component.sha256
               FROM agent_installation installation
               JOIN agent_install_component component
                 ON component.lock_id = installation.current_lock_id
               WHERE installation.agent_id = ?
               ORDER BY component.component_kind, component.absolute_path"#,
        )
        .bind(agent_id.as_str())
        .fetch_all(pool)
        .await
        {
            Ok(rows) => rows
                .into_iter()
                .map(
                    |(component_kind, absolute_path, expected_sha256)| LaunchComponentEvidence {
                        component_kind,
                        absolute_path: PathBuf::from(absolute_path),
                        expected_sha256: expected_sha256.unwrap_or_default(),
                    },
                )
                .collect::<Vec<_>>(),
            Err(error) => {
                tracing::warn!(agent_id = %agent_id, %error, "failed to load external Agent components");
                continue;
            }
        };
        if evidence.is_empty() || LaunchGate::verify_components(&evidence).await.is_err() {
            continue;
        }
        if let Err(error) = record_post_install_probe(app, pool, &agent_id).await {
            tracing::debug!(
                agent_id = %agent_id,
                %error,
                "external Agent revalidation did not recover the installation"
            );
            continue;
        }
        let _ = sqlx::query(
            r#"UPDATE agent_installation
               SET lifecycle = 'ready', updated_at = CURRENT_TIMESTAMP
               WHERE agent_id = ?
                 AND ownership = 'external'
                 AND lifecycle = 'needs_repair'
                 AND current_lock_id IS NOT NULL
                 AND active_operation IS NULL"#,
        )
        .bind(agent_id.as_str())
        .execute(pool)
        .await;
        let _ = sqlx::query(
            r#"UPDATE agent_diagnostic
               SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
               WHERE agent_id = ?
                 AND read_at IS NULL
                 AND redacted_output LIKE
                   'terminal command `%` already resolves to `%` and is not managed by Agent `%`'"#,
        )
        .bind(agent_id.as_str())
        .execute(pool)
        .await;
    }
}

async fn ensure_agent_management_warmup(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    runtime: &AgentManagementRuntimeState,
) {
    run_agent_management_warmup_once(runtime, async {
        if let Err(error) = refresh_agent_management_evidence(app, pool, false).await {
            tracing::warn!(
                message = %error.message,
                "Agent management startup warmup failed"
            );
        }
    })
    .await;
}

pub(crate) async fn warm_agent_management(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    runtime: &AgentManagementRuntimeState,
) {
    ensure_agent_management_warmup(app, pool, runtime).await;
    if let Err(error) = app.emit(MANAGEMENT_INVALIDATED_EVENT, ()) {
        tracing::warn!(%error, "failed to emit Agent management snapshot invalidation");
    }
}

pub(crate) async fn warm_local_runtime_discovery(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    runtime: &AgentManagementRuntimeState,
) {
    ensure_local_runtime_discovery(app, pool, runtime).await;
    if let Err(error) = app.emit(MANAGEMENT_INVALIDATED_EVENT, ()) {
        tracing::warn!(%error, "failed to emit local Agent discovery invalidation");
    }
}

async fn normalize_optional_profile_authentication(pool: &sqlx::SqlitePool) {
    for profile in BuiltInProfileCatalog::bundled()
        .profiles()
        .iter()
        .filter(|profile| !profile.authentication_required_by_default)
    {
        if let Err(error) = sync_authentication_probe_with_requirement(
            pool,
            &profile.agent_id,
            AgentAuthenticationStatus::NotRequired,
            false,
        )
        .await
        {
            tracing::warn!(
                agent_id = %profile.agent_id,
                message = %error.message,
                "failed to normalize optional profile authentication"
            );
        }
    }
}

fn profile_component_distribution_kind(
    profile: &agents::BuiltInProfile,
    component_kind: &str,
) -> PlannedDistributionKind {
    profile
        .install_sources
        .iter()
        .find_map(|source| match source {
            agents::ProfileInstallSource::Npx { component, .. }
                if profile_component_key(*component) == component_kind =>
            {
                Some(PlannedDistributionKind::Npx)
            }
            agents::ProfileInstallSource::Uvx { component, .. }
                if profile_component_key(*component) == component_kind =>
            {
                Some(PlannedDistributionKind::Uvx)
            }
            agents::ProfileInstallSource::Binary { component, .. }
                if profile_component_key(*component) == component_kind =>
            {
                Some(PlannedDistributionKind::Binary)
            }
            _ => None,
        })
        .unwrap_or(PlannedDistributionKind::Binary)
}

async fn probe_local_runtime_candidate(
    candidate: &agents::ProfileExternalCandidate,
) -> anyhow::Result<LocalRuntimeEvidence> {
    if !matches!(
        candidate.component,
        ProfileComponent::AgentRuntime | ProfileComponent::CombinedRuntime
    ) {
        anyhow::bail!("candidate is not a local Runtime component");
    }

    let executable = utils::shell::resolve_executable_path(candidate.executable)
        .await
        .ok_or_else(|| {
            anyhow::anyhow!(
                "external Agent Runtime candidate `{}` was not found",
                candidate.executable
            )
        })?;
    probe_resolved_local_runtime_candidate(candidate, executable).await
}

async fn probe_resolved_local_runtime_candidate(
    candidate: &agents::ProfileExternalCandidate,
    executable: PathBuf,
) -> anyhow::Result<LocalRuntimeEvidence> {
    let executable = tokio::fs::canonicalize(executable).await?;
    if !executable.is_absolute() || !tokio::fs::metadata(&executable).await?.is_file() {
        anyhow::bail!("external Runtime candidate is not an absolute executable file");
    }

    let mut command = agent_process_command(&executable);
    command.kill_on_drop(true);
    command.args(candidate.version_args);
    let output = tokio::time::timeout(LOCAL_RUNTIME_VERSION_TIMEOUT, command.output())
        .await
        .map_err(|_| anyhow::anyhow!("external Runtime version probe timed out"))??;
    ensure_success("external Runtime version probe", &output)?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let version = [stdout, stderr].into_iter().find(|value| !value.is_empty());

    Ok(LocalRuntimeEvidence {
        path: executable,
        version,
    })
}

async fn discover_profile_acp_launch(
    profile: &agents::BuiltInProfile,
) -> anyhow::Result<SessionLaunchLock> {
    let candidate = profile
        .external_candidates
        .iter()
        .find(|candidate| {
            matches!(
                candidate.component,
                ProfileComponent::AcpAdapter | ProfileComponent::CombinedRuntime
            )
        })
        .ok_or_else(|| anyhow::anyhow!("Profile does not declare an ACP candidate"))?;
    let executable = utils::shell::resolve_executable_path(candidate.executable)
        .await
        .ok_or_else(|| {
            anyhow::anyhow!(
                "external ACP candidate `{}` was not found",
                candidate.executable
            )
        })?;
    let executable = tokio::fs::canonicalize(executable).await?;
    if !executable.is_absolute() || !tokio::fs::metadata(&executable).await?.is_file() {
        anyhow::bail!("external ACP candidate is not an absolute executable file");
    }
    let args = profile
        .install_sources
        .iter()
        .find_map(|source| match source {
            ProfileInstallSource::Npx {
                component, args, ..
            }
            | ProfileInstallSource::Uvx {
                component, args, ..
            }
            | ProfileInstallSource::Binary {
                component, args, ..
            } if profile_component_key(*component)
                == profile_component_key(candidate.component) =>
            {
                Some(
                    args.iter()
                        .map(|argument| (*argument).to_string())
                        .collect::<Vec<_>>(),
                )
            }
            _ => None,
        })
        .unwrap_or_default();
    let mut env = BTreeMap::new();
    let mut path_entries = vec![
        executable
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(".")),
    ];
    path_entries.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    env.insert(
        "PATH".to_string(),
        std::env::join_paths(path_entries)?
            .to_string_lossy()
            .to_string(),
    );
    Ok(SessionLaunchLock {
        agent_id: profile.agent_id.clone(),
        absolute_acp_program: executable,
        args,
        env,
        runtime_version: String::new(),
        acp_version: String::new(),
    })
}

async fn discover_profile_local_runtime(
    pool: &sqlx::SqlitePool,
    profile: &agents::BuiltInProfile,
) -> anyhow::Result<LocalRuntimeEvidence> {
    let candidate = profile
        .external_candidates
        .iter()
        .find(|candidate| {
            matches!(
                candidate.component,
                ProfileComponent::AgentRuntime | ProfileComponent::CombinedRuntime
            )
        })
        .ok_or_else(|| anyhow::anyhow!("Profile does not declare a local Runtime candidate"))?;

    if profile.agent_id.as_str() == "pi" && candidate.component == ProfileComponent::AgentRuntime {
        let configured_env_json = sqlx::query_scalar::<_, Option<String>>(
            "SELECT env_json FROM agent_setting WHERE agent_type = ?",
        )
        .bind(profile.agent_id.as_str())
        .fetch_optional(pool)
        .await?
        .flatten();
        let configured_env = parse_agent_env(configured_env_json.as_deref())?;
        if let Some(command) = configured_env
            .get("PI_ACP_PI_COMMAND")
            .map(String::as_str)
            .map(str::trim)
            .filter(|command| !command.is_empty())
        {
            let executable = pi_configuration::resolve_command(command)
                .ok_or_else(|| anyhow::anyhow!("custom Pi Runtime `{command}` was not found"))?;
            return probe_resolved_local_runtime_candidate(candidate, executable).await;
        }
    }

    probe_local_runtime_candidate(candidate).await
}

async fn probe_one_built_in_external_installation(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    profile: &agents::BuiltInProfile,
    local_runtime: &LocalRuntimeEvidence,
) -> anyhow::Result<()> {
    let configured_env_json = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(profile.agent_id.as_str())
    .fetch_optional(pool)
    .await?
    .flatten();
    let configured_env = parse_agent_env(configured_env_json.as_deref())?;
    let mut components = Vec::new();
    for candidate in profile.external_candidates {
        let is_runtime_candidate = matches!(
            candidate.component,
            ProfileComponent::AgentRuntime | ProfileComponent::CombinedRuntime
        );
        let executable = if is_runtime_candidate {
            local_runtime.path.clone()
        } else {
            utils::shell::resolve_executable_path(candidate.executable)
                .await
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "external Agent candidate `{}` was not found",
                        candidate.executable
                    )
                })?
        };
        let executable = tokio::fs::canonicalize(executable).await?;
        if !executable.is_absolute() || !tokio::fs::metadata(&executable).await?.is_file() {
            anyhow::bail!("external candidate is not an absolute executable file");
        }
        let version = if is_runtime_candidate {
            local_runtime.version.clone().unwrap_or_default()
        } else {
            let mut command = agent_process_command(&executable);
            command.kill_on_drop(true);
            command.args(candidate.version_args);
            let output = tokio::time::timeout(EXTERNAL_COMPONENT_VERSION_TIMEOUT, command.output())
                .await
                .map_err(|_| anyhow::anyhow!("external Agent version probe timed out"))??;
            ensure_success("external Agent version probe", &output)?;
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            [stdout, stderr]
                .into_iter()
                .find(|value| !value.is_empty())
                .unwrap_or_default()
        };
        if version.is_empty() {
            anyhow::bail!("external Agent version probe returned no version");
        }
        let sha256 = format!("{:x}", Sha256::digest(tokio::fs::read(&executable).await?));
        components.push(InstalledComponent {
            kind: profile_component_key(candidate.component).to_string(),
            absolute_path: executable,
            version,
            sha256: Some(sha256),
            trust_state: "tofu".to_string(),
            ownership: "external".to_string(),
            shared_resource_key: None,
        });
    }
    let required_components_present = match profile.topology {
        ProfileTopology::NativeAcp => components
            .iter()
            .any(|component| component.kind == "combined_runtime"),
        ProfileTopology::AdapterBacked => {
            components
                .iter()
                .any(|component| component.kind == "agent_runtime")
                && components
                    .iter()
                    .any(|component| component.kind == "acp_adapter")
        }
    };
    if !required_components_present {
        anyhow::bail!("not every Profile-declared external component is available");
    }
    let observed = components
        .iter()
        .map(|component| ObservedUserComponent {
            component_id: component.kind.clone(),
            version: Some(component.version.clone()),
        })
        .collect::<Vec<_>>();
    if !observed_satisfies_profile(profile, &observed) {
        anyhow::bail!(
            "user-environment Agent is older than the Built-in Profile pin and must be reinstalled"
        );
    }
    let runtime = components
        .iter()
        .find(|component| {
            matches!(
                component.kind.as_str(),
                "agent_runtime" | "combined_runtime"
            )
        })
        .ok_or_else(|| anyhow::anyhow!("external local Runtime is missing"))?;
    let acp = components
        .iter()
        .find(|component| matches!(component.kind.as_str(), "acp_adapter" | "combined_runtime"))
        .ok_or_else(|| anyhow::anyhow!("external ACP executable is missing"))?;
    let args = profile
        .install_sources
        .iter()
        .find_map(|source| match source {
            ProfileInstallSource::Npx {
                component, args, ..
            }
            | ProfileInstallSource::Uvx {
                component, args, ..
            }
            | ProfileInstallSource::Binary {
                component, args, ..
            } if profile_component_key(*component) == acp.kind => Some(
                args.iter()
                    .map(|argument| (*argument).to_string())
                    .collect::<Vec<_>>(),
            ),
            _ => None,
        })
        .unwrap_or_default();
    let mut env = BTreeMap::new();
    if profile.agent_id.as_str() == "pi" {
        env.extend(pi_runtime_lock_env(&configured_env));
    }
    let mut path_entries = components
        .iter()
        .filter_map(|component| component.absolute_path.parent().map(Path::to_path_buf))
        .collect::<Vec<_>>();
    path_entries.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    env.insert(
        "PATH".to_string(),
        std::env::join_paths(path_entries)?
            .to_string_lossy()
            .to_string(),
    );
    bind_profile_runtime_executable(&profile.agent_id, &runtime.absolute_path, &mut env);
    let mut launch_lock = SessionLaunchLock {
        agent_id: profile.agent_id.clone(),
        absolute_acp_program: acp.absolute_path.clone(),
        args,
        env,
        runtime_version: runtime.version.clone(),
        acp_version: acp.version.clone(),
    };
    let working_dir = app
        .path()
        .app_data_dir()?
        .join("agents")
        .join(profile.agent_id.as_str());
    tokio::fs::create_dir_all(&working_dir).await?;
    verify_acp_handshake(
        &profile.agent_id,
        &launch_lock,
        &working_dir,
        &CancellationToken::new(),
    )
    .await?;
    if profile.agent_id.as_str() == "pi" {
        // Runtime preferences are only needed by the adoption handshake. They
        // remain live settings and must not be frozen into the persisted lock.
        for key in [
            "PI_ACP_PI_COMMAND",
            "PI_CODING_AGENT_DIR",
            "PI_CODING_AGENT_SESSION_DIR",
        ] {
            launch_lock.env.remove(key);
        }
    }

    let plan = ResolvedInstallPlan {
        agent_id: profile.agent_id.clone(),
        source: LockedInstallSource::BuiltInProfile,
        version: acp.version.clone(),
        platform: agents::current_platform(),
        components: components
            .iter()
            .map(|component| PlannedInstallComponent {
                component_id: component.kind.clone(),
                distribution_kind: profile_component_distribution_kind(profile, &component.kind),
                version: component.version.clone(),
                resolved_source: component.absolute_path.display().to_string(),
                command: component
                    .absolute_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_string(),
                args: Vec::new(),
                env: Default::default(),
                trust: ArtifactTrust::Tofu,
            })
            .collect(),
    };
    persist_installed_lock(
        pool,
        Uuid::new_v4(),
        &plan,
        &InstalledPlan {
            launch_lock,
            components,
        },
        "external",
    )
    .await?;
    record_post_install_probe(app, pool, &profile.agent_id).await
}

fn profile_component_key(component: ProfileComponent) -> &'static str {
    match component {
        ProfileComponent::AgentRuntime => "agent_runtime",
        ProfileComponent::AcpAdapter => "acp_adapter",
        ProfileComponent::CombinedRuntime => "combined_runtime",
    }
}

fn bind_profile_runtime_executable(
    agent_id: &AgentId,
    runtime_path: &Path,
    env: &mut BTreeMap<String, String>,
) {
    if let Some(variable) = BuiltInProfileCatalog::bundled()
        .profile(agent_id)
        .and_then(|profile| profile.runtime_executable_env)
    {
        env.insert(variable.to_string(), runtime_path.display().to_string());
    }
}

fn pi_runtime_lock_env(configured_env: &HashMap<String, String>) -> BTreeMap<String, String> {
    [
        "PI_ACP_PI_COMMAND",
        "PI_CODING_AGENT_DIR",
        "PI_CODING_AGENT_SESSION_DIR",
    ]
    .into_iter()
    .filter_map(|key| {
        configured_env
            .get(key)
            .cloned()
            .map(|value| (key.to_string(), value))
    })
    .collect()
}

pub(crate) fn management_error(
    code: AgentManagementErrorCode,
    message: impl Into<String>,
    agent_id: Option<AgentId>,
) -> AgentManagementErrorView {
    AgentManagementErrorView {
        code,
        message: message.into(),
        agent_id,
        preflight_item_id: None,
    }
}

pub(crate) fn operation_event(
    sequence: u32,
    agent_id: AgentId,
    operation_id: impl Into<String>,
    kind: AgentOperationKind,
    status: AgentOperationStatus,
    progress_percent: Option<u8>,
    message: Option<String>,
) -> AgentOperationEvent {
    AgentOperationEvent {
        sequence,
        agent_id,
        operation_id: operation_id.into(),
        kind,
        status,
        progress_percent,
        message,
    }
}

fn internal_error(error: impl std::fmt::Display) -> AgentManagementErrorView {
    management_error(AgentManagementErrorCode::Internal, error.to_string(), None)
}

fn emit_operation(
    app: &AppHandle,
    agent_id: AgentId,
    operation_id: &str,
    kind: AgentOperationKind,
    status: AgentOperationStatus,
    progress_percent: Option<u8>,
    message: Option<String>,
) {
    let event = operation_event(
        u32::try_from(EVENT_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1).unwrap_or(u32::MAX),
        agent_id,
        operation_id,
        kind,
        status,
        progress_percent,
        message,
    );
    if let Err(error) = app.emit(MANAGEMENT_EVENT, event) {
        tracing::warn!(%error, "failed to emit Agent management operation event");
    }
}

async fn overlay_local_runtime_evidence(
    runtime: &AgentManagementRuntimeState,
    views: &mut [AgentManagementView],
) {
    let local_runtimes = runtime.local_runtimes().await;
    for view in views {
        view.local_runtime =
            local_runtimes
                .get(&view.agent_id)
                .map(|evidence| AgentLocalRuntimeView {
                    path: evidence.path.display().to_string(),
                    version: evidence.version.clone(),
                });
    }
}

async fn read_agent_management_snapshot(
    pool: &sqlx::SqlitePool,
    runtime: &AgentManagementRuntimeState,
) -> Result<Vec<AgentManagementView>, AgentManagementErrorView> {
    let mut views = AgentManagementApplicationService::new(pool.clone())
        .list()
        .await
        .map_err(internal_error)?;
    overlay_local_runtime_evidence(runtime, &mut views).await;
    Ok(views)
}

#[tauri::command]
pub async fn agent_management_bar(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentManagementView>, AgentManagementErrorView> {
    // Keep the navigation snapshot read-only and latency-bounded. Startup
    // warmup owns local Runtime discovery and emits an invalidation when its
    // evidence is ready; UI reads must never wait behind probe processes.
    read_agent_management_snapshot(&state.deployment.db().pool, &state.agent_management_runtime)
        .await
}

#[tauri::command]
pub async fn agent_management_discovery_progress(
    state: tauri::State<'_, AppState>,
) -> Result<AgentDiscoveryProgressView, AgentManagementErrorView> {
    Ok(local_runtime_discovery_progress_view(
        state
            .agent_management_runtime
            .local_runtime_discovery_progress()
            .await,
    ))
}

#[tauri::command]
pub async fn agent_management_refresh(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentManagementView>, AgentManagementErrorView> {
    refresh_agent_management_evidence(&app, &state.deployment.db().pool, true).await?;
    let mut views = AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .list()
        .await
        .map_err(internal_error)?;
    overlay_local_runtime_evidence(&state.agent_management_runtime, &mut views).await;
    Ok(views)
}

#[tauri::command]
pub async fn agent_management_detail(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentManagementView, AgentManagementErrorView> {
    let mut views = AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .list()
        .await
        .map_err(internal_error)?;
    overlay_local_runtime_evidence(&state.agent_management_runtime, &mut views).await;
    views
        .into_iter()
        .find(|view| view.agent_id == agent_id)
        .ok_or_else(|| {
            management_error(
                AgentManagementErrorCode::NotFound,
                format!("Agent `{agent_id}` has not been added"),
                Some(agent_id),
            )
        })
}

#[tauri::command]
pub async fn agent_registry_view(
    state: tauri::State<'_, AppState>,
) -> Result<AgentRegistryView, AgentManagementErrorView> {
    let store = AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(
        state.deployment.db().pool.clone(),
    ));
    let snapshot = store.load().await.map_err(internal_error)?;
    let freshness = snapshot
        .as_ref()
        .map(|snapshot| {
            if Utc::now().signed_duration_since(snapshot.fetched_at) <= Duration::hours(24) {
                RegistryCacheFreshness::Fresh
            } else {
                RegistryCacheFreshness::Stale
            }
        })
        .unwrap_or(RegistryCacheFreshness::Empty);
    AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .registry_view(freshness, None)
        .await
        .map_err(internal_error)
}

#[tauri::command]
pub async fn agent_registry_refresh(
    state: tauri::State<'_, AppState>,
) -> Result<AgentRegistryView, AgentManagementErrorView> {
    let store = AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(
        state.deployment.db().pool.clone(),
    ));
    let mut cache = store
        .load()
        .await
        .map_err(internal_error)?
        .map(RegistryCache::from_snapshot)
        .unwrap_or_default();
    let client = RegistrySnapshotClient::new(
        Arc::new(OfficialRegistryHttpFetcher::default()),
        Arc::new(SystemClock),
    );
    let cached_freshness = cache
        .snapshot()
        .map(|snapshot| {
            if Utc::now().signed_duration_since(snapshot.fetched_at) <= Duration::hours(24) {
                RegistryCacheFreshness::Fresh
            } else {
                RegistryCacheFreshness::Stale
            }
        })
        .unwrap_or(RegistryCacheFreshness::Empty);
    let (freshness, refresh_error, should_save) =
        match tokio::time::timeout(REGISTRY_REFRESH_TIMEOUT, client.refresh(&mut cache)).await {
            Ok(view) => {
                let should_save = view.refresh_error.is_none();
                (view.freshness, view.refresh_error, should_save)
            }
            Err(_) => (
                cached_freshness,
                Some(format!(
                    "Registry refresh timed out after {} seconds",
                    REGISTRY_REFRESH_TIMEOUT.as_secs()
                )),
                false,
            ),
        };
    if should_save && let Some(snapshot) = cache.snapshot() {
        store.save(snapshot).await.map_err(internal_error)?;
    }
    AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .registry_view(freshness, refresh_error)
        .await
        .map_err(internal_error)
}

#[tauri::command]
pub async fn agent_registry_add_and_install(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentOperationReceipt, AgentManagementErrorView> {
    AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .add(agent_id.clone())
        .await
        .map_err(|error| {
            management_error(
                AgentManagementErrorCode::RegistryUnavailable,
                error.to_string(),
                Some(agent_id.clone()),
            )
        })?;
    if let Some(receipt) = revalidate_external_installation(
        &app,
        &state.deployment.db().pool,
        &agent_id,
        AgentOperationKind::Install,
    )
    .await?
    {
        return Ok(receipt);
    }
    if let Some(receipt) = try_adopt_user_environment(
        &app,
        &state.deployment.db().pool,
        &agent_id,
        AgentOperationKind::Install,
    )
    .await?
    {
        return Ok(receipt);
    }
    queue_operation(
        &app,
        &state.deployment.db().pool,
        agent_id,
        AgentOperationKind::Install,
    )
    .await
}

#[tauri::command]
pub async fn agent_user_definition_add_and_install(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    request: UserAgentDefinitionRequest,
) -> Result<AgentOperationReceipt, AgentManagementErrorView> {
    let agent_id = request.agent_id.clone();
    AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .add_user_definition(request)
        .await
        .map_err(|error| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                error.to_string(),
                Some(agent_id.clone()),
            )
        })?;
    queue_operation(
        &app,
        &state.deployment.db().pool,
        agent_id,
        AgentOperationKind::Install,
    )
    .await
}

#[tauri::command]
pub async fn agent_user_definition_detail(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<UserAgentDefinitionView, AgentManagementErrorView> {
    AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .user_definition_view(&agent_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| {
            management_error(
                AgentManagementErrorCode::NotFound,
                format!("user Agent `{agent_id}` does not exist"),
                Some(agent_id),
            )
        })
}

#[tauri::command]
pub async fn agent_user_definition_update(
    state: tauri::State<'_, AppState>,
    request: UserAgentDefinitionRequest,
) -> Result<UserAgentDefinitionView, AgentManagementErrorView> {
    let agent_id = request.agent_id.clone();
    AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .update_user_definition(request)
        .await
        .map_err(|error| {
            let code = if error.to_string().contains("management operation is active") {
                AgentManagementErrorCode::Busy
            } else {
                AgentManagementErrorCode::InvalidState
            };
            management_error(code, error.to_string(), Some(agent_id))
        })
}

#[tauri::command]
pub async fn agent_management_set_enabled(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
    enabled: bool,
) -> Result<AgentManagementView, AgentManagementErrorView> {
    let changed = sqlx::query(
        "UPDATE agent_membership SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
    )
    .bind(enabled)
    .bind(agent_id.as_str())
    .execute(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?
    .rows_affected();
    if changed == 0 {
        return Err(management_error(
            AgentManagementErrorCode::NotFound,
            format!("Agent `{agent_id}` has not been added"),
            Some(agent_id),
        ));
    }
    agent_management_detail(state, agent_id).await
}

#[tauri::command]
pub async fn agent_management_reorder(
    state: tauri::State<'_, AppState>,
    agent_ids: Vec<AgentId>,
) -> Result<Vec<AgentManagementView>, AgentManagementErrorView> {
    AgentMembershipRepository::new(state.deployment.db().pool.clone())
        .reorder(&agent_ids)
        .await
        .map_err(internal_error)?;
    AgentManagementApplicationService::new(state.deployment.db().pool.clone())
        .list()
        .await
        .map_err(internal_error)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimePreflightFacts {
    available: bool,
    version: Option<String>,
    path: Option<String>,
}

fn runtime_preflight_facts(
    installed: Option<(&Path, &str, bool)>,
    discovered: Option<&AgentLocalRuntimeView>,
) -> RuntimePreflightFacts {
    if let Some((path, version, true)) = installed {
        return RuntimePreflightFacts {
            available: true,
            version: Some(version.to_string()),
            path: Some(path.display().to_string()),
        };
    }
    if let Some(discovered) = discovered {
        return RuntimePreflightFacts {
            available: true,
            version: discovered.version.clone(),
            path: Some(discovered.path.clone()),
        };
    }
    RuntimePreflightFacts {
        available: false,
        version: installed.map(|(_, version, _)| version.to_string()),
        path: installed.map(|(path, _, _)| path.display().to_string()),
    }
}

#[tauri::command]
pub async fn agent_management_preflight(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
    scope: Option<String>,
) -> Result<AgentPreflightView, AgentManagementErrorView> {
    if scope.as_deref() == Some("authentication") {
        return preflight_authentication_scope(app, state, agent_id).await;
    }
    refresh_agent_management_evidence(&app, &state.deployment.db().pool, true).await?;
    let _ = utils::shell::refresh_process_path_after_install().await;
    let view = agent_management_detail(state.clone(), agent_id.clone()).await?;
    let status = |pass: bool| if pass { "pass" } else { "fail" }.to_string();
    let pool = &state.deployment.db().pool;
    let agent_env_json = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?
    .flatten();
    let agent_env = parse_agent_env(agent_env_json.as_deref()).map_err(internal_error)?;
    let lock = sqlx::query_as::<_, (String, String)>(
        r#"SELECT lock.id, lock.resolved_json
           FROM agent_installation installation
           JOIN agent_install_lock lock ON lock.id = installation.current_lock_id
           WHERE installation.agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?;
    let components = if let Some((lock_id, _)) = &lock {
        sqlx::query_as::<_, (String, String, String, Option<String>, String)>(
            r#"SELECT component_kind, absolute_path, version, sha256, ownership
               FROM agent_install_component WHERE lock_id = ?"#,
        )
        .bind(lock_id)
        .fetch_all(pool)
        .await
        .map_err(internal_error)?
    } else {
        Vec::new()
    };
    let mut checked_components = Vec::with_capacity(components.len());
    for (kind, path, version, expected_sha256, _ownership) in components {
        let path = PathBuf::from(path);
        let healthy = preflight_component_is_healthy(&path, expected_sha256.as_deref()).await;
        checked_components.push((kind, path, version, healthy));
    }
    let find_component = |kinds: &[&str]| {
        checked_components
            .iter()
            .find(|(kind, _, _, _)| kinds.contains(&kind.as_str()))
    };
    let find_healthy_component = |kinds: &[&str]| {
        checked_components
            .iter()
            .find(|(kind, _, _, healthy)| kinds.contains(&kind.as_str()) && *healthy)
    };
    let runtime = find_component(&["agent_runtime", "combined_runtime"]);
    let acp = find_component(&["acp_adapter", "combined_runtime"]);
    let discovered_runtime = view.local_runtime.clone();
    let runtime_facts = runtime_preflight_facts(
        runtime.map(|(_, path, version, healthy)| (path.as_path(), version.as_str(), *healthy)),
        discovered_runtime.as_ref(),
    );
    let mut runtime_ok = runtime_facts.available;
    let healthy_acp = find_healthy_component(&["acp_adapter", "combined_runtime"]);
    let mut acp_ok = false;
    let mut acp_error = None;
    let mut authentication_observation = None;
    if let (Some((_, resolved_json)), Some(_)) = (&lock, healthy_acp) {
        #[derive(serde::Deserialize)]
        struct LockedPayload {
            absolute_acp_program: PathBuf,
            #[serde(default)]
            args: Vec<String>,
            #[serde(default)]
            env: BTreeMap<String, String>,
            runtime_version: String,
            acp_version: String,
        }
        if let Ok(payload) = serde_json::from_str::<LockedPayload>(resolved_json) {
            let working_dir = app
                .path()
                .app_data_dir()
                .map_err(internal_error)?
                .join("agents")
                .join(agent_id.as_str());
            let mut launch_env = payload.env.into_iter().collect::<HashMap<_, _>>();
            launch_env.extend(agent_env.clone());
            launch_env.remove("PI_ACP_TRUST_WORKSPACE");
            let mut launch_args = payload.args;
            agents::apply_built_in_launch_policy(&agent_id, &mut launch_env, &mut launch_args);
            let launch_lock = SessionLaunchLock {
                agent_id: agent_id.clone(),
                absolute_acp_program: payload.absolute_acp_program,
                args: launch_args,
                env: launch_env.into_iter().collect(),
                runtime_version: payload.runtime_version,
                acp_version: payload.acp_version,
            };
            match probe_acp_capabilities(
                &agent_id,
                &launch_lock,
                &working_dir,
                &CancellationToken::new(),
            )
            .await
            {
                Ok(capabilities) => {
                    acp_ok = true;
                    authentication_observation = capabilities.authentication;
                }
                Err(error) => {
                    acp_ok = false;
                    acp_error = Some(error.to_string());
                }
            }
        }
    }
    if !acp_ok {
        let catalog = BuiltInProfileCatalog::bundled();
        if let Some(profile) = catalog.profile(&agent_id)
            && let Ok(discovered) = discover_profile_acp_launch(profile).await
        {
            let working_dir = app
                .path()
                .app_data_dir()
                .map_err(internal_error)?
                .join("agents")
                .join(agent_id.as_str());
            match probe_acp_capabilities(
                &agent_id,
                &discovered,
                &working_dir,
                &CancellationToken::new(),
            )
            .await
            {
                Ok(capabilities) => {
                    acp_ok = true;
                    acp_error = None;
                    authentication_observation = capabilities.authentication;
                }
                Err(error) => {
                    if acp_error.is_none() {
                        acp_error = Some(error.to_string());
                    }
                }
            }
        }
    }
    let native_authentication = if let Ok(home) = app.path().home_dir() {
        let account_logged_in = resolve_native_account_login(&home, &agent_id, &agent_env).await;
        let provider = NativeConfigProvider::with_environment(
            Arc::new(TokioNativeFileSystem),
            home,
            agent_env.clone().into_iter().collect(),
        );
        match provider.read(&agent_id, account_logged_in).await {
            Ok(snapshot) => snapshot.authentication,
            Err(agents::NativeConfigError::Unsupported(_)) => {
                AgentAuthenticationStatus::NotRequired
            }
            Err(_) => AgentAuthenticationStatus::NotLoggedIn,
        }
    } else {
        AgentAuthenticationStatus::NotLoggedIn
    };
    let native_authentication = if agent_id.as_str() == "deepseek_harness" {
        if let Ok(home) = app.path().home_dir() {
            let paths = dsh_paths(&home, &agent_env);
            if dsh_configuration::any_credential_present(&paths) {
                AgentAuthenticationStatus::ApiKey
            } else {
                native_authentication
            }
        } else {
            native_authentication
        }
    } else {
        native_authentication
    };
    let authentication_required_by_default = BuiltInProfileCatalog::bundled()
        .profile(&agent_id)
        .is_some_and(|profile| profile.authentication_required_by_default);
    let (authentication, authentication_required) = resolve_authentication_observation(
        native_authentication,
        authentication_observation.as_ref(),
        authentication_required_by_default,
    );
    let managed_artifacts_dir = app_managed_artifacts_directory(&app).ok();
    let managed_node = managed_artifacts_dir
        .as_deref()
        .and_then(managed_node_executables);
    let managed_uv = managed_artifacts_dir
        .as_deref()
        .and_then(managed_uv_executable);
    let (dependency_items, required_dependencies_ok) =
        if let Some(profile) = BuiltInProfileCatalog::bundled().profile(&agent_id) {
            let node_runtime = resolve_existing_node_runtime(
                node_requirement_for_agent(&agent_id),
                managed_node.as_ref(),
            )
            .await;
            probe_profile_dependencies(profile, node_runtime.as_ref(), managed_uv.as_deref()).await
        } else {
            (Vec::new(), true)
        };
    let pi_runtime_validation = if agent_id.as_str() == "pi" {
        agent_env
            .get("PI_ACP_PI_COMMAND")
            .map(String::as_str)
            .map(str::trim)
            .filter(|command| !command.is_empty())
            .map(|command| async move {
                (
                    command.to_string(),
                    pi_configuration::validate_command(command).await,
                )
            })
    } else {
        None
    };
    let pi_runtime_validation = match pi_runtime_validation {
        Some(validation) => Some(validation.await),
        None => None,
    };
    if let Some((_, validation)) = &pi_runtime_validation {
        runtime_ok = validation.found;
    }
    let (auth_mode_item, auth_mode_ready, auth_mode_satisfies_authentication) =
        evaluate_auth_mode_preflight(&app, pool, agent_id.clone(), &agent_env, authentication)
            .await?;
    let lifecycle = if !runtime_ok || !acp_ok || !required_dependencies_ok {
        AgentLifecycleState::NeedsRepair
    } else if !auth_mode_ready
        || (authentication_required
            && !auth_mode_satisfies_authentication
            && matches!(
                authentication,
                AgentAuthenticationStatus::NotLoggedIn | AgentAuthenticationStatus::MultipleUnknown
            ))
    {
        AgentLifecycleState::NeedsAuth
    } else {
        AgentLifecycleState::Ready
    };
    AgentManagementApplicationService::new(pool.clone())
        .record_probe(
            &agent_id,
            lifecycle,
            authentication,
            runtime_ok,
            acp_ok,
            authentication_required,
        )
        .await
        .map_err(internal_error)?;
    let mut items = vec![
        AgentPreflightItemView {
            id: "membership".to_string(),
            label: "运行入口".to_string(),
            status: status(!view.retired),
            detail: if view.retired {
                "此 Agent 仅保留历史记录。".to_string()
            } else {
                "Agent 已加入本地列表。".to_string()
            },
            version: None,
            path: None,
            source: None,
            repairable: false,
        },
        AgentPreflightItemView {
            id: "runtime".to_string(),
            label: if pi_runtime_validation.is_some() {
                "实际 Runtime（自定义 pi）".to_string()
            } else {
                "本地 Runtime".to_string()
            },
            status: status(runtime_ok),
            detail: if let Some((command, validation)) = &pi_runtime_validation {
                if validation.found {
                    format!("自定义命令 `{command}` 已解析并通过可执行性检查。")
                } else {
                    format!("自定义命令 `{command}` 无法解析为可执行文件。")
                }
            } else if runtime.is_none() && discovered_runtime.is_none() {
                "未发现有效的当前安装锁。".to_string()
            } else if runtime.is_some_and(|(_, _, _, healthy)| !healthy)
                && discovered_runtime.is_some()
            {
                "当前安装锁中的 Runtime 异常，但检测到可执行的本地 CLI Runtime。".to_string()
            } else {
                String::new()
            },
            version: pi_runtime_validation
                .as_ref()
                .and_then(|(_, validation)| validation.version.clone())
                .or_else(|| runtime_facts.version.clone()),
            path: pi_runtime_validation
                .as_ref()
                .and_then(|(_, validation)| validation.resolved_path.clone())
                .or_else(|| runtime_facts.path.clone()),
            source: None,
            repairable: true,
        },
        AgentPreflightItemView {
            id: "acp".to_string(),
            label: "ACP 适配器".to_string(),
            status: status(acp_ok),
            detail: if acp_ok {
                String::new()
            } else if let Some(error) = acp_error.as_ref() {
                format!("ACP 握手失败：{error}")
            } else if acp.is_none() {
                "未发现 ACP 安装组件。请先安装官方 CLI，或使用「安装 Runtime 和 ACP」。".to_string()
            } else {
                "已记录安装路径，但尚未完成可用的 ACP 握手。".to_string()
            },
            version: acp.map(|(_, _, version, _)| version.clone()),
            path: acp.map(|(_, path, _, _)| path.display().to_string()),
            source: None,
            repairable: true,
        },
    ];
    items.extend(dependency_items);
    items.extend(auth_mode_item);
    if agent_id.as_str() == "opencode" {
        match opencode_provider_paths(&agent_env).and_then(|paths| {
            opencode_plugins::check_plugins(&paths.config_path, &paths.cache_dir)
                .map_err(internal_error)
        }) {
            Ok(summary) => {
                let missing = summary
                    .plugins
                    .iter()
                    .filter(|plugin| plugin.status == OpenCodePluginStatus::Missing)
                    .map(|plugin| plugin.name.as_str())
                    .collect::<Vec<_>>();
                items.push(AgentPreflightItemView {
                    id: "opencode.plugins".to_string(),
                    label: "OpenCode 插件".to_string(),
                    status: if missing.is_empty() { "pass" } else { "fail" }.to_string(),
                    detail: if summary.plugins.is_empty() {
                        "opencode.json 未声明插件。".to_string()
                    } else if missing.is_empty() {
                        format!("已安装 {} 个声明的插件。", summary.plugins.len())
                    } else {
                        format!("缺少 {} 个插件：{}", missing.len(), missing.join(", "))
                    },
                    version: None,
                    path: Some(summary.cache_dir.clone()),
                    source: None,
                    repairable: !missing.is_empty(),
                });
                let floating = summary
                    .plugins
                    .iter()
                    .filter(|plugin| {
                        opencode_plugins::spec_has_floating_version(&plugin.declared_spec)
                    })
                    .map(|plugin| plugin.name.as_str())
                    .collect::<Vec<_>>();
                if !floating.is_empty() {
                    items.push(AgentPreflightItemView {
                        id: "opencode.plugins.floating".to_string(),
                        label: "插件版本".to_string(),
                        status: "warning".to_string(),
                        detail: format!(
                            "{} 个插件使用 @latest，会在启动时触发网络检查：{}",
                            floating.len(),
                            floating.join(", ")
                        ),
                        version: None,
                        path: Some(summary.config_path),
                        source: None,
                        repairable: true,
                    });
                }
            }
            Err(error) => items.push(AgentPreflightItemView {
                id: "opencode.plugins".to_string(),
                label: "OpenCode 插件".to_string(),
                status: "warning".to_string(),
                detail: error.message,
                version: None,
                path: None,
                source: None,
                repairable: false,
            }),
        }
    }
    Ok(AgentPreflightView {
        agent_id,
        checked_at: Utc::now().to_rfc3339(),
        items,
    })
}

async fn preflight_authentication_scope(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentPreflightView, AgentManagementErrorView> {
    let pool = &state.deployment.db().pool;
    let (authentication, agent_env) =
        refresh_one_agent_authentication(&app, pool, &agent_id, false).await?;
    let (auth_mode_item, _, _) =
        evaluate_auth_mode_preflight(&app, pool, agent_id.clone(), &agent_env, authentication)
            .await?;
    Ok(AgentPreflightView {
        agent_id,
        checked_at: Utc::now().to_rfc3339(),
        items: auth_mode_item.into_iter().collect(),
    })
}

async fn evaluate_auth_mode_preflight(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: AgentId,
    agent_env: &HashMap<String, String>,
    authentication: AgentAuthenticationStatus,
) -> Result<(Option<AgentPreflightItemView>, bool, bool), AgentManagementErrorView> {
    let status = |pass: bool| if pass { "pass" } else { "fail" }.to_string();
    if agent_id.as_str() == "codex" {
        return Ok(match read_codex_auth_mode_view(app, pool).await {
            Ok(auth_mode) => {
                let codex_home = app
                    .path()
                    .home_dir()
                    .map(|home| {
                        resolve_agent_home_directory(&home, agent_env, "CODEX_HOME", ".codex")
                    })
                    .map_err(internal_error)?;
                let provider_projection_ready = if auth_mode.mode == "model_provider" {
                    codex_provider_projection_ready(&codex_home).await
                        && auth_mode.credential_present
                } else {
                    true
                };
                let ready = match auth_mode.mode.as_str() {
                    "api_key" => auth_mode.credential_present,
                    "model_provider" => provider_projection_ready,
                    "chatgpt_subscription" => matches!(
                        authentication,
                        AgentAuthenticationStatus::Account
                            | AgentAuthenticationStatus::MultipleUnknown
                    ),
                    _ => false,
                };
                let detail = match auth_mode.mode.as_str() {
                    "api_key" if ready => {
                        "api_key 模式已配置 OPENAI_API_KEY（凭据内容不会显示）。".to_string()
                    }
                    "api_key" => {
                        "api_key 模式缺少 OPENAI_API_KEY，请在鉴权模式中保存凭据。".to_string()
                    }
                    "model_provider" if ready => {
                        "Model Provider 绑定、Codex 原生配置与凭据投影已对齐。".to_string()
                    }
                    "model_provider" => {
                        "Model Provider 绑定与 Codex auth.json/config.toml 投影不一致，请重新绑定。"
                            .to_string()
                    }
                    "chatgpt_subscription" if ready => {
                        "ChatGPT 订阅模式已检测到有效账号会话。".to_string()
                    }
                    "chatgpt_subscription" => {
                        "ChatGPT 订阅模式尚未检测到有效账号会话，请使用设备码登录。".to_string()
                    }
                    _ => format!("无法验证鉴权模式 `{}`。", auth_mode.mode),
                };
                (
                    Some(AgentPreflightItemView {
                        id: "auth.mode".to_string(),
                        label: "鉴权模式".to_string(),
                        status: status(ready),
                        detail,
                        version: Some(auth_mode.mode),
                        path: Some(codex_home.join("auth.json").display().to_string()),
                        source: None,
                        repairable: !ready,
                    }),
                    ready,
                    ready,
                )
            }
            Err(error) => (
                Some(AgentPreflightItemView {
                    id: "auth.mode".to_string(),
                    label: "鉴权模式".to_string(),
                    status: "fail".to_string(),
                    detail: error.message,
                    version: None,
                    path: None,
                    source: None,
                    repairable: true,
                }),
                false,
                false,
            ),
        });
    }
    if agent_id.as_str() == "deepseek_harness" {
        return Ok(match read_dsh_auth_mode_view(app, pool).await {
            Ok(auth_mode) => {
                let ready = auth_mode.credential_present;
                (
                    Some(AgentPreflightItemView {
                        id: "auth.mode".to_string(),
                        label: "鉴权模式".to_string(),
                        status: status(ready),
                        detail: if ready {
                            "已从 DeepSeek Harness 原生凭据检测到 API 配置。".to_string()
                        } else {
                            "尚未检测到 DeepSeek API Key 或自定义模型供应商凭据。".to_string()
                        },
                        version: Some(auth_mode.mode),
                        path: Some(
                            dsh_paths(&app.path().home_dir().unwrap_or_default(), agent_env)
                                .credentials
                                .display()
                                .to_string(),
                        ),
                        source: None,
                        repairable: !ready,
                    }),
                    ready,
                    ready,
                )
            }
            Err(error) => (
                Some(AgentPreflightItemView {
                    id: "auth.mode".to_string(),
                    label: "鉴权模式".to_string(),
                    status: "fail".to_string(),
                    detail: error.message,
                    version: None,
                    path: None,
                    source: None,
                    repairable: true,
                }),
                false,
                false,
            ),
        });
    }
    if matches!(agent_id.as_str(), "claude_code" | "antigravity" | "gemini") {
        return Ok(
            match evaluate_profile_auth_mode_preflight(app, pool, agent_id.clone(), authentication)
                .await
            {
                Ok((auth_mode, ready, detail, path)) => (
                    Some(AgentPreflightItemView {
                        id: "auth.mode".to_string(),
                        label: "鉴权模式".to_string(),
                        status: status(ready),
                        detail,
                        version: Some(auth_mode.mode),
                        path,
                        source: None,
                        repairable: !ready,
                    }),
                    ready,
                    ready,
                ),
                Err(error) => (
                    Some(AgentPreflightItemView {
                        id: "auth.mode".to_string(),
                        label: "鉴权模式".to_string(),
                        status: "fail".to_string(),
                        detail: error.message,
                        version: None,
                        path: None,
                        source: None,
                        repairable: true,
                    }),
                    false,
                    false,
                ),
            },
        );
    }
    let Some(policy) = agents::built_in_auth_mode_policy(&agent_id) else {
        return Ok((None, true, false));
    };
    let auth_mode = project_agent_auth_mode(agent_id.clone(), policy, agent_env);
    let needs_credential = policy.credential_modes.contains(&auth_mode.mode.as_str());
    let custom_ready = if agent_id.as_str() == "grok" && auth_mode.mode == "custom" {
        let home = app.path().home_dir().map_err(internal_error)?;
        let provider = NativeConfigProvider::with_environment(
            Arc::new(TokioNativeFileSystem),
            home,
            agent_env.clone().into_iter().collect(),
        );
        provider
            .read(&agent_id, false)
            .await
            .ok()
            .is_some_and(|snapshot| {
                native_field_present(&snapshot, "grok_api_key")
                    && native_field_text(&snapshot, "grok_base_url").is_some()
                    && native_field_text(&snapshot, "grok_custom_model_id").is_some()
            })
    } else {
        true
    };
    let subscription_ready = auth_mode.mode != "subscription"
        || matches!(
            authentication,
            AgentAuthenticationStatus::Account | AgentAuthenticationStatus::MultipleUnknown
        );
    let ready =
        (!needs_credential || auth_mode.credential_present) && custom_ready && subscription_ready;
    let detail = if auth_mode.mode == "subscription" {
        format!(
            "订阅登录模式；启动时会清除冲突的 {}。",
            policy.subscription_scrub_env.join("、")
        )
    } else if needs_credential && !auth_mode.credential_present {
        format!(
            "{} 模式缺少 {}，请在鉴权模式中保存凭据。",
            auth_mode.mode, auth_mode.credential_env
        )
    } else if auth_mode.credential_present {
        format!(
            "{} 模式已配置 {}（凭据内容不会显示）。",
            auth_mode.mode, auth_mode.credential_env
        )
    } else {
        format!("已选择 {} 模式。", auth_mode.mode)
    };
    Ok((
        Some(AgentPreflightItemView {
            id: "auth.mode".to_string(),
            label: "鉴权模式".to_string(),
            status: status(ready),
            detail,
            version: Some(auth_mode.mode),
            path: None,
            source: None,
            repairable: !ready,
        }),
        ready,
        ready,
    ))
}

async fn preflight_component_is_healthy(path: &Path, expected_sha256: Option<&str>) -> bool {
    if !path.is_absolute() || !path.is_file() {
        return false;
    }
    let Some(expected) = expected_sha256
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        // npx/uvx shims and recovered locks may not record a content hash.
        // Presence is enough to attempt the ACP handshake; a missing hash is
        // not evidence that the adapter was never installed.
        return true;
    };
    tokio::fs::read(path)
        .await
        .map(|bytes| format!("{:x}", Sha256::digest(bytes)).eq_ignore_ascii_case(expected))
        .unwrap_or(false)
}

#[cfg(test)]
fn relocate_managed_path(path: &Path, from: &Path, to: &Path) -> PathBuf {
    path.strip_prefix(from)
        .map(|relative| to.join(relative))
        .unwrap_or_else(|_| path.to_path_buf())
}

async fn codex_provider_projection_ready(codex_home: &Path) -> bool {
    let Ok(source) = tokio::fs::read_to_string(codex_home.join("config.toml")).await else {
        return false;
    };
    toml::from_str::<toml::Table>(&source)
        .is_ok_and(|table| codex_provider_config_is_projected(&table))
}

fn codex_provider_config_is_projected(table: &toml::Table) -> bool {
    table.get("model_provider").and_then(toml::Value::as_str) == Some("vibex")
        && table
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .and_then(|providers| providers.get("vibex"))
            .and_then(toml::Value::as_table)
            .is_some_and(|provider| {
                provider.get("wire_api").and_then(toml::Value::as_str) == Some("responses")
                    && provider
                        .get("requires_openai_auth")
                        .and_then(toml::Value::as_bool)
                        == Some(true)
            })
}

async fn probe_profile_dependencies(
    profile: &agents::BuiltInProfile,
    node_runtime: Option<&NodeRuntime>,
    managed_uv: Option<&Path>,
) -> (Vec<AgentPreflightItemView>, bool) {
    let mut required_ok = true;
    let mut items = Vec::with_capacity(profile.dependencies.len());
    for dependency in profile.dependencies {
        if matches!(dependency.executable, "node" | "npm") {
            let runtime_source = node_runtime.map(|runtime| runtime.source);
            let path = node_runtime.map(|runtime| {
                if dependency.executable == "node" {
                    runtime.node.clone()
                } else {
                    runtime.npm.clone()
                }
            });
            let version = node_runtime.and_then(|runtime| {
                if dependency.executable == "node" {
                    Some(runtime.version.clone())
                } else {
                    runtime.npm_version.clone()
                }
            });
            let passed = version.as_ref().is_some_and(|version| {
                dependency_version_satisfied(dependency.requirement, version).unwrap_or(true)
            });
            if dependency.required && !passed {
                required_ok = false;
            }
            let detail = match runtime_source {
                Some(RuntimeSource::System) => {
                    format!("使用系统安装。要求：{}", dependency.requirement)
                }
                Some(RuntimeSource::Managed) => {
                    format!("使用 VibeX 托管版本。要求：{}", dependency.requirement)
                }
                None => format!(
                    "未找到兼容的 Node.js 与 npm；安装或修复时将自动准备 VibeX 托管环境。要求：{}",
                    dependency.requirement
                ),
            };
            items.push(AgentPreflightItemView {
                id: format!("dependency.{}", dependency.id),
                label: dependency.label.to_string(),
                status: if passed {
                    "pass".to_string()
                } else if dependency.required {
                    "fail".to_string()
                } else {
                    "warning".to_string()
                },
                detail,
                version,
                path: path.map(|path| path.display().to_string()),
                source: runtime_source.map(|_| AgentPreflightSource::System),
                repairable: dependency.repairable,
            });
            continue;
        }

        let preferred_candidate = match dependency.executable {
            "uv" => managed_uv,
            _ => None,
        };
        let preferred_path = if let Some(candidate) = preferred_candidate
            && tokio::fs::metadata(candidate)
                .await
                .is_ok_and(|metadata| metadata.is_file())
        {
            Some(candidate.to_path_buf())
        } else {
            None
        };
        let runtime_source = preferred_path.as_ref().map(|_| RuntimeSource::Managed);
        let path = match preferred_path {
            Some(path) => Some(path),
            None => utils::shell::resolve_executable_path(dependency.executable).await,
        };
        let mut passed = path.is_some();
        let mut version = None;
        let mut detail = match runtime_source {
            Some(RuntimeSource::System) => {
                format!("使用系统安装。要求：{}", dependency.requirement)
            }
            Some(RuntimeSource::Managed) => {
                format!("使用 VibeX 托管版本。要求：{}", dependency.requirement)
            }
            None => format!("要求：{}", dependency.requirement),
        };
        if let Some(executable) = path.as_ref() {
            let mut command = utils::process::new_hidden_tokio_command(
                executable,
                dependency.version_args.iter().copied(),
            );
            command.kill_on_drop(true);
            if passed {
                match tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
                    .await
                {
                    Ok(Ok(output)) if output.status.success() => {
                        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                        let observed = if stdout.is_empty() { stderr } else { stdout };
                        version = (!observed.is_empty()).then_some(observed.clone());
                        if let Some(satisfied) =
                            dependency_version_satisfied(dependency.requirement, &observed)
                        {
                            passed = satisfied;
                            if !satisfied {
                                detail = format!("当前版本不满足 {}。", dependency.requirement);
                            }
                        }
                    }
                    Ok(Ok(output)) => {
                        passed = false;
                        detail = utils::process::command_output_detail(&output)
                            .unwrap_or_else(|| "版本检查失败。".to_string());
                    }
                    Ok(Err(error)) => {
                        passed = false;
                        detail = format!("无法运行版本检查：{error}");
                    }
                    Err(_) => {
                        passed = false;
                        detail = "版本检查超时。".to_string();
                    }
                }
            }
        } else {
            detail = format!(
                "未找到 {}。要求：{}",
                dependency.executable, dependency.requirement
            );
        }
        if dependency.required && !passed {
            required_ok = false;
        }
        items.push(AgentPreflightItemView {
            id: format!("dependency.{}", dependency.id),
            label: dependency.label.to_string(),
            status: if passed {
                "pass".to_string()
            } else if dependency.required {
                "fail".to_string()
            } else {
                "warning".to_string()
            },
            detail,
            version,
            path: path.map(|path| path.display().to_string()),
            source: runtime_source.map(|_| AgentPreflightSource::System),
            repairable: dependency.repairable,
        });
    }
    (items, required_ok)
}

fn dependency_version_satisfied(requirement: &str, output: &str) -> Option<bool> {
    if !requirement.trim_start().starts_with(['>', '<', '=']) {
        return None;
    }
    let version = normalized_semver(output)?;
    let requirement = semver::VersionReq::parse(requirement).ok()?;
    Some(requirement.matches(&version))
}

fn normalized_semver(output: &str) -> Option<semver::Version> {
    static VERSION: OnceLock<regex::Regex> = OnceLock::new();
    let regex = VERSION
        .get_or_init(|| regex::Regex::new(r"(?i)\bv?(\d+(?:\.\d+){0,2})").expect("version regex"));
    let version = regex.captures(output)?.get(1)?.as_str();
    let mut parts = version.split('.').collect::<Vec<_>>();
    while parts.len() < 3 {
        parts.push("0");
    }
    semver::Version::parse(&parts.join(".")).ok()
}

#[tauri::command]
pub async fn agent_management_repair(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentOperationReceipt, AgentManagementErrorView> {
    let pool = &state.deployment.db().pool;
    if let Some(receipt) =
        revalidate_external_installation(&app, pool, &agent_id, AgentOperationKind::Repair).await?
    {
        return Ok(receipt);
    }
    if let Some(receipt) =
        try_adopt_user_environment(&app, pool, &agent_id, AgentOperationKind::Repair).await?
    {
        return Ok(receipt);
    }
    queue_operation(&app, pool, agent_id, AgentOperationKind::Repair).await
}

#[tauri::command]
pub async fn agent_management_check_update(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentUpdateCheckView, AgentManagementErrorView> {
    let current_version = sqlx::query_scalar::<_, String>(
        r#"SELECT lock.registry_version
           FROM agent_installation installation
           JOIN agent_install_lock lock ON lock.id = installation.current_lock_id
           WHERE installation.agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?;
    let snapshot = AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(
        state.deployment.db().pool.clone(),
    ))
    .load()
    .await
    .map_err(internal_error)?;
    let available_version = snapshot.as_ref().and_then(|snapshot| {
        snapshot
            .entries
            .iter()
            .find(|entry| entry.agent_id == agent_id)
            .map(|entry| entry.version.clone())
    });
    let fresh = snapshot.as_ref().is_some_and(|snapshot| {
        Utc::now().signed_duration_since(snapshot.fetched_at) <= Duration::hours(24)
    });
    Ok(AgentUpdateCheckView {
        agent_id,
        update_available: current_version
            .as_ref()
            .zip(available_version.as_ref())
            .is_some_and(|(current, available)| current != available),
        current_version,
        available_version,
        snapshot_id: snapshot.as_ref().map(|snapshot| snapshot.id.to_string()),
        fetched_at: snapshot
            .as_ref()
            .map(|snapshot| snapshot.fetched_at.to_rfc3339()),
        fresh,
    })
}

#[tauri::command]
pub async fn agent_management_apply_update(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentOperationReceipt, AgentManagementErrorView> {
    queue_operation(
        &app,
        &state.deployment.db().pool,
        agent_id,
        AgentOperationKind::Update,
    )
    .await
}

#[tauri::command]
pub async fn agent_management_install_version(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
    version: String,
) -> Result<AgentOperationReceipt, AgentManagementErrorView> {
    queue_operation_with_version(
        &app,
        &state.deployment.db().pool,
        agent_id,
        AgentOperationKind::Install,
        Some(&version),
    )
    .await
}

#[tauri::command]
pub async fn agent_management_rollback(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentManagementView, AgentManagementErrorView> {
    let installation =
        sqlx::query_as::<_, (Option<String>, Option<String>, Option<String>, String)>(
            r#"SELECT active_operation, current_lock_id, rollback_lock_id, ownership
           FROM agent_installation
           WHERE agent_id = ?"#,
        )
        .bind(agent_id.as_str())
        .fetch_optional(&state.deployment.db().pool)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| {
            management_error(
                AgentManagementErrorCode::NotFound,
                format!("Agent `{agent_id}` has not been added"),
                Some(agent_id.clone()),
            )
        })?;
    if installation.0.is_some() {
        return Err(management_error(
            AgentManagementErrorCode::Busy,
            "Agent 已有正在执行的管理操作",
            Some(agent_id),
        ));
    }
    let rollback_lock_id = installation.2.as_deref().ok_or_else(|| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            "Agent 没有可回滚的上一版本",
            Some(agent_id.clone()),
        )
    })?;
    let mut cli_switch = None;
    if installation.3 == "managed" {
        let current_runtime = match installation.1.as_deref() {
            Some(lock_id) => managed_runtime_cli_for_lock(&state.deployment.db().pool, lock_id)
                .await
                .map_err(internal_error)?,
            None => None,
        };
        let rollback_runtime =
            managed_runtime_cli_for_lock(&state.deployment.db().pool, rollback_lock_id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| {
                    management_error(
                        AgentManagementErrorCode::InvalidState,
                        "上一版本没有有效的本地 Runtime",
                        Some(agent_id.clone()),
                    )
                })?;
        let managed_artifacts_dir =
            app_managed_artifacts_directory(&app).map_err(internal_error)?;
        let home_dir = app.path().home_dir().map_err(internal_error)?;
        let root =
            managed_install_root(&managed_artifacts_dir, &agent_id).map_err(internal_error)?;
        let shell = configured_shell_family();
        let _ = utils::shell::refresh_process_path_after_install().await;
        switch_managed_runtime_cli(
            &home_dir,
            &agent_id,
            &root,
            current_runtime
                .as_ref()
                .map(|runtime| runtime.runtime_executable.as_path()),
            &rollback_runtime.runtime_executable,
            &rollback_runtime.runtime_path_entries,
            shell,
        )
        .map_err(internal_error)?;
        cli_switch = Some((home_dir, root, current_runtime, rollback_runtime, shell));
    }
    let update = sqlx::query(
        r#"UPDATE agent_installation
           SET current_lock_id = rollback_lock_id,
               rollback_lock_id = current_lock_id,
               lifecycle = 'ready',
               updated_at = CURRENT_TIMESTAMP
           WHERE agent_id = ? AND rollback_lock_id IS NOT NULL"#,
    )
    .bind(agent_id.as_str())
    .execute(&state.deployment.db().pool)
    .await;
    let changed = match update {
        Ok(result) => result.rows_affected(),
        Err(error) => {
            if let Some((home, root, current, rollback, shell)) = &cli_switch
                && let Err(restore_error) = restore_managed_cli_switch(
                    home,
                    &agent_id,
                    root,
                    current.as_ref(),
                    &rollback.runtime_executable,
                    *shell,
                )
            {
                tracing::error!(
                    agent_id = %agent_id,
                    %restore_error,
                    "failed to restore terminal command after rollback database failure"
                );
            }
            return Err(internal_error(error));
        }
    };
    if changed == 0 {
        if let Some((home, root, current, rollback, shell)) = &cli_switch
            && let Err(error) = restore_managed_cli_switch(
                home,
                &agent_id,
                root,
                current.as_ref(),
                &rollback.runtime_executable,
                *shell,
            )
        {
            tracing::error!(
                agent_id = %agent_id,
                %error,
                "failed to restore terminal command after rejected rollback"
            );
        }
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            "Agent 没有可回滚的上一版本",
            Some(agent_id),
        ));
    }
    sqlx::query("DELETE FROM agent_probe WHERE agent_id = ?")
        .bind(agent_id.as_str())
        .execute(&state.deployment.db().pool)
        .await
        .map_err(internal_error)?;
    let _ = utils::shell::refresh_process_path_after_install().await;
    agent_management_detail(state, agent_id).await
}

async fn queue_operation(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: AgentId,
    kind: AgentOperationKind,
) -> Result<AgentOperationReceipt, AgentManagementErrorView> {
    queue_operation_with_version(app, pool, agent_id, kind, None).await
}

async fn revalidate_external_installation(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    kind: AgentOperationKind,
) -> Result<Option<AgentOperationReceipt>, AgentManagementErrorView> {
    let installation = sqlx::query_as::<_, (String, Option<String>)>(
        r#"SELECT ownership, current_lock_id
           FROM agent_installation
           WHERE agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?;
    if !installation
        .as_ref()
        .is_some_and(|(ownership, lock_id)| ownership == "external" && lock_id.is_some())
    {
        return Ok(None);
    }
    if !user_environment_lock_satisfies_plan(pool, agent_id).await? {
        return Ok(None);
    }

    // External files remain owned by their installer. The install/repair action
    // only refreshes evidence when the locked versions already satisfy the plan.
    refresh_agent_management_evidence(app, pool, true).await?;
    let lifecycle = sqlx::query_scalar::<_, String>(
        "SELECT lifecycle FROM agent_installation WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_one(pool)
    .await
    .map_err(internal_error)?;
    let _ = app.emit(MANAGEMENT_INVALIDATED_EVENT, ());
    if lifecycle != "ready" {
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            "外部 Agent 安装未通过官方验证；未执行托管安装，请查看诊断或使用原安装方式修复",
            Some(agent_id.clone()),
        ));
    }
    Ok(Some(AgentOperationReceipt {
        operation_id: Uuid::new_v4().to_string(),
        agent_id: agent_id.clone(),
        kind,
        status: AgentOperationStatus::Succeeded,
    }))
}

async fn user_environment_lock_satisfies_plan(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<bool, AgentManagementErrorView> {
    let Ok(plan) = resolve_install_plan(pool, agent_id).await else {
        return Ok(false);
    };
    let lock_id = sqlx::query_scalar::<_, Option<String>>(
        "SELECT current_lock_id FROM agent_installation WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?
    .flatten();
    let Some(lock_id) = lock_id else {
        return Ok(false);
    };
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT component_kind, version FROM agent_install_component WHERE lock_id = ?",
    )
    .bind(&lock_id)
    .fetch_all(pool)
    .await
    .map_err(internal_error)?;
    let observed = rows
        .into_iter()
        .map(|(component_id, version)| ObservedUserComponent {
            component_id,
            version: Some(version),
        })
        .collect::<Vec<_>>();
    Ok(matches!(
        decide_user_environment_adopt(&plan_required_components(&plan), &observed),
        UserEnvironmentAdoptDecision::Adopt
    ))
}

/// Bind a user-environment install (PATH) as the current external lock.
/// After a data wipe this is the preferred repair/install path only when
/// the leftover CLI is complete and at least as new as the Profile pin.
async fn try_adopt_user_environment(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    kind: AgentOperationKind,
) -> Result<Option<AgentOperationReceipt>, AgentManagementErrorView> {
    let catalog = BuiltInProfileCatalog::bundled();
    let Some(profile) = catalog.profile(agent_id) else {
        return Ok(None);
    };
    let _ = utils::shell::refresh_process_path_after_install().await;
    let Ok(local_runtime) = discover_profile_local_runtime(pool, profile).await else {
        return Ok(None);
    };
    if probe_one_built_in_external_installation(app, pool, profile, &local_runtime)
        .await
        .is_err()
    {
        return Ok(None);
    }
    let _ = app.emit(MANAGEMENT_INVALIDATED_EVENT, ());
    Ok(Some(AgentOperationReceipt {
        operation_id: Uuid::new_v4().to_string(),
        agent_id: agent_id.clone(),
        kind,
        status: AgentOperationStatus::Succeeded,
    }))
}

async fn queue_operation_with_version(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: AgentId,
    kind: AgentOperationKind,
    version_override: Option<&str>,
) -> Result<AgentOperationReceipt, AgentManagementErrorView> {
    let kind_key = operation_kind_key(kind);
    let mut plan = match kind {
        AgentOperationKind::Repair => match resolve_repair_plan(pool, &agent_id).await {
            Ok(plan) => Ok(plan),
            Err(_) => resolve_install_plan(pool, &agent_id).await,
        },
        _ => resolve_install_plan(pool, &agent_id).await,
    }
    .map_err(|error| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            error.to_string(),
            Some(agent_id.clone()),
        )
    })?;
    if let Some(version) = version_override {
        apply_custom_version_override(&mut plan, version).map_err(|message| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                message,
                Some(agent_id.clone()),
            )
        })?;
    }
    let frozen_plan_json = serde_json::to_string(&plan).map_err(internal_error)?;
    let resource_claims = install_resource_claims(&plan);
    let operation = InstallationOperationRepository::new(pool.clone())
        .enqueue(NewInstallationOperation {
            agent_id: agent_id.clone(),
            kind: kind_key.to_string(),
            frozen_plan_json,
            host_instance_id: host_instance_id().to_string(),
            resource_claims,
            staging_path: None,
        })
        .await
        .map_err(|error| match error {
            error if error.to_string().contains("UNIQUE constraint failed") => management_error(
                AgentManagementErrorCode::Busy,
                "Agent 已有正在执行的管理操作，或所需共享资源正被占用",
                Some(agent_id.clone()),
            ),
            error => internal_error(error),
        })?;
    let operation_id = operation.id.to_string();
    let cancellation = OperationScheduler::shared()
        .cancellations
        .register(&operation_id);
    emit_operation(
        app,
        agent_id.clone(),
        &operation_id,
        kind,
        AgentOperationStatus::Queued,
        Some(0),
        None,
    );
    let app = app.clone();
    let pool = pool.clone();
    let operation_agent_id = agent_id.clone();
    let operation_id_for_task = operation_id.clone();
    tauri::async_runtime::spawn(async move {
        run_install_operation(
            app,
            pool,
            operation_agent_id,
            operation_id_for_task,
            kind,
            plan,
            cancellation,
        )
        .await;
    });
    Ok(AgentOperationReceipt {
        operation_id,
        agent_id,
        kind,
        status: AgentOperationStatus::Queued,
    })
}

fn apply_custom_version_override(
    plan: &mut ResolvedInstallPlan,
    requested: &str,
) -> Result<(), String> {
    if !matches!(
        plan.source,
        LockedInstallSource::BuiltInProfile
            | LockedInstallSource::BuiltInProfileWithRegistry { .. }
    ) {
        return Err("指定版本安装仅适用于内置 Agent".to_string());
    }
    let version = sanitize_custom_version(requested)
        .ok_or_else(|| format!("无效的指定版本：{}", requested.trim()))?;
    let pinned_version = plan.version.clone();
    let mut changed = false;
    for component in &mut plan.components {
        if !matches!(
            component.component_id.as_str(),
            "agent_runtime" | "combined_runtime" | "acp_adapter"
        ) {
            continue;
        }
        match component.distribution_kind {
            PlannedDistributionKind::Npx => {
                let package = npm_package_name(&component.resolved_source)
                    .map_err(|error| error.to_string())?;
                component.resolved_source = format!("{package}@{version}");
                component.trust = ArtifactTrust::EcosystemIntegrityRequired;
            }
            PlannedDistributionKind::Binary => {
                if pinned_version.is_empty() || !component.resolved_source.contains(&pinned_version)
                {
                    return Err("当前二进制下载地址无法安全替换指定版本".to_string());
                }
                component.resolved_source =
                    component.resolved_source.replace(&pinned_version, &version);
                component.trust = ArtifactTrust::Tofu;
            }
            PlannedDistributionKind::Uvx => {
                return Err("uvx Agent 不支持指定版本安装".to_string());
            }
        }
        component.version.clone_from(&version);
        changed = true;
    }
    if !changed {
        return Err("Agent 的安装方案没有可替换的 Runtime 组件".to_string());
    }
    plan.version = version;
    Ok(())
}

fn sanitize_custom_version(input: &str) -> Option<String> {
    let trimmed = input.trim();
    let normalized = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    if normalized.len() > 128 || !normalized.contains('.') {
        return None;
    }
    let mut characters = normalized.chars();
    if !characters.next()?.is_ascii_digit() {
        return None;
    }
    normalized
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+'))
        .then(|| normalized.to_string())
}

async fn run_install_operation(
    app: AppHandle,
    pool: sqlx::SqlitePool,
    agent_id: AgentId,
    operation_id: String,
    kind: AgentOperationKind,
    plan: ResolvedInstallPlan,
    cancellation: CancellationToken,
) {
    let scheduler = OperationScheduler::shared();
    let _global = tokio::select! {
        permit = scheduler.global.acquire() => {
            permit.expect("Agent operation semaphore remains open")
        }
        () = cancellation.cancelled() => {
            finish_canceled_operation(&app, &pool, &agent_id, &operation_id, kind).await;
            scheduler.cancellations.remove(&operation_id);
            return;
        }
    };
    let agent_lock = scheduler.agent_lock(&agent_id);
    let _agent = tokio::select! {
        guard = agent_lock.lock() => guard,
        () = cancellation.cancelled() => {
            finish_canceled_operation(&app, &pool, &agent_id, &operation_id, kind).await;
            scheduler.cancellations.remove(&operation_id);
            return;
        }
    };
    let lifecycle = match kind {
        AgentOperationKind::Update => "updating",
        AgentOperationKind::Repair => "repairing",
        _ => "installing",
    };
    if let Ok(operation_uuid) = Uuid::parse_str(&operation_id)
        && let Err(error) = InstallationOperationRepository::new(pool.clone())
            .mark_running(operation_uuid, host_instance_id())
            .await
    {
        finish_failed_operation(
            &app,
            &pool,
            &agent_id,
            &operation_id,
            kind,
            error.to_string(),
        )
        .await;
        return;
    }
    if let Err(error) = sqlx::query(
        "UPDATE agent_installation SET lifecycle = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
    )
    .bind(lifecycle)
    .bind(agent_id.as_str())
    .execute(&pool)
    .await
    {
        finish_failed_operation(&app, &pool, &agent_id, &operation_id, kind, error.to_string()).await;
        return;
    }
    emit_operation(
        &app,
        agent_id.clone(),
        &operation_id,
        kind,
        AgentOperationStatus::Running,
        Some(5),
        Some("正在解析已锁定的安装方案".to_string()),
    );

    let result = async {
        let managed_artifacts_dir = app_managed_artifacts_directory(&app)?;
        let root = managed_install_root(&managed_artifacts_dir, &agent_id)?;
        tokio::fs::create_dir_all(&root).await?;
        let lock_id = Uuid::new_v4();
        let staging = root.join(format!(".staging-{lock_id}"));
        if let Ok(operation_uuid) = Uuid::parse_str(&operation_id) {
            InstallationOperationRepository::new(pool.clone())
                .set_staging_path(operation_uuid, &staging.display().to_string())
                .await?;
        }
        tokio::fs::create_dir_all(&staging).await?;
        emit_operation(
            &app,
            agent_id.clone(),
            &operation_id,
            kind,
            AgentOperationStatus::Running,
            Some(20),
            Some("正在安装本地 Runtime 与 ACP".to_string()),
        );
        let custom_builtin_binary = matches!(
            plan.source,
            LockedInstallSource::BuiltInProfile
                | LockedInstallSource::BuiltInProfileWithRegistry { .. }
        ) && plan.components.iter().any(|component| {
            component.distribution_kind == PlannedDistributionKind::Binary
                && matches!(component.trust, ArtifactTrust::Tofu)
        });
        let tofu_fingerprints = if custom_builtin_binary {
            HashMap::new()
        } else {
            previous_tofu_fingerprints(&pool, &agent_id).await?
        };
        let install_log = OperationLogEmitter::new(&app, &agent_id, &operation_id, kind);
        let installation = async {
            let node_runtime = if plan
                .components
                .iter()
                .any(|component| component.distribution_kind == PlannedDistributionKind::Npx)
            {
                Some(
                    resolve_node_runtime(
                        &managed_artifacts_dir,
                        &plan.agent_id,
                        &cancellation,
                        &install_log,
                    )
                    .await?,
                )
            } else {
                None
            };
            let managed_uv = if plan
                .components
                .iter()
                .any(|component| component.distribution_kind == PlannedDistributionKind::Uvx)
            {
                Some(ensure_managed_uv(&managed_artifacts_dir, &cancellation, &install_log).await?)
            } else {
                None
            };
            let home_dir = app
                .path()
                .home_dir()
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let user_env = UserEnvironmentLayout::for_current_user(home_dir);
            prepare_user_environment(&user_env).await?;
            install_locked_plan(
                &plan,
                &staging,
                &user_env,
                &cancellation,
                &tofu_fingerprints,
                Some(&install_log),
                node_runtime.as_ref(),
                managed_uv.as_deref(),
            )
            .await
        }
        .await;
        let installation = match installation {
            Ok(installation) => installation,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&staging).await;
                return Err(error);
            }
        };
        emit_operation(
            &app,
            agent_id.clone(),
            &operation_id,
            kind,
            AgentOperationStatus::Running,
            Some(75),
            Some("正在验证 ACP 握手".to_string()),
        );
        if let Err(error) = verify_acp_handshake(
            &agent_id,
            &installation.launch_lock,
            &staging,
            &cancellation,
        )
        .await
        {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(error);
        }
        if cancellation.is_cancelled() {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            anyhow::bail!("operation canceled");
        }
        let _ = tokio::fs::remove_dir_all(&staging).await;
        emit_operation(
            &app,
            agent_id.clone(),
            &operation_id,
            kind,
            AgentOperationStatus::Running,
            Some(85),
            Some("正在绑定用户环境命令".to_string()),
        );
        persist_installed_lock(&pool, lock_id, &plan, &installation, "external").await?;
        let _ = utils::shell::refresh_process_path_after_install().await;
        record_post_install_probe(&app, &pool, &agent_id).await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;

    match result {
        Ok(()) => {
            let _ = sqlx::query(
                "UPDATE agent_installation SET lifecycle = 'ready', active_operation = NULL, active_operation_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
            )
            .bind(agent_id.as_str())
            .execute(&pool)
            .await;
            if let Ok(operation_uuid) = Uuid::parse_str(&operation_id) {
                let _ = InstallationOperationRepository::new(pool.clone())
                    .finish(operation_uuid, "succeeded")
                    .await;
            }
            emit_operation(
                &app,
                agent_id,
                &operation_id,
                kind,
                AgentOperationStatus::Succeeded,
                Some(100),
                Some("安装与 ACP 验证完成".to_string()),
            );
        }
        Err(_error) if cancellation.is_cancelled() => {
            finish_canceled_operation(&app, &pool, &agent_id, &operation_id, kind).await;
        }
        Err(error) => {
            finish_failed_operation(
                &app,
                &pool,
                &agent_id,
                &operation_id,
                kind,
                redact_operation_output(&error.to_string()),
            )
            .await;
        }
    }
    scheduler.cancellations.remove(&operation_id);
}

async fn record_post_install_probe(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> anyhow::Result<()> {
    #[derive(serde::Deserialize)]
    struct LockedPayload {
        absolute_acp_program: PathBuf,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        runtime_version: String,
        acp_version: String,
    }

    let resolved_json = sqlx::query_scalar::<_, String>(
        r#"SELECT lock.resolved_json
           FROM agent_installation installation
           JOIN agent_install_lock lock ON lock.id = installation.current_lock_id
           WHERE installation.agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .fetch_one(pool)
    .await?;
    let payload: LockedPayload = serde_json::from_str(&resolved_json)?;
    let mut launch_env = payload.env.into_iter().collect::<HashMap<_, _>>();
    let configured_env = read_agent_environment(pool, agent_id)
        .await
        .map_err(|error| anyhow::anyhow!(error.message))?;
    launch_env.extend(configured_env);
    launch_env.remove("PI_ACP_TRUST_WORKSPACE");
    let mut launch_args = payload.args;
    agents::apply_built_in_launch_policy(agent_id, &mut launch_env, &mut launch_args);
    let launch_lock = SessionLaunchLock {
        agent_id: agent_id.clone(),
        absolute_acp_program: payload.absolute_acp_program,
        args: launch_args,
        env: launch_env.into_iter().collect(),
        runtime_version: payload.runtime_version,
        acp_version: payload.acp_version,
    };
    let working_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| anyhow::anyhow!(error.to_string()))?
        .join("agents")
        .join(agent_id.as_str());
    tokio::fs::create_dir_all(&working_dir).await?;
    let capabilities = probe_acp_capabilities(
        agent_id,
        &launch_lock,
        &working_dir,
        &CancellationToken::new(),
    )
    .await?;
    let native_authentication = if let Ok(home) = app.path().home_dir() {
        let agent_env = read_agent_environment(pool, agent_id)
            .await
            .map_err(|error| anyhow::anyhow!(error.message))?;
        let account_logged_in = resolve_native_account_login(&home, agent_id, &agent_env).await;
        let provider = NativeConfigProvider::with_environment(
            Arc::new(TokioNativeFileSystem),
            home,
            agent_env.into_iter().collect(),
        );
        match provider.read(agent_id, account_logged_in).await {
            Ok(snapshot) => snapshot.authentication,
            Err(agents::NativeConfigError::Unsupported(_)) => {
                AgentAuthenticationStatus::NotRequired
            }
            Err(error) => return Err(error.into()),
        }
    } else {
        AgentAuthenticationStatus::NotRequired
    };
    let authentication_required_by_default = BuiltInProfileCatalog::bundled()
        .profile(agent_id)
        .is_some_and(|profile| profile.authentication_required_by_default);
    let (observed, authentication_required) = resolve_authentication_observation(
        native_authentication,
        capabilities.authentication.as_ref(),
        authentication_required_by_default,
    );
    let authentication = recorded_account_over_residue(pool, agent_id, observed).await;
    sync_authentication_probe_with_requirement(
        pool,
        agent_id,
        authentication,
        authentication_required
            && !matches!(
                authentication,
                AgentAuthenticationStatus::Account | AgentAuthenticationStatus::ApiKey
            ),
    )
    .await
    .map_err(|error| anyhow::anyhow!(error.message))
}

async fn resolve_native_account_login(
    home: &Path,
    agent_id: &AgentId,
    environment: &HashMap<String, String>,
) -> bool {
    let local = detect_account_login(home, agent_id, environment).await;
    let document = match agent_id.as_str() {
        "codex" => read_account_evidence_document(home, agent_id, environment).await,
        _ => None,
    };
    agents::account_still_present(
        local,
        agents::confirm_account_session(agent_id, local, document.as_ref()).await,
    )
}

async fn read_account_evidence_document(
    home: &Path,
    agent_id: &AgentId,
    environment: &HashMap<String, String>,
) -> Option<serde_json::Value> {
    let bytes = read_account_evidence_bytes(home, agent_id, environment).await?;
    serde_json::from_slice(&bytes).ok()
}

async fn detect_account_login(
    home: &Path,
    agent_id: &AgentId,
    environment: &HashMap<String, String>,
) -> bool {
    if agent_id.as_str() == "cursor" {
        return agents::cursor_account_token().await.is_some();
    }
    let Some(bytes) = read_account_evidence_bytes(home, agent_id, environment).await else {
        return false;
    };
    serde_json::from_slice::<serde_json::Value>(&bytes).is_ok_and(|value| {
        if agent_id.as_str() == "kimi_code" && kimi_credential_is_synthetic(&value) {
            return false;
        }
        BuiltInProfileCatalog::bundled()
            .profile(agent_id)
            .and_then(|profile| profile.account_evidence.as_ref())
            .is_some_and(|evidence| evidence.matches(&value))
    })
}

async fn read_account_evidence_bytes(
    home: &Path,
    agent_id: &AgentId,
    environment: &HashMap<String, String>,
) -> Option<Vec<u8>> {
    let catalog = BuiltInProfileCatalog::bundled();
    let evidence = catalog
        .profile(agent_id)
        .and_then(|profile| profile.account_evidence.as_ref())?;
    let override_directory = evidence.directory_override_env.and_then(|name| {
        environment
            .get(name)
            .filter(|value| !value.trim().is_empty())
            .map(|value| expand_agent_home_path(home, value))
            .or_else(|| {
                std::env::var_os(name)
                    .filter(|value| !value.is_empty())
                    .map(|value| expand_agent_home_path(home, &value.to_string_lossy()))
            })
    });
    let directory = override_directory
        .map(|directory| directory.join(evidence.override_relative_directory))
        .unwrap_or_else(|| home.join(evidence.home_relative_directory));
    tokio::fs::read(directory.join(evidence.relative_file))
        .await
        .ok()
}

fn expand_agent_home_path(home: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value.trim());
    if path == Path::new("~") {
        return home.to_path_buf();
    }
    if let Ok(relative) = path.strip_prefix("~/") {
        return home.join(relative);
    }
    if path.is_relative() {
        return home.join(path);
    }
    path
}

fn resolve_agent_home_directory(
    home: &Path,
    environment: &HashMap<String, String>,
    variable: &str,
    fallback: &str,
) -> PathBuf {
    environment
        .get(variable)
        .filter(|value| !value.trim().is_empty())
        .map(|value| expand_agent_home_path(home, value))
        .or_else(|| {
            std::env::var_os(variable)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| home.join(fallback))
}

async fn resolve_install_plan(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> anyhow::Result<ResolvedInstallPlan> {
    let _ = utils::shell::refresh_process_path_after_install().await;
    // Npx plans can bootstrap VibeX's pinned, checksum-verified Node.js
    // distribution. A clean machine therefore remains install-capable without
    // trusting or mutating a user-managed PATH runtime.
    let node_verified = (utils::shell::resolve_executable_path("node")
        .await
        .is_some()
        && utils::shell::resolve_executable_path("npm").await.is_some())
        || managed_node_artifact(&agents::current_platform()).is_some();
    // Hermes can use VibeX's pinned, checksum-verified uv distribution when no
    // system uv is available. Treat supported platforms as install-capable so
    // planning can proceed to the managed-tool bootstrap in run_operation.
    let uv_verified = utils::shell::resolve_executable_path("uv").await.is_some()
        || managed_uv_artifact(&agents::current_platform()).is_some();
    let python_verified = utils::shell::resolve_executable_path("python3")
        .await
        .is_some()
        || utils::shell::resolve_executable_path("python")
            .await
            .is_some();
    let environment = InstallEnvironment {
        node_verified,
        uv_verified,
        python_verified,
    };
    let membership = AgentMembershipRepository::new(pool.clone())
        .find(agent_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Agent 尚未添加"))?;
    let source = match membership.source {
        AgentSource::BuiltInProfile => {
            // ADR-0038 方向 A:存在 fresh Registry snapshot 且该内置 Agent 有
            // registry binding 时,更新目标解析自 snapshot;离线/过期回退
            // Profile 锁版本。
            let store =
                AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(pool.clone()));
            let snapshot = store.load().await?;
            let registry_target = snapshot
                .filter(|snapshot| {
                    Utc::now().signed_duration_since(snapshot.fetched_at) <= Duration::hours(24)
                })
                .and_then(|snapshot| {
                    agents::registry_target_for_built_in_update(
                        &agents::BuiltInProfileCatalog::bundled(),
                        &snapshot,
                        agent_id,
                    )
                });
            match registry_target {
                Some(target) => {
                    InstallCandidateSource::BuiltInProfileWithRegistry(Box::new(target))
                }
                None => InstallCandidateSource::BuiltInProfile,
            }
        }
        AgentSource::OfficialRegistry => {
            let store =
                AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(pool.clone()));
            let snapshot = store
                .load()
                .await?
                .ok_or_else(|| anyhow::anyhow!("ACP Registry 缓存为空，请先刷新注册表"))?;
            if Utc::now().signed_duration_since(snapshot.fetched_at) > Duration::hours(24) {
                anyhow::bail!("ACP Registry 快照已过期，请先刷新注册表");
            }
            let entry = snapshot
                .entries
                .iter()
                .find(|entry| &entry.agent_id == agent_id)
                .ok_or_else(|| anyhow::anyhow!("Agent 已从当前 ACP Registry 下架，无法重新安装"))?;
            InstallCandidateSource::Registry(Box::new(entry.lock_add_target(snapshot.id)))
        }
        AgentSource::UserDefinition => {
            let target = AgentManagementApplicationService::new(pool.clone())
                .user_install_target(agent_id)
                .await?
                .ok_or_else(|| anyhow::anyhow!("手动 Agent 缺少已保存的发行定义"))?;
            InstallCandidateSource::UserDefinition(Box::new(target))
        }
        AgentSource::RetiredLegacy => {
            anyhow::bail!("已退役的 Agent 无法安装")
        }
    };
    InstallPlanner::bundled()
        .plan(InstallPlanningInput {
            agent_id: agent_id.clone(),
            source,
            platform: agents::current_platform(),
            environment,
        })
        .map_err(Into::into)
}

async fn resolve_repair_plan(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> anyhow::Result<ResolvedInstallPlan> {
    let resolved_json = sqlx::query_scalar::<_, String>(
        r#"SELECT lock.resolved_json
           FROM agent_installation installation
           JOIN agent_install_lock lock ON lock.id = installation.current_lock_id
           WHERE installation.agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| anyhow::anyhow!("Agent 没有可用于修复的 current Installation lock"))?;
    let value: serde_json::Value = serde_json::from_str(&resolved_json)?;
    let plan = value.get("frozen_plan").cloned().ok_or_else(|| {
        anyhow::anyhow!("现有 Installation lock 缺少可复现修复计划，需要重新安装")
    })?;
    serde_json::from_value(plan).map_err(Into::into)
}

fn install_resource_claims(plan: &ResolvedInstallPlan) -> Vec<String> {
    let mut claims = vec![
        format!("agent:{}", plan.agent_id),
        format!("shim:{}", plan.agent_id),
        format!("target:{}", plan.agent_id),
    ];
    for component in &plan.components {
        match component.distribution_kind {
            PlannedDistributionKind::Npx => {
                claims.push("runtime:node".to_string());
                claims.push("cache:npm".to_string());
            }
            PlannedDistributionKind::Uvx => {
                claims.push("runtime:python".to_string());
                claims.push("runtime:uv".to_string());
                claims.push("cache:uv".to_string());
            }
            PlannedDistributionKind::Binary => {}
        }
    }
    claims.sort();
    claims.dedup();
    claims
}

struct InstalledComponent {
    kind: String,
    absolute_path: PathBuf,
    version: String,
    sha256: Option<String>,
    trust_state: String,
    ownership: String,
    shared_resource_key: Option<String>,
}

struct InstalledPlan {
    launch_lock: SessionLaunchLock,
    components: Vec<InstalledComponent>,
}

struct OperationLogEmitter<'a> {
    app: &'a AppHandle,
    agent_id: &'a AgentId,
    operation_id: &'a str,
    kind: AgentOperationKind,
    emitted_lines: AtomicUsize,
}

impl<'a> OperationLogEmitter<'a> {
    fn new(
        app: &'a AppHandle,
        agent_id: &'a AgentId,
        operation_id: &'a str,
        kind: AgentOperationKind,
    ) -> Self {
        Self {
            app,
            agent_id,
            operation_id,
            kind,
            emitted_lines: AtomicUsize::new(0),
        }
    }

    fn emit(&self, message: impl AsRef<str>) {
        if self.emitted_lines.fetch_add(1, Ordering::Relaxed) >= 200 {
            return;
        }
        let message = redact_operation_output(message.as_ref());
        if message.trim().is_empty() {
            return;
        }
        emit_operation(
            self.app,
            self.agent_id.clone(),
            self.operation_id,
            self.kind,
            AgentOperationStatus::Running,
            None,
            Some(message),
        );
    }
}

fn node_requirement_for_agent(agent_id: &AgentId) -> &'static str {
    BuiltInProfileCatalog::bundled()
        .profile(agent_id)
        .and_then(|profile| {
            profile
                .dependencies
                .iter()
                .find(|dependency| dependency.id == "node")
        })
        .map(|dependency| dependency.requirement)
        .unwrap_or(">=20")
}

fn command_version_text(output: &std::process::Output) -> Option<String> {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    [stdout, stderr].into_iter().find(|value| !value.is_empty())
}

async fn probe_system_node_runtime(
    node: PathBuf,
    npm: PathBuf,
    requirement: &str,
) -> anyhow::Result<NodeRuntime> {
    for (label, executable) in [("Node.js", &node), ("npm", &npm)] {
        if !executable.is_absolute()
            || !tokio::fs::metadata(executable)
                .await
                .is_ok_and(|metadata| metadata.is_file())
        {
            anyhow::bail!(
                "system {label} candidate is not an absolute executable file: {}",
                executable.display()
            );
        }
    }

    let bin_dir = node
        .parent()
        .ok_or_else(|| anyhow::anyhow!("system Node.js executable has no parent directory"))?
        .to_path_buf();
    let mut node_command = agent_process_command(&node);
    node_command.arg("--version").kill_on_drop(true);
    let node_output = tokio::time::timeout(LOCAL_RUNTIME_VERSION_TIMEOUT, node_command.output())
        .await
        .map_err(|_| anyhow::anyhow!("system Node.js version check timed out"))??;
    ensure_success("system Node.js version check", &node_output)?;
    let node_version_output = command_version_text(&node_output)
        .ok_or_else(|| anyhow::anyhow!("system Node.js version check returned no version"))?;
    let node_compatible = dependency_version_satisfied(requirement, &node_version_output)
        .ok_or_else(|| anyhow::anyhow!("system Node.js returned an invalid version"))?;
    if !node_compatible {
        anyhow::bail!("system Node.js {node_version_output} does not satisfy {requirement}");
    }
    let version = normalized_semver(&node_version_output)
        .ok_or_else(|| anyhow::anyhow!("system Node.js returned an invalid version"))?
        .to_string();

    let mut npm_command = agent_process_command(&npm);
    npm_command.arg("--version").kill_on_drop(true);
    prepend_command_path(&mut npm_command, &bin_dir)?;
    let npm_output = tokio::time::timeout(LOCAL_RUNTIME_VERSION_TIMEOUT, npm_command.output())
        .await
        .map_err(|_| anyhow::anyhow!("system npm version check timed out"))??;
    ensure_success("system npm version check", &npm_output)?;
    let npm_version = command_version_text(&npm_output)
        .and_then(|output| normalized_semver(&output))
        .ok_or_else(|| anyhow::anyhow!("system npm returned an invalid version"))?;
    if npm_version.major == 0 {
        anyhow::bail!("system npm returned an invalid version");
    }

    Ok(NodeRuntime {
        node,
        npm,
        bin_dir,
        version,
        npm_version: Some(npm_version.to_string()),
        source: RuntimeSource::System,
    })
}

async fn discover_system_node_runtime(requirement: &str) -> anyhow::Result<NodeRuntime> {
    let node = utils::shell::resolve_executable_path("node")
        .await
        .ok_or_else(|| anyhow::anyhow!("system Node.js was not found"))?;
    let sibling_npm = node
        .parent()
        .map(|directory| directory.join(if cfg!(windows) { "npm.cmd" } else { "npm" }));
    let npm = match sibling_npm {
        Some(path)
            if tokio::fs::metadata(&path)
                .await
                .is_ok_and(|metadata| metadata.is_file()) =>
        {
            path
        }
        _ => utils::shell::resolve_executable_path(if cfg!(windows) { "npm.cmd" } else { "npm" })
            .await
            .ok_or_else(|| anyhow::anyhow!("system npm was not found"))?,
    };
    let node = tokio::fs::canonicalize(node).await?;
    probe_system_node_runtime(node, npm, requirement).await
}

async fn resolve_existing_node_runtime(
    requirement: &str,
    managed_runtime: Option<&NodeRuntime>,
) -> Option<NodeRuntime> {
    if let Ok(runtime) = discover_system_node_runtime(requirement).await {
        return Some(runtime);
    }
    let runtime = managed_runtime?;
    if dependency_version_satisfied(requirement, &runtime.version) != Some(true) {
        return None;
    }
    verify_managed_node_runtime(runtime.clone()).await
}

async fn resolve_node_runtime(
    managed_artifacts_dir: &Path,
    agent_id: &AgentId,
    cancellation: &CancellationToken,
    log: &OperationLogEmitter<'_>,
) -> anyhow::Result<NodeRuntime> {
    let requirement = node_requirement_for_agent(agent_id);
    match discover_system_node_runtime(requirement).await {
        Ok(runtime) => {
            log.emit(format!(
                "Using system Node.js {}: {}",
                runtime.version,
                runtime.node.display()
            ));
            return Ok(runtime);
        }
        Err(error) => {
            log.emit(format!(
                "System Node.js is unavailable or incompatible ({error}); falling back to VibeX-managed Node.js {MANAGED_NODE_VERSION}"
            ));
        }
    }

    if dependency_version_satisfied(requirement, MANAGED_NODE_VERSION) != Some(true) {
        anyhow::bail!(
            "VibeX-managed Node.js {MANAGED_NODE_VERSION} does not satisfy {requirement}"
        );
    }
    ensure_managed_node(managed_artifacts_dir, cancellation, log).await
}

async fn verify_managed_node_runtime(mut runtime: NodeRuntime) -> Option<NodeRuntime> {
    if !tokio::fs::metadata(&runtime.node)
        .await
        .is_ok_and(|metadata| metadata.is_file())
        || !tokio::fs::metadata(&runtime.npm)
            .await
            .is_ok_and(|metadata| metadata.is_file())
    {
        return None;
    }
    let mut node_command = agent_process_command(&runtime.node);
    node_command.arg("--version").kill_on_drop(true);
    let node_output = tokio::time::timeout(LOCAL_RUNTIME_VERSION_TIMEOUT, node_command.output())
        .await
        .ok()?
        .ok()?;
    let expected_node_version = format!("v{MANAGED_NODE_VERSION}");
    if !node_output.status.success()
        || command_version_text(&node_output).as_deref() != Some(expected_node_version.as_str())
    {
        return None;
    }

    let mut npm_command = agent_process_command(&runtime.npm);
    npm_command.arg("--version").kill_on_drop(true);
    prepend_command_path(&mut npm_command, &runtime.bin_dir).ok()?;
    let npm_output = tokio::time::timeout(LOCAL_RUNTIME_VERSION_TIMEOUT, npm_command.output())
        .await
        .ok()?
        .ok()?;
    if !npm_output.status.success() {
        return None;
    }
    let npm_version =
        command_version_text(&npm_output).and_then(|value| normalized_semver(&value))?;
    if npm_version.major == 0 {
        return None;
    }
    runtime.npm_version = Some(npm_version.to_string());
    Some(runtime)
}

fn managed_uv_version_matches(output: &str) -> bool {
    let mut fields = output.split_whitespace();
    matches!(
        (fields.next(), fields.next()),
        (Some("uv"), Some(version)) if version == MANAGED_UV_VERSION
    )
}

async fn managed_uv_is_healthy(executable: &Path) -> bool {
    if !tokio::fs::metadata(executable)
        .await
        .is_ok_and(|metadata| metadata.is_file())
    {
        return false;
    }
    let mut command = agent_process_command(executable);
    command.arg("--version").kill_on_drop(true);
    matches!(
        tokio::time::timeout(std::time::Duration::from_secs(5), command.output()).await,
        Ok(Ok(output)) if output.status.success() && {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let observed = if stdout.trim().is_empty() { &stderr } else { &stdout };
            managed_uv_version_matches(observed.trim())
        }
    )
}

async fn ensure_managed_node(
    managed_artifacts_dir: &Path,
    cancellation: &CancellationToken,
    log: &OperationLogEmitter<'_>,
) -> anyhow::Result<NodeRuntime> {
    let platform = agents::current_platform();
    let artifact = managed_node_artifact(&platform)
        .ok_or_else(|| anyhow::anyhow!("Node.js 不支持当前平台 {platform}"))?;
    let runtime = managed_node_executables(managed_artifacts_dir)
        .ok_or_else(|| anyhow::anyhow!("无法解析托管 Node.js 路径"))?;
    if let Some(runtime) = verify_managed_node_runtime(runtime.clone()).await {
        log.emit(format!(
            "Using managed Node.js {MANAGED_NODE_VERSION}: {}",
            runtime.node.display()
        ));
        return Ok(runtime);
    }

    let base = managed_artifacts_dir
        .join("agent-tools")
        .join("node")
        .join(MANAGED_NODE_VERSION);
    tokio::fs::create_dir_all(&base).await?;
    let staging = base.join(format!(".staging-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&staging).await?;
    let filename = format!(
        "node-v{MANAGED_NODE_VERSION}-{}.{}",
        artifact.target, artifact.extension
    );
    let url = format!("https://nodejs.org/dist/v{MANAGED_NODE_VERSION}/{filename}");
    log.emit(format!(
        "Downloading managed Node.js {MANAGED_NODE_VERSION} ({platform})"
    ));
    let result = async {
        let response = tokio::select! {
            response = reqwest::get(&url) => response?,
            () = cancellation.cancelled() => anyhow::bail!("operation canceled"),
        };
        if !response.status().is_success() {
            anyhow::bail!("Node.js download returned HTTP {}", response.status());
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_MANAGED_NODE_BYTES as u64)
        {
            anyhow::bail!("Node.js archive exceeds the 128 MiB size limit");
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = tokio::select! {
            chunk = stream.next() => chunk,
            () = cancellation.cancelled() => anyhow::bail!("operation canceled"),
        } {
            let chunk = chunk?;
            if bytes.len().saturating_add(chunk.len()) > MAX_MANAGED_NODE_BYTES {
                anyhow::bail!("Node.js archive exceeds the 128 MiB size limit");
            }
            bytes.extend_from_slice(&chunk);
        }
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(artifact.sha256) {
            anyhow::bail!(
                "Node.js archive SHA-256 mismatch: expected {}, found {actual}",
                artifact.sha256
            );
        }
        extract_binary_archive(&bytes, &url, &staging, cancellation).await?;
        clear_macos_quarantine(&staging)?;

        let staged_root = staging.join(format!("node-v{MANAGED_NODE_VERSION}-{}", artifact.target));
        let staged_bin = if cfg!(windows) {
            staged_root
        } else {
            staged_root.join("bin")
        };
        for expected in [
            staged_bin.join(if cfg!(windows) { "node.exe" } else { "node" }),
            staged_bin.join(if cfg!(windows) { "npm.cmd" } else { "npm" }),
        ] {
            if !tokio::fs::metadata(&expected)
                .await
                .is_ok_and(|metadata| metadata.is_file())
            {
                anyhow::bail!(
                    "Node.js archive did not contain expected executable {}",
                    expected.display()
                );
            }
        }

        let final_root = base.join(&platform);
        if tokio::fs::metadata(&final_root).await.is_ok() {
            let aside = base.join(format!(".invalid-{}", Uuid::new_v4()));
            tokio::fs::rename(&final_root, &aside).await?;
            if let Err(error) = tokio::fs::rename(&staging, &final_root).await {
                let _ = tokio::fs::rename(&aside, &final_root).await;
                return Err(error.into());
            }
            let _ = tokio::fs::remove_dir_all(aside).await;
        } else {
            tokio::fs::rename(&staging, &final_root).await?;
        }
        let runtime = verify_managed_node_runtime(runtime).await.ok_or_else(|| {
            anyhow::anyhow!("installed managed Node.js or npm failed its version health check")
        })?;
        log.emit(format!(
            "Managed Node.js {MANAGED_NODE_VERSION} verified and installed"
        ));
        Ok(runtime)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
    }
    result
}

async fn ensure_managed_uv(
    managed_artifacts_dir: &Path,
    cancellation: &CancellationToken,
    log: &OperationLogEmitter<'_>,
) -> anyhow::Result<PathBuf> {
    let platform = agents::current_platform();
    let artifact = managed_uv_artifact(&platform)
        .ok_or_else(|| anyhow::anyhow!("uv 不支持当前平台 {platform}"))?;
    let final_executable = managed_uv_executable(managed_artifacts_dir)
        .ok_or_else(|| anyhow::anyhow!("无法解析托管 uv 路径"))?;
    if managed_uv_is_healthy(&final_executable).await {
        log.emit(format!(
            "Using managed uv {MANAGED_UV_VERSION}: {}",
            final_executable.display()
        ));
        return Ok(final_executable);
    }

    let base = managed_artifacts_dir.join("agent-tools").join("uv");
    tokio::fs::create_dir_all(&base).await?;
    let staging = base.join(format!(".staging-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&staging).await?;
    let filename = format!("uv-{}.{}", artifact.target, artifact.extension);
    let url = format!(
        "https://github.com/astral-sh/uv/releases/download/{MANAGED_UV_VERSION}/{filename}"
    );
    log.emit(format!(
        "Downloading managed uv {MANAGED_UV_VERSION} ({platform})"
    ));
    let result = async {
        let response = tokio::select! {
            response = reqwest::get(&url) => response?,
            () = cancellation.cancelled() => anyhow::bail!("operation canceled"),
        };
        if !response.status().is_success() {
            anyhow::bail!("uv download returned HTTP {}", response.status());
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_MANAGED_UV_BYTES as u64)
        {
            anyhow::bail!("uv archive exceeds the 128 MiB size limit");
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = tokio::select! {
            chunk = stream.next() => chunk,
            () = cancellation.cancelled() => anyhow::bail!("operation canceled"),
        } {
            let chunk = chunk?;
            if bytes.len().saturating_add(chunk.len()) > MAX_MANAGED_UV_BYTES {
                anyhow::bail!("uv archive exceeds the 128 MiB size limit");
            }
            bytes.extend_from_slice(&chunk);
        }
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(artifact.sha256) {
            anyhow::bail!(
                "uv archive SHA-256 mismatch: expected {}, found {actual}",
                artifact.sha256
            );
        }
        extract_binary_archive(&bytes, &url, &staging, cancellation).await?;
        clear_macos_quarantine(&staging)?;
        let staged_executable = staging
            .join(format!("uv-{}", artifact.target))
            .join(if cfg!(windows) { "uv.exe" } else { "uv" });
        if !tokio::fs::metadata(&staged_executable)
            .await
            .is_ok_and(|metadata| metadata.is_file())
        {
            anyhow::bail!("uv archive did not contain the expected executable");
        }
        let final_root = final_executable
            .ancestors()
            .nth(2)
            .ok_or_else(|| anyhow::anyhow!("托管 uv 目标路径无效"))?
            .to_path_buf();
        if tokio::fs::metadata(&final_root).await.is_ok() {
            let aside = base.join(format!(".invalid-{}", Uuid::new_v4()));
            tokio::fs::rename(&final_root, &aside).await?;
            if let Err(error) = tokio::fs::rename(&staging, &final_root).await {
                let _ = tokio::fs::rename(&aside, &final_root).await;
                return Err(error.into());
            }
            let _ = tokio::fs::remove_dir_all(aside).await;
        } else {
            if let Some(parent) = final_root.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            tokio::fs::rename(&staging, &final_root).await?;
        }
        if !managed_uv_is_healthy(&final_executable).await {
            anyhow::bail!("installed managed uv failed its version health check");
        }
        log.emit(format!(
            "Managed uv {MANAGED_UV_VERSION} verified and installed"
        ));
        Ok(final_executable)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
    }
    result
}

async fn prepare_user_environment(layout: &UserEnvironmentLayout) -> anyhow::Result<()> {
    tokio::fs::create_dir_all(&layout.user_bin).await?;
    tokio::fs::create_dir_all(&layout.npm_bin).await?;
    tokio::fs::create_dir_all(&layout.uv_tool_dir).await?;
    for directory in layout.path_entries() {
        utils::shell::expose_user_bin_to_process_path(&directory);
    }
    let _ = ensure_user_cli_path(&layout.home, configured_shell_family());
    #[cfg(windows)]
    {
        let _ = ensure_user_cli_path(&layout.home, ShellFamily::Windows);
    }
    let _ = utils::shell::refresh_process_path_after_install().await;
    Ok(())
}

async fn existing_user_environment_component(
    component: &PlannedInstallComponent,
) -> Option<(PathBuf, String)> {
    let command = component.command.trim();
    if command.is_empty() || command == "npm" || command == "uv" {
        return None;
    }
    let executable = utils::shell::resolve_executable_path(command).await?;
    let executable = tokio::fs::canonicalize(&executable).await.ok()?;
    let version = probe_installed_component_version(&executable).await?;
    if agents::version_at_least(&version, &component.version) {
        Some((executable, version))
    } else {
        None
    }
}

async fn probe_installed_component_version(executable: &Path) -> Option<String> {
    let mut command = agent_process_command(executable);
    command.arg("--version").kill_on_drop(true);
    let output = tokio::time::timeout(EXTERNAL_COMPONENT_VERSION_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = if stdout.trim().is_empty() {
        stderr
    } else {
        stdout
    };
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

async fn install_locked_plan(
    plan: &ResolvedInstallPlan,
    staging: &Path,
    user_env: &UserEnvironmentLayout,
    cancellation: &CancellationToken,
    previous_tofu_fingerprints: &HashMap<String, String>,
    log: Option<&OperationLogEmitter<'_>>,
    node_runtime: Option<&NodeRuntime>,
    managed_uv: Option<&Path>,
) -> anyhow::Result<InstalledPlan> {
    let mut components = Vec::new();
    let mut path_entries = user_env.path_entries();
    if let Some(runtime) = node_runtime {
        path_entries.insert(0, runtime.bin_dir.clone());
    }
    for (index, component) in plan.components.iter().enumerate() {
        if let Some((absolute_path, version)) = existing_user_environment_component(component).await
        {
            if let Some(log) = log {
                log.emit(format!(
                    "Reusing user-environment {} {} at {}",
                    component.component_id,
                    version,
                    absolute_path.display()
                ));
            }
            let sha256 = format!(
                "{:x}",
                Sha256::digest(tokio::fs::read(&absolute_path).await?)
            );
            components.push(InstalledComponent {
                kind: component.component_id.clone(),
                absolute_path,
                version,
                sha256: Some(sha256),
                trust_state: "user_environment".to_string(),
                ownership: "external".to_string(),
                shared_resource_key: None,
            });
            continue;
        }
        let component_root = staging.join(format!("{index}-{}", component.component_id));
        tokio::fs::create_dir_all(&component_root).await?;
        clear_macos_quarantine(&component_root).map_err(|error| {
            anyhow::anyhow!(
                "failed to prepare user-environment staging directory {}: {error}",
                component_root.display()
            )
        })?;
        let (absolute_path, mut sha256, trust_state) = match component.distribution_kind {
            PlannedDistributionKind::Npx => {
                if let Some(log) = log {
                    let package = npm_package_name(&component.resolved_source)
                        .unwrap_or(&component.component_id);
                    log.emit(format!(
                        "$ npm install -g --force --prefix {} {package}@{}",
                        user_env.npm_prefix.display(),
                        component.version
                    ));
                }
                verify_npm_integrity(
                    &component.resolved_source,
                    &component.trust,
                    cancellation,
                    node_runtime,
                )
                .await?;
                let mut command = agent_process_command(
                    node_runtime
                        .map(|runtime| runtime.npm.as_path())
                        .unwrap_or_else(|| Path::new("npm")),
                );
                if let Some(runtime) = node_runtime {
                    prepend_command_path(&mut command, &runtime.bin_dir)?;
                }
                command.args(npm_global_install_args(
                    &user_env.npm_prefix,
                    &component.resolved_source,
                ));
                let output = if let Some(log) = log {
                    cancellable_command_output_streaming(command, cancellation, log).await?
                } else {
                    cancellable_command_output(command, cancellation).await?
                };
                ensure_success("npm install -g", &output)?;
                path_entries.push(user_env.npm_bin.clone());
                let executable = resolve_npm_package_executable(
                    &user_env.npm_global_root(),
                    &user_env.npm_bin,
                    &component.resolved_source,
                )
                .await?;
                (
                    executable,
                    None,
                    match component.trust {
                        ArtifactTrust::EcosystemIntegrity { .. } => "verified_integrity",
                        _ => "ecosystem_verified",
                    }
                    .to_string(),
                )
            }
            PlannedDistributionKind::Uvx => {
                let mut command =
                    agent_process_command(managed_uv.unwrap_or_else(|| Path::new("uv")));
                configure_uv_tool_install_command(
                    &mut command,
                    user_env,
                    &component.resolved_source,
                );
                if let Some(log) = log {
                    log.emit(format!(
                        "$ uv tool install {} ({})",
                        component.component_id, component.version
                    ));
                }
                let output = if let Some(log) = log {
                    cancellable_command_output_streaming(command, cancellation, log).await?
                } else {
                    cancellable_command_output(command, cancellation).await?
                };
                ensure_success("uv tool install", &output)?;
                path_entries.push(user_env.uv_tool_bin.clone());
                let executable = resolve_uv_tool_executable(
                    &user_env.uv_tool_bin,
                    &component.resolved_source,
                    &component.command,
                )
                .await?;
                (executable, None, "ecosystem_verified".to_string())
            }
            PlannedDistributionKind::Binary => {
                if let Some(log) = log {
                    log.emit(format!(
                        "Downloading {} ({})",
                        component.component_id, component.version
                    ));
                }
                let response = tokio::select! {
                    response = reqwest::get(&component.resolved_source) => response?,
                    () = cancellation.cancelled() => anyhow::bail!("operation canceled"),
                };
                if !response.status().is_success() {
                    anyhow::bail!("binary download returned HTTP {}", response.status());
                }
                if response
                    .content_length()
                    .is_some_and(|length| length > MAX_AGENT_BINARY_BYTES as u64)
                {
                    anyhow::bail!("binary download exceeds the 512 MiB size limit");
                }
                let mut stream = response.bytes_stream();
                let mut bytes = Vec::new();
                while let Some(chunk) = stream.next().await {
                    let chunk = chunk?;
                    if bytes.len().saturating_add(chunk.len()) > MAX_AGENT_BINARY_BYTES {
                        anyhow::bail!("binary download exceeds the 512 MiB size limit");
                    }
                    bytes.extend_from_slice(&chunk);
                }
                let verified = verify_artifact_bytes(
                    &component.trust,
                    &bytes,
                    previous_tofu_fingerprints
                        .get(&component.component_id)
                        .map(|sha256| TofuFingerprint {
                            sha256: sha256.clone(),
                        })
                        .as_ref(),
                )?;
                extract_binary_archive(
                    &bytes,
                    &component.resolved_source,
                    &component_root,
                    cancellation,
                )
                .await?;
                if let Some(log) = log {
                    log.emit(format!("Extracted {}", component.component_id));
                }
                let staged = safe_archive_executable(&component_root, &component.command)?;
                let executable =
                    publish_user_bin_executable(&user_env.user_bin, &component.command, &staged)
                        .await?;
                publish_required_binary_siblings(&plan.agent_id, &user_env.user_bin, &staged)
                    .await?;
                path_entries.push(user_env.user_bin.clone());
                (
                    executable,
                    Some(verified.sha256),
                    match component.trust {
                        ArtifactTrust::ExpectedSha256 { .. } => "verified_sha256",
                        ArtifactTrust::Tofu => "tofu",
                        _ => "verified_integrity",
                    }
                    .to_string(),
                )
            }
        };
        #[cfg(target_os = "macos")]
        {
            let quarantine_root = component_root.clone();
            tokio::task::spawn_blocking(move || clear_macos_quarantine(&quarantine_root))
                .await
                .map_err(|error| {
                    anyhow::anyhow!("managed runtime quarantine task failed: {error}")
                })?
                .map_err(|error| {
                    anyhow::anyhow!(
                        "failed to clear quarantine from managed runtime {}: {error}",
                        component_root.display()
                    )
                })?;
        }
        if !absolute_path.is_absolute() || tokio::fs::metadata(&absolute_path).await.is_err() {
            anyhow::bail!(
                "installed component `{}` has no executable at {}",
                component.component_id,
                absolute_path.display()
            );
        }
        if sha256.is_none() {
            let bytes = tokio::fs::read(&absolute_path).await?;
            sha256 = Some(format!("{:x}", Sha256::digest(bytes)));
        }
        components.push(InstalledComponent {
            kind: component.component_id.clone(),
            absolute_path,
            version: component.version.clone(),
            sha256,
            trust_state,
            ownership: "external".to_string(),
            shared_resource_key: None,
        });
    }
    let acp = components
        .iter()
        .find(|component| component.kind == "acp_adapter" || component.kind == "combined_runtime")
        .ok_or_else(|| anyhow::anyhow!("安装方案没有 ACP 可执行组件"))?;
    let runtime = components
        .iter()
        .find(|component| component.kind == "agent_runtime" || component.kind == "combined_runtime")
        .ok_or_else(|| anyhow::anyhow!("安装方案没有本地 Runtime 组件"))?;
    let mut env = build_launch_environment(
        &plan.components,
        &path_entries,
        std::env::var_os("PATH").unwrap_or_default(),
    )?;
    bind_profile_runtime_executable(&plan.agent_id, &runtime.absolute_path, &mut env);
    Ok(InstalledPlan {
        launch_lock: SessionLaunchLock {
            agent_id: plan.agent_id.clone(),
            absolute_acp_program: acp.absolute_path.clone(),
            args: plan
                .components
                .iter()
                .find(|component| component.component_id == acp.kind)
                .map(|component| component.args.clone())
                .unwrap_or_default(),
            env,
            runtime_version: runtime.version.clone(),
            acp_version: acp.version.clone(),
        },
        components,
    })
}

fn configure_uv_tool_install_command(
    command: &mut tokio::process::Command,
    user_env: &UserEnvironmentLayout,
    package: &str,
) {
    command
        .arg("tool")
        .arg("install")
        .arg("--force")
        .arg("--no-config");
    // Hermes pins 3.13 upstream because its dependency set is not compatible
    // with every machine-default Python. uv owns and downloads this runtime,
    // so a system python executable is deliberately not an install gate.
    if package.starts_with("hermes-agent[") {
        command.arg("--python").arg("3.13");
    }
    command
        .arg(package)
        .env("UV_TOOL_DIR", &user_env.uv_tool_dir)
        .env("UV_TOOL_BIN_DIR", &user_env.uv_tool_bin)
        .env("UV_PYTHON_INSTALL_DIR", &user_env.uv_python_dir)
        .env("UV_CACHE_DIR", &user_env.uv_cache_dir);
}

async fn publish_user_bin_executable(
    user_bin: &Path,
    command: &str,
    staged: &Path,
) -> anyhow::Result<PathBuf> {
    tokio::fs::create_dir_all(user_bin).await?;
    let file_name = if cfg!(windows) {
        let raw = Path::new(command)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(command);
        if raw.to_ascii_lowercase().ends_with(".cmd")
            || raw.to_ascii_lowercase().ends_with(".exe")
            || raw.to_ascii_lowercase().ends_with(".bat")
        {
            raw.to_string()
        } else if staged
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("cmd"))
        {
            format!("{raw}.cmd")
        } else {
            format!("{raw}.exe")
        }
    } else {
        Path::new(command)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(command)
            .to_string()
    };
    let destination = user_bin.join(file_name);
    tokio::fs::copy(staged, &destination).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = tokio::fs::metadata(&destination).await?.permissions();
        permissions.set_mode(0o755);
        tokio::fs::set_permissions(&destination, permissions).await?;
    }
    Ok(tokio::fs::canonicalize(&destination)
        .await
        .unwrap_or(destination))
}

async fn publish_required_binary_siblings(
    agent_id: &AgentId,
    user_bin: &Path,
    staged_executable: &Path,
) -> anyhow::Result<()> {
    let Some(profile) = BuiltInProfileCatalog::bundled().profile(agent_id).cloned() else {
        return Ok(());
    };
    let windows = cfg!(windows);
    let siblings = profile.binary_required_siblings(windows);
    if siblings.is_empty() {
        return Ok(());
    }
    let Some(staged_dir) = staged_executable.parent() else {
        anyhow::bail!("binary archive entry has no parent directory");
    };
    for sibling in siblings {
        let name = Path::new(sibling)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(sibling);
        let source = staged_dir.join(name);
        if !source.is_file() {
            anyhow::bail!("extracted archive is missing required sibling `{name}`");
        }
        let destination = user_bin.join(name);
        tokio::fs::copy(&source, &destination).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = tokio::fs::metadata(&destination).await?.permissions();
            permissions.set_mode(0o755);
            tokio::fs::set_permissions(&destination, permissions).await?;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn clear_macos_quarantine(root: &Path) -> std::io::Result<()> {
    fn visit(path: &Path) -> std::io::Result<()> {
        let quarantine = std::ffi::OsStr::new("com.apple.quarantine");
        if xattr::list_deref(path)?.any(|attribute| attribute == quarantine) {
            xattr::remove_deref(path, quarantine)?;
        }

        let metadata = std::fs::symlink_metadata(path)?;
        if metadata.is_dir() {
            for entry in std::fs::read_dir(path)? {
                visit(&entry?.path())?;
            }
        }
        Ok(())
    }

    visit(root)
}

#[cfg(not(target_os = "macos"))]
fn clear_macos_quarantine(_root: &Path) -> std::io::Result<()> {
    Ok(())
}

fn build_launch_environment(
    components: &[PlannedInstallComponent],
    path_entries: &[PathBuf],
    inherited_path: OsString,
) -> anyhow::Result<BTreeMap<String, String>> {
    let mut env = BTreeMap::new();
    for component in components {
        for (key, value) in &component.env {
            if let Some(existing) = env.insert(key.clone(), value.clone())
                && existing != *value
            {
                anyhow::bail!("installation components declare conflicting `{key}` values");
            }
        }
    }
    if !path_entries.is_empty() {
        let inherited = env
            .remove("PATH")
            .map(OsString::from)
            .unwrap_or(inherited_path);
        let mut joined = path_entries.to_vec();
        joined.extend(std::env::split_paths(&inherited));
        env.insert(
            "PATH".to_string(),
            std::env::join_paths(joined)?.to_string_lossy().to_string(),
        );
    }
    Ok(env)
}

fn prepend_command_path(command: &mut tokio::process::Command, path: &Path) -> anyhow::Result<()> {
    let mut entries = vec![path.to_path_buf()];
    entries.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    command.env("PATH", std::env::join_paths(entries)?);
    Ok(())
}

async fn verify_npm_integrity(
    source: &str,
    trust: &ArtifactTrust,
    cancellation: &CancellationToken,
    node_runtime: Option<&NodeRuntime>,
) -> anyhow::Result<()> {
    if !matches!(
        trust,
        ArtifactTrust::EcosystemIntegrity { .. } | ArtifactTrust::EcosystemIntegrityRequired
    ) {
        return Ok(());
    }
    let mut command = agent_process_command(
        node_runtime
            .map(|runtime| runtime.npm.as_path())
            .unwrap_or_else(|| Path::new("npm")),
    );
    if let Some(runtime) = node_runtime {
        prepend_command_path(&mut command, &runtime.bin_dir)?;
    }
    command.args([
        "view",
        source,
        "dist.integrity",
        "--json",
        "--registry=https://registry.npmjs.org",
    ]);
    let output = cancellable_command_output(command, cancellation).await?;
    ensure_success("npm view dist.integrity", &output)?;
    let actual = String::from_utf8_lossy(&output.stdout)
        .trim()
        .trim_matches('"')
        .to_string();
    if !actual.starts_with("sha512-") && !actual.starts_with("sha256-") {
        anyhow::bail!("npm package did not publish a valid dist.integrity value");
    }
    if let ArtifactTrust::EcosystemIntegrity { integrity } = trust
        && &actual != integrity
    {
        anyhow::bail!("npm package integrity mismatch");
    }
    Ok(())
}

async fn previous_tofu_fingerprints(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> anyhow::Result<HashMap<String, String>> {
    Ok(sqlx::query_as::<_, (String, String)>(
        r#"SELECT component.component_kind, component.sha256
           FROM agent_installation installation
           JOIN agent_install_component component
             ON component.lock_id = installation.current_lock_id
           WHERE installation.agent_id = ?
             AND component.trust_state = 'tofu'
             AND component.sha256 IS NOT NULL"#,
    )
    .bind(agent_id.as_str())
    .fetch_all(pool)
    .await?
    .into_iter()
    .collect())
}

async fn cancellable_command_output(
    mut command: tokio::process::Command,
    cancellation: &CancellationToken,
) -> anyhow::Result<std::process::Output> {
    command.kill_on_drop(true);
    tokio::select! {
        output = command.output() => Ok(output?),
        () = cancellation.cancelled() => anyhow::bail!("operation canceled"),
    }
}

async fn cancellable_command_output_streaming(
    mut command: tokio::process::Command,
    cancellation: &CancellationToken,
    log: &OperationLogEmitter<'_>,
) -> anyhow::Result<std::process::Output> {
    use std::process::Stdio;

    const MAX_CAPTURE_BYTES: usize = 4 * 1024 * 1024;
    command
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("安装进程 stdout 不可用"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| anyhow::anyhow!("安装进程 stderr 不可用"))?;
    let (sender, mut receiver) = mpsc::unbounded_channel::<Vec<u8>>();
    let sent_lines = Arc::new(AtomicUsize::new(0));
    let stdout_task = tokio::spawn(collect_process_stream(
        stdout,
        sender.clone(),
        sent_lines.clone(),
        MAX_CAPTURE_BYTES,
    ));
    let stderr_task = tokio::spawn(collect_process_stream(
        stderr,
        sender,
        sent_lines,
        MAX_CAPTURE_BYTES,
    ));

    let status = loop {
        tokio::select! {
            result = child.wait() => break result?,
            line = receiver.recv() => {
                if let Some(line) = line {
                    log.emit(String::from_utf8_lossy(&line));
                }
            }
            () = cancellation.cancelled() => {
                let _ = child.kill().await;
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                anyhow::bail!("operation canceled");
            }
        }
    };
    let stdout = stdout_task
        .await
        .map_err(|error| anyhow::anyhow!("stdout task failed: {error}"))??;
    let stderr = stderr_task
        .await
        .map_err(|error| anyhow::anyhow!("stderr task failed: {error}"))??;
    while let Ok(line) = receiver.try_recv() {
        log.emit(String::from_utf8_lossy(&line));
    }
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

async fn collect_process_stream<R>(
    stream: R,
    sender: mpsc::UnboundedSender<Vec<u8>>,
    sent_lines: Arc<AtomicUsize>,
    max_capture_bytes: usize,
) -> std::io::Result<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncBufReadExt;

    let mut reader = tokio::io::BufReader::new(stream);
    let mut captured = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line).await?;
        if read == 0 {
            break;
        }
        let remaining = max_capture_bytes.saturating_sub(captured.len());
        captured.extend_from_slice(&line[..line.len().min(remaining)]);
        if sent_lines.fetch_add(1, Ordering::Relaxed) < 200 {
            let without_newline = line.strip_suffix(b"\n").unwrap_or(&line);
            let trimmed = without_newline
                .strip_suffix(b"\r")
                .unwrap_or(without_newline);
            let _ = sender.send(trimmed.to_vec());
        }
    }
    Ok(captured)
}

fn ensure_success(label: &str, output: &std::process::Output) -> anyhow::Result<()> {
    if output.status.success() {
        return Ok(());
    }
    anyhow::bail!(
        "{label} failed: {}",
        redact_operation_output(&String::from_utf8_lossy(&output.stderr))
    )
}

fn npm_executable(bin_dir: &Path, command: &str) -> PathBuf {
    #[cfg(windows)]
    {
        bin_dir.join(format!("{command}.cmd"))
    }
    #[cfg(not(windows))]
    {
        bin_dir.join(command)
    }
}

#[derive(serde::Deserialize)]
struct NpmPackageManifest {
    name: String,
    bin: NpmPackageBins,
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum NpmPackageBins {
    Single(String),
    Named(BTreeMap<String, String>),
}

async fn resolve_npm_package_executable(
    component_root: &Path,
    bin_dir: &Path,
    package_spec: &str,
) -> anyhow::Result<PathBuf> {
    let package_name = npm_package_name(package_spec)?;
    let package_root = package_name.split('/').try_fold(
        component_root.join("node_modules"),
        |path, segment| {
            if segment.is_empty()
                || segment == "."
                || segment == ".."
                || !segment.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'-' | b'_' | b'.')
                })
            {
                anyhow::bail!("npm package name contains an unsafe path segment");
            }
            Ok(path.join(segment))
        },
    )?;
    let manifest_bytes = tokio::fs::read(package_root.join("package.json")).await?;
    let manifest: NpmPackageManifest = serde_json::from_slice(&manifest_bytes)?;
    if manifest.name != package_name {
        anyhow::bail!(
            "installed npm package name `{}` does not match locked package `{package_name}`",
            manifest.name
        );
    }
    let preferred = package_name
        .rsplit('/')
        .next()
        .expect("validated npm package name has a final segment");
    let command = match manifest.bin {
        NpmPackageBins::Single(path) => {
            if path.trim().is_empty() {
                anyhow::bail!("npm package `{package_name}` publishes an empty binary path");
            }
            preferred.to_string()
        }
        NpmPackageBins::Named(bins) => {
            if bins.is_empty() {
                anyhow::bail!("npm package `{package_name}` publishes no executable");
            }
            if let Some(path) = bins.get(preferred) {
                if path.trim().is_empty() {
                    anyhow::bail!(
                        "npm package `{package_name}` publishes an empty binary path for `{preferred}`"
                    );
                }
                preferred.to_string()
            } else if bins.len() == 1 {
                let (command, path) = bins.into_iter().next().expect("one-entry npm bin map");
                if path.trim().is_empty() {
                    anyhow::bail!(
                        "npm package `{package_name}` publishes an empty binary path for `{command}`"
                    );
                }
                command
            } else if bins
                .values()
                .next()
                .is_some_and(|first| bins.values().all(|path| path == first))
            {
                let (command, path) = bins.into_iter().next().expect("non-empty npm alias map");
                if path.trim().is_empty() {
                    anyhow::bail!(
                        "npm package `{package_name}` publishes an empty binary path for `{command}`"
                    );
                }
                command
            } else {
                anyhow::bail!(
                    "npm package `{package_name}` publishes multiple executables without a canonical `{preferred}` entry"
                );
            }
        }
    };
    let executable = npm_executable(bin_dir, &command);
    if tokio::fs::metadata(&executable).await.is_err() {
        anyhow::bail!(
            "npm package `{package_name}` did not create executable `{}`",
            executable.display()
        );
    }
    Ok(executable)
}

fn npm_package_name(package_spec: &str) -> anyhow::Result<&str> {
    let separator = if package_spec.starts_with('@') {
        let slash = package_spec
            .find('/')
            .ok_or_else(|| anyhow::anyhow!("invalid scoped npm package spec `{package_spec}`"))?;
        package_spec[slash + 1..]
            .rfind('@')
            .map(|offset| slash + 1 + offset)
    } else {
        package_spec.rfind('@').filter(|separator| *separator > 0)
    }
    .ok_or_else(|| anyhow::anyhow!("npm package spec is not version-locked: `{package_spec}`"))?;
    let package_name = &package_spec[..separator];
    if package_name.is_empty() {
        anyhow::bail!("npm package spec has no package name");
    }
    Ok(package_name)
}

async fn resolve_uv_tool_executable(
    bin_dir: &Path,
    package_spec: &str,
    preferred_command: &str,
) -> anyhow::Result<PathBuf> {
    let package_name = uv_distribution_name(package_spec)
        .ok_or_else(|| anyhow::anyhow!("uv package spec has an invalid distribution name"))?;
    let normalized_package_name = normalize_python_command(package_name);
    let mut entries = tokio::fs::read_dir(bin_dir).await?;
    let mut executables = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if tokio::fs::metadata(&path)
            .await
            .is_ok_and(|metadata| metadata.is_file())
        {
            executables.push(path);
        }
    }
    executables.sort();
    if executables.is_empty() {
        anyhow::bail!("uv tool install for `{package_name}` produced no local executable");
    }
    let normalized_preferred_command = normalize_python_command(preferred_command);
    if let Some(executable) = executables.iter().find(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| normalize_python_command(name) == normalized_preferred_command)
    }) {
        return Ok(executable.clone());
    }
    if let Some(executable) = executables.iter().find(|path| {
        path.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| normalize_python_command(name) == normalized_package_name)
    }) {
        return Ok(executable.clone());
    }
    if executables.len() == 1 {
        return Ok(executables.remove(0));
    }
    let names = executables
        .iter()
        .filter_map(|path| path.file_name().and_then(|name| name.to_str()))
        .collect::<Vec<_>>()
        .join(", ");
    anyhow::bail!(
        "uv package `{package_name}` publishes multiple executables without a canonical entry: {names}"
    )
}

fn normalize_python_command(value: &str) -> String {
    let lowercase = value.to_ascii_lowercase();
    let without_windows_suffix = [".exe", ".cmd", ".bat"]
        .into_iter()
        .find_map(|suffix| lowercase.strip_suffix(suffix))
        .unwrap_or(&lowercase);
    without_windows_suffix
        .chars()
        .map(|character| match character {
            '_' | '.' => '-',
            other => other,
        })
        .collect()
}

async fn extract_binary_archive(
    bytes: &[u8],
    source: &str,
    destination: &Path,
    cancellation: &CancellationToken,
) -> anyhow::Result<()> {
    if source.to_ascii_lowercase().ends_with(".zip") {
        let bytes = bytes.to_vec();
        let destination = destination.to_path_buf();
        tokio::select! {
            result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            let mut archive = zip::ZipArchive::new(Cursor::new(bytes))?;
            validate_zip_symlinks(&mut archive)?;
            // The registry includes Python onedir releases whose Framework layout relies on
            // relative symlinks. zip's extractor preserves those links and rejects links or
            // archive paths that can escape the managed installation root.
            archive.extract(&destination)?;
            Ok(())
            }) => result??,
            () = cancellation.cancelled() => anyhow::bail!("operation canceled"),
        }
        return Ok(());
    }
    let archive = destination.join("download.archive");
    tokio::fs::write(&archive, bytes).await?;
    let mut command = agent_process_command("tar");
    command.arg("-xf").arg(&archive).arg("-C").arg(destination);
    let result = match cancellable_command_output(command, cancellation).await {
        Ok(output) => ensure_success("binary archive extraction", &output),
        Err(error) => Err(error),
    };
    let _ = tokio::fs::remove_file(&archive).await;
    result
}

fn validate_zip_symlinks<R>(archive: &mut zip::ZipArchive<R>) -> anyhow::Result<()>
where
    R: Read + std::io::Seek,
{
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        if !file.is_symlink() {
            continue;
        }
        let link = file
            .enclosed_name()
            .ok_or_else(|| anyhow::anyhow!("binary archive contains an unsafe symlink path"))?;
        let mut target = Vec::with_capacity(file.size() as usize);
        file.read_to_end(&mut target)?;
        let target = std::str::from_utf8(&target)
            .map_err(|_| anyhow::anyhow!("binary archive contains a non-UTF-8 symlink target"))?;
        validate_zip_symlink_target(&link, Path::new(target))?;
    }
    Ok(())
}

fn validate_zip_symlink_target(link: &Path, target: &Path) -> anyhow::Result<()> {
    use std::path::Component;

    if target.is_absolute() {
        anyhow::bail!("binary archive contains an absolute symlink target");
    }
    let mut depth = link
        .parent()
        .into_iter()
        .flat_map(Path::components)
        .filter(|component| matches!(component, Component::Normal(_)))
        .count();
    for component in target.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(_) => depth += 1,
            Component::ParentDir if depth > 0 => depth -= 1,
            Component::ParentDir => {
                anyhow::bail!("binary archive symlink target escapes the installation root")
            }
            Component::RootDir | Component::Prefix(_) => {
                anyhow::bail!("binary archive contains an absolute symlink target")
            }
        }
    }
    Ok(())
}

fn safe_archive_executable(root: &Path, command: &str) -> anyhow::Result<PathBuf> {
    let relative = Path::new(command);
    if relative.as_os_str().is_empty()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        anyhow::bail!("binary command escapes the installation root");
    }
    Ok(root.join(relative))
}

async fn verify_acp_handshake(
    agent_id: &AgentId,
    lock: &SessionLaunchLock,
    working_dir: &Path,
    cancellation: &CancellationToken,
) -> anyhow::Result<()> {
    let (event_tx, _event_rx) = mpsc::unbounded_channel();
    let manager = AgentConnectionManager::new(event_tx);
    let connection_id = AgentConnectionId::new();
    let (_snapshot, ready) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id,
            agent_id: agent_id.clone(),
            launch_lock: lock.clone(),
            workspace_id: Uuid::nil(),
            working_dir: working_dir.to_path_buf(),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;
    tokio::select! {
        result = ready => {
            result
                .map_err(|_| anyhow::anyhow!("ACP process exited before initialize"))??
        }
        () = cancellation.cancelled() => {
            let _ = manager.disconnect(connection_id).await;
            anyhow::bail!("operation canceled");
        }
    };
    manager.disconnect(connection_id).await?;
    Ok(())
}

async fn probe_acp_capabilities(
    agent_id: &AgentId,
    lock: &SessionLaunchLock,
    working_dir: &Path,
    cancellation: &CancellationToken,
) -> anyhow::Result<AcpCapabilitySnapshot> {
    let (event_tx, _event_rx) = mpsc::unbounded_channel();
    let manager = AgentConnectionManager::new(event_tx);
    let connection_id = AgentConnectionId::new();
    let (_snapshot, ready) = manager
        .register_connection(AgentConnectionLaunch {
            connection_id,
            agent_id: agent_id.clone(),
            launch_lock: lock.clone(),
            workspace_id: Uuid::nil(),
            working_dir: working_dir.to_path_buf(),
            additional_directories: Vec::new(),
            auto_approve_mode: AgentAutoApproveMode::Off,
            env: HashMap::new(),
        })
        .await;
    let initialized: anyhow::Result<()> = tokio::select! {
        result = ready => match result {
            Ok(result) => result.map_err(Into::into),
            Err(_) => Err(anyhow::anyhow!("ACP process exited before initialize")),
        },
        () = cancellation.cancelled() => Err(anyhow::anyhow!("operation canceled")),
    };
    if let Err(error) = initialized {
        let _ = manager.disconnect(connection_id).await;
        return Err(error);
    }

    let capabilities = manager.connection_capabilities(connection_id).await;
    let disconnected = manager.disconnect(connection_id).await;
    match (capabilities, disconnected) {
        (Ok(capabilities), Ok(())) => Ok(capabilities),
        (Err(error), _) => Err(error.into()),
        (Ok(_), Err(error)) => Err(error.into()),
    }
}

fn resolve_authentication_observation(
    native_authentication: AgentAuthenticationStatus,
    observation: Option<&AcpAuthenticationObservationSnapshot>,
    authentication_required_by_default: bool,
) -> (AgentAuthenticationStatus, bool) {
    if matches!(
        native_authentication,
        AgentAuthenticationStatus::Account | AgentAuthenticationStatus::ApiKey
    ) {
        return (native_authentication, false);
    }

    match observation.map(|observation| observation.state) {
        Some(AuthenticationObservationState::Authenticated) => {
            (AgentAuthenticationStatus::MultipleUnknown, false)
        }
        Some(AuthenticationObservationState::Unauthenticated)
            if authentication_required_by_default =>
        {
            (AgentAuthenticationStatus::NotLoggedIn, true)
        }
        Some(AuthenticationObservationState::Unauthenticated) => {
            (AgentAuthenticationStatus::NotRequired, false)
        }
        Some(
            AuthenticationObservationState::Unknown | AuthenticationObservationState::Degraded,
        )
        | None => (
            native_authentication,
            authentication_required_by_default
                && matches!(
                    native_authentication,
                    AgentAuthenticationStatus::NotLoggedIn
                        | AgentAuthenticationStatus::MultipleUnknown
                ),
        ),
    }
}

async fn persist_installed_lock(
    pool: &sqlx::SqlitePool,
    lock_id: Uuid,
    plan: &ResolvedInstallPlan,
    installation: &InstalledPlan,
    installation_ownership: &str,
) -> anyhow::Result<()> {
    let source = match &plan.source {
        LockedInstallSource::BuiltInProfile => serde_json::json!({
            "kind": "built_in_profile"
        }),
        LockedInstallSource::BuiltInProfileWithRegistry {
            snapshot_id,
            registry_id,
        } => serde_json::json!({
            "kind": "built_in_profile_with_registry",
            "snapshot_id": snapshot_id,
            "registry_id": registry_id,
        }),
        LockedInstallSource::OfficialRegistry {
            snapshot_id,
            registry_id,
        } => serde_json::json!({
            "kind": "official_registry",
            "snapshot_id": snapshot_id,
            "registry_id": registry_id,
        }),
        LockedInstallSource::UserDefinition { definition_sha256 } => serde_json::json!({
            "kind": "user_definition",
            "definition_sha256": definition_sha256,
        }),
    };
    let resolved_json = serde_json::json!({
        "source": source,
        "frozen_plan": plan,
        "absolute_acp_program": installation.launch_lock.absolute_acp_program,
        "args": installation.launch_lock.args,
        "env": installation.launch_lock.env,
        "runtime_version": installation.launch_lock.runtime_version,
        "acp_version": installation.launch_lock.acp_version,
    })
    .to_string();
    let mut transaction = pool.begin().await?;
    sqlx::query(
        r#"INSERT INTO agent_install_lock
           (id, agent_id, registry_version, platform, distribution_kind, resolved_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(lock_id.to_string())
    .bind(plan.agent_id.as_str())
    .bind(&plan.version)
    .bind(&plan.platform)
    .bind(
        plan.components
            .first()
            .map(|component| format!("{:?}", component.distribution_kind).to_lowercase())
            .unwrap_or_else(|| "unknown".to_string()),
    )
    .bind(resolved_json)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *transaction)
    .await?;
    for component in &installation.components {
        sqlx::query(
            r#"INSERT INTO agent_install_component
               (id, lock_id, component_kind, absolute_path, version, sha256,
                trust_state, ownership, shared_resource_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(lock_id.to_string())
        .bind(&component.kind)
        .bind(component.absolute_path.display().to_string())
        .bind(&component.version)
        .bind(&component.sha256)
        .bind(&component.trust_state)
        .bind(&component.ownership)
        .bind(&component.shared_resource_key)
        .execute(&mut *transaction)
        .await?;
    }
    sqlx::query(
        r#"INSERT INTO agent_installation
           (agent_id, ownership, lifecycle, current_lock_id, rollback_lock_id,
            active_operation, active_operation_id, updated_at)
           VALUES (?, ?, 'ready', ?, NULL, NULL, NULL, CURRENT_TIMESTAMP)
           ON CONFLICT(agent_id) DO UPDATE SET
             ownership = excluded.ownership,
             rollback_lock_id = agent_installation.current_lock_id,
             current_lock_id = excluded.current_lock_id,
             lifecycle = 'ready',
             active_operation = NULL,
             active_operation_id = NULL,
             updated_at = CURRENT_TIMESTAMP"#,
    )
    .bind(plan.agent_id.as_str())
    .bind(installation_ownership)
    .bind(lock_id.to_string())
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}

async fn finish_failed_operation(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    operation_id: &str,
    kind: AgentOperationKind,
    message: String,
) {
    let _ = sqlx::query(
        r#"UPDATE agent_installation
           SET lifecycle = CASE
                 WHEN ownership = 'external' AND current_lock_id IS NOT NULL THEN 'ready'
                 WHEN ? = 'update' THEN 'ready'
                 ELSE 'needs_repair'
               END,
               active_operation = NULL,
               active_operation_id = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE agent_id = ?"#,
    )
    .bind(operation_kind_key(kind))
    .bind(agent_id.as_str())
    .execute(pool)
    .await;
    if let Ok(operation_uuid) = Uuid::parse_str(operation_id) {
        let _ = InstallationOperationRepository::new(pool.clone())
            .finish(operation_uuid, "failed")
            .await;
    }
    let redacted = redact_operation_output(&message);
    let _ = db::models::agent_management::DiagnosticRepository::new(pool.clone())
        .append_bounded(&db::models::agent_management::DiagnosticRecord {
            id: Uuid::new_v4(),
            agent_id: agent_id.clone(),
            operation_kind: operation_kind_key(kind).to_string(),
            severity: "error".to_string(),
            message: "Agent 安装或验证失败".to_string(),
            redacted_output: Some(redacted.clone()),
            created_at: Utc::now().to_rfc3339(),
        })
        .await;
    emit_operation(
        app,
        agent_id.clone(),
        operation_id,
        kind,
        AgentOperationStatus::Failed,
        None,
        Some(redacted),
    );
}

async fn finish_canceled_operation(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    operation_id: &str,
    kind: AgentOperationKind,
) {
    let _ = sqlx::query(
        r#"UPDATE agent_installation
           SET lifecycle = CASE
                 WHEN current_lock_id IS NULL THEN 'uninstalled'
                 ELSE 'ready'
               END,
               active_operation = NULL,
               active_operation_id = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE agent_id = ? AND active_operation_id = ?"#,
    )
    .bind(agent_id.as_str())
    .bind(operation_id)
    .execute(pool)
    .await;
    if let Ok(operation_uuid) = Uuid::parse_str(operation_id) {
        let _ = InstallationOperationRepository::new(pool.clone())
            .finish(operation_uuid, "cancelled")
            .await;
    }
    emit_operation(
        app,
        agent_id.clone(),
        operation_id,
        kind,
        AgentOperationStatus::Canceled,
        None,
        Some("操作已取消".to_string()),
    );
}

#[tauri::command]
pub async fn agent_management_cancel_operation(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
    operation_id: String,
) -> Result<AgentOperationReceipt, AgentManagementErrorView> {
    let operation_repository =
        InstallationOperationRepository::new(state.deployment.db().pool.clone());
    if let Ok(id) = Uuid::parse_str(&operation_id) {
        let operation = operation_repository
            .find(id)
            .await
            .map_err(internal_error)?;
        if let Some(operation) = operation
            && operation.agent_id == agent_id
            && !matches!(operation.status.as_str(), "queued" | "running")
        {
            let kind = parse_operation_kind(&operation.kind).ok_or_else(|| {
                management_error(
                    AgentManagementErrorCode::InvalidState,
                    "持久化管理操作类型无效",
                    Some(agent_id.clone()),
                )
            })?;
            let status = match operation.status.as_str() {
                "succeeded" => AgentOperationStatus::Succeeded,
                "failed" => AgentOperationStatus::Failed,
                "cancelled" => AgentOperationStatus::Canceled,
                "interrupted" => AgentOperationStatus::Interrupted,
                _ => AgentOperationStatus::Failed,
            };
            return Ok(AgentOperationReceipt {
                operation_id,
                agent_id,
                kind,
                status,
            });
        }
    }
    let active = sqlx::query_as::<_, (Option<String>, Option<String>)>(
        "SELECT active_operation, active_operation_id FROM agent_installation WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?
    .ok_or_else(|| {
        management_error(
            AgentManagementErrorCode::NotFound,
            format!("Agent `{agent_id}` 没有可取消的管理操作"),
            Some(agent_id.clone()),
        )
    })?;
    let kind = active
        .0
        .as_deref()
        .and_then(parse_operation_kind)
        .ok_or_else(|| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                "Agent 没有可取消的管理操作",
                Some(agent_id.clone()),
            )
        })?;
    if active.1.as_deref() != Some(operation_id.as_str())
        || !OperationScheduler::shared()
            .cancellations
            .cancel(&operation_id)
    {
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            "管理操作已经结束或不是当前操作",
            Some(agent_id),
        ));
    }
    emit_operation(
        &app,
        agent_id.clone(),
        &operation_id,
        kind,
        AgentOperationStatus::Running,
        None,
        Some("正在取消操作".to_string()),
    );
    Ok(AgentOperationReceipt {
        operation_id,
        agent_id,
        kind,
        status: AgentOperationStatus::Running,
    })
}

fn redact_operation_output(value: &str) -> String {
    const MAX_DIAGNOSTIC_BYTES: usize = 8 * 1024;
    const REDACTED: &str = "[REDACTED]";
    let mut boundary = value.len().min(MAX_DIAGNOSTIC_BYTES);
    while boundary > 0 && !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    let mut redacted = value[..boundary].to_string();
    for marker in [
        "ANTHROPIC_API_KEY=",
        "ANTHROPIC_AUTH_TOKEN=",
        "OPENAI_API_KEY=",
        "GEMINI_API_KEY=",
        "GOOGLE_API_KEY=",
        "XAI_API_KEY=",
        "KIMI_API_KEY=",
        "OPENROUTER_API_KEY=",
        "API_KEY=",
        "api_key=",
        "apiKey=",
        "--api-key ",
        "Authorization: Bearer ",
        "authorization: bearer ",
    ] {
        let mut search_from = 0;
        while let Some(relative_start) = redacted[search_from..].find(marker) {
            let start = search_from + relative_start;
            let value_start = start + marker.len();
            let value_end = redacted[value_start..]
                .find(char::is_whitespace)
                .map(|offset| value_start + offset)
                .unwrap_or(redacted.len());
            if redacted[value_start..].starts_with(REDACTED) {
                search_from = value_start + REDACTED.len();
                continue;
            }
            redacted.replace_range(value_start..value_end, REDACTED);
            search_from = value_start + REDACTED.len();
        }
    }
    if redacted.len() > MAX_DIAGNOSTIC_BYTES {
        let mut boundary = MAX_DIAGNOSTIC_BYTES;
        while boundary > 0 && !redacted.is_char_boundary(boundary) {
            boundary -= 1;
        }
        redacted.truncate(boundary);
    }
    redacted
}

#[tauri::command]
pub async fn agent_management_uninstall(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentManagementView, AgentManagementErrorView> {
    ensure_not_busy(&state, &agent_id).await?;
    uninstall_managed_installation(&app, &state.deployment.db().pool, &agent_id).await?;
    agent_management_detail(state, agent_id).await
}

async fn uninstall_managed_installation(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<(), AgentManagementErrorView> {
    let ownership = sqlx::query_scalar::<_, String>(
        "SELECT ownership FROM agent_installation WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?;
    if ownership.as_deref() == Some("external") {
        uninstall_user_environment_installation(app, pool, agent_id).await?;
        return clear_installation_lock(pool, agent_id).await;
    }
    if ownership.as_deref() == Some("managed") {
        let managed_artifacts_dir = app_managed_artifacts_directory(app).map_err(internal_error)?;
        let home_dir = app.path().home_dir().map_err(internal_error)?;
        let root =
            managed_install_root(&managed_artifacts_dir, agent_id).map_err(internal_error)?;
        let runtime = current_managed_runtime_cli(pool, agent_id)
            .await
            .map_err(internal_error)?;
        if let Some(runtime) = runtime.as_ref() {
            remove_managed_runtime_cli(&home_dir, agent_id, &runtime.runtime_executable)
                .map_err(internal_error)?;
        }
        match tokio::fs::remove_dir_all(&root).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                if let Some(runtime) = runtime.as_ref()
                    && runtime.runtime_executable.is_file()
                    && let Err(restore_error) = publish_managed_runtime_cli(
                        &home_dir,
                        agent_id,
                        &root,
                        &runtime.runtime_executable,
                        &runtime.runtime_path_entries,
                        configured_shell_family(),
                    )
                {
                    tracing::error!(
                        agent_id = %agent_id,
                        %restore_error,
                        "failed to restore terminal command after uninstall failure"
                    );
                }
                return Err(management_error(
                    AgentManagementErrorCode::Internal,
                    format!("无法删除平台托管的 Agent 安装：{error}"),
                    Some(agent_id.clone()),
                ));
            }
        }
    }
    clear_installation_lock(pool, agent_id).await
}

async fn clear_installation_lock(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<(), AgentManagementErrorView> {
    let mut transaction = pool.begin().await.map_err(internal_error)?;
    sqlx::query(
        r#"UPDATE agent_installation
           SET lifecycle = 'uninstalled', current_lock_id = NULL,
               rollback_lock_id = NULL, active_operation = NULL,
               active_operation_id = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .execute(&mut *transaction)
    .await
    .map_err(internal_error)?;
    sqlx::query("DELETE FROM agent_install_lock WHERE agent_id = ?")
        .bind(agent_id.as_str())
        .execute(&mut *transaction)
        .await
        .map_err(internal_error)?;
    transaction.commit().await.map_err(internal_error)?;
    CLI_EXPOSURES
        .get_or_init(|| AsyncMutex::new(HashSet::new()))
        .lock()
        .await
        .remove(agent_id);
    Ok(())
}

async fn uninstall_user_environment_installation(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<(), AgentManagementErrorView> {
    let resolved_json = sqlx::query_scalar::<_, String>(
        r#"SELECT lock.resolved_json
           FROM agent_installation installation
           JOIN agent_install_lock lock ON lock.id = installation.current_lock_id
           WHERE installation.agent_id = ?"#,
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?;
    let Some(resolved_json) = resolved_json else {
        return Ok(());
    };
    let payload: serde_json::Value =
        serde_json::from_str(&resolved_json).map_err(internal_error)?;
    let plan = payload.get("frozen_plan").cloned().ok_or_else(|| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            "Installation lock is missing its frozen plan",
            Some(agent_id.clone()),
        )
    })?;
    let plan: ResolvedInstallPlan = serde_json::from_value(plan).map_err(internal_error)?;
    let home_dir = app.path().home_dir().map_err(internal_error)?;
    let user_env = UserEnvironmentLayout::for_current_user(home_dir);
    let node_runtime = discover_system_node_runtime(node_requirement_for_agent(agent_id))
        .await
        .ok();
    for component in &plan.components {
        match component.distribution_kind {
            PlannedDistributionKind::Npx => {
                let Ok(package) = npm_package_name(&component.resolved_source) else {
                    continue;
                };
                let mut command = agent_process_command(
                    node_runtime
                        .as_ref()
                        .map(|runtime| runtime.npm.as_path())
                        .unwrap_or_else(|| Path::new("npm")),
                );
                if let Some(runtime) = node_runtime.as_ref() {
                    prepend_command_path(&mut command, &runtime.bin_dir).map_err(internal_error)?;
                }
                command
                    .arg("uninstall")
                    .arg("-g")
                    .arg("--prefix")
                    .arg(&user_env.npm_prefix)
                    .arg(package);
                let output = cancellable_command_output(command, &CancellationToken::new())
                    .await
                    .map_err(internal_error)?;
                if !output.status.success() {
                    return Err(management_error(
                        AgentManagementErrorCode::InvalidState,
                        format!(
                            "npm uninstall -g {package} failed: {}",
                            redact_operation_output(&String::from_utf8_lossy(&output.stderr))
                        ),
                        Some(agent_id.clone()),
                    ));
                }
            }
            PlannedDistributionKind::Uvx => {
                let Some(package) = uv_distribution_name(&component.resolved_source) else {
                    continue;
                };
                let mut command = agent_process_command(Path::new("uv"));
                command
                    .arg("tool")
                    .arg("uninstall")
                    .arg(package)
                    .env("UV_TOOL_DIR", &user_env.uv_tool_dir)
                    .env("UV_TOOL_BIN_DIR", &user_env.uv_tool_bin);
                let output = cancellable_command_output(command, &CancellationToken::new())
                    .await
                    .map_err(internal_error)?;
                if !output.status.success() {
                    return Err(management_error(
                        AgentManagementErrorCode::InvalidState,
                        format!(
                            "uv tool uninstall {package} failed: {}",
                            redact_operation_output(&String::from_utf8_lossy(&output.stderr))
                        ),
                        Some(agent_id.clone()),
                    ));
                }
            }
            PlannedDistributionKind::Binary => {
                let command_name = Path::new(&component.command)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or(component.command.as_str());
                let destination = if cfg!(windows) {
                    user_env.user_bin.join(format!("{command_name}.exe"))
                } else {
                    user_env.user_bin.join(command_name)
                };
                match tokio::fs::remove_file(&destination).await {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(management_error(
                            AgentManagementErrorCode::Internal,
                            format!("无法删除用户环境 Binary：{error}"),
                            Some(agent_id.clone()),
                        ));
                    }
                }
            }
        }
    }
    let _ = utils::shell::refresh_process_path_after_install().await;
    let leftover = leftover_user_environment_commands(&plan).await;
    if !leftover.is_empty() {
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            format!(
                "卸载后 PATH 上仍能找到 {}，已保留 Installation lock",
                leftover.join(", ")
            ),
            Some(agent_id.clone()),
        ));
    }
    Ok(())
}

async fn leftover_user_environment_commands(plan: &ResolvedInstallPlan) -> Vec<String> {
    let mut leftover = Vec::new();
    for component in &plan.components {
        let command = component.command.trim();
        if command.is_empty() || command == "npm" || command == "uv" {
            continue;
        }
        if utils::shell::resolve_executable_path(command)
            .await
            .is_some()
        {
            leftover.push(command.to_string());
        }
    }
    leftover
}

#[tauri::command]
pub async fn agent_management_remove(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<(), AgentManagementErrorView> {
    ensure_not_busy(&state, &agent_id).await?;
    let built_in =
        sqlx::query_scalar::<_, bool>("SELECT built_in FROM agent_membership WHERE agent_id = ?")
            .bind(agent_id.as_str())
            .fetch_optional(&state.deployment.db().pool)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| {
                management_error(
                    AgentManagementErrorCode::NotFound,
                    format!("Agent `{agent_id}` has not been added"),
                    Some(agent_id.clone()),
                )
            })?;
    if built_in {
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            "内置 Agent 不能从列表移除",
            Some(agent_id),
        ));
    }
    uninstall_managed_installation(&app, &state.deployment.db().pool, &agent_id).await?;
    sqlx::query("DELETE FROM agent_membership WHERE agent_id = ?")
        .bind(agent_id.as_str())
        .execute(&state.deployment.db().pool)
        .await
        .map_err(internal_error)?;
    Ok(())
}

async fn ensure_not_busy(
    state: &tauri::State<'_, AppState>,
    agent_id: &AgentId,
) -> Result<(), AgentManagementErrorView> {
    let active_process =
        state
            .agent_runtime
            .snapshot()
            .await
            .connections
            .iter()
            .any(|connection| {
                &connection.agent_id == agent_id
                    && matches!(
                        connection.status,
                        agents::AgentConnectionStatus::Connecting
                            | agents::AgentConnectionStatus::Ready
                    )
            });
    let active_operation = sqlx::query_scalar::<_, Option<String>>(
        "SELECT active_operation FROM agent_installation WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?
    .flatten()
    .is_some();
    let in_flight_turn = sqlx::query_scalar::<_, bool>(
        r#"SELECT EXISTS(
             SELECT 1
             FROM conversation_turns turn
             JOIN sessions session ON session.id = turn.conversation_id
             WHERE session.agent_id = ?
               AND turn.status IN ('pending', 'queued', 'running', 'blocked')
           )"#,
    )
    .bind(agent_id.as_str())
    .fetch_one(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?;
    if active_process || active_operation || in_flight_turn {
        return Err(management_error(
            AgentManagementErrorCode::Busy,
            agents::BUSY_LIFECYCLE_MESSAGE,
            Some(agent_id.clone()),
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn opencode_provider_connections(
    state: tauri::State<'_, AppState>,
) -> Result<OpenCodeProviderConnectionsView, AgentManagementErrorView> {
    let agent_id = AgentId::parse("opencode").expect("built-in id");
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let paths = opencode_provider_paths(&environment)?;
    let auth = read_json_object_or_empty(&paths.auth_path).await?;
    let config = read_json_object_or_empty(&paths.config_path).await?;
    Ok(project_opencode_provider_connections(&auth, &config))
}

#[tauri::command]
pub async fn opencode_provider_catalog(
    app: AppHandle,
    force_refresh: bool,
) -> Result<OpenCodeProviderCatalogView, AgentManagementErrorView> {
    let data_dir = app.path().app_data_dir().map_err(internal_error)?;
    Ok(opencode_catalog::provider_catalog(&data_dir, force_refresh).await)
}

#[tauri::command]
pub async fn codex_request_device_code() -> Result<CodexDeviceCodeView, AgentManagementErrorView> {
    codex_device_auth::request_device_code()
        .await
        .map_err(internal_error)
}

#[tauri::command]
pub async fn codex_poll_device_code(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    device_auth_id: String,
    user_code: String,
) -> Result<CodexDeviceCodePollView, AgentManagementErrorView> {
    let home = app.path().home_dir().map_err(internal_error)?;
    let agent_id = AgentId::parse("codex").expect("built-in id");
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let codex_home = resolve_agent_home_directory(&home, &environment, "CODEX_HOME", ".codex");
    let result = codex_device_auth::poll_device_code(&codex_home, device_auth_id, user_code)
        .await
        .map_err(internal_error)?;
    if result.status == "success" {
        sync_authentication_probe(
            &state.deployment.db().pool,
            &agent_id,
            AgentAuthenticationStatus::Account,
        )
        .await?;
        let _ = app.emit(MANAGEMENT_INVALIDATED_EVENT, ());
    }
    Ok(result)
}

#[tauri::command]
pub async fn cursor_model_catalog(
    state: tauri::State<'_, AppState>,
) -> Result<AgentModelCatalogView, AgentManagementErrorView> {
    let agent_id = AgentId::parse("cursor").expect("built-in id");
    let env = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let program =
        resolve_management_program(&state.deployment.db().pool, &agent_id, "cursor-agent", &env)
            .await
            .ok_or_else(|| {
                management_error(
                    AgentManagementErrorCode::InvalidState,
                    "未找到 cursor-agent；请先安装或修复 Cursor。",
                    Some(agent_id.clone()),
                )
            })?;
    model_catalogs::cursor(&program, env.get("CURSOR_API_KEY").map(String::as_str))
        .await
        .map_err(|message| {
            management_error(AgentManagementErrorCode::Internal, message, Some(agent_id))
        })
}

#[tauri::command]
pub async fn kimi_model_catalog(
    base_url: String,
    api_key: String,
) -> Result<AgentModelCatalogView, AgentManagementErrorView> {
    model_catalogs::kimi(&base_url, &api_key)
        .await
        .map_err(|message| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                message,
                Some(AgentId::parse("kimi_code").expect("built-in id")),
            )
        })
}

#[tauri::command]
pub async fn codex_model_catalog(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    force_refresh: bool,
) -> Result<AgentModelCatalogView, AgentManagementErrorView> {
    let agent_id = AgentId::parse("codex").expect("built-in id");
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let program = resolve_management_program(
        &state.deployment.db().pool,
        &agent_id,
        "codex",
        &environment,
    )
    .await;
    let cache_path = app
        .path()
        .app_data_dir()
        .map_err(internal_error)?
        .join("agent-catalogs")
        .join("codex-bundled.json");
    Ok(model_catalogs::codex(program.as_deref(), &cache_path, force_refresh).await)
}

#[tauri::command]
pub async fn codex_model_catalog_config(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<CodexModelCatalogConfigView, AgentManagementErrorView> {
    let agent_id = AgentId::parse("codex").expect("built-in id");
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let program = resolve_management_program(
        &state.deployment.db().pool,
        &agent_id,
        "codex",
        &environment,
    )
    .await;
    let cache_path = app
        .path()
        .app_data_dir()
        .map_err(internal_error)?
        .join("agent-catalogs")
        .join("codex-bundled.json");
    let official = model_catalogs::codex_official_document(program.as_deref(), &cache_path)
        .await
        .ok();
    let home = app.path().home_dir().map_err(internal_error)?;
    let codex_home = environment
        .get("CODEX_HOME")
        .filter(|value| !value.trim().is_empty())
        .map(|value| expand_agent_home_path(&home, value))
        .or_else(|| {
            std::env::var_os("CODEX_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| home.join(".codex"));
    model_catalogs::load_codex_config(&codex_home, official.as_ref())
        .await
        .map_err(internal_error)
}

#[tauri::command]
pub async fn codex_model_catalog_apply(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    request: CodexModelCatalogConfigRequest,
) -> Result<CodexModelCatalogConfigView, AgentManagementErrorView> {
    let agent_id = AgentId::parse("codex").expect("built-in id");
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let program = resolve_management_program(
        &state.deployment.db().pool,
        &agent_id,
        "codex",
        &environment,
    )
    .await;
    let app_data_dir = app.path().app_data_dir().map_err(internal_error)?;
    let cache_path = app_data_dir
        .join("agent-catalogs")
        .join("codex-bundled.json");
    let official = model_catalogs::codex_official_document(program.as_deref(), &cache_path)
        .await
        .map_err(|message| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                message,
                Some(agent_id.clone()),
            )
        })?;
    let home = app.path().home_dir().map_err(internal_error)?;
    let codex_home = resolve_agent_home_directory(&home, &environment, "CODEX_HOME", ".codex");
    let result = model_catalogs::apply_codex_config(&codex_home, &official, request)
        .await
        .map_err(internal_error)?;
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "Codex 模型清单已更改")
        .await;
    Ok(result)
}

#[tauri::command]
pub async fn agent_model_providers(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentModelProvidersView, AgentManagementErrorView> {
    let store_path = app
        .path()
        .app_data_dir()
        .map_err(internal_error)?
        .join("agent-model-providers.json");
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let home = app.path().home_dir().map_err(internal_error)?;
    let codex_home = resolve_agent_home_directory(&home, &environment, "CODEX_HOME", ".codex");
    model_providers::list_with_native(&store_path, agent_id, Some(&codex_home))
        .await
        .map_err(internal_error)
}

#[tauri::command]
pub async fn agent_model_provider_catalog(
    app: AppHandle,
    agent_id: AgentId,
    provider_id: Option<String>,
    api_url: String,
    api_key: Option<String>,
) -> Result<AgentModelCatalogView, AgentManagementErrorView> {
    let store_path = app
        .path()
        .app_data_dir()
        .map_err(internal_error)?
        .join("agent-model-providers.json");
    let api_key = model_providers::resolve_probe_api_key(
        &store_path,
        &agent_id,
        provider_id.as_deref(),
        api_key.as_deref(),
    )
    .await
    .map_err(|message| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            message,
            Some(agent_id.clone()),
        )
    })?;
    model_catalogs::provider(agent_id.clone(), &api_url, &api_key)
        .await
        .map_err(|message| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                message,
                Some(agent_id),
            )
        })
}

#[tauri::command]
pub async fn agent_model_provider_save(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    request: AgentModelProviderSaveRequest,
) -> Result<AgentModelProvidersView, AgentManagementErrorView> {
    let store_path = app
        .path()
        .app_data_dir()
        .map_err(internal_error)?
        .join("agent-model-providers.json");
    let home = app.path().home_dir().map_err(internal_error)?;
    let agent_id = request.agent_id.clone();
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let has_binding = model_providers::list(&store_path, agent_id.clone())
        .await
        .map_err(internal_error)?
        .bound_provider_id
        .is_some();
    if has_binding {
        // Keep the database overlay valid before changing any native Agent file.
        // A failed save therefore leaves both the previous binding and its auth
        // projection intact instead of returning after a partial success.
        sync_model_provider_auth_overlay(&state.deployment.db().pool, &agent_id, true).await?;
    }
    let result = model_providers::save(&store_path, &home, &environment, request)
        .await
        .map_err(internal_error)?;
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "Model Provider 已更改")
        .await;
    Ok(result)
}

#[tauri::command]
pub async fn agent_model_provider_bind(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
    provider_id: Option<String>,
) -> Result<AgentModelProvidersView, AgentManagementErrorView> {
    let store_path = app
        .path()
        .app_data_dir()
        .map_err(internal_error)?
        .join("agent-model-providers.json");
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let previous_binding = model_providers::list(&store_path, agent_id.clone())
        .await
        .map_err(internal_error)?
        .bound_provider_id;
    let result = model_providers::bind(
        &store_path,
        &home,
        &environment,
        agent_id.clone(),
        provider_id,
    )
    .await
    .map_err(internal_error)?;
    if let Err(error) = sync_model_provider_auth_overlay(
        &state.deployment.db().pool,
        &agent_id,
        result.bound_provider_id.is_some(),
    )
    .await
    {
        if let Err(rollback_error) = model_providers::bind(
            &store_path,
            &home,
            &environment,
            agent_id.clone(),
            previous_binding,
        )
        .await
        {
            return Err(management_error(
                AgentManagementErrorCode::Internal,
                format!(
                    "Model Provider 鉴权状态同步失败，且原生配置回滚失败：{}；{}",
                    error.message, rollback_error
                ),
                Some(agent_id),
            ));
        }
        return Err(error);
    }
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "Model Provider 绑定已更改")
        .await;
    Ok(result)
}

async fn sync_model_provider_auth_overlay(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    bound: bool,
) -> Result<(), AgentManagementErrorView> {
    let Some(policy) = agents::built_in_auth_mode_policy(agent_id) else {
        return Ok(());
    };
    if !policy.modes.contains(&"model_provider") {
        return Ok(());
    }
    let mut environment = read_agent_environment(pool, agent_id).await?;
    if bound {
        environment.insert(policy.mode_env.to_string(), "model_provider".to_string());
        agents::apply_built_in_auth_mode_policy(agent_id, &mut environment);
    } else {
        environment.remove(policy.mode_env);
    }
    let env_json = serde_json::to_string(&environment).map_err(internal_error)?;
    ensure_agent_setting_row(pool, agent_id).await?;
    let result = sqlx::query(
        "UPDATE agent_setting SET env_json = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_type = ?",
    )
    .bind(env_json)
    .bind(agent_id.as_str())
    .execute(pool)
    .await
    .map_err(internal_error)?;
    if result.rows_affected() == 0 {
        return Err(management_error(
            AgentManagementErrorCode::NotFound,
            "Agent 设置不存在",
            Some(agent_id.clone()),
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_model_provider_delete(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
    provider_id: String,
) -> Result<AgentModelProvidersView, AgentManagementErrorView> {
    let store_path = app
        .path()
        .app_data_dir()
        .map_err(internal_error)?
        .join("agent-model-providers.json");
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    // 删除当前绑定的 Provider 会在模型层先解绑并恢复原生投影，默认回到其它
    // Provider 或官方订阅登录；删除未绑定的 Provider 不影响鉴权模式。
    let was_bound = model_providers::list(&store_path, agent_id.clone())
        .await
        .map_err(internal_error)?
        .bound_provider_id
        .as_deref()
        == Some(provider_id.as_str());
    let result = model_providers::delete(
        &store_path,
        &home,
        &environment,
        agent_id.clone(),
        &provider_id,
    )
    .await
    .map_err(internal_error)?;
    if was_bound {
        // Provider 已删除，无法像 bind 那样回滚绑定；overlay 同步失败只降级
        // 为告警，不把已成功的删除整体报错。
        if let Err(error) =
            sync_model_provider_auth_overlay(&state.deployment.db().pool, &agent_id, false).await
        {
            tracing::warn!(?error, "删除 Model Provider 后同步鉴权模式失败");
        }
    }
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "Model Provider 已删除")
        .await;
    Ok(result)
}

#[tauri::command]
pub async fn pi_configuration(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<PiConfigurationView, AgentManagementErrorView> {
    let home = app.path().home_dir().map_err(internal_error)?;
    pi_configuration::load(&state.deployment.db().pool, &home)
        .await
        .map_err(internal_error)
}

#[tauri::command]
pub async fn pi_credentials_save(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    request: PiCredentialsSaveRequest,
) -> Result<PiConfigurationView, AgentManagementErrorView> {
    let home = app.path().home_dir().map_err(internal_error)?;
    let result = pi_configuration::save_credentials(&state.deployment.db().pool, &home, request)
        .await
        .map_err(internal_error)?;
    let agent_id = AgentId::parse("pi").expect("built-in id");
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "Pi Provider 配置已更改")
        .await;
    Ok(result)
}

#[tauri::command]
pub async fn pi_runtime_save(
    state: tauri::State<'_, AppState>,
    request: PiRuntimeSaveRequest,
) -> Result<(), AgentManagementErrorView> {
    pi_configuration::save_runtime(&state.deployment.db().pool, request)
        .await
        .map_err(internal_error)?;
    let agent_id = AgentId::parse("pi").expect("built-in id");
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "Pi Runtime 配置已更改")
        .await;
    Ok(())
}

#[tauri::command]
pub async fn pi_command_validate(command: String) -> PiCommandValidationView {
    pi_configuration::validate_command(&command).await
}

fn dsh_agent_id() -> AgentId {
    AgentId::parse("deepseek_harness").expect("built-in id")
}

fn dsh_paths(home: &Path, environment: &HashMap<String, String>) -> dsh_configuration::DshPaths {
    dsh_configuration::resolve_paths(home, environment)
}

#[tauri::command]
pub async fn dsh_providers(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<DshProvidersView, AgentManagementErrorView> {
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(&state.deployment.db().pool, &dsh_agent_id()).await?;
    let paths = dsh_paths(&home, &environment);
    dsh_configuration::load_providers(
        &paths,
        environment
            .get(dsh_configuration::ACP_PROVIDER_ENV)
            .map(String::as_str),
        environment
            .get(dsh_configuration::ACP_MODEL_ENV)
            .map(String::as_str),
    )
    .map_err(internal_error)
}

#[tauri::command]
pub async fn dsh_provider_save(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    request: DshProviderSaveRequest,
) -> Result<DshProvidersView, AgentManagementErrorView> {
    let agent_id = dsh_agent_id();
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let paths = dsh_paths(&home, &environment);
    let (view, mutations) =
        dsh_configuration::save_provider(&paths, request.clone()).map_err(|message| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                message,
                Some(agent_id.clone()),
            )
        })?;
    apply_native_file_mutations(&mutations).await?;
    apply_dsh_default_environment(
        &state.deployment.db().pool,
        &agent_id,
        &request,
        &environment,
    )
    .await?;
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "DeepSeek Harness Provider 已更改")
        .await;
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    dsh_configuration::load_providers(
        &paths,
        environment
            .get(dsh_configuration::ACP_PROVIDER_ENV)
            .map(String::as_str),
        environment
            .get(dsh_configuration::ACP_MODEL_ENV)
            .map(String::as_str),
    )
    .map_err(internal_error)
    .or(Ok(view))
}

#[tauri::command]
pub async fn dsh_provider_delete(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    provider_id: String,
) -> Result<DshProvidersView, AgentManagementErrorView> {
    let agent_id = dsh_agent_id();
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let paths = dsh_paths(&home, &environment);
    let (view, mutations) =
        dsh_configuration::delete_provider(&paths, &provider_id).map_err(|message| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                message,
                Some(agent_id.clone()),
            )
        })?;
    apply_native_file_mutations(&mutations).await?;
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "DeepSeek Harness Provider 已删除")
        .await;
    Ok(view)
}

#[tauri::command]
pub async fn dsh_provider_discover_models(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    request: DshProviderDiscoverRequest,
) -> Result<Vec<DshProviderModelView>, AgentManagementErrorView> {
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(&state.deployment.db().pool, &dsh_agent_id()).await?;
    let paths = dsh_paths(&home, &environment);
    dsh_configuration::discover_models(
        &paths,
        &request.base_url,
        request.api_key.as_deref(),
        request.provider_id.as_deref(),
    )
    .await
    .map_err(|message| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            message,
            Some(dsh_agent_id()),
        )
    })
}

#[tauri::command]
pub async fn dsh_plugins(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<DshPluginSummaryView, AgentManagementErrorView> {
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(&state.deployment.db().pool, &dsh_agent_id()).await?;
    dsh_configuration::load_plugins(&dsh_paths(&home, &environment)).map_err(internal_error)
}

#[tauri::command]
pub async fn dsh_plugin_add(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    spec: String,
) -> Result<DshPluginSummaryView, AgentManagementErrorView> {
    let agent_id = dsh_agent_id();
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let result = dsh_configuration::add_plugin(&dsh_paths(&home, &environment), &spec)
        .await
        .map_err(|message| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                message,
                Some(agent_id.clone()),
            )
        })?;
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "DeepSeek Harness 插件已更改")
        .await;
    Ok(result)
}

#[tauri::command]
pub async fn dsh_plugin_remove(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<DshPluginSummaryView, AgentManagementErrorView> {
    let agent_id = dsh_agent_id();
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let result = dsh_configuration::remove_plugin(&dsh_paths(&home, &environment), &name)
        .await
        .map_err(|message| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                message,
                Some(agent_id.clone()),
            )
        })?;
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "DeepSeek Harness 插件已更改")
        .await;
    Ok(result)
}

fn grok_agent_id() -> AgentId {
    AgentId::parse("grok").expect("built-in id")
}

#[tauri::command]
pub async fn grok_plugins(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<GrokPluginSummaryView, AgentManagementErrorView> {
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(&state.deployment.db().pool, &grok_agent_id()).await?;
    grok_plugins::list_plugins(&home, &environment)
        .await
        .map_err(internal_error)
}

#[tauri::command]
pub async fn grok_plugin_add(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    spec: String,
) -> Result<GrokPluginSummaryView, AgentManagementErrorView> {
    let agent_id = grok_agent_id();
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let result = grok_plugins::add_plugin(&home, &environment, &spec)
        .await
        .map_err(|message| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                message,
                Some(agent_id.clone()),
            )
        })?;
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "Grok 插件已更改")
        .await;
    Ok(result)
}

#[tauri::command]
pub async fn grok_plugin_remove(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<GrokPluginSummaryView, AgentManagementErrorView> {
    let agent_id = grok_agent_id();
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let result = grok_plugins::remove_plugin(&home, &environment, &name)
        .await
        .map_err(|message| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                message,
                Some(agent_id.clone()),
            )
        })?;
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "Grok 插件已更改")
        .await;
    Ok(result)
}

async fn apply_dsh_default_environment(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    request: &DshProviderSaveRequest,
    current: &HashMap<String, String>,
) -> Result<(), AgentManagementErrorView> {
    let updates = dsh_configuration::default_env_updates(request, current);
    if updates.is_empty() {
        return Ok(());
    }
    let (raw_environment, mut environment) = read_agent_environment_record(pool, agent_id).await?;
    for (name, value) in updates {
        match value {
            Some(value) => {
                environment.insert(name, value);
            }
            None => {
                environment.remove(&name);
            }
        }
    }
    let serialized = serde_json::to_string(&environment).map_err(internal_error)?;
    let updated =
        compare_and_set_agent_environment(pool, agent_id, raw_environment.as_deref(), &serialized)
            .await?;
    if !updated {
        return Err(management_error(
            AgentManagementErrorCode::ConfigConflict,
            "Agent 环境变量在保存期间发生变化，请重新读取后再保存",
            Some(agent_id.clone()),
        ));
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_auth_mode(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentAuthModeView, AgentManagementErrorView> {
    if agent_id.as_str() == "codex" {
        return with_account_label(
            read_codex_auth_mode_view(&app, &state.deployment.db().pool).await?,
        )
        .await;
    }
    if agent_id.as_str() == "deepseek_harness" {
        return with_account_label(
            read_dsh_auth_mode_view(&app, &state.deployment.db().pool).await?,
        )
        .await;
    }
    if matches!(agent_id.as_str(), "claude_code" | "antigravity" | "gemini") {
        return with_account_label(
            read_profile_auth_mode_view(&app, &state.deployment.db().pool, agent_id).await?,
        )
        .await;
    }
    let policy = agents::built_in_auth_mode_policy(&agent_id).ok_or_else(|| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            "此 Agent 没有独立鉴权模式",
            Some(agent_id.clone()),
        )
    })?;
    let env_json = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?
    .flatten();
    let env = parse_agent_env(env_json.as_deref()).map_err(internal_error)?;
    with_account_label(project_agent_auth_mode(agent_id, policy, &env)).await
}

#[tauri::command]
pub async fn agent_auth_mode_set(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
    mode: String,
    api_key: Option<String>,
) -> Result<AgentAuthModeView, AgentManagementErrorView> {
    if agent_id.as_str() == "codex" {
        return with_account_label(
            set_codex_auth_mode(&app, &state, agent_id, &mode, api_key.as_deref()).await?,
        )
        .await;
    }
    if agent_id.as_str() == "deepseek_harness" {
        return with_account_label(
            set_dsh_auth_mode(&app, &state, agent_id, &mode, api_key.as_deref()).await?,
        )
        .await;
    }
    if matches!(agent_id.as_str(), "claude_code" | "antigravity" | "gemini") {
        return with_account_label(
            set_profile_auth_mode(&app, &state, agent_id, &mode, api_key.as_deref()).await?,
        )
        .await;
    }
    let policy = agents::built_in_auth_mode_policy(&agent_id).ok_or_else(|| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            "此 Agent 没有独立鉴权模式",
            Some(agent_id.clone()),
        )
    })?;
    if !policy.modes.contains(&mode.as_str()) {
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            format!("不支持鉴权模式 `{mode}`"),
            Some(agent_id),
        ));
    }
    let env_json = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?
    .flatten();
    let mut env = parse_agent_env(env_json.as_deref()).map_err(internal_error)?;
    env.insert(policy.mode_env.to_string(), mode.clone());
    if policy.credential_modes.contains(&mode.as_str()) {
        if let Some(api_key) = api_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            env.insert(policy.credential_env.to_string(), api_key.to_string());
        }
        if env
            .get(policy.credential_env)
            .is_none_or(|value| value.trim().is_empty())
        {
            return Err(management_error(
                AgentManagementErrorCode::InvalidState,
                format!("{} 模式需要 {}", mode, policy.credential_env),
                Some(agent_id),
            ));
        }
    }
    agents::apply_built_in_auth_mode_policy(&agent_id, &mut env);
    let env_json = serde_json::to_string(&env).map_err(internal_error)?;
    ensure_agent_setting_row(&state.deployment.db().pool, &agent_id).await?;
    let result = sqlx::query(
        "UPDATE agent_setting SET env_json = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_type = ?",
    )
    .bind(env_json)
    .bind(agent_id.as_str())
    .execute(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?;
    if result.rows_affected() == 0 {
        return Err(management_error(
            AgentManagementErrorCode::NotFound,
            "Agent 设置不存在",
            Some(agent_id),
        ));
    }
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "Agent 鉴权模式已更改")
        .await;
    with_account_label(project_agent_auth_mode(agent_id, policy, &env)).await
}

async fn with_account_label(
    view: AgentAuthModeView,
) -> Result<AgentAuthModeView, AgentManagementErrorView> {
    Ok(AgentAuthModeView {
        account_label: agents::resolve_account_label(&view.agent_id).await,
        ..view
    })
}

async fn read_dsh_auth_mode_view(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
) -> Result<AgentAuthModeView, AgentManagementErrorView> {
    let agent_id = dsh_agent_id();
    let policy = agents::built_in_auth_mode_policy(&agent_id).expect("DSH auth policy");
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(pool, &agent_id).await?;
    let paths = dsh_paths(&home, &environment);
    let view = dsh_configuration::load_providers(
        &paths,
        environment
            .get(dsh_configuration::ACP_PROVIDER_ENV)
            .map(String::as_str),
        environment
            .get(dsh_configuration::ACP_MODEL_ENV)
            .map(String::as_str),
    )
    .map_err(internal_error)?;
    let mut projected = project_agent_auth_mode(agent_id, policy, &environment);
    projected.credential_present = view
        .providers
        .iter()
        .any(|provider| provider.credential_present)
        || dsh_configuration::any_credential_present(&paths)
        || environment
            .get(policy.credential_env)
            .is_some_and(|value| !value.trim().is_empty());
    projected.mode = dsh_configuration::inferred_auth_mode(
        &paths,
        environment.get(policy.mode_env).map(String::as_str),
    )
    .to_string();
    Ok(projected)
}

async fn set_dsh_auth_mode(
    app: &AppHandle,
    state: &AppState,
    agent_id: AgentId,
    mode: &str,
    api_key: Option<&str>,
) -> Result<AgentAuthModeView, AgentManagementErrorView> {
    let policy = agents::built_in_auth_mode_policy(&agent_id).expect("DSH auth policy");
    if !policy.modes.contains(&mode) {
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            format!("不支持鉴权模式 `{mode}`"),
            Some(agent_id),
        ));
    }
    let home = app.path().home_dir().map_err(internal_error)?;
    let mut environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    environment.insert(policy.mode_env.to_string(), mode.to_string());
    if let Some(api_key) = api_key.map(str::trim).filter(|value| !value.is_empty()) {
        let paths = dsh_paths(&home, &environment);
        let request = DshProviderSaveRequest {
            id: dsh_configuration::OFFICIAL_PROVIDER_ID.to_string(),
            display_name: None,
            notes: None,
            api: None,
            base_url: None,
            api_key: Some(api_key.to_string()),
            models: Vec::new(),
            set_default: false,
            default_model: None,
        };
        let (_, mutations) =
            dsh_configuration::save_provider(&paths, request).map_err(|message| {
                management_error(
                    AgentManagementErrorCode::InvalidState,
                    message,
                    Some(agent_id.clone()),
                )
            })?;
        apply_native_file_mutations(&mutations).await?;
    }
    agents::apply_built_in_auth_mode_policy(&agent_id, &mut environment);
    let serialized = serde_json::to_string(&environment).map_err(internal_error)?;
    let (raw, _) = read_agent_environment_record(&state.deployment.db().pool, &agent_id).await?;
    let updated = compare_and_set_agent_environment(
        &state.deployment.db().pool,
        &agent_id,
        raw.as_deref(),
        &serialized,
    )
    .await?;
    if !updated {
        return Err(management_error(
            AgentManagementErrorCode::ConfigConflict,
            "Agent 环境变量在保存期间发生变化，请重新读取后再保存",
            Some(agent_id),
        ));
    }
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "DeepSeek Harness 鉴权模式已更改")
        .await;
    read_dsh_auth_mode_view(app, &state.deployment.db().pool).await
}

fn parse_agent_env(value: Option<&str>) -> Result<HashMap<String, String>, serde_json::Error> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map(Option::unwrap_or_default)
}

async fn read_agent_environment(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<HashMap<String, String>, AgentManagementErrorView> {
    let env_json = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?
    .flatten();
    parse_agent_env(env_json.as_deref()).map_err(internal_error)
}

fn project_agent_auth_mode(
    agent_id: AgentId,
    policy: agents::BuiltInAuthModePolicy,
    env: &HashMap<String, String>,
) -> AgentAuthModeView {
    let fallback_credential_present = env
        .get(policy.credential_env)
        .is_some_and(|value| !value.trim().is_empty());
    let mode = env
        .get(policy.mode_env)
        .filter(|mode| policy.modes.contains(&mode.as_str()))
        .cloned()
        .or_else(|| {
            fallback_credential_present
                .then(|| policy.credential_modes.first().copied())
                .flatten()
                .map(str::to_string)
        })
        .unwrap_or_else(|| policy.default_mode.to_string());
    let credential_env =
        agents::auth_mode_credential_env(&agent_id, &mode).unwrap_or(policy.credential_env);
    let credential_present = env
        .get(credential_env)
        .is_some_and(|value| !value.trim().is_empty());
    AgentAuthModeView {
        options: project_auth_mode_options(&agent_id, policy.modes),
        agent_id,
        mode,
        modes: policy
            .modes
            .iter()
            .map(|mode| (*mode).to_string())
            .collect(),
        credential_env: credential_env.to_string(),
        credential_present,
        account_label: None,
    }
}

async fn read_profile_auth_mode_view(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: AgentId,
) -> Result<AgentAuthModeView, AgentManagementErrorView> {
    let policy = agents::built_in_auth_mode_policy(&agent_id).ok_or_else(|| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            "此 Agent 没有独立鉴权模式",
            Some(agent_id.clone()),
        )
    })?;
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(pool, &agent_id).await?;
    let store_path = app
        .path()
        .app_data_dir()
        .map_err(internal_error)?
        .join("agent-model-providers.json");
    let providers = model_providers::list(&store_path, agent_id.clone())
        .await
        .map_err(internal_error)?;
    let account_logged_in = resolve_native_account_login(&home, &agent_id, &environment).await;
    let snapshot = NativeConfigProvider::with_environment(
        Arc::new(TokioNativeFileSystem),
        home,
        environment.clone().into_iter().collect(),
    )
    .read(&agent_id, account_logged_in)
    .await
    .map_err(internal_error)?;
    let configured_mode = environment
        .get(policy.mode_env)
        .filter(|mode| policy.modes.contains(&mode.as_str()))
        .filter(|mode| mode.as_str() != "model_provider")
        .cloned();
    let mode = if providers.bound_provider_id.is_some() {
        "model_provider".to_string()
    } else if let Some(mode) = configured_mode {
        mode
    } else if agent_id.as_str() == "claude_code" {
        if native_field_present(&snapshot, "anthropic_api_key")
            || native_field_text(&snapshot, "anthropic_base_url").is_some()
        {
            "custom".to_string()
        } else {
            "official_subscription".to_string()
        }
    } else if native_field_present(&snapshot, "antigravity_api_key") {
        "gemini-api-key".to_string()
    } else if native_field_present(&snapshot, "antigravity_google_api_key")
        || native_field_text(&snapshot, "antigravity_cloud_project").is_some()
    {
        "agent-platform".to_string()
    } else {
        "oauth-personal".to_string()
    };
    let credential_env = agents::auth_mode_credential_env(&agent_id, &mode)
        .unwrap_or(policy.credential_env)
        .to_string();
    let credential_present = match (agent_id.as_str(), mode.as_str()) {
        (_, "model_provider") => providers
            .providers
            .iter()
            .find(|provider| Some(&provider.id) == providers.bound_provider_id.as_ref())
            .is_some_and(|provider| provider.credential_present),
        ("claude_code", "custom") => native_field_present(&snapshot, "anthropic_api_key"),
        ("antigravity" | "gemini", "gemini-api-key") => {
            native_field_present(&snapshot, "antigravity_api_key")
        }
        ("antigravity" | "gemini", "agent-platform") => {
            native_field_present(&snapshot, "antigravity_google_api_key")
                || (native_field_text(&snapshot, "antigravity_cloud_project").is_some()
                    && native_field_text(&snapshot, "antigravity_cloud_location").is_some())
        }
        _ => false,
    };
    Ok(AgentAuthModeView {
        options: project_auth_mode_options(&agent_id, policy.modes),
        agent_id,
        mode,
        modes: policy
            .modes
            .iter()
            .map(|mode| (*mode).to_string())
            .collect(),
        credential_env,
        credential_present,
        account_label: None,
    })
}

async fn evaluate_profile_auth_mode_preflight(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
    agent_id: AgentId,
    authentication: AgentAuthenticationStatus,
) -> Result<(AgentAuthModeView, bool, String, Option<String>), AgentManagementErrorView> {
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(pool, &agent_id).await?;
    let account_logged_in = resolve_native_account_login(&home, &agent_id, &environment).await;
    let snapshot = NativeConfigProvider::with_environment(
        Arc::new(TokioNativeFileSystem),
        home.clone(),
        environment.clone().into_iter().collect(),
    )
    .read(&agent_id, account_logged_in)
    .await
    .map_err(internal_error)?;
    let view = read_profile_auth_mode_view(app, pool, agent_id.clone()).await?;
    let account_ready = matches!(
        authentication,
        AgentAuthenticationStatus::Account | AgentAuthenticationStatus::MultipleUnknown
    );
    let native_path = snapshot.path.display().to_string();
    let (ready, detail, path) = match (agent_id.as_str(), view.mode.as_str()) {
        ("claude_code", "official_subscription") => (
            account_ready,
            if account_ready {
                "Claude 官方订阅模式已检测到有效账号会话。"
            } else {
                "Claude 官方订阅模式尚未检测到有效账号会话，请先运行官方登录。"
            }
            .to_string(),
            Some(native_path),
        ),
        ("claude_code", "custom") => {
            let base_ready = native_field_text(&snapshot, "anthropic_base_url").is_some();
            let ready = base_ready && view.credential_present;
            (
                ready,
                if ready {
                    "Claude 自定义端点与 ANTHROPIC_API_KEY 已配置。".to_string()
                } else {
                    "Claude 自定义模式需要 ANTHROPIC_BASE_URL 与 ANTHROPIC_API_KEY。".to_string()
                },
                Some(native_path),
            )
        }
        ("claude_code", "model_provider") => {
            let projection_ready =
                provider_json_projection_ready(&snapshot.path, agent_id.as_str()).await;
            let ready = view.credential_present && projection_ready;
            (
                ready,
                if ready {
                    "Model Provider 绑定、凭据与原生配置投影已对齐。".to_string()
                } else {
                    "Model Provider 绑定与原生配置投影不一致，请重新绑定。".to_string()
                },
                Some(native_path),
            )
        }
        ("antigravity" | "gemini", "oauth-personal") => (
            true,
            "首次会话会打开浏览器完成 Google 登录。".to_string(),
            Some(native_path),
        ),
        ("antigravity" | "gemini", "oauth-business") => {
            let ready = native_field_text(&snapshot, "antigravity_cloud_project").is_some()
                && native_field_text(&snapshot, "antigravity_cloud_location").is_some();
            (
                ready,
                if ready {
                    "Gemini Enterprise 项目与区域已配置。".to_string()
                } else {
                    "Gemini Enterprise 需要 Google Cloud 项目与区域。".to_string()
                },
                Some(native_path),
            )
        }
        ("antigravity" | "gemini", "gemini-api-key" | "agent-platform") => (
            view.credential_present,
            if view.credential_present {
                format!("{} 已配置（凭据内容不会显示）。", view.credential_env)
            } else {
                format!("{} 模式缺少必要凭据。", view.mode)
            },
            Some(native_path),
        ),
        ("antigravity" | "gemini", "model_provider") => {
            let projection_ready =
                provider_json_projection_ready(&snapshot.path, agent_id.as_str()).await;
            let ready = view.credential_present && projection_ready;
            (
                ready,
                if ready {
                    "Model Provider 绑定、凭据与原生配置投影已对齐。".to_string()
                } else {
                    "Model Provider 绑定与原生配置投影不一致，请重新绑定。".to_string()
                },
                Some(native_path),
            )
        }
        _ => (
            false,
            format!("无法验证鉴权模式 `{}`。", view.mode),
            Some(native_path),
        ),
    };
    Ok((view, ready, detail, path))
}

async fn provider_json_projection_ready(path: &Path, agent_id: &str) -> bool {
    let Ok(document) = read_json_object_or_empty(path).await else {
        return false;
    };
    let Some(environment) = document.get("env").and_then(serde_json::Value::as_object) else {
        return false;
    };
    let present = |key: &str| {
        environment
            .get(key)
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    };
    match agent_id {
        "claude_code" => present("ANTHROPIC_BASE_URL") && present("ANTHROPIC_AUTH_TOKEN"),
        "antigravity" | "gemini" => {
            present("GEMINI_API_KEY")
                && (present("GOOGLE_GEMINI_BASE_URL") || present("GEMINI_BASE_URL"))
        }
        _ => false,
    }
}

fn native_field_present(snapshot: &agents::NativeConfigSnapshot, field_id: &str) -> bool {
    snapshot
        .fields
        .iter()
        .find(|field| field.field_id == field_id)
        .is_some_and(|field| field.present)
}

fn native_field_text<'a>(
    snapshot: &'a agents::NativeConfigSnapshot,
    field_id: &str,
) -> Option<&'a str> {
    snapshot
        .fields
        .iter()
        .find(|field| field.field_id == field_id)
        .and_then(|field| field.value.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

async fn set_profile_auth_mode(
    app: &AppHandle,
    state: &AppState,
    agent_id: AgentId,
    mode: &str,
    api_key: Option<&str>,
) -> Result<AgentAuthModeView, AgentManagementErrorView> {
    let policy = agents::built_in_auth_mode_policy(&agent_id).ok_or_else(|| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            "此 Agent 没有独立鉴权模式",
            Some(agent_id.clone()),
        )
    })?;
    if !policy.modes.contains(&mode) {
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            format!("不支持鉴权模式 `{mode}`"),
            Some(agent_id),
        ));
    }
    let home = app.path().home_dir().map_err(internal_error)?;
    let mut environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let original_environment = environment.clone();
    let store_path = app
        .path()
        .app_data_dir()
        .map_err(internal_error)?
        .join("agent-model-providers.json");
    let providers = model_providers::list(&store_path, agent_id.clone())
        .await
        .map_err(internal_error)?;
    if mode == "model_provider" && providers.bound_provider_id.is_none() {
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            "请先在 Model Provider 区域绑定一个 Provider",
            Some(agent_id),
        ));
    }

    let previous_binding = providers.bound_provider_id;
    let env_rollback = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?
    .flatten();
    let mut native_provider = None;
    let mut native_patch = None;
    let mut file_rollback = Vec::new();
    let account_logged_in = if mode != "model_provider" {
        let account_logged_in = resolve_native_account_login(&home, &agent_id, &environment).await;
        let provider = NativeConfigProvider::with_environment(
            Arc::new(TokioNativeFileSystem),
            home.clone(),
            environment.clone().into_iter().collect(),
        );
        let snapshot = provider
            .read(&agent_id, account_logged_in)
            .await
            .map_err(internal_error)?;
        let patch = native_auth_mode_patch(&agent_id, mode, api_key, &snapshot)?;
        file_rollback = capture_native_file_rollback(&snapshot.paths).await?;
        native_provider = Some(provider);
        native_patch = Some(patch);
        Some(account_logged_in)
    } else {
        None
    };

    let operation = async {
        if mode != "model_provider" && previous_binding.is_some() {
            model_providers::bind(&store_path, &home, &environment, agent_id.clone(), None)
                .await
                .map_err(internal_error)?;
        }
        if let (Some(provider), Some(patch), Some(account_logged_in)) =
            (native_provider.as_ref(), native_patch, account_logged_in)
        {
            provider
                .save(&agent_id, patch, account_logged_in)
                .await
                .map_err(|error| map_native_config_save_error(&agent_id, error))?;
            refresh_native_file_rollback_expected(&mut file_rollback).await?;
        }

        environment.insert(policy.mode_env.to_string(), mode.to_string());
        if let Some(credential_env) = agents::auth_mode_credential_env(&agent_id, mode)
            && let Some(api_key) = api_key.map(str::trim).filter(|value| !value.is_empty())
        {
            environment.insert(credential_env.to_string(), api_key.to_string());
        }
        agents::apply_built_in_auth_mode_policy(&agent_id, &mut environment);
        let env_json = serde_json::to_string(&environment).map_err(internal_error)?;
        ensure_agent_setting_row(&state.deployment.db().pool, &agent_id).await?;
        let result = sqlx::query(
            "UPDATE agent_setting SET env_json = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_type = ?",
        )
        .bind(env_json)
        .bind(agent_id.as_str())
        .execute(&state.deployment.db().pool)
        .await
        .map_err(internal_error)?;
        if result.rows_affected() == 0 {
            return Err(management_error(
                AgentManagementErrorCode::NotFound,
                "Agent 设置不存在",
                Some(agent_id.clone()),
            ));
        }
        Ok::<(), AgentManagementErrorView>(())
    }
    .await;
    if let Err(mut error) = operation {
        let files_restored = match restore_native_file_rollback(&file_rollback).await {
            Ok(()) => true,
            Err(rollback_error) => {
                error.message = format!(
                    "{}；恢复原生鉴权配置失败：{}",
                    error.message, rollback_error.message
                );
                false
            }
        };
        if files_restored
            && mode != "model_provider"
            && let Some(provider_id) = previous_binding
            && let Err(rollback_error) = model_providers::bind(
                &store_path,
                &home,
                &original_environment,
                agent_id.clone(),
                Some(provider_id),
            )
            .await
        {
            error.message = format!(
                "{}；恢复 Model Provider 绑定失败：{}",
                error.message, rollback_error
            );
        }
        if let Err(rollback_error) = sqlx::query(
            "UPDATE agent_setting SET env_json = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_type = ?",
        )
        .bind(env_rollback)
        .bind(agent_id.as_str())
        .execute(&state.deployment.db().pool)
        .await
        {
            error.message = format!("{}；恢复鉴权环境失败：{}", error.message, rollback_error);
        }
        return Err(error);
    }
    if matches!(agent_id.as_str(), "antigravity" | "gemini") {
        let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
        let home = app.path().home_dir().ok();
        let report = agents::sync_antigravity_settings(&environment, home.as_deref());
        if report.status == agents::AntigravitySyncStatus::Skipped {
            tracing::warn!(
                path = %report.path.display(),
                reason = report.reason.as_deref().unwrap_or("unknown"),
                "Antigravity settings.json was left unchanged"
            );
        }
    }
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "Agent 鉴权模式已更改")
        .await;
    read_profile_auth_mode_view(app, &state.deployment.db().pool, agent_id).await
}

fn native_auth_mode_patch(
    agent_id: &AgentId,
    mode: &str,
    api_key: Option<&str>,
    snapshot: &agents::NativeConfigSnapshot,
) -> Result<NativeConfigPatch, AgentManagementErrorView> {
    let submitted_key = api_key.map(str::trim).filter(|value| !value.is_empty());
    let mut values = BTreeMap::new();
    let mut set = |field: &str, value: Option<String>| {
        values.insert(field.to_string(), value);
    };
    if agent_id.as_str() == "claude_code" {
        match mode {
            "official_subscription" => {
                set("anthropic_base_url", None);
                set("anthropic_api_key", None);
            }
            "custom" => {
                if let Some(api_key) = submitted_key {
                    set("anthropic_api_key", Some(api_key.to_string()));
                }
                require_native_auth_value(
                    agent_id,
                    mode,
                    "ANTHROPIC_API_KEY",
                    submitted_key.is_some() || native_field_present(snapshot, "anthropic_api_key"),
                )?;
                require_native_auth_value(
                    agent_id,
                    mode,
                    "ANTHROPIC_BASE_URL",
                    native_field_text(snapshot, "anthropic_base_url").is_some(),
                )?;
            }
            _ => {}
        }
    } else if matches!(agent_id.as_str(), "antigravity" | "gemini") {
        set("antigravity_auth", Some(mode.to_string()));
        match mode {
            "oauth-personal" => {
                set("antigravity_api_key", None);
                set("antigravity_google_api_key", None);
            }
            "oauth-business" => {
                set("antigravity_api_key", None);
                set("antigravity_google_api_key", None);
                require_native_auth_value(
                    agent_id,
                    mode,
                    "GOOGLE_CLOUD_PROJECT",
                    native_field_text(snapshot, "antigravity_cloud_project").is_some(),
                )?;
                require_native_auth_value(
                    agent_id,
                    mode,
                    "GOOGLE_CLOUD_LOCATION",
                    native_field_text(snapshot, "antigravity_cloud_location").is_some(),
                )?;
            }
            "gemini-api-key" => {
                set("antigravity_google_api_key", None);
                if let Some(api_key) = submitted_key {
                    set("antigravity_api_key", Some(api_key.to_string()));
                }
                require_native_auth_value(
                    agent_id,
                    mode,
                    "GEMINI_API_KEY",
                    submitted_key.is_some()
                        || native_field_present(snapshot, "antigravity_api_key"),
                )?;
            }
            "agent-platform" => {
                set("antigravity_api_key", None);
                if let Some(api_key) = submitted_key {
                    set("antigravity_google_api_key", Some(api_key.to_string()));
                }
                let key_ready = submitted_key.is_some()
                    || native_field_present(snapshot, "antigravity_google_api_key");
                let project_ready = native_field_text(snapshot, "antigravity_cloud_project")
                    .is_some()
                    && native_field_text(snapshot, "antigravity_cloud_location").is_some();
                require_native_auth_value(
                    agent_id,
                    mode,
                    "GOOGLE_API_KEY or GOOGLE_CLOUD_PROJECT",
                    key_ready || project_ready,
                )?;
            }
            _ => {}
        }
    }
    let base_field_revisions = snapshot
        .fields
        .iter()
        .filter(|field| values.contains_key(&field.field_id))
        .map(|field| (field.field_id.clone(), field.revision.clone()))
        .collect();
    Ok(NativeConfigPatch {
        base_field_revisions,
        values,
    })
}

fn require_native_auth_value(
    agent_id: &AgentId,
    mode: &str,
    value_name: &str,
    present: bool,
) -> Result<(), AgentManagementErrorView> {
    if present {
        return Ok(());
    }
    Err(management_error(
        AgentManagementErrorCode::InvalidState,
        format!("{mode} 模式需要 {value_name}"),
        Some(agent_id.clone()),
    ))
}

async fn read_codex_auth_mode_view(
    app: &AppHandle,
    pool: &sqlx::SqlitePool,
) -> Result<AgentAuthModeView, AgentManagementErrorView> {
    let agent_id = AgentId::parse("codex").expect("built-in id");
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(pool, &agent_id).await?;
    let codex_home = resolve_agent_home_directory(&home, &environment, "CODEX_HOME", ".codex");
    let auth = read_json_object_or_empty(&codex_home.join("auth.json")).await?;
    let store_path = app
        .path()
        .app_data_dir()
        .map_err(internal_error)?
        .join("agent-model-providers.json");
    let providers =
        model_providers::list_with_native(&store_path, agent_id.clone(), Some(&codex_home))
            .await
            .map_err(internal_error)?;
    Ok(project_codex_auth_mode(
        agent_id,
        &auth,
        providers.bound_provider_id.is_some(),
    ))
}

async fn set_codex_auth_mode(
    app: &AppHandle,
    state: &AppState,
    agent_id: AgentId,
    mode: &str,
    api_key: Option<&str>,
) -> Result<AgentAuthModeView, AgentManagementErrorView> {
    if !agents::CODEX_AUTH_MODES.contains(&mode) {
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            format!("不支持鉴权模式 `{mode}`"),
            Some(agent_id),
        ));
    }
    let home = app.path().home_dir().map_err(internal_error)?;
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let codex_home = resolve_agent_home_directory(&home, &environment, "CODEX_HOME", ".codex");
    let store_path = app
        .path()
        .app_data_dir()
        .map_err(internal_error)?
        .join("agent-model-providers.json");
    let providers =
        model_providers::list_with_native(&store_path, agent_id.clone(), Some(&codex_home))
            .await
            .map_err(internal_error)?;

    if mode == "model_provider" {
        if providers.bound_provider_id.is_none() {
            return Err(management_error(
                AgentManagementErrorCode::InvalidState,
                "请先在 Model Provider 区域绑定一个 Codex Provider",
                Some(agent_id),
            ));
        }
        return read_codex_auth_mode_view(app, &state.deployment.db().pool).await;
    }

    // 解除绑定只针对 VibeX 预设的绑定；原生 config.toml 中的自定义 Provider
    // 属于 Agent 原生配置，切换模式不触碰它们。
    let previous_binding = model_providers::list(&store_path, agent_id.clone())
        .await
        .map_err(internal_error)?
        .bound_provider_id;
    if previous_binding.is_some() {
        model_providers::bind(&store_path, &home, &environment, agent_id.clone(), None)
            .await
            .map_err(internal_error)?;
    }

    let mutation_result = match prepare_codex_auth_mode_mutations(&codex_home, mode, api_key).await
    {
        Ok(mutations) => apply_native_file_mutations(&mutations).await,
        Err(error) => Err(error),
    };
    if let Err(mut error) = mutation_result {
        if let Some(provider_id) = previous_binding
            && let Err(rollback_error) = model_providers::bind(
                &store_path,
                &home,
                &environment,
                agent_id.clone(),
                Some(provider_id),
            )
            .await
        {
            error.message = format!(
                "{}；恢复原 Model Provider 绑定失败：{}",
                error.message, rollback_error
            );
        }
        return Err(error);
    }
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "Codex 鉴权模式已更改")
        .await;
    read_codex_auth_mode_view(app, &state.deployment.db().pool).await
}

async fn prepare_codex_auth_mode_mutations(
    codex_home: &Path,
    mode: &str,
    api_key: Option<&str>,
) -> Result<Vec<NativeFileMutation>, AgentManagementErrorView> {
    let auth_path = codex_home.join("auth.json");
    let (mut auth, auth_original) = read_json_object_state(&auth_path).await?;
    apply_codex_auth_document(&mut auth, mode, api_key)?;
    let mut mutations = vec![json_document_mutation(
        &auth_path,
        auth_original,
        &auth,
        true,
    )?];

    if mode == "chatgpt_subscription" {
        let config_path = codex_home.join("config.toml");
        let config_original = match tokio::fs::read(&config_path).await {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(internal_error(error)),
        };
        if let Some(source) = config_original.as_deref() {
            let text = std::str::from_utf8(source).map_err(internal_error)?;
            let mut table = if text.trim().is_empty() {
                toml::Table::new()
            } else {
                toml::from_str::<toml::Table>(text).map_err(internal_error)?
            };
            let mut changed = false;
            // 只移除 VibeX 投影写入的 `model_provider = "vibex"`；用户在原生
            // config.toml 中手写的自定义 Provider 属于 Agent 原生配置，切换
            // 订阅模式不删除它。
            if table.get("model_provider").and_then(toml::Value::as_str) == Some("vibex") {
                changed |= table.remove("model_provider").is_some();
            }
            if let Some(providers) = table
                .get_mut("model_providers")
                .and_then(toml::Value::as_table_mut)
            {
                changed |= providers.remove("vibex").is_some();
                if providers.is_empty() {
                    table.remove("model_providers");
                }
            }
            if changed {
                mutations.push(NativeFileMutation {
                    path: config_path,
                    expected: config_original,
                    replacement: Some(
                        toml::to_string_pretty(&table)
                            .map_err(internal_error)?
                            .into_bytes(),
                    ),
                    sensitive: false,
                });
            }
        }
    }
    Ok(mutations)
}

fn apply_codex_auth_document(
    document: &mut serde_json::Value,
    mode: &str,
    api_key: Option<&str>,
) -> Result<(), AgentManagementErrorView> {
    agents::apply_codex_auth_mode(document, mode, api_key).map_err(|message| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            message,
            Some(AgentId::parse("codex").expect("built-in id")),
        )
    })
}

fn project_codex_auth_mode(
    agent_id: AgentId,
    auth: &serde_json::Value,
    provider_bound: bool,
) -> AgentAuthModeView {
    let projection = agents::project_codex_auth_mode(auth, provider_bound);
    AgentAuthModeView {
        options: project_auth_mode_options(&agent_id, agents::CODEX_AUTH_MODES),
        agent_id,
        mode: projection.mode.to_string(),
        modes: agents::CODEX_AUTH_MODES
            .iter()
            .map(|mode| (*mode).to_string())
            .collect(),
        credential_env: "OPENAI_API_KEY".to_string(),
        credential_present: projection.credential_present,
        account_label: None,
    }
}

fn project_auth_mode_options(agent_id: &AgentId, modes: &[&str]) -> Vec<AgentAuthModeOptionView> {
    modes
        .iter()
        .map(|mode| {
            let (label_key, description_key) = auth_mode_translation_keys(agent_id, mode);
            let credential_env = agents::auth_mode_credential_env(agent_id, mode)
                .map(str::to_string)
                .or_else(|| {
                    (agent_id.as_str() == "codex" && *mode == "api_key")
                        .then(|| "OPENAI_API_KEY".to_string())
                });
            AgentAuthModeOptionView {
                value: (*mode).to_string(),
                label_key: label_key.to_string(),
                description_key: description_key.to_string(),
                credential_required: credential_env.is_some(),
                credential_env,
                native_config_field_id: native_auth_config_field_id(agent_id, mode)
                    .map(str::to_string),
            }
        })
        .collect()
}

fn native_auth_config_field_id(agent_id: &AgentId, mode: &str) -> Option<&'static str> {
    match (agent_id.as_str(), mode) {
        ("claude_code", "custom") => Some("anthropic_api_key"),
        ("codex", "api_key") => Some("openai_api_key"),
        ("antigravity" | "gemini", "gemini-api-key") => Some("antigravity_api_key"),
        ("antigravity" | "gemini", "agent-platform") => Some("antigravity_google_api_key"),
        ("deepseek_harness", "deepseek" | "custom") => Some("deepseek_harness_api_key"),
        _ => None,
    }
}

fn auth_mode_translation_keys(agent_id: &AgentId, mode: &str) -> (&'static str, &'static str) {
    match (agent_id.as_str(), mode) {
        ("claude_code", "official_subscription") => (
            "agents.authModeOfficialSubscription",
            "agents.authDescClaudeSubscription",
        ),
        ("claude_code", "custom") => (
            "agents.authModeCustomEndpoint",
            "agents.authDescClaudeCustom",
        ),
        ("claude_code", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescClaudeProvider")
        }
        ("antigravity" | "gemini", "oauth-personal") => (
            "agents.authModeGoogleLogin",
            "agents.authDescAntigravityOauthPersonal",
        ),
        ("antigravity" | "gemini", "oauth-business") => (
            "agents.authModeAntigravityEnterprise",
            "agents.authDescAntigravityOauthBusiness",
        ),
        ("antigravity" | "gemini", "gemini-api-key") => (
            "agents.authModeGeminiKey",
            "agents.authDescAntigravityApiKey",
        ),
        ("antigravity" | "gemini", "agent-platform") => (
            "agents.authModeAntigravityPlatform",
            "agents.authDescAntigravityPlatform",
        ),
        ("antigravity" | "gemini", "model_provider") => {
            ("agents.authModeProvider", "agents.authDescGeminiProvider")
        }
        ("codex", "chatgpt_subscription") => {
            ("agents.authModeChatGpt", "agents.authDescCodexSubscription")
        }
        ("codex", "api_key") => ("agents.authModeOpenAiKey", "agents.authDescCodexKey"),
        ("codex", "model_provider") => ("agents.authModeProvider", "agents.authDescCodexProvider"),
        ("grok", "subscription") => (
            "agents.authModeSubscription",
            "agents.authDescGrokSubscription",
        ),
        ("grok", "api_key") => ("agents.authModeXaiKey", "agents.authDescGrokKey"),
        ("grok", "custom") => ("agents.authModeCustomEndpoint", "agents.authDescGrokCustom"),
        ("cursor", "subscription") => (
            "agents.authModeSubscription",
            "agents.authDescCursorSubscription",
        ),
        ("cursor", "custom") => ("agents.authModeCursorKey", "agents.authDescCursorKey"),
        ("deepseek_harness", "deepseek") => {
            ("agents.authModeDeepseekApi", "agents.authDescDeepseekApi")
        }
        ("deepseek_harness", "custom") => (
            "agents.authModeCustomEndpoint",
            "agents.authDescDeepseekCustom",
        ),
        _ => ("agents.authModeUnknown", "agents.authDescUnknown"),
    }
}

#[tauri::command]
pub async fn opencode_plugin_list(
    state: tauri::State<'_, AppState>,
) -> Result<OpenCodePluginSummaryView, AgentManagementErrorView> {
    let agent_id = AgentId::parse("opencode").expect("built-in id");
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let paths = opencode_provider_paths(&environment)?;
    opencode_plugins::check_plugins(&paths.config_path, &paths.cache_dir).map_err(internal_error)
}

#[tauri::command]
pub async fn opencode_plugin_install(
    state: tauri::State<'_, AppState>,
    names: Option<Vec<String>>,
) -> Result<OpenCodePluginSummaryView, AgentManagementErrorView> {
    let agent_id = AgentId::parse("opencode").expect("built-in id");
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let paths = opencode_provider_paths(&environment)?;
    let result = opencode_plugins::install_missing(paths.config_path, paths.cache_dir, names)
        .await
        .map_err(internal_error)?;
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "OpenCode 插件已更改")
        .await;
    Ok(result)
}

#[tauri::command]
pub async fn opencode_plugin_uninstall(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<OpenCodePluginSummaryView, AgentManagementErrorView> {
    let agent_id = AgentId::parse("opencode").expect("built-in id");
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let paths = opencode_provider_paths(&environment)?;
    let result = opencode_plugins::uninstall(paths.config_path, paths.cache_dir, name)
        .await
        .map_err(internal_error)?;
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "OpenCode 插件已更改")
        .await;
    Ok(result)
}

#[tauri::command]
pub async fn opencode_provider_connect(
    state: tauri::State<'_, AppState>,
    request: OpenCodeProviderConnectRequest,
) -> Result<OpenCodeProviderConnectionsView, AgentManagementErrorView> {
    let agent_id = AgentId::parse("opencode").expect("built-in id");
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let paths = opencode_provider_paths(&environment)?;
    let auth_path = paths.auth_path;
    let config_path = paths.config_path;
    let (mut auth, auth_original) = read_json_object_state(&auth_path).await?;
    let (mut config, config_original) = read_json_object_state(&config_path).await?;
    apply_opencode_provider_connection(&mut auth, &mut config, &request).map_err(|message| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            message,
            Some(AgentId::parse("opencode").expect("AgentId")),
        )
    })?;
    apply_native_file_mutations(&[
        json_document_mutation(&auth_path, auth_original, &auth, true)?,
        json_document_mutation(&config_path, config_original, &config, false)?,
    ])
    .await?;
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "OpenCode Provider 已更改")
        .await;
    Ok(project_opencode_provider_connections(&auth, &config))
}

#[tauri::command]
pub async fn opencode_provider_disconnect(
    state: tauri::State<'_, AppState>,
    provider_id: String,
) -> Result<OpenCodeProviderConnectionsView, AgentManagementErrorView> {
    validate_opencode_provider_id(&provider_id).map_err(|message| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            message,
            Some(AgentId::parse("opencode").expect("AgentId")),
        )
    })?;
    let agent_id = AgentId::parse("opencode").expect("built-in id");
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let paths = opencode_provider_paths(&environment)?;
    let auth_path = paths.auth_path;
    let config_path = paths.config_path;
    let (mut auth, auth_original) = read_json_object_state(&auth_path).await?;
    let (mut config, config_original) = read_json_object_state(&config_path).await?;
    auth.as_object_mut().expect("object").remove(&provider_id);
    if let Some(providers) = config
        .get_mut("provider")
        .and_then(serde_json::Value::as_object_mut)
    {
        providers.remove(&provider_id);
        if providers.is_empty() {
            config.as_object_mut().expect("object").remove("provider");
        }
    }
    remove_opencode_provider_state(&mut config, &provider_id);
    apply_native_file_mutations(&[
        json_document_mutation(&auth_path, auth_original, &auth, true)?,
        json_document_mutation(&config_path, config_original, &config, false)?,
    ])
    .await?;
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "OpenCode Provider 已更改")
        .await;
    Ok(project_opencode_provider_connections(&auth, &config))
}

#[tauri::command]
pub async fn opencode_provider_set_enabled(
    state: tauri::State<'_, AppState>,
    provider_id: String,
    enabled: bool,
) -> Result<OpenCodeProviderConnectionsView, AgentManagementErrorView> {
    validate_opencode_provider_id(&provider_id).map_err(|message| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            message,
            Some(AgentId::parse("opencode").expect("AgentId")),
        )
    })?;
    let agent_id = AgentId::parse("opencode").expect("built-in id");
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let paths = opencode_provider_paths(&environment)?;
    let auth_path = paths.auth_path;
    let config_path = paths.config_path;
    let auth = read_json_object_or_empty(&auth_path).await?;
    let (mut config, config_original) = read_json_object_state(&config_path).await?;
    let exists = auth.get(&provider_id).is_some()
        || config
            .get("provider")
            .and_then(|providers| providers.get(&provider_id))
            .is_some();
    if !exists {
        return Err(management_error(
            AgentManagementErrorCode::NotFound,
            "OpenCode Provider 不存在",
            Some(AgentId::parse("opencode").expect("AgentId")),
        ));
    }
    set_opencode_provider_enabled(&mut config, &provider_id, enabled).map_err(|message| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            message,
            Some(AgentId::parse("opencode").expect("AgentId")),
        )
    })?;
    apply_native_file_mutations(&[json_document_mutation(
        &config_path,
        config_original,
        &config,
        false,
    )?])
    .await?;
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&agent_id, "OpenCode Provider 已更改")
        .await;
    Ok(project_opencode_provider_connections(&auth, &config))
}

struct OpenCodeNativePaths {
    auth_path: PathBuf,
    config_path: PathBuf,
    cache_dir: PathBuf,
}

fn opencode_provider_paths(
    environment: &HashMap<String, String>,
) -> Result<OpenCodeNativePaths, AgentManagementErrorView> {
    let home = dirs::home_dir().ok_or_else(|| internal_error("用户目录不可用"))?;
    let cache_root = environment
        .get("XDG_CACHE_HOME")
        .filter(|value| !value.trim().is_empty())
        .map(|value| expand_agent_home_path(&home, value))
        .or_else(|| {
            std::env::var_os("XDG_CACHE_HOME")
                .filter(|value| !value.is_empty())
                .map(|value| expand_agent_home_path(&home, &value.to_string_lossy()))
        })
        .unwrap_or_else(|| home.join(".cache"));
    let config_dir =
        agents::metadata::opencode_config_dir().ok_or_else(|| internal_error("用户目录不可用"))?;
    let primary_config = config_dir.join("opencode.json");
    let legacy_config = config_dir.join("config.json");
    let config_path = if !primary_config.is_file() && legacy_config.is_file() {
        legacy_config
    } else {
        primary_config
    };
    Ok(OpenCodeNativePaths {
        auth_path: agents::metadata::opencode_auth_path()
            .ok_or_else(|| internal_error("用户目录不可用"))?,
        config_path,
        cache_dir: cache_root.join("opencode"),
    })
}

async fn read_json_object_or_empty(
    path: &Path,
) -> Result<serde_json::Value, AgentManagementErrorView> {
    read_json_object_state(path).await.map(|(value, _)| value)
}

async fn read_json_object_state(
    path: &Path,
) -> Result<(serde_json::Value, Option<Vec<u8>>), AgentManagementErrorView> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(internal_error(error)),
    };
    let Some(source) = bytes.as_deref() else {
        return Ok((serde_json::json!({}), None));
    };
    let value: serde_json::Value = serde_json::from_slice(source).map_err(internal_error)?;
    if !value.is_object() {
        return Err(internal_error(format!(
            "{} 顶层必须是 JSON 对象",
            path.display()
        )));
    }
    Ok((value, bytes))
}

fn json_document_mutation(
    path: &Path,
    expected: Option<Vec<u8>>,
    value: &serde_json::Value,
    sensitive: bool,
) -> Result<NativeFileMutation, AgentManagementErrorView> {
    Ok(NativeFileMutation {
        path: path.to_path_buf(),
        expected,
        replacement: Some(serde_json::to_vec_pretty(value).map_err(internal_error)?),
        sensitive,
    })
}

async fn apply_native_file_mutations(
    mutations: &[NativeFileMutation],
) -> Result<(), AgentManagementErrorView> {
    TokioNativeFileSystem
        .apply_many_atomic(mutations)
        .await
        .map_err(internal_error)
}

async fn apply_config_transition_then<F>(
    mutations: Vec<NativeFileMutation>,
    operation: F,
) -> Result<(), AgentManagementErrorView>
where
    F: FnOnce() -> Result<(), AgentManagementErrorView>,
{
    apply_native_file_mutations(&mutations).await?;
    if let Err(mut operation_error) = operation() {
        let rollback = mutations
            .into_iter()
            .map(|mutation| NativeFileMutation {
                path: mutation.path,
                expected: mutation.replacement,
                replacement: mutation.expected,
                sensitive: mutation.sensitive,
            })
            .collect::<Vec<_>>();
        if let Err(rollback_error) = apply_native_file_mutations(&rollback).await {
            operation_error.message = format!(
                "{}；恢复原配置失败：{}",
                operation_error.message, rollback_error.message
            );
        }
        return Err(operation_error);
    }
    Ok(())
}

async fn write_json_document(
    path: &Path,
    value: &serde_json::Value,
    sensitive: bool,
) -> Result<(), AgentManagementErrorView> {
    let bytes = serde_json::to_vec_pretty(value).map_err(internal_error)?;
    write_bytes_document(path, &bytes, sensitive).await
}

fn apply_opencode_provider_connection(
    auth: &mut serde_json::Value,
    config: &mut serde_json::Value,
    request: &OpenCodeProviderConnectRequest,
) -> Result<(), String> {
    validate_opencode_provider_id(&request.provider_id)?;
    if !auth.is_object() || !config.is_object() {
        return Err("OpenCode auth.json 与 opencode.json 顶层必须是对象".to_string());
    }
    let submitted_api_key = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty());
    let credential_present = auth.get(&request.provider_id).is_some_and(|entry| {
        entry
            .get("key")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|key| !key.trim().is_empty())
            || entry.get("type").and_then(serde_json::Value::as_str) == Some("oauth")
    });
    if submitted_api_key.is_none() && !credential_present {
        return Err("新 Provider 必须提供 API Key".to_string());
    }
    if let Some(api_key) = submitted_api_key {
        let auth_entry = auth
            .as_object_mut()
            .expect("object")
            .entry(request.provider_id.clone())
            .or_insert_with(|| serde_json::json!({}));
        if !auth_entry.is_object() {
            *auth_entry = serde_json::json!({});
        }
        let auth_entry = auth_entry.as_object_mut().expect("object");
        auth_entry.insert("type".to_string(), serde_json::json!("api"));
        auth_entry.insert("key".to_string(), serde_json::json!(api_key));
    }

    let has_provider_override = request
        .npm
        .as_deref()
        .is_some_and(|npm| !npm.trim().is_empty())
        || request
            .api
            .as_deref()
            .is_some_and(|api| !api.trim().is_empty())
        || request
            .base_url
            .as_deref()
            .is_some_and(|url| !url.trim().is_empty())
        || request
            .models
            .iter()
            .any(|model| !model.id.trim().is_empty());
    if !has_provider_override {
        set_opencode_provider_enabled(config, &request.provider_id, request.enabled)?;
        return Ok(());
    }

    let providers = config
        .as_object_mut()
        .expect("object")
        .entry("provider")
        .or_insert_with(|| serde_json::json!({}));
    let providers = providers
        .as_object_mut()
        .ok_or_else(|| "opencode.json 的 provider 必须是对象".to_string())?;
    let provider = providers
        .entry(request.provider_id.clone())
        .or_insert_with(|| serde_json::json!({}));
    let provider = provider
        .as_object_mut()
        .ok_or_else(|| format!("Provider `{}` 的配置必须是对象", request.provider_id))?;
    provider.insert(
        "name".to_string(),
        serde_json::Value::String(if request.name.trim().is_empty() {
            request.provider_id.clone()
        } else {
            request.name.trim().to_string()
        }),
    );
    match request
        .npm
        .as_deref()
        .map(str::trim)
        .filter(|npm| !npm.is_empty())
    {
        Some(npm) => {
            provider.insert(
                "npm".to_string(),
                serde_json::Value::String(npm.to_string()),
            );
        }
        None => {
            provider.remove("npm");
        }
    }
    match request
        .api
        .as_deref()
        .map(str::trim)
        .filter(|api| !api.is_empty())
    {
        Some(api) => {
            provider.insert(
                "api".to_string(),
                serde_json::Value::String(api.to_string()),
            );
        }
        None => {
            provider.remove("api");
        }
    }
    let base_url = request
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty());
    if base_url.is_some() || provider.contains_key("options") {
        let options = provider
            .entry("options".to_string())
            .or_insert_with(|| serde_json::json!({}));
        let options = options
            .as_object_mut()
            .ok_or_else(|| format!("Provider `{}` 的 options 必须是对象", request.provider_id))?;
        match base_url {
            Some(base_url) => {
                options.insert("baseURL".to_string(), serde_json::json!(base_url));
            }
            None => {
                options.remove("baseURL");
            }
        }
        if options.is_empty() {
            provider.remove("options");
        }
    }
    let requested_models = normalize_opencode_provider_models(&request.models)?;
    let mut existing_models = match provider.remove("models") {
        Some(serde_json::Value::Object(models)) => models,
        Some(_) => {
            return Err(format!(
                "Provider `{}` 的 models 必须是对象",
                request.provider_id
            ));
        }
        None => serde_json::Map::new(),
    };
    if !requested_models.is_empty() {
        let mut preserved_entries = Vec::with_capacity(requested_models.len());
        for model in &requested_models {
            let source_id = model.previous_id.as_deref().unwrap_or(&model.id);
            let entry = existing_models
                .remove(source_id)
                .or_else(|| existing_models.remove(&model.id));
            preserved_entries.push(entry);
        }
        let models = requested_models
            .into_iter()
            .zip(preserved_entries)
            .map(|(model, existing)| {
                let mut entry = match existing {
                    Some(serde_json::Value::Object(entry)) => entry,
                    _ => serde_json::Map::new(),
                };
                entry.insert("name".to_string(), serde_json::json!(model.name));
                (model.id, serde_json::Value::Object(entry))
            })
            .collect::<serde_json::Map<_, _>>();
        provider.insert("models".to_string(), serde_json::Value::Object(models));
    } else {
        provider.remove("models");
    }
    set_opencode_provider_enabled(config, &request.provider_id, request.enabled)?;
    Ok(())
}

fn normalize_opencode_provider_models(
    models: &[OpenCodeProviderModelRequest],
) -> Result<Vec<OpenCodeProviderModelRequest>, String> {
    let mut ids = std::collections::BTreeSet::new();
    let mut normalized = Vec::with_capacity(models.len());
    for model in models {
        let id = model.id.trim();
        if id.is_empty() {
            return Err("模型 ID 不能为空".to_string());
        }
        if !ids.insert(id.to_string()) {
            return Err(format!("模型 ID `{id}` 重复"));
        }
        let name = model.name.trim();
        normalized.push(OpenCodeProviderModelRequest {
            id: id.to_string(),
            name: if name.is_empty() { id } else { name }.to_string(),
            previous_id: model
                .previous_id
                .as_deref()
                .map(str::trim)
                .filter(|previous_id| !previous_id.is_empty())
                .map(str::to_string),
        });
    }
    Ok(normalized)
}

fn set_opencode_provider_enabled(
    config: &mut serde_json::Value,
    provider_id: &str,
    enabled: bool,
) -> Result<(), String> {
    let object = config
        .as_object_mut()
        .ok_or_else(|| "opencode.json 顶层必须是对象".to_string())?;
    update_provider_id_array(object, "disabled_providers", provider_id, !enabled)?;
    if object
        .get("enabled_providers")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|values| !values.is_empty())
    {
        update_provider_id_array(object, "enabled_providers", provider_id, enabled)?;
    }
    Ok(())
}

fn remove_opencode_provider_state(config: &mut serde_json::Value, provider_id: &str) {
    let Some(object) = config.as_object_mut() else {
        return;
    };
    for key in ["enabled_providers", "disabled_providers"] {
        if let Some(values) = object
            .get_mut(key)
            .and_then(serde_json::Value::as_array_mut)
        {
            values.retain(|value| value.as_str() != Some(provider_id));
            if values.is_empty() {
                object.remove(key);
            }
        }
    }
}

fn update_provider_id_array(
    object: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    provider_id: &str,
    present: bool,
) -> Result<(), String> {
    if !present && object.get(key).is_none() {
        return Ok(());
    }
    let values = object
        .entry(key.to_string())
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or_else(|| format!("opencode.json 的 {key} 必须是数组"))?;
    values.retain(|value| value.as_str() != Some(provider_id));
    if present {
        values.push(serde_json::Value::String(provider_id.to_string()));
    } else if values.is_empty() {
        object.remove(key);
    }
    Ok(())
}

fn validate_opencode_provider_id(provider_id: &str) -> Result<(), String> {
    static ID: OnceLock<regex::Regex> = OnceLock::new();
    let pattern =
        ID.get_or_init(|| regex::Regex::new(r"^[a-z0-9][a-z0-9._-]*$").expect("provider id regex"));
    if pattern.is_match(provider_id) {
        Ok(())
    } else {
        Err("Provider ID 只能包含小写字母、数字、点、短横线和下划线".to_string())
    }
}

fn project_opencode_provider_connections(
    auth: &serde_json::Value,
    config: &serde_json::Value,
) -> OpenCodeProviderConnectionsView {
    let mut ids = std::collections::BTreeSet::new();
    ids.extend(
        auth.as_object()
            .into_iter()
            .flat_map(|object| object.keys().cloned()),
    );
    ids.extend(
        config
            .get("provider")
            .and_then(serde_json::Value::as_object)
            .into_iter()
            .flat_map(|object| object.keys().cloned()),
    );
    let providers = ids
        .into_iter()
        .map(|provider_id| {
            let definition = config
                .get("provider")
                .and_then(|value| value.get(&provider_id));
            let credential_present = auth.get(&provider_id).is_some_and(|entry| {
                entry
                    .get("key")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|key| !key.trim().is_empty())
                    || entry.get("type").and_then(serde_json::Value::as_str) == Some("oauth")
            });
            let disabled = config
                .get("disabled_providers")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|values| {
                    values
                        .iter()
                        .any(|value| value.as_str() == Some(&provider_id))
                });
            let enabled_allowlist = config
                .get("enabled_providers")
                .and_then(serde_json::Value::as_array);
            let enabled = !disabled
                && enabled_allowlist.is_none_or(|values| {
                    values.is_empty()
                        || values
                            .iter()
                            .any(|value| value.as_str() == Some(&provider_id))
                });
            OpenCodeProviderConnectionView {
                name: definition
                    .and_then(|value| value.get("name"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(&provider_id)
                    .to_string(),
                npm: definition
                    .and_then(|value| value.get("npm"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                api: definition
                    .and_then(|value| value.get("api"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                base_url: definition
                    .and_then(|value| value.get("options"))
                    .and_then(|value| value.get("baseURL"))
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string),
                models: definition
                    .and_then(|value| value.get("models"))
                    .and_then(serde_json::Value::as_object)
                    .map(|models| {
                        models
                            .iter()
                            .map(|(id, model)| OpenCodeProviderModelView {
                                id: id.clone(),
                                name: model
                                    .get("name")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or(id)
                                    .to_string(),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                provider_id,
                credential_present,
                enabled,
            }
        })
        .collect();
    OpenCodeProviderConnectionsView { providers }
}

#[tauri::command]
pub async fn agent_management_actions(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentManagementActionsView, AgentManagementErrorView> {
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = catalog.profile(&agent_id).ok_or_else(|| {
        management_error(
            AgentManagementErrorCode::NotFound,
            format!("Agent `{agent_id}` 没有内置账号管理动作"),
            Some(agent_id.clone()),
        )
    })?;
    let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let mut actions = Vec::with_capacity(profile.management_actions.len());
    for action in profile.management_actions {
        let program = match action.program {
            Some(program) => {
                resolve_management_program(
                    &state.deployment.db().pool,
                    &agent_id,
                    program,
                    &environment,
                )
                .await
            }
            None => None,
        };
        let available = action.url.is_some() || program.is_some();
        let translation_prefix = format!(
            "agents.managementAction.{}.{}",
            agent_id.as_str(),
            action.id
        );
        actions.push(AgentManagementActionView {
            id: action.id.to_string(),
            label: action.label.to_string(),
            description: action.description.to_string(),
            label_key: format!("{translation_prefix}.label"),
            description_key: format!("{translation_prefix}.description"),
            kind: management_action_kind(action.kind),
            available,
            unavailable_reason: (!available).then(|| {
                format!(
                    "未找到 `{}`；请先安装或修复此 Agent。",
                    action.program.unwrap_or("命令")
                )
            }),
            url: action.url.map(str::to_string),
        });
    }
    Ok(AgentManagementActionsView { agent_id, actions })
}

#[tauri::command]
pub async fn agent_management_run_action(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
    action_id: String,
) -> Result<AgentManagementActionReceipt, AgentManagementErrorView> {
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = catalog.profile(&agent_id).ok_or_else(|| {
        management_error(
            AgentManagementErrorCode::NotFound,
            format!("Agent `{agent_id}` 没有内置账号管理动作"),
            Some(agent_id.clone()),
        )
    })?;
    let action = profile
        .management_actions
        .iter()
        .find(|action| action.id == action_id)
        .ok_or_else(|| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                format!("Agent `{agent_id}` 不支持动作 `{action_id}`"),
                Some(agent_id.clone()),
            )
        })?;

    if let Some(url) = action.url {
        utils::browser::open_browser(url)
            .await
            .map_err(internal_error)?;
    } else {
        let program_name = action.program.ok_or_else(|| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                "账号管理动作缺少内置命令",
                Some(agent_id.clone()),
            )
        })?;
        let environment = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
        let program = resolve_management_program(
            &state.deployment.db().pool,
            &agent_id,
            program_name,
            &environment,
        )
        .await
        .ok_or_else(|| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                format!("未找到 `{program_name}`；请先安装或修复此 Agent。"),
                Some(agent_id.clone()),
            )
        })?;
        let command = std::iter::once(program.display().to_string())
            .chain(action.args.iter().map(|argument| (*argument).to_string()))
            .map(|part| shell_quote_management_part(&part))
            .collect::<Vec<_>>()
            .join(" ");
        let command = management_command_with_environment(&command, &environment);
        let watches_account = matches!(
            action.kind,
            ProfileManagementActionKind::Login | ProfileManagementActionKind::Logout
        );
        let command = if watches_account {
            let result_path = account_flow::account_flow_result_path(&agent_id);
            let _ = tokio::fs::remove_file(&result_path).await;
            account_flow::register_account_flow(
                &agent_id,
                action.id,
                action.kind,
                result_path.clone(),
            );
            account_flow::wrap_account_flow_command(&command, &result_path)
        } else {
            command
        };
        if agent_id.as_str() == "kimi_code" && action.id == "login" {
            let mutations = prepare_kimi_vibex_configuration_cleanup(&environment).await?;
            apply_config_transition_then(mutations, || {
                spawn_agent_management_terminal(&command).map_err(internal_error)
            })
            .await?;
        } else {
            spawn_agent_management_terminal(&command).map_err(internal_error)?;
        }
    }

    Ok(AgentManagementActionReceipt {
        agent_id,
        action_id,
        launched: true,
    })
}

#[tauri::command]
pub async fn agent_management_account_flow(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentAccountFlowView, AgentManagementErrorView> {
    let Some(pending) = account_flow::peek_account_flow(&agent_id) else {
        return Ok(account_flow::idle_account_flow(agent_id));
    };
    let Ok(contents) = tokio::fs::read_to_string(&pending.result_path).await else {
        return Ok(account_flow::pending_account_flow_view(
            agent_id,
            pending.action_id,
        ));
    };
    let Some(exit_code) = account_flow::parse_account_flow_exit(&contents) else {
        return Ok(account_flow::pending_account_flow_view(
            agent_id,
            pending.action_id,
        ));
    };
    account_flow::take_account_flow(&agent_id);
    let _ = tokio::fs::remove_file(&pending.result_path).await;
    let recorded = recorded_authentication(&state.deployment.db().pool, &agent_id).await;
    let authentication =
        agents::authentication_from_account_command(pending.kind, exit_code).unwrap_or(recorded);
    if authentication != recorded {
        sync_authentication_probe(&state.deployment.db().pool, &agent_id, authentication).await?;
    }
    if exit_code == 0 {
        let _ = app.emit(MANAGEMENT_INVALIDATED_EVENT, ());
    }
    Ok(AgentAccountFlowView {
        agent_id,
        action_id: Some(pending.action_id),
        status: if exit_code == 0 {
            AgentAccountFlowStatus::Succeeded
        } else {
            AgentAccountFlowStatus::Failed
        },
        exit_code: Some(exit_code),
        authentication: Some(authentication),
    })
}

fn management_action_kind(kind: ProfileManagementActionKind) -> AgentManagementActionKind {
    match kind {
        ProfileManagementActionKind::Login => AgentManagementActionKind::Login,
        ProfileManagementActionKind::Logout => AgentManagementActionKind::Logout,
        ProfileManagementActionKind::Setup => AgentManagementActionKind::Setup,
        ProfileManagementActionKind::Subscription => AgentManagementActionKind::Subscription,
    }
}

async fn resolve_management_program(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    program: &str,
    environment: &HashMap<String, String>,
) -> Option<PathBuf> {
    if agent_id.as_str() == "pi"
        && program == "pi"
        && let Some(command) = environment.get("PI_ACP_PI_COMMAND")
    {
        let exact = PathBuf::from(command.trim());
        if exact.is_file() {
            return Some(exact);
        }
        if let Some(first) = command.split_whitespace().next() {
            let candidate = PathBuf::from(first);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let components = sqlx::query_scalar::<_, String>(
        r#"SELECT component.absolute_path
           FROM agent_installation installation
           JOIN agent_install_component component ON component.lock_id = installation.current_lock_id
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
        let parent = path.parent()?;
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
    utils::shell::resolve_executable_path(program).await
}

fn management_command_with_environment(
    command: &str,
    environment: &HashMap<String, String>,
) -> String {
    let mut variables = environment
        .iter()
        .filter(|(key, value)| {
            !value.trim().is_empty()
                && !["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"]
                    .iter()
                    .any(|marker| key.contains(marker))
                && (key.ends_with("_HOME")
                    || key.ends_with("_DIR")
                    || key.ends_with("_BASE_URL")
                    || key.starts_with("XDG_"))
        })
        .collect::<Vec<_>>();
    variables.sort_by_key(|(key, _)| *key);
    if variables.is_empty() {
        return command.to_string();
    }
    #[cfg(not(windows))]
    {
        let prefix = variables
            .into_iter()
            .map(|(key, value)| format!("{key}={}", shell_quote_management_part(value)))
            .collect::<Vec<_>>()
            .join(" ");
        format!("{prefix} {command}")
    }
    #[cfg(windows)]
    {
        let prefix = variables
            .into_iter()
            .map(|(key, value)| {
                let escaped = value
                    .replace('^', "^^")
                    .replace('%', "%%")
                    .replace('&', "^&")
                    .replace('|', "^|")
                    .replace('<', "^<")
                    .replace('>', "^>");
                format!("set \"{key}={escaped}\"")
            })
            .collect::<Vec<_>>()
            .join(" && ");
        format!("{prefix} && {command}")
    }
}

fn executable_matches(path: &Path, program: &str) -> bool {
    path.file_stem()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(program))
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(program))
}

fn shell_quote_management_part(value: &str) -> String {
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"-._/:\\".contains(&byte))
    {
        return value.to_string();
    }
    #[cfg(windows)]
    return format!("\"{}\"", value.replace('"', "\\\""));
    #[cfg(not(windows))]
    return format!("'{}'", value.replace('\'', "'\\''"));
}

#[cfg(target_os = "windows")]
fn spawn_agent_management_terminal(command: &str) -> std::io::Result<()> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", "cmd", "/K", command])
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn spawn_agent_management_terminal(command: &str) -> std::io::Result<()> {
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
        command.replace('\\', "\\\\").replace('"', "\\\"")
    );
    std::process::Command::new("osascript")
        .args(["-e", &script])
        .spawn()
        .map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_agent_management_terminal(command: &str) -> std::io::Result<()> {
    let run = format!("{command}; exec $SHELL");
    for terminal in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
        if which::which(terminal).is_ok()
            && std::process::Command::new(terminal)
                .args(["-e", "sh", "-lc", &run])
                .spawn()
                .map(|_| ())
                .is_ok()
        {
            return Ok(());
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "no supported terminal emulator found",
    ))
}

const MAX_AGENT_ENVIRONMENT_ENTRIES: usize = 256;
const MAX_AGENT_ENVIRONMENT_NAME_BYTES: usize = 128;
const MAX_AGENT_ENVIRONMENT_VALUE_BYTES: usize = 64 * 1024;
const MAX_AGENT_ENVIRONMENT_BYTES: usize = 256 * 1024;

#[tauri::command]
pub async fn agent_management_environment_diagnostics(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentEnvironmentDiagnosticsView, AgentManagementErrorView> {
    environment_diagnostics::collect(&app, &state, agent_id).await
}

#[tauri::command]
pub async fn agent_management_environment(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentEnvironmentView, AgentManagementErrorView> {
    let (_, environment) =
        read_agent_environment_record(&state.deployment.db().pool, &agent_id).await?;
    Ok(project_agent_environment(agent_id, &environment))
}

#[tauri::command]
pub async fn agent_management_environment_write(
    state: tauri::State<'_, AppState>,
    request: AgentEnvironmentPatchRequest,
) -> Result<AgentEnvironmentView, AgentManagementErrorView> {
    if request.values.len() > MAX_AGENT_ENVIRONMENT_ENTRIES {
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            "单次环境变量更新项过多",
            Some(request.agent_id),
        ));
    }
    let (raw_environment, mut environment) =
        read_agent_environment_record(&state.deployment.db().pool, &request.agent_id).await?;
    if environment_revision(&environment) != request.base_revision {
        return Err(management_error(
            AgentManagementErrorCode::ConfigConflict,
            "Agent 环境变量已被其它操作修改，请重新读取后再保存",
            Some(request.agent_id),
        ));
    }
    for (name, value) in request.values {
        validate_agent_environment_name(&name).map_err(|message| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                message,
                Some(request.agent_id.clone()),
            )
        })?;
        match value {
            Some(value) => {
                if value.len() > MAX_AGENT_ENVIRONMENT_VALUE_BYTES {
                    return Err(management_error(
                        AgentManagementErrorCode::InvalidState,
                        format!("环境变量 `{name}` 的值超过 64 KiB"),
                        Some(request.agent_id),
                    ));
                }
                environment.insert(name, value);
            }
            None => {
                environment.remove(&name);
            }
        }
    }
    if environment.len() > MAX_AGENT_ENVIRONMENT_ENTRIES {
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            "Agent 环境变量不能超过 256 项",
            Some(request.agent_id),
        ));
    }
    let serialized = serde_json::to_string(&environment).map_err(internal_error)?;
    if serialized.len() > MAX_AGENT_ENVIRONMENT_BYTES {
        return Err(management_error(
            AgentManagementErrorCode::InvalidState,
            "Agent 环境变量总大小超过 256 KiB",
            Some(request.agent_id),
        ));
    }
    let updated = compare_and_set_agent_environment(
        &state.deployment.db().pool,
        &request.agent_id,
        raw_environment.as_deref(),
        &serialized,
    )
    .await?;
    if !updated {
        return Err(management_error(
            AgentManagementErrorCode::ConfigConflict,
            "Agent 环境变量在保存期间发生变化，请重新读取后再保存",
            Some(request.agent_id),
        ));
    }
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&request.agent_id, "Agent 环境变量已更改")
        .await;
    Ok(project_agent_environment(request.agent_id, &environment))
}

async fn compare_and_set_agent_environment(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    expected: Option<&str>,
    serialized: &str,
) -> Result<bool, AgentManagementErrorView> {
    ensure_agent_setting_row(pool, agent_id).await?;
    let result = sqlx::query(
        "UPDATE agent_setting SET env_json = ?, updated_at = CURRENT_TIMESTAMP \
         WHERE agent_type = ? AND env_json IS ?",
    )
    .bind(serialized)
    .bind(agent_id.as_str())
    .bind(expected)
    .execute(pool)
    .await
    .map_err(internal_error)?;
    Ok(result.rows_affected() == 1)
}

async fn ensure_agent_setting_row(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<(), AgentManagementErrorView> {
    AgentSetting::ensure_row(pool, agent_id.as_str())
        .await
        .map_err(internal_error)
}

async fn read_agent_environment_record(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<(Option<String>, BTreeMap<String, String>), AgentManagementErrorView> {
    ensure_agent_setting_row(pool, agent_id).await?;
    let Some(raw) = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?
    else {
        return Err(management_error(
            AgentManagementErrorCode::NotFound,
            "Agent 设置不存在",
            Some(agent_id.clone()),
        ));
    };
    let environment = parse_agent_env(raw.as_deref())
        .map_err(internal_error)?
        .into_iter()
        .collect::<BTreeMap<_, _>>();
    Ok((raw, environment))
}

fn project_agent_environment(
    agent_id: AgentId,
    environment: &BTreeMap<String, String>,
) -> AgentEnvironmentView {
    AgentEnvironmentView {
        agent_id,
        entries: environment
            .iter()
            .map(|(name, value)| {
                let secret = is_secret_environment_name(name);
                AgentEnvironmentEntryView {
                    name: name.clone(),
                    value: (!secret).then(|| value.clone()),
                    secret,
                    present: true,
                    masked_value: secret.then(|| "••••••••".to_string()),
                }
            })
            .collect(),
        revision: environment_revision(environment),
    }
}

fn environment_revision(environment: &BTreeMap<String, String>) -> String {
    let bytes = serde_json::to_vec(environment).expect("environment map is serializable");
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_agent_environment_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > MAX_AGENT_ENVIRONMENT_NAME_BYTES {
        return Err("环境变量名称长度必须为 1 到 128 字节".to_string());
    }
    let mut bytes = name.bytes();
    let first = bytes.next().expect("non-empty environment name");
    if !(first == b'_' || first.is_ascii_alphabetic())
        || !bytes.all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
    {
        return Err(format!("环境变量名称 `{name}` 不合法"));
    }
    Ok(())
}

fn is_secret_environment_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    [
        "API_KEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "CREDENTIAL",
        "PRIVATE_KEY",
        "ACCESS_KEY",
    ]
    .iter()
    .any(|marker| upper.contains(marker))
}

#[tauri::command]
pub async fn agent_management_config_read(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<AgentNativeConfigView, AgentManagementErrorView> {
    let Some(home) = dirs::home_dir() else {
        return Err(internal_error("用户目录不可用"));
    };
    let agent_env = read_agent_environment(&state.deployment.db().pool, &agent_id).await?;
    let account_logged_in = resolve_native_account_login(&home, &agent_id, &agent_env).await;
    let provider = NativeConfigProvider::with_environment(
        Arc::new(TokioNativeFileSystem),
        home,
        agent_env.into_iter().collect(),
    );
    let snapshot = match provider.read(&agent_id, account_logged_in).await {
        Ok(snapshot) => snapshot,
        Err(agents::NativeConfigError::Unsupported(_)) => {
            return Ok(AgentNativeConfigView {
                agent_id,
                available: false,
                settings_features: Vec::new(),
                path: None,
                paths: Vec::new(),
                fields: Vec::new(),
                files: Vec::new(),
                applies_to_next_session: true,
            });
        }
        Err(error) => return Err(internal_error(error)),
    };
    sync_authentication_without_account_residue(
        &state.deployment.db().pool,
        &agent_id,
        snapshot.authentication,
    )
    .await?;
    Ok(native_config_view(agent_id, snapshot))
}

fn native_config_view(
    agent_id: AgentId,
    snapshot: agents::NativeConfigSnapshot,
) -> AgentNativeConfigView {
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = catalog.profile(&agent_id);
    let settings_features = profile
        .map(|profile| profile.settings_features.to_vec())
        .unwrap_or_default();
    let fields = snapshot
        .fields
        .into_iter()
        .map(|field| AgentNativeConfigFieldView {
            id: field.field_id,
            label: field.label,
            description: field.description,
            kind: match field.kind {
                agents::NativeConfigFieldKind::Text => AgentNativeConfigFieldKind::Text,
                agents::NativeConfigFieldKind::Secret => AgentNativeConfigFieldKind::Secret,
                agents::NativeConfigFieldKind::Select => AgentNativeConfigFieldKind::Select,
                agents::NativeConfigFieldKind::Boolean => AgentNativeConfigFieldKind::Boolean,
                agents::NativeConfigFieldKind::Number => AgentNativeConfigFieldKind::Number,
                agents::NativeConfigFieldKind::Json => AgentNativeConfigFieldKind::Json,
            },
            options: field
                .options
                .into_iter()
                .map(|(value, label)| AgentNativeConfigOptionView { value, label })
                .collect(),
            secret: field.secret,
            path: field.path.display().to_string(),
            present: field.present,
            value: field.value,
            masked_value: field.masked_value,
            revision: field.revision,
            surface: match field.surface {
                agents::NativeConfigSurface::Configuration => {
                    AgentNativeConfigSurface::Configuration
                }
                agents::NativeConfigSurface::Authentication => {
                    AgentNativeConfigSurface::Authentication
                }
            },
        })
        .collect();
    let files = snapshot
        .files
        .into_iter()
        .map(|file| {
            let format = match file.format {
                agents::NativeConfigFormat::Json => AgentNativeConfigFormat::Json,
                agents::NativeConfigFormat::Toml => AgentNativeConfigFormat::Toml,
                agents::NativeConfigFormat::Yaml => AgentNativeConfigFormat::Yaml,
                agents::NativeConfigFormat::Dotenv => AgentNativeConfigFormat::Dotenv,
            };
            // Sensitive files cross the boundary verbatim: VibeX is local-first
            // and the UI masks the preview until hover/focus, so users can
            // inspect their own credentials instead of a redacted stand-in.
            AgentNativeConfigFileView {
                path: file.path.display().to_string(),
                format,
                content: file.content,
                sensitive: file.sensitive,
                exists: file.exists,
                revision: file.revision,
            }
        })
        .collect();
    AgentNativeConfigView {
        agent_id,
        available: true,
        settings_features,
        path: Some(snapshot.path.display().to_string()),
        paths: snapshot
            .paths
            .into_iter()
            .map(|path| path.display().to_string())
            .collect(),
        fields,
        files,
        applies_to_next_session: true,
    }
}

#[tauri::command]
pub async fn agent_management_config_write(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    request: AgentNativeConfigPatchRequest,
) -> Result<AgentNativeConfigView, AgentManagementErrorView> {
    let Some(home) = dirs::home_dir() else {
        return Err(internal_error("用户目录不可用"));
    };
    validate_native_config_patch(&request)?;
    let agent_env = read_agent_environment(&state.deployment.db().pool, &request.agent_id).await?;
    let account_logged_in =
        resolve_native_account_login(&home, &request.agent_id, &agent_env).await;
    let kimi_fields = (request.agent_id.as_str() == "kimi_code").then(|| request.fields.clone());
    let grok_fields = (request.agent_id.as_str() == "grok").then(|| request.fields.clone());
    let sync_launch_preferences = matches!(
        request.agent_id.as_str(),
        "cursor" | "grok" | "openclaw" | "codebuddy"
    );
    let provider = NativeConfigProvider::with_environment(
        Arc::new(TokioNativeFileSystem),
        home.clone(),
        agent_env.clone().into_iter().collect(),
    );
    let before = provider
        .read(&request.agent_id, account_logged_in)
        .await
        .map_err(internal_error)?;
    let mut rollback_paths = before.paths.clone();
    if request.agent_id.as_str() == "kimi_code" {
        rollback_paths.push(kimi_code_home(&home, &agent_env).join("credentials/kimi-code.json"));
    }
    let mut file_rollback = capture_native_file_rollback(&rollback_paths).await?;
    let env_rollback = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(request.agent_id.as_str())
    .fetch_optional(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?
    .flatten();
    let operation = async {
        let mut result = provider
            .save(
                &request.agent_id,
                NativeConfigPatch {
                    base_field_revisions: request.base_field_revisions,
                    values: request.fields,
                },
                account_logged_in,
            )
            .await
            .map_err(|error| map_native_config_save_error(&request.agent_id, error))?;
        refresh_native_file_rollback_expected(&mut file_rollback).await?;
        let mut reconciled = false;
        if let Some(fields) = kimi_fields {
            reconcile_kimi_vibex_configuration(&home, &agent_env, &fields).await?;
            refresh_native_file_rollback_expected(&mut file_rollback).await?;
            reconciled = true;
        }
        if let Some(fields) = grok_fields {
            reconcile_grok_vibex_configuration(&home, &agent_env, &fields).await?;
            refresh_native_file_rollback_expected(&mut file_rollback).await?;
            reconciled = true;
        }
        if sync_launch_preferences {
            sync_native_launch_preferences(&state.deployment.db().pool, &request.agent_id, &home)
                .await?;
        }
        if reconciled {
            let account_logged_in =
                resolve_native_account_login(&home, &request.agent_id, &agent_env).await;
            result.snapshot = provider
                .read(&request.agent_id, account_logged_in)
                .await
                .map_err(internal_error)?;
        }
        sync_authentication_without_account_residue(
            &state.deployment.db().pool,
            &request.agent_id,
            result.snapshot.authentication,
        )
        .await?;
        Ok::<_, AgentManagementErrorView>(result)
    }
    .await;
    let result = match operation {
        Ok(result) => result,
        Err(mut error) => {
            if let Err(rollback_error) = restore_native_file_rollback(&file_rollback).await {
                error.message = format!(
                    "{}；恢复原配置失败：{}",
                    error.message, rollback_error.message
                );
            }
            if let Err(rollback_error) = sqlx::query(
                "UPDATE agent_setting SET env_json = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_type = ?",
            )
            .bind(env_rollback)
            .bind(request.agent_id.as_str())
            .execute(&state.deployment.db().pool)
            .await
            {
                error.message = format!("{}；恢复启动环境失败：{}", error.message, rollback_error);
            }
            return Err(error);
        }
    };
    let probe_app = app.clone();
    let probe_pool = state.deployment.db().pool.clone();
    let probe_agent_id = request.agent_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            record_post_install_probe(&probe_app, &probe_pool, &probe_agent_id).await
        {
            tracing::warn!(
                agent_id = %probe_agent_id,
                %error,
                "failed to refresh ACP authentication after saving Agent configuration"
            );
        }
    });
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&request.agent_id, "Agent 原生配置已更改")
        .await;
    Ok(native_config_view(request.agent_id, result.snapshot))
}

struct NativeFileRollback {
    path: PathBuf,
    original: Option<Vec<u8>>,
    expected: Option<Vec<u8>>,
    sensitive: bool,
}

async fn capture_native_file_rollback(
    paths: &[PathBuf],
) -> Result<Vec<NativeFileRollback>, AgentManagementErrorView> {
    let mut captured = Vec::new();
    let mut seen = HashSet::new();
    for path in paths {
        if !seen.insert(path.clone()) {
            continue;
        }
        let bytes = match tokio::fs::read(path).await {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(internal_error(error)),
        };
        let sensitive = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                matches!(
                    name,
                    "auth.json" | "credentials.json" | "kimi-code.json" | ".env"
                )
            });
        captured.push(NativeFileRollback {
            path: path.clone(),
            original: bytes.clone(),
            expected: bytes,
            sensitive,
        });
    }
    Ok(captured)
}

async fn refresh_native_file_rollback_expected(
    captured: &mut [NativeFileRollback],
) -> Result<(), AgentManagementErrorView> {
    for rollback in captured {
        rollback.expected = match tokio::fs::read(&rollback.path).await {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(internal_error(error)),
        };
    }
    Ok(())
}

async fn restore_native_file_rollback(
    captured: &[NativeFileRollback],
) -> Result<(), AgentManagementErrorView> {
    let mut mutations = Vec::with_capacity(captured.len());
    for rollback in captured {
        mutations.push(NativeFileMutation {
            path: rollback.path.clone(),
            expected: rollback.expected.clone(),
            replacement: rollback.original.clone(),
            sensitive: rollback.sensitive,
        });
    }
    apply_native_file_mutations(&mutations).await
}

#[tauri::command]
pub async fn agent_management_config_file_write(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    request: AgentNativeConfigFileWriteRequest,
) -> Result<AgentNativeConfigView, AgentManagementErrorView> {
    let Some(home) = dirs::home_dir() else {
        return Err(internal_error("用户目录不可用"));
    };
    let agent_env = read_agent_environment(&state.deployment.db().pool, &request.agent_id).await?;
    let account_logged_in =
        resolve_native_account_login(&home, &request.agent_id, &agent_env).await;
    let provider = NativeConfigProvider::with_environment(
        Arc::new(TokioNativeFileSystem),
        home.clone(),
        agent_env.clone().into_iter().collect(),
    );
    let path = PathBuf::from(&request.path);
    let mut file_rollback = capture_native_file_rollback(std::slice::from_ref(&path)).await?;
    let env_rollback = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(request.agent_id.as_str())
    .fetch_optional(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?
    .flatten();
    let operation = async {
        let result = provider
            .save_file(
                &request.agent_id,
                NativeConfigFilePatch {
                    path,
                    base_revision: request.base_revision,
                    content: request.content,
                },
                account_logged_in,
            )
            .await
            .map_err(|error| map_native_config_save_error(&request.agent_id, error))?;
        refresh_native_file_rollback_expected(&mut file_rollback).await?;

        if matches!(
            request.agent_id.as_str(),
            "cursor" | "grok" | "openclaw" | "codebuddy"
        ) {
            sync_native_launch_preferences(&state.deployment.db().pool, &request.agent_id, &home)
                .await?;
        }
        sync_authentication_without_account_residue(
            &state.deployment.db().pool,
            &request.agent_id,
            result.snapshot.authentication,
        )
        .await?;
        Ok::<_, AgentManagementErrorView>(result)
    }
    .await;
    let result = match operation {
        Ok(result) => result,
        Err(mut error) => {
            if let Err(rollback_error) = restore_native_file_rollback(&file_rollback).await {
                error.message = format!(
                    "{}；恢复原配置失败：{}",
                    error.message, rollback_error.message
                );
            }
            if let Err(rollback_error) = sqlx::query(
                "UPDATE agent_setting SET env_json = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_type = ?",
            )
            .bind(env_rollback)
            .bind(request.agent_id.as_str())
            .execute(&state.deployment.db().pool)
            .await
            {
                error.message = format!("{}；恢复启动环境失败：{}", error.message, rollback_error);
            }
            return Err(error);
        }
    };
    let probe_app = app.clone();
    let probe_pool = state.deployment.db().pool.clone();
    let probe_agent_id = request.agent_id.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) =
            record_post_install_probe(&probe_app, &probe_pool, &probe_agent_id).await
        {
            tracing::warn!(
                agent_id = %probe_agent_id,
                %error,
                "failed to refresh ACP authentication after saving an Agent native file"
            );
        }
    });
    state
        .agent_runtime
        .mark_agent_sessions_config_stale(&request.agent_id, "Agent 原生配置文件已更改")
        .await;
    Ok(native_config_view(request.agent_id, result.snapshot))
}

fn map_native_config_save_error(
    agent_id: &AgentId,
    error: agents::NativeConfigSaveError,
) -> AgentManagementErrorView {
    match error {
        agents::NativeConfigSaveError::FieldConflicts { fields } => {
            let mut view = management_error(
                AgentManagementErrorCode::ConfigConflict,
                format!("配置字段已被外部修改：{}", fields.join(", ")),
                Some(agent_id.clone()),
            );
            view.preflight_item_id = fields.first().cloned();
            view
        }
        agents::NativeConfigSaveError::FileConflict { path } => {
            let path = path.display().to_string();
            let mut view = management_error(
                AgentManagementErrorCode::ConfigConflict,
                format!("配置文件已被外部修改：{path}"),
                Some(agent_id.clone()),
            );
            view.preflight_item_id = Some(path);
            view
        }
        agents::NativeConfigSaveError::Read(agents::NativeConfigError::Invalid(message)) => {
            management_error(
                AgentManagementErrorCode::InvalidState,
                message,
                Some(agent_id.clone()),
            )
        }
        other @ (agents::NativeConfigSaveError::UnknownFile(_)
        | agents::NativeConfigSaveError::SensitiveFile(_)) => management_error(
            AgentManagementErrorCode::InvalidState,
            other.to_string(),
            Some(agent_id.clone()),
        ),
        other => internal_error(other),
    }
}

async fn sync_native_launch_preferences(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    home: &Path,
) -> Result<(), AgentManagementErrorView> {
    let env_json = sqlx::query_scalar::<_, Option<String>>(
        "SELECT env_json FROM agent_setting WHERE agent_type = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .map_err(internal_error)?
    .flatten();
    let mut env = parse_agent_env(env_json.as_deref()).map_err(internal_error)?;
    let updates = match agent_id.as_str() {
        "cursor" => {
            let config_dir = env
                .get("CURSOR_CONFIG_DIR")
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("CURSOR_CONFIG_DIR")
                        .filter(|value| !value.is_empty())
                        .map(PathBuf::from)
                })
                .unwrap_or_else(|| home.join(".cursor"));
            let config = read_json_object_or_empty(&config_dir.join("cli-config.json")).await?;
            vec![
                (
                    "CURSOR_MODEL",
                    config
                        .pointer("/vibex/model")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                ),
                (
                    "CURSOR_FORCE",
                    config
                        .pointer("/vibex/force")
                        .and_then(serde_json::Value::as_bool)
                        .filter(|enabled| *enabled)
                        .map(|_| "1".to_string()),
                ),
            ]
        }
        "grok" => {
            let config_dir = env
                .get("GROK_HOME")
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("GROK_HOME")
                        .filter(|value| !value.is_empty())
                        .map(PathBuf::from)
                })
                .unwrap_or_else(|| home.join(".grok"));
            let config = tokio::fs::read_to_string(config_dir.join("config.toml"))
                .await
                .ok()
                .and_then(|text| toml::from_str::<toml::Value>(&text).ok());
            vec![(
                "GROK_PERMISSION_MODE",
                config
                    .as_ref()
                    .and_then(|value| value.get("ui"))
                    .and_then(|value| value.get("permission_mode"))
                    .and_then(toml::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty() && *value != "default")
                    .map(str::to_string),
            )]
        }
        "openclaw" => {
            let config_dir = env
                .get("OPENCLAW_HOME")
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("OPENCLAW_HOME")
                        .filter(|value| !value.is_empty())
                        .map(PathBuf::from)
                })
                .unwrap_or_else(|| home.join(".openclaw"));
            let config = read_json_object_or_empty(&config_dir.join("openclaw.json")).await?;
            let string = |pointer: &str| {
                config
                    .pointer(pointer)
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            };
            vec![
                ("OPENCLAW_GATEWAY_URL", string("/gateway/remote/url")),
                ("OPENCLAW_GATEWAY_TOKEN", string("/gateway/auth/token")),
                ("OPENCLAW_SESSION_KEY", string("/acp/sessionKey")),
            ]
        }
        "codebuddy" => {
            let config_dir = env
                .get("CODEBUDDY_CONFIG_DIR")
                .filter(|value| !value.trim().is_empty())
                .map(|value| expand_agent_home_path(home, value))
                .or_else(|| {
                    std::env::var_os("CODEBUDDY_CONFIG_DIR")
                        .filter(|value| !value.is_empty())
                        .map(|value| expand_agent_home_path(home, &value.to_string_lossy()))
                })
                .unwrap_or_else(|| home.join(".codebuddy"));
            let text = tokio::fs::read_to_string(config_dir.join(".env"))
                .await
                .unwrap_or_default();
            let api_key = dotenv_launch_value(&text, "CODEBUDDY_API_KEY");
            let base_url = dotenv_launch_value(&text, "CODEBUDDY_BASE_URL");
            let environment = base_url
                .is_none()
                .then(|| dotenv_launch_value(&text, "CODEBUDDY_INTERNET_ENVIRONMENT"))
                .flatten();
            vec![
                ("CODEBUDDY_API_KEY", api_key),
                ("CODEBUDDY_BASE_URL", base_url),
                ("CODEBUDDY_INTERNET_ENVIRONMENT", environment),
            ]
        }
        _ => return Ok(()),
    };
    for (key, value) in updates {
        match value {
            Some(value) => {
                env.insert(key.to_string(), value);
            }
            None => {
                env.remove(key);
            }
        }
    }
    let env_json = serde_json::to_string(&env).map_err(internal_error)?;
    ensure_agent_setting_row(pool, agent_id).await?;
    let result = sqlx::query(
        "UPDATE agent_setting SET env_json = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_type = ?",
    )
    .bind(env_json)
    .bind(agent_id.as_str())
    .execute(pool)
    .await
    .map_err(internal_error)?;
    if result.rows_affected() == 0 {
        return Err(management_error(
            AgentManagementErrorCode::NotFound,
            "Agent 设置不存在",
            Some(agent_id.clone()),
        ));
    }
    Ok(())
}

fn dotenv_launch_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let line = line.trim();
        let line = line.strip_prefix("export ").unwrap_or(line);
        let (candidate, raw) = line.split_once('=')?;
        if candidate.trim() != key {
            return None;
        }
        let raw = raw.trim();
        let value = if raw.len() >= 2
            && ((raw.starts_with('"') && raw.ends_with('"'))
                || (raw.starts_with('\'') && raw.ends_with('\'')))
        {
            &raw[1..raw.len() - 1]
        } else {
            raw.split(" #").next().unwrap_or(raw).trim()
        };
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn validate_native_config_patch(
    request: &AgentNativeConfigPatchRequest,
) -> Result<(), AgentManagementErrorView> {
    if let Some(Some(value)) = request.fields.get("grok_auto_compact_threshold") {
        let threshold = value.parse::<i64>().map_err(|_| {
            management_error(
                AgentManagementErrorCode::InvalidState,
                "Grok 自动压缩阈值必须是 0–100 的整数",
                Some(request.agent_id.clone()),
            )
        })?;
        if !(0..=100).contains(&threshold) {
            return Err(management_error(
                AgentManagementErrorCode::InvalidState,
                "Grok 自动压缩阈值必须在 0–100 之间",
                Some(request.agent_id.clone()),
            ));
        }
    }
    Ok(())
}

fn kimi_code_home(home: &Path, environment: &HashMap<String, String>) -> PathBuf {
    environment
        .get("KIMI_CODE_HOME")
        .filter(|value| !value.trim().is_empty())
        .map(|value| expand_agent_home_path(home, value))
        .or_else(|| {
            std::env::var_os("KIMI_CODE_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| home.join(".kimi-code"))
}

async fn reconcile_kimi_vibex_configuration(
    home: &Path,
    environment: &HashMap<String, String>,
    changed_fields: &BTreeMap<String, Option<String>>,
) -> Result<(), AgentManagementErrorView> {
    if !changed_fields
        .keys()
        .any(|field| field.starts_with("kimi_"))
    {
        return Ok(());
    }
    let kimi_home = kimi_code_home(home, environment);
    let config_path = kimi_home.join("config.toml");
    let mut document = match tokio::fs::read_to_string(&config_path).await {
        Ok(text) if !text.trim().is_empty() => {
            toml::from_str::<toml::Value>(&text).map_err(internal_error)?
        }
        Ok(_) => toml::Value::Table(toml::Table::new()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            toml::Value::Table(toml::Table::new())
        }
        Err(error) => return Err(internal_error(error)),
    };
    let root = document
        .as_table_mut()
        .ok_or_else(|| internal_error("Kimi config.toml 顶层必须是表"))?;
    let model_id = root
        .get("models")
        .and_then(toml::Value::as_table)
        .and_then(|models| models.get("vibex"))
        .and_then(toml::Value::as_table)
        .and_then(|model| model.get("model"))
        .and_then(toml::Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .map(str::to_string);
    if model_id.is_some() {
        root.insert(
            "default_model".to_string(),
            toml::Value::String("vibex".to_string()),
        );
        let models = root
            .entry("models")
            .or_insert_with(|| toml::Value::Table(toml::Table::new()))
            .as_table_mut()
            .ok_or_else(|| internal_error("Kimi models 必须是表"))?;
        let model = models
            .entry("vibex")
            .or_insert_with(|| toml::Value::Table(toml::Table::new()))
            .as_table_mut()
            .ok_or_else(|| internal_error("Kimi models.vibex 必须是表"))?;
        model.insert(
            "provider".to_string(),
            toml::Value::String("vibex".to_string()),
        );
        model
            .entry("max_context_size")
            .or_insert(toml::Value::Integer(262_144));
    } else if root.get("default_model").and_then(toml::Value::as_str) == Some("vibex") {
        root.remove("default_model");
    }
    let provider = root
        .get("providers")
        .and_then(toml::Value::as_table)
        .and_then(|providers| providers.get("vibex"))
        .and_then(toml::Value::as_table);
    let api_key_present = provider.is_some_and(|provider| {
        provider
            .get("api_key")
            .and_then(toml::Value::as_str)
            .is_some_and(|key| !key.trim().is_empty())
            || provider
                .get("env")
                .and_then(toml::Value::as_table)
                .is_some_and(|env| {
                    env.values()
                        .any(|value| value.as_str().is_some_and(|value| !value.trim().is_empty()))
                })
    });
    let serialized = toml::to_string_pretty(&document).map_err(internal_error)?;
    write_bytes_document(&config_path, format!("{serialized}\n").as_bytes(), false).await?;

    let credential_path = kimi_home.join("credentials/kimi-code.json");
    if api_key_present {
        seed_kimi_synthetic_credential(&credential_path).await
    } else {
        remove_kimi_synthetic_credential_if_ours(&credential_path).await
    }
}

async fn reconcile_grok_vibex_configuration(
    home: &Path,
    environment: &HashMap<String, String>,
    changed_fields: &BTreeMap<String, Option<String>>,
) -> Result<(), AgentManagementErrorView> {
    if !changed_fields
        .keys()
        .any(|field| field.starts_with("grok_"))
    {
        return Ok(());
    }
    let grok_home = environment
        .get("GROK_HOME")
        .filter(|value| !value.trim().is_empty())
        .map(|value| expand_agent_home_path(home, value))
        .or_else(|| {
            std::env::var_os("GROK_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| home.join(".grok"));
    let config_path = grok_home.join("config.toml");
    let mut document = match tokio::fs::read_to_string(&config_path).await {
        Ok(text) if !text.trim().is_empty() => {
            toml::from_str::<toml::Value>(&text).map_err(internal_error)?
        }
        Ok(_) => toml::Value::Table(toml::Table::new()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            toml::Value::Table(toml::Table::new())
        }
        Err(error) => return Err(internal_error(error)),
    };
    let root = document
        .as_table_mut()
        .ok_or_else(|| internal_error("Grok config.toml 顶层必须是表"))?;
    let custom_model = root
        .get("model")
        .and_then(toml::Value::as_table)
        .and_then(|models| models.get("vibex"))
        .and_then(toml::Value::as_table)
        .and_then(|model| model.get("model"))
        .and_then(toml::Value::as_str)
        .is_some_and(|model| !model.trim().is_empty());
    let models = root
        .entry("models")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()))
        .as_table_mut()
        .ok_or_else(|| internal_error("Grok models 必须是表"))?;
    if custom_model {
        models.insert(
            "default".to_string(),
            toml::Value::String("vibex".to_string()),
        );
    } else if models.get("default").and_then(toml::Value::as_str) == Some("vibex") {
        models.remove("default");
    }
    if models.is_empty() {
        root.remove("models");
    }
    let serialized = toml::to_string_pretty(&document).map_err(internal_error)?;
    write_bytes_document(&config_path, format!("{serialized}\n").as_bytes(), false).await
}

async fn prepare_kimi_vibex_configuration_cleanup(
    environment: &HashMap<String, String>,
) -> Result<Vec<NativeFileMutation>, AgentManagementErrorView> {
    let home = dirs::home_dir().ok_or_else(|| internal_error("用户目录不可用"))?;
    let kimi_home = kimi_code_home(&home, environment);
    let config_path = kimi_home.join("config.toml");
    let mut mutations = Vec::with_capacity(2);
    let config_original = match tokio::fs::read(&config_path).await {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(internal_error(error)),
    };
    if let Some(source) = config_original.as_deref() {
        let text = std::str::from_utf8(source).map_err(internal_error)?;
        let mut document: toml::Value = toml::from_str(text).map_err(internal_error)?;
        let root = document
            .as_table_mut()
            .ok_or_else(|| internal_error("Kimi config.toml 顶层必须是表"))?;
        if root.get("default_model").and_then(toml::Value::as_str) == Some("vibex") {
            root.remove("default_model");
        }
        if let Some(providers) = root
            .get_mut("providers")
            .and_then(toml::Value::as_table_mut)
        {
            providers.remove("vibex");
        }
        if let Some(models) = root.get_mut("models").and_then(toml::Value::as_table_mut) {
            models.remove("vibex");
        }
        let serialized = toml::to_string_pretty(&document).map_err(internal_error)?;
        mutations.push(NativeFileMutation {
            path: config_path,
            expected: config_original,
            replacement: Some(format!("{serialized}\n").into_bytes()),
            sensitive: false,
        });
    }
    let credential_path = kimi_home.join("credentials/kimi-code.json");
    let credential_original = match tokio::fs::read(&credential_path).await {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(internal_error(error)),
    };
    if let Some(source) = credential_original.as_deref() {
        let value: serde_json::Value = serde_json::from_slice(source).map_err(internal_error)?;
        if kimi_credential_is_synthetic(&value) {
            mutations.push(NativeFileMutation {
                path: credential_path,
                expected: credential_original,
                replacement: None,
                sensitive: true,
            });
        }
    }
    Ok(mutations)
}

async fn seed_kimi_synthetic_credential(path: &Path) -> Result<(), AgentManagementErrorView> {
    if let Ok(bytes) = tokio::fs::read(path).await
        && let Ok(existing) = serde_json::from_slice::<serde_json::Value>(&bytes)
        && existing
            .get("access_token")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|token| !token.is_empty())
        && !kimi_credential_is_synthetic(&existing)
    {
        return Ok(());
    }
    let value = serde_json::json!({
        "access_token": "vibex-local-gate",
        "refresh_token": "",
        "expires_in": 9_999_999,
        "scope": "",
        "token_type": "Bearer",
        "_vibex_synthetic": true,
    });
    write_bytes_document(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&value).map_err(internal_error)?
        )
        .as_bytes(),
        true,
    )
    .await
}

async fn remove_kimi_synthetic_credential_if_ours(
    path: &Path,
) -> Result<(), AgentManagementErrorView> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(internal_error(error)),
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(internal_error)?;
    if kimi_credential_is_synthetic(&value) {
        tokio::fs::remove_file(path).await.map_err(internal_error)?;
    }
    Ok(())
}

fn kimi_credential_is_synthetic(value: &serde_json::Value) -> bool {
    value
        .get("_vibex_synthetic")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
        || value
            .get("access_token")
            .and_then(serde_json::Value::as_str)
            == Some("vibex-local-gate")
}

async fn write_bytes_document(
    path: &Path,
    bytes: &[u8],
    sensitive: bool,
) -> Result<(), AgentManagementErrorView> {
    TokioNativeFileSystem
        .write_atomic(path, bytes, sensitive)
        .await
        .map_err(internal_error)
}

async fn recorded_authentication(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> AgentAuthenticationStatus {
    let value = sqlx::query_scalar::<_, String>(
        "SELECT authentication FROM agent_probe WHERE agent_id = ?",
    )
    .bind(agent_id.as_str())
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    match value.as_deref() {
        Some("account") => AgentAuthenticationStatus::Account,
        Some("api_key") => AgentAuthenticationStatus::ApiKey,
        Some("multiple_unknown") => AgentAuthenticationStatus::MultipleUnknown,
        Some("not_required") => AgentAuthenticationStatus::NotRequired,
        _ => AgentAuthenticationStatus::NotLoggedIn,
    }
}

async fn recorded_account_over_residue(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    observed: AgentAuthenticationStatus,
) -> AgentAuthenticationStatus {
    agents::prefer_recorded_account_over_residue(
        recorded_authentication(pool, agent_id).await,
        observed,
    )
}

async fn sync_authentication_without_account_residue(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    observed: AgentAuthenticationStatus,
) -> Result<(), AgentManagementErrorView> {
    sync_authentication_probe(
        pool,
        agent_id,
        recorded_account_over_residue(pool, agent_id, observed).await,
    )
    .await
}

async fn sync_authentication_probe(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    authentication: AgentAuthenticationStatus,
) -> Result<(), AgentManagementErrorView> {
    AgentManagementApplicationService::new(pool.clone())
        .sync_authentication(agent_id, authentication, None)
        .await
        .map_err(internal_error)
}

pub(crate) async fn sync_authentication_probe_with_requirement(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
    authentication: AgentAuthenticationStatus,
    authentication_required: bool,
) -> Result<(), AgentManagementErrorView> {
    AgentManagementApplicationService::new(pool.clone())
        .sync_authentication(agent_id, authentication, Some(authentication_required))
        .await
        .map_err(internal_error)
}

#[tauri::command]
pub async fn agent_management_diagnostics(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<Vec<AgentDiagnosticView>, AgentManagementErrorView> {
    let rows = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            String,
            Option<String>,
            String,
            Option<String>,
        ),
    >(
        r#"SELECT id, operation_kind, severity, message, redacted_output, created_at, read_at
           FROM agent_diagnostic WHERE agent_id = ?
           ORDER BY created_at DESC, id DESC LIMIT 20"#,
    )
    .bind(agent_id.as_str())
    .fetch_all(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?;
    Ok(rows
        .into_iter()
        .map(
            |(id, operation_kind, severity, message, redacted_output, created_at, read_at)| {
                AgentDiagnosticView {
                    id,
                    agent_id: agent_id.clone(),
                    operation_kind,
                    severity,
                    message,
                    redacted_output,
                    created_at,
                    read: read_at.is_some(),
                }
            },
        )
        .collect())
}

#[tauri::command]
pub async fn agent_management_mark_diagnostics_read(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<(), AgentManagementErrorView> {
    sqlx::query(
        r#"UPDATE agent_diagnostic
           SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
           WHERE agent_id = ? AND read_at IS NULL"#,
    )
    .bind(agent_id.as_str())
    .execute(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?;
    Ok(())
}

#[tauri::command]
pub async fn agent_management_clear_diagnostics(
    state: tauri::State<'_, AppState>,
    agent_id: AgentId,
) -> Result<(), AgentManagementErrorView> {
    sqlx::query("DELETE FROM agent_diagnostic WHERE agent_id = ?")
        .bind(agent_id.as_str())
        .execute(&state.deployment.db().pool)
        .await
        .map_err(internal_error)?;
    Ok(())
}

fn operation_kind_key(kind: AgentOperationKind) -> &'static str {
    match kind {
        AgentOperationKind::Install => "install",
        AgentOperationKind::Update => "update",
        AgentOperationKind::Repair => "repair",
        AgentOperationKind::Rollback => "rollback",
        AgentOperationKind::Uninstall => "uninstall",
        AgentOperationKind::Remove => "remove",
        AgentOperationKind::Check => "check",
    }
}

fn parse_operation_kind(value: &str) -> Option<AgentOperationKind> {
    match value {
        "install" => Some(AgentOperationKind::Install),
        "update" => Some(AgentOperationKind::Update),
        "repair" => Some(AgentOperationKind::Repair),
        "rollback" => Some(AgentOperationKind::Rollback),
        "uninstall" => Some(AgentOperationKind::Uninstall),
        "remove" => Some(AgentOperationKind::Remove),
        "check" => Some(AgentOperationKind::Check),
        _ => None,
    }
}
