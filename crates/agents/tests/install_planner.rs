use std::collections::BTreeMap;

use agents::{
    AgentId, ArtifactTrust, BuiltInProfileCatalog, InstallCandidateSource, InstallEnvironment,
    InstallPlanner, InstallPlanningError, InstallPlanningInput, LockedInstallSource,
    ObservedUserComponent, PlannedDistributionKind, ProfileTopology, RegistryAddTarget,
    RegistryAgentEntry, RegistryBinaryTarget, RegistryDistributions, RegistryPackageDistribution,
    RegistrySnapshot, TofuFingerprint, UserAgentDistributionKind, UserAgentInstallTarget,
    VersionEvidence, planned_preflight_updates, profile_required_versions,
    registry_target_for_built_in_update, verify_artifact_bytes, verify_version_evidence,
};
use chrono::Utc;
use uuid::Uuid;

fn package(package: &str) -> RegistryPackageDistribution {
    RegistryPackageDistribution {
        package: package.to_string(),
        args: Vec::new(),
        env: BTreeMap::new(),
        integrity: None,
    }
}

fn generic_target(distributions: RegistryDistributions) -> RegistryAddTarget {
    RegistryAddTarget {
        snapshot_id: Uuid::new_v4(),
        agent_id: AgentId::parse("vendor-agent").unwrap(),
        registry_id: "vendor-agent".to_string(),
        version: "1.2.3".to_string(),
        distributions,
    }
}

#[test]
fn built_in_linux_agents_resolve_supported_runtime_and_acp_plans() {
    let planner = InstallPlanner::bundled();

    for platform in ["linux-x86_64", "linux-aarch64"] {
        for agent in ["claude_code", "codex", "pi"] {
            let agent_id = AgentId::parse(agent).unwrap();
            let plan = planner
                .plan(InstallPlanningInput {
                    agent_id,
                    source: InstallCandidateSource::BuiltInProfile,
                    platform: platform.to_string(),
                    environment: InstallEnvironment {
                        node_verified: true,
                        ..Default::default()
                    },
                })
                .unwrap();

            assert_eq!(plan.platform, platform);
            assert_eq!(plan.components.len(), 2);
            assert!(plan.components.iter().all(|component| {
                component.distribution_kind == PlannedDistributionKind::Npx
                    && component.resolved_source.contains('@')
            }));
        }

        let opencode = planner
            .plan(InstallPlanningInput {
                agent_id: AgentId::parse("opencode").unwrap(),
                source: InstallCandidateSource::BuiltInProfile,
                platform: platform.to_string(),
                environment: InstallEnvironment::default(),
            })
            .unwrap();

        assert_eq!(opencode.platform, platform);
        assert_eq!(opencode.components.len(), 1);
        assert_eq!(
            opencode.components[0].distribution_kind,
            PlannedDistributionKind::Binary
        );
        assert!(opencode.components[0].resolved_source.ends_with(".tar.gz"));
        assert_eq!(opencode.components[0].command, "opencode");
    }
}

#[test]
fn hermes_install_requires_uv_but_not_a_system_python() {
    let plan = InstallPlanner::bundled()
        .plan(InstallPlanningInput {
            agent_id: AgentId::parse("hermes").unwrap(),
            source: InstallCandidateSource::BuiltInProfile,
            platform: "linux-x86_64".to_string(),
            environment: InstallEnvironment {
                uv_verified: true,
                python_verified: false,
                ..Default::default()
            },
        })
        .unwrap();

    assert_eq!(plan.components.len(), 1);
    assert_eq!(
        plan.components[0].distribution_kind,
        PlannedDistributionKind::Uvx
    );
    assert_eq!(
        plan.components[0].resolved_source,
        "hermes-agent[acp,mcp]==0.19.0"
    );
}

