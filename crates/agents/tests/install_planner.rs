use std::collections::BTreeMap;

use agents::{
    AgentId, ArtifactTrust, InstallCandidateSource, InstallEnvironment, InstallPlanner,
    InstallPlanningError, InstallPlanningInput, LockedInstallSource, PlannedDistributionKind,
    RegistryAddTarget, RegistryBinaryTarget, RegistryDistributions, RegistryPackageDistribution,
    TofuFingerprint, UserAgentDistributionKind, UserAgentInstallTarget, VersionEvidence,
    verify_artifact_bytes, verify_version_evidence,
};
use uuid::Uuid;

fn package(package: &str) -> RegistryPackageDistribution {
    RegistryPackageDistribution {
        package: package.to_string(),
        args: Vec::new(),
        env: BTreeMap::new(),
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