#[test]
fn user_definition_freezes_the_explicit_distribution_without_registry_provenance() {
    let planner = InstallPlanner::bundled();
    let agent_id = AgentId::parse("local-reviewer").unwrap();
    let mut binary = BTreeMap::new();
    binary.insert(
        "darwin-aarch64".to_string(),
        RegistryBinaryTarget {
            archive: "https://example.test/local-reviewer.tar.gz".to_string(),
            sha256: Some("ab".repeat(32)),
            cmd: "./local-reviewer".to_string(),
            args: vec!["--acp".to_string()],
            env: BTreeMap::new(),
        },
    );
    let target = UserAgentInstallTarget {
        agent_id: agent_id.clone(),
        version: "1.2.3".to_string(),
        distribution_kind: UserAgentDistributionKind::Npx,
        distributions: RegistryDistributions {
            binary: Some(binary),
            npx: Some(package("local-reviewer@1.2.3")),
            uvx: None,
        },
        definition_sha256: "cd".repeat(32),
    };

    let plan = planner
        .plan(InstallPlanningInput {
            agent_id,
            source: InstallCandidateSource::UserDefinition(Box::new(target)),
            platform: "darwin-aarch64".to_string(),
            environment: InstallEnvironment {
                node_verified: true,
                ..Default::default()
            },
        })
        .unwrap();

    assert_eq!(
        plan.source,
        LockedInstallSource::UserDefinition {
            definition_sha256: "cd".repeat(32),
        }
    );
    assert_eq!(
        plan.components[0].distribution_kind,
        PlannedDistributionKind::Npx
    );
    assert_eq!(plan.components[0].resolved_source, "local-reviewer@1.2.3");
}

#[test]
fn planner_applies_immutable_macos_packaging_advisory_before_freezing_plan() {
    let planner = InstallPlanner::bundled();
    let mut binary = BTreeMap::new();
    binary.insert(
        "darwin-aarch64".to_string(),
        RegistryBinaryTarget {
            archive: "https://github.com/MoonshotAI/kimi-cli/releases/download/1.49.0/kimi-1.49.0-aarch64-apple-darwin.tar.gz".to_string(),
            sha256: Some(
                "15018b20b203aee09658fdc64840c4846fc17c108d8dba1a19a95581d3ce2921"
                    .to_string(),
            ),
            cmd: "./kimi".to_string(),
            args: vec!["acp".to_string()],
            env: BTreeMap::new(),
        },
    );
    let target = RegistryAddTarget {
        snapshot_id: Uuid::new_v4(),
        agent_id: AgentId::parse("registry-agent").unwrap(),
        registry_id: "registry-agent".to_string(),
        version: "1.49.0".to_string(),
        distributions: RegistryDistributions {
            binary: Some(binary),
            npx: None,
            uvx: None,
        },
    };

    let plan = planner
        .plan(InstallPlanningInput {
            agent_id: target.agent_id.clone(),
            source: InstallCandidateSource::Registry(Box::new(target)),
            platform: "darwin-aarch64".to_string(),
            environment: InstallEnvironment::default(),
        })
        .unwrap();
    let component = &plan.components[0];

    assert_eq!(
        component.resolved_source,
        "https://github.com/MoonshotAI/kimi-cli/releases/download/1.49.0/kimi-1.49.0-aarch64-apple-darwin-onedir.tar.gz"
    );
    assert_eq!(component.command, "./kimi/kimi");
    assert_eq!(
        component.trust,
        ArtifactTrust::ExpectedSha256 {
            sha256: "3533d7197a3cf807d7ba3b67d54637180544565f6277870f9bcf639ef21754fb".to_string(),
        }
    );
}

#[test]
fn planner_does_not_apply_packaging_advisory_to_an_unrecognized_hash() {
    let planner = InstallPlanner::bundled();
    let original_archive = "https://github.com/MoonshotAI/kimi-cli/releases/download/1.49.0/kimi-1.49.0-aarch64-apple-darwin.tar.gz";
    let mut binary = BTreeMap::new();
    binary.insert(
        "darwin-aarch64".to_string(),
        RegistryBinaryTarget {
            archive: original_archive.to_string(),
            sha256: Some("ab".repeat(32)),
            cmd: "./kimi".to_string(),
            args: vec!["acp".to_string()],
            env: BTreeMap::new(),
        },
    );
    let target = generic_target(RegistryDistributions {
        binary: Some(binary),
        npx: None,
        uvx: None,
    });

    let plan = planner
        .plan(InstallPlanningInput {
            agent_id: target.agent_id.clone(),
            source: InstallCandidateSource::Registry(Box::new(target)),
            platform: "darwin-aarch64".to_string(),
            environment: InstallEnvironment::default(),
        })
        .unwrap();

    assert_eq!(plan.components[0].resolved_source, original_archive);
    assert_eq!(plan.components[0].command, "./kimi");
}

#[test]
fn planner_accepts_official_uv_at_version_syntax_and_preserves_environment() {
    let planner = InstallPlanner::bundled();
    let mut distribution = package("minion-code@0.1.44");
    distribution.args = vec!["acp".to_string()];
    distribution
        .env
        .insert("MINION_TEST_MODE".to_string(), "1".to_string());
    let target = RegistryAddTarget {
        snapshot_id: Uuid::new_v4(),
        agent_id: AgentId::parse("minion-code").unwrap(),
        registry_id: "minion-code".to_string(),
        version: "0.1.44".to_string(),
        distributions: RegistryDistributions {
            binary: None,
            npx: None,
            uvx: Some(distribution),
        },
    };

    let plan = planner
        .plan(InstallPlanningInput {
            agent_id: target.agent_id.clone(),
            source: InstallCandidateSource::Registry(Box::new(target)),
            platform: "darwin-aarch64".to_string(),
            environment: InstallEnvironment {
                uv_verified: true,
                ..Default::default()
            },
        })
        .unwrap();

    assert_eq!(
        plan.components[0].distribution_kind,
        PlannedDistributionKind::Uvx
    );
    assert_eq!(plan.components[0].args, ["acp"]);
    assert_eq!(
        plan.components[0].env.get("MINION_TEST_MODE"),
        Some(&"1".to_string())
    );
}

#[test]
fn planner_locks_distribution_version_platform_and_trust() {
    let planner = InstallPlanner::bundled();
    let mut binary = BTreeMap::new();
    binary.insert(
        "darwin-aarch64".to_string(),
        RegistryBinaryTarget {
            archive: "https://example.test/vendor.tar.gz".to_string(),
            sha256: Some("ab".repeat(32)),
            cmd: "./vendor".to_string(),
            args: vec!["--acp".to_string()],
            env: BTreeMap::new(),
        },
    );
    let target = generic_target(RegistryDistributions {
        binary: Some(binary),
        npx: Some(package("vendor-agent@1.2.3")),
        uvx: Some(package("vendor-agent==1.2.3")),
    });
    let input = InstallPlanningInput {
        agent_id: target.agent_id.clone(),
        source: InstallCandidateSource::Registry(Box::new(target.clone())),
        platform: "darwin-aarch64".to_string(),
        environment: InstallEnvironment {
            node_verified: true,
            uv_verified: true,
            python_verified: true,
        },
    };
    let plan = planner.plan(input).unwrap();
    assert_eq!(plan.version, "1.2.3");
    assert_eq!(plan.platform, "darwin-aarch64");
    assert_eq!(
        plan.components[0].distribution_kind,
        PlannedDistributionKind::Binary
    );
    assert!(matches!(
        plan.components[0].trust,
        ArtifactTrust::ExpectedSha256 { .. }
    ));

    let without_binary_for_platform = generic_target(RegistryDistributions {
        binary: target.distributions.binary,
        npx: target.distributions.npx,
        uvx: target.distributions.uvx,
    });
    let npx_plan = planner
        .plan(InstallPlanningInput {
            agent_id: without_binary_for_platform.agent_id.clone(),
            source: InstallCandidateSource::Registry(Box::new(without_binary_for_platform.clone())),
            platform: "linux-x86_64".to_string(),
            environment: InstallEnvironment {
                node_verified: true,
                uv_verified: true,
                python_verified: true,
            },
        })
        .unwrap();
    assert_eq!(
        npx_plan.components[0].distribution_kind,
        PlannedDistributionKind::Npx
    );

    assert!(matches!(
        planner.plan(InstallPlanningInput {
            agent_id: without_binary_for_platform.agent_id.clone(),
            source: InstallCandidateSource::Registry(Box::new(without_binary_for_platform)),
            platform: "linux-x86_64".to_string(),
            environment: InstallEnvironment::default(),
        }),
        Err(InstallPlanningError::UnsupportedPlatform { .. })
    ));

    let profile_plan = planner
        .plan(InstallPlanningInput {
            agent_id: AgentId::parse("codex").unwrap(),
            source: InstallCandidateSource::BuiltInProfile,
            platform: "darwin-aarch64".to_string(),
            environment: InstallEnvironment {
                node_verified: true,
                ..Default::default()
            },
        })
        .unwrap();
    assert_eq!(profile_plan.components.len(), 2);
    assert!(profile_plan.components.iter().all(|component| {
        component.distribution_kind == PlannedDistributionKind::Npx
            && !component.resolved_source.contains("latest")
    }));

    let expected = "11".repeat(32);
    assert!(matches!(
        verify_artifact_bytes(
            &ArtifactTrust::ExpectedSha256 { sha256: expected },
            b"different",
            None
        ),
        Err(InstallPlanningError::HashMismatch { .. })
    ));

    let first = verify_artifact_bytes(&ArtifactTrust::Tofu, b"release-one", None).unwrap();
    let recorded = first.tofu_fingerprint.expect("TOFU fingerprint");
    verify_artifact_bytes(&ArtifactTrust::Tofu, b"release-one", Some(&recorded)).unwrap();
    assert!(matches!(
        verify_artifact_bytes(
            &ArtifactTrust::Tofu,
            b"release-two",
            Some(&TofuFingerprint {
                sha256: recorded.sha256
            })
        ),
        Err(InstallPlanningError::TofuChanged { .. })
    ));

    assert!(matches!(
        verify_version_evidence(
            "1.2.3",
            &[
                VersionEvidence::new("manifest", "1.2.3"),
                VersionEvidence::new("runtime", "1.2.4"),
            ]
        ),
        Err(InstallPlanningError::VersionEvidenceConflict { .. })
    ));
}

#[test]
fn built_in_update_target_pins_profile_locked_versions() {
    // ADR-0038 Phase 0 表征:内置 Agent 的更新目标始终是 Profile 编译期锁定的
    // 版本组合,与 Registry 最新版本无关(ADR-0016、ADR-0027)。
    let planner = InstallPlanner::bundled();
    let plan = planner
        .plan(InstallPlanningInput {
            agent_id: AgentId::parse("codex").unwrap(),
            source: InstallCandidateSource::BuiltInProfile,
            platform: "darwin-aarch64".to_string(),
            environment: InstallEnvironment {
                node_verified: true,
                ..Default::default()
            },
        })
        .unwrap();

    assert_eq!(plan.version, "0.146.0");
    let runtime = plan
        .components
        .iter()
        .find(|component| component.component_id == "agent_runtime")
        .expect("codex declares an agent_runtime component");
    assert_eq!(runtime.resolved_source, "@openai/codex@0.146.0");
    assert_eq!(runtime.version, "0.146.0");
    let adapter = plan
        .components
        .iter()
        .find(|component| component.component_id == "acp_adapter")
        .expect("codex declares an acp_adapter component");
    assert_eq!(
        adapter.resolved_source,
        "@agentclientprotocol/codex-acp@1.7.0"
    );
    assert_eq!(adapter.version, "1.7.0");
}

#[test]
fn paired_versions_update_runtime_and_acp_independently() {
    let mut plan = InstallPlanner::bundled()
        .plan(InstallPlanningInput {
            agent_id: AgentId::parse("codex").unwrap(),
            source: InstallCandidateSource::BuiltInProfile,
            platform: "darwin-aarch64".to_string(),
            environment: InstallEnvironment {
                node_verified: true,
                ..Default::default()
            },
        })
        .unwrap();
    agents::apply_component_versions(&mut plan, Some("0.148.0"), Some("1.7.0")).unwrap();
    let runtime = plan
        .components
        .iter()
        .find(|component| component.component_id == "agent_runtime")
        .unwrap();
    let adapter = plan
        .components
        .iter()
        .find(|component| component.component_id == "acp_adapter")
        .unwrap();
    assert_eq!(runtime.resolved_source, "@openai/codex@0.148.0");
    assert_eq!(
        adapter.resolved_source,
        "@agentclientprotocol/codex-acp@1.7.0"
    );
}

#[test]
fn registry_package_integrity_sets_ecosystem_trust() {
    // ADR-0038 Phase 1:Registry npx 分发携带官方完整性时,计划组件采用
    // EcosystemIntegrity(可持久化官方指纹);缺失时保持现状(生态完整性要求)。
    let planner = InstallPlanner::bundled();
    let target = generic_target(RegistryDistributions {
        binary: None,
        npx: Some(RegistryPackageDistribution {
            package: "vendor-agent@1.2.3".to_string(),
            args: Vec::new(),
            env: BTreeMap::new(),
            integrity: Some("sha512-official".to_string()),
        }),
        uvx: None,
    });
    let plan = planner
        .plan(InstallPlanningInput {
            agent_id: target.agent_id.clone(),
            source: InstallCandidateSource::Registry(Box::new(target)),
            platform: "darwin-aarch64".to_string(),
            environment: InstallEnvironment {
                node_verified: true,
                ..Default::default()
            },
        })
        .unwrap();

    assert!(matches!(
        plan.components[0].trust,
        ArtifactTrust::EcosystemIntegrity {
            ref integrity,
        } if integrity == "sha512-official"
    ));

    let without = generic_target(RegistryDistributions {
        binary: None,
        npx: Some(RegistryPackageDistribution {
            package: "vendor-agent@1.2.3".to_string(),
            args: Vec::new(),
            env: BTreeMap::new(),
            integrity: None,
        }),
        uvx: None,
    });
    let fallback = planner
        .plan(InstallPlanningInput {
            agent_id: without.agent_id.clone(),
            source: InstallCandidateSource::Registry(Box::new(without)),
            platform: "darwin-aarch64".to_string(),
            environment: InstallEnvironment {
                node_verified: true,
                ..Default::default()
            },
        })
        .unwrap();
    assert!(matches!(
        fallback.components[0].trust,
        ArtifactTrust::EcosystemIntegrityRequired
    ));
}

#[test]
fn built_in_update_with_registry_replaces_only_the_acp_adapter() {
    // ADR-0038 方向 A:AdapterBacked 内置 Agent(codex)更新时,Registry 条目
    // 只替换 acp_adapter;agent_runtime 保持 Profile 锁版本。
    let planner = InstallPlanner::bundled();
    let target = RegistryAddTarget {
        snapshot_id: Uuid::new_v4(),
        agent_id: AgentId::parse("codex").unwrap(),
        registry_id: "codex-acp".to_string(),
        version: "1.2.0".to_string(),
        distributions: RegistryDistributions {
            binary: None,
            npx: Some(RegistryPackageDistribution {
                package: "@agentclientprotocol/codex-acp@1.2.0".to_string(),
                args: Vec::new(),
                env: BTreeMap::new(),
                integrity: Some("sha512-1.2.0".to_string()),
            }),
            uvx: None,
        },
    };
    let plan = planner
        .plan(InstallPlanningInput {
            agent_id: target.agent_id.clone(),
            source: InstallCandidateSource::BuiltInProfileWithRegistry(Box::new(target)),
            platform: "darwin-aarch64".to_string(),
            environment: InstallEnvironment {
                node_verified: true,
                ..Default::default()
            },
        })
        .unwrap();

    assert_eq!(plan.agent_id.as_str(), "codex");
    assert_eq!(plan.version, "0.146.0");
    assert_eq!(plan.registry_bound_version(), "1.2.0");
    assert!(matches!(
        plan.source,
        LockedInstallSource::BuiltInProfileWithRegistry { .. }
    ));
    let runtime = plan
        .components
        .iter()
        .find(|component| component.component_id == "agent_runtime")
        .expect("runtime component");
    assert_eq!(runtime.resolved_source, "@openai/codex@0.146.0");
    let adapter = plan
        .components
        .iter()
        .find(|component| component.component_id == "acp_adapter")
        .expect("acp_adapter component");
    assert_eq!(
        adapter.resolved_source,
        "@agentclientprotocol/codex-acp@1.2.0"
    );
    assert_eq!(adapter.version, "1.2.0");
    assert!(matches!(
        adapter.trust,
        ArtifactTrust::EcosystemIntegrity { ref integrity } if integrity == "sha512-1.2.0"
    ));
}

#[test]
fn built_in_update_with_registry_replaces_the_combined_runtime() {
    // ADR-0038 方向 A:CombinedRuntime 内置 Agent(opencode)整体随 Registry 版本。
    let planner = InstallPlanner::bundled();
    let target = RegistryAddTarget {
        snapshot_id: Uuid::new_v4(),
        agent_id: AgentId::parse("opencode").unwrap(),
        registry_id: "opencode".to_string(),
        version: "1.19.0".to_string(),
        distributions: RegistryDistributions {
            binary: Some(BTreeMap::from([(
                "darwin-aarch64".to_string(),
                RegistryBinaryTarget {
                    archive: "https://example.test/opencode-1.19.0.tar.gz".to_string(),
                    sha256: Some(
                        "aa19412dd20fc49416742440077fab60944096650072b0ce08e87a16183978e1"
                            .to_string(),
                    ),
                    cmd: "./opencode".to_string(),
                    args: vec!["acp".to_string()],
                    env: BTreeMap::new(),
                },
            )])),
            npx: None,
            uvx: None,
        },
    };
    let plan = planner
        .plan(InstallPlanningInput {
            agent_id: target.agent_id.clone(),
            source: InstallCandidateSource::BuiltInProfileWithRegistry(Box::new(target)),
            platform: "darwin-aarch64".to_string(),
            environment: InstallEnvironment::default(),
        })
        .unwrap();

    assert_eq!(plan.version, "1.19.0");
    assert_eq!(plan.components.len(), 1);
    assert_eq!(plan.components[0].component_id, "combined_runtime");
    assert_eq!(plan.components[0].version, "1.19.0");
    assert!(matches!(
        plan.components[0].trust,
        ArtifactTrust::ExpectedSha256 { .. }
    ));
}

#[test]
fn registry_target_for_built_in_update_resolves_the_binding() {
    // ADR-0038 方向 A:registry_target_for_built_in_update 按 profile 的
    // registry binding 在 snapshot 中定位条目;缺失时返回 None(回退锁版本)。
    let catalog = BuiltInProfileCatalog::bundled();
    let snapshot = RegistrySnapshot {
        id: Uuid::new_v4(),
        source_url: "https://registry.example.test/registry.json".to_string(),
        fetched_at: Utc::now(),
        schema_version: "1.0.0".to_string(),
        document_json: "{}".to_string(),
        document_sha256: "digest".to_string(),
        etag: None,
        entries: vec![RegistryAgentEntry {
            agent_id: AgentId::parse("codex").unwrap(),
            registry_id: "codex-acp".to_string(),
            name: "Codex".to_string(),
            version: "1.2.0".to_string(),
            description: "ACP adapter for OpenAI's coding assistant".to_string(),
            repository: None,
            website: None,
            authors: Vec::new(),
            license: None,
            distributions: RegistryDistributions {
                binary: None,
                npx: Some(RegistryPackageDistribution {
                    package: "@agentclientprotocol/codex-acp@1.2.0".to_string(),
                    args: Vec::new(),
                    env: BTreeMap::new(),
                    integrity: None,
                }),
                uvx: None,
            },
            icon_url: None,
            icon_svg: None,
        }],
    };
    let codex = AgentId::parse("codex").unwrap();
    let target = registry_target_for_built_in_update(&catalog, &snapshot, &codex).unwrap();
    assert_eq!(target.agent_id.as_str(), "codex");
    assert_eq!(target.version, "1.2.0");

    let unbound = AgentId::parse("claude_code").unwrap();
    assert!(
        registry_target_for_built_in_update(&catalog, &snapshot, &unbound).is_none(),
        "snapshot 中没有 claude-acp 条目时应回退 Profile 锁版本"
    );
}

#[test]
fn built_in_update_with_registry_rejects_a_mismatched_target() {
    // Registry target 与 profile 不是同一 Agent 时拒绝,防止跨 Agent 混搭。
    let planner = InstallPlanner::bundled();
    let target = RegistryAddTarget {
        snapshot_id: Uuid::new_v4(),
        agent_id: AgentId::parse("opencode").unwrap(),
        registry_id: "opencode".to_string(),
        version: "1.19.0".to_string(),
        distributions: RegistryDistributions {
            binary: Some(BTreeMap::from([(
                "darwin-aarch64".to_string(),
                RegistryBinaryTarget {
                    archive: "https://example.test/opencode-1.19.0.tar.gz".to_string(),
                    sha256: None,
                    cmd: "./opencode".to_string(),
                    args: Vec::new(),
                    env: BTreeMap::new(),
                },
            )])),
            npx: None,
            uvx: None,
        },
    };
    let error = planner
        .plan(InstallPlanningInput {
            agent_id: AgentId::parse("codex").unwrap(),
            source: InstallCandidateSource::BuiltInProfileWithRegistry(Box::new(target)),
            platform: "darwin-aarch64".to_string(),
            environment: InstallEnvironment {
                node_verified: true,
                ..Default::default()
            },
        })
        .unwrap_err();
    assert!(matches!(
        error,
        InstallPlanningError::RegistryTargetAgentMismatch { .. }
    ));
}

#[test]
fn built_in_registry_binding_accepts_a_distinct_registry_agent_id() {
    let planner = InstallPlanner::bundled();
    let target = RegistryAddTarget {
        snapshot_id: Uuid::new_v4(),
        agent_id: AgentId::parse("antigravity-acp").unwrap(),
        registry_id: "antigravity-acp".to_string(),
        version: "20260818.01".to_string(),
        distributions: RegistryDistributions {
            binary: Some(BTreeMap::from([(
                "darwin-aarch64".to_string(),
                RegistryBinaryTarget {
                    archive: "https://example.test/agy-acp-server.zip".to_string(),
                    sha256: None,
                    cmd: "./agy_acp_server.par".to_string(),
                    args: Vec::new(),
                    env: BTreeMap::new(),
                },
            )])),
            npx: None,
            uvx: None,
        },
    };
    let plan = planner
        .plan(InstallPlanningInput {
            agent_id: AgentId::parse("antigravity").unwrap(),
            source: InstallCandidateSource::BuiltInProfileWithRegistry(Box::new(target)),
            platform: "darwin-aarch64".to_string(),
            environment: InstallEnvironment::default(),
        })
        .expect("registry id antigravity-acp binds to the antigravity profile");
    assert_eq!(plan.agent_id.as_str(), "antigravity");
    assert_eq!(plan.version, "20260818.01");
    assert!(matches!(
        plan.source,
        LockedInstallSource::BuiltInProfileWithRegistry { registry_id, .. }
            if registry_id == "antigravity-acp"
    ));
}

#[test]
fn adapter_backed_identity_version_is_not_the_registry_lock_version() {
    let planner = InstallPlanner::bundled();
    let environment = InstallEnvironment {
        node_verified: true,
        uv_verified: true,
        python_verified: true,
    };
    for agent_id in ["claude_code", "codex", "pi"] {
        let plan = planner
            .plan(InstallPlanningInput {
                agent_id: AgentId::parse(agent_id).unwrap(),
                source: InstallCandidateSource::BuiltInProfile,
                platform: "darwin-aarch64".to_string(),
                environment: environment.clone(),
            })
            .unwrap();
        assert_eq!(
            plan.registry_bound_component()
                .map(|component| component.component_id.as_str()),
            Some("acp_adapter"),
            "{agent_id}"
        );
        assert_ne!(
            plan.version,
            plan.registry_bound_version(),
            "{agent_id} would reintroduce mixed-version update checks if identity were persisted as registry_version"
        );
    }
}

#[test]
fn bundled_registry_updates_follow_each_profile_topology() {
    // Adapter-backed Agents (Claude Code / Codex / Pi) keep the Runtime pin and
    // only consume Registry versions on ACP. Native ACP Agents replace the
    // combined runtime. Update badges must follow that plan, not mix the two
    // version namespaces.
    let catalog = BuiltInProfileCatalog::bundled();
    let planner = InstallPlanner::bundled();
    let newer = "99999.0.0";
    let environment = InstallEnvironment {
        node_verified: true,
        uv_verified: true,
        python_verified: true,
    };
    for profile in catalog.profiles() {
        let binding = profile
            .registry_binding
            .as_ref()
            .expect("bundled profiles declare a Registry binding");
        let target = RegistryAddTarget {
            snapshot_id: Uuid::new_v4(),
            agent_id: profile.agent_id.clone(),
            registry_id: binding.registry_id.to_string(),
            version: newer.to_string(),
            distributions: RegistryDistributions {
                binary: None,
                npx: Some(RegistryPackageDistribution {
                    package: format!("example@{newer}"),
                    args: Vec::new(),
                    env: BTreeMap::new(),
                    integrity: None,
                }),
                uvx: None,
            },
        };
        let plan = planner
            .plan(InstallPlanningInput {
                agent_id: profile.agent_id.clone(),
                source: InstallCandidateSource::BuiltInProfileWithRegistry(Box::new(target)),
                platform: "darwin-aarch64".to_string(),
                environment: environment.clone(),
            })
            .unwrap_or_else(|error| panic!("{}: {error}", profile.agent_id));
        let current = profile_required_versions(profile)
            .into_iter()
            .map(|(component_id, version)| ObservedUserComponent {
                component_id,
                version: Some(version.to_string()),
            })
            .collect::<Vec<_>>();
        let updates = planned_preflight_updates(&plan.components, &current);
        let item_ids = updates
            .iter()
            .map(|update| update.item_id)
            .collect::<Vec<_>>();
        match profile.topology {
            ProfileTopology::AdapterBacked => {
                let runtime_pin = current
                    .iter()
                    .find(|component| component.component_id == "agent_runtime")
                    .and_then(|component| component.version.as_deref())
                    .unwrap_or_else(|| panic!("{} missing runtime pin", profile.agent_id));
                assert_eq!(plan.version, runtime_pin, "{}", profile.agent_id);
                assert_ne!(
                    plan.version,
                    plan.registry_bound_version(),
                    "{} identity version must not be the Registry update target",
                    profile.agent_id
                );
                assert_eq!(item_ids, ["acp"], "{}", profile.agent_id);
                assert_eq!(updates[0].available_version, newer, "{}", profile.agent_id);
                assert_eq!(plan.registry_bound_version(), newer, "{}", profile.agent_id);
            }
            ProfileTopology::NativeAcp => {
                assert_eq!(plan.version, newer, "{}", profile.agent_id);
                assert_eq!(plan.registry_bound_version(), newer, "{}", profile.agent_id);
                assert_eq!(item_ids, ["runtime", "acp"], "{}", profile.agent_id);
                assert!(
                    updates
                        .iter()
                        .all(|update| update.available_version == newer),
                    "{}",
                    profile.agent_id
                );
            }
        }
    }
}
