use agents::{
    AgentId, BuiltInProfileCatalog, NativeConfigFieldKind, NativeConfigSurface, ProfileComponent,
    ProfileInstallSource, ProfileManagementActionKind, RegistryEntryIdentity,
};
use api_types::{AgentKind, AgentSettingsFeature};

fn native_field<'a>(
    catalog: &'a BuiltInProfileCatalog,
    agent_id: &str,
    field_id: &str,
) -> &'a agents::NativeConfigField {
    catalog
        .profile(&AgentId::parse(agent_id).unwrap())
        .unwrap()
        .native_config
        .iter()
        .flat_map(|binding| binding.fields)
        .find(|field| field.field_id == field_id)
        .unwrap_or_else(|| panic!("missing {agent_id}.{field_id}"))
}

#[test]
fn hermes_profile_uses_the_official_desktop_brand_icon() {
    let catalog = BuiltInProfileCatalog::bundled();
    let hermes = catalog
        .profile(&AgentId::parse("hermes").unwrap())
        .expect("bundled Hermes profile");

    assert_eq!(hermes.icon.light, "/agents/hermes.png");
    assert_eq!(hermes.icon.dark, "/agents/hermes.png");
}

#[test]
fn codeg_pinned_distribution_matrix_is_exact() {
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = |id: &str| catalog.profile(&AgentId::parse(id).unwrap()).unwrap();

    assert_eq!(
        profile("claude_code").install_sources.len(),
        1,
        "claude_code must only pin AcpAdapter"
    );
    assert_eq!(
        profile("codex").install_sources.len(),
        1,
        "codex must only pin AcpAdapter"
    );
    assert_eq!(
        profile("pi").install_sources.len(),
        2,
        "pi still pins both AgentRuntime and AcpAdapter"
    );

    for (id, component, package, version, command, node) in [
        (
            "claude_code",
            ProfileComponent::AcpAdapter,
            "@agentclientprotocol/claude-agent-acp",
            "0.94.0",
            "claude-agent-acp",
            ">=22",
        ),
        (
            "codex",
            ProfileComponent::AcpAdapter,
            "@agentclientprotocol/codex-acp",
            "2.2.2",
            "codex-acp",
            ">=20.3",
        ),
        (
            "openclaw",
            ProfileComponent::CombinedRuntime,
            "openclaw",
            "2026.9.8",
            "openclaw",
            ">=24.16.0",
        ),
        (
            "cline",
            ProfileComponent::CombinedRuntime,
            "cline",
            "3.0.73",
            "cline",
            ">=22",
        ),
        (
            "hermes",
            ProfileComponent::CombinedRuntime,
            "hermes-agent",
            "0.22.2",
            "hermes",
            ">=20",
        ),
        (
            "codebuddy",
            ProfileComponent::CombinedRuntime,
            "@tencent-ai/codebuddy-code",
            "2.168.2",
            "codebuddy",
            ">=22",
        ),
        (
            "kimi_code",
            ProfileComponent::CombinedRuntime,
            "@moonshot-ai/kimi-code",
            "2.2.0",
            "kimi",
            ">=22.19",
        ),
        (
            "pi",
            ProfileComponent::AgentRuntime,
            "@earendil-works/pi-coding-agent",
            "0.83.0",
            "pi",
            ">=22",
        ),
        (
            "pi",
            ProfileComponent::AcpAdapter,
            "pi-acp",
            "0.0.34",
            "pi-acp",
            ">=22",
        ),
        (
            "grok",
            ProfileComponent::CombinedRuntime,
            "@xai-official/grok",
            "1.0.62",
            "grok",
            ">=20",
        ),
        (
            "deepseek_harness",
            ProfileComponent::CombinedRuntime,
            "deepseek-acp",
            "0.9.0",
            "deepseek-acp",
            ">=22",
        ),
        (
            "qoder",
            ProfileComponent::CombinedRuntime,
            "@qoder-ai/qodercli",
            "1.1.73",
            "qodercli",
            ">=20",
        ),
        (
            "omp",
            ProfileComponent::CombinedRuntime,
            "@oh-my-pi/pi-coding-agent",
            "18.8.0",
            "omp",
            ">=20",
        ),
    ] {
        let source = profile(id)
            .install_sources
            .iter()
            .find(|source| {
                matches!(source, ProfileInstallSource::Npx { component: actual, .. } if *actual == component)
            })
            .unwrap_or_else(|| panic!("missing pinned npx source for {id}"));
        let ProfileInstallSource::Npx {
            package: actual_package,
            version: actual_version,
            command: actual_command,
            args,
            node_requirement,
            integrity,
            ..
        } = source
        else {
            unreachable!()
        };
        assert_eq!(*actual_package, package, "{id} package");
        assert_eq!(*actual_version, version, "{id} version");
        assert_eq!(*actual_command, command, "{id} command");
        assert_eq!(*node_requirement, node, "{id} Node requirement");
        assert!(!integrity.is_empty(), "{id} must pin npm integrity");
        if id == "deepseek_harness" {
            assert_eq!(
                *integrity,
                "sha512-OG6Ia7GkdjP7UCnFPT8yooZncMo/c2fjpR7BlzuBp7EPF8b+Kohzkhj5U4kJN0vIS9txf50jb3R8CHZcmIZSgg==",
                "deepseek-acp 0.9.0 npm integrity"
            );
        }
        if id == "claude_code" && component == ProfileComponent::AcpAdapter {
            assert_eq!(
                *integrity,
                "sha512-3quBG9QaMKhETZPF0QaD/Ue2C0UCQDzDztDbzs8AVYM8RQKX93TPL0YzJl7sx06qYPLQvxrCDdiAp5a6cgFfZg==",
                "claude-agent-acp 0.94.0 npm integrity"
            );
        }
        if id == "hermes" {
            assert_eq!(*args, ["acp"], "hermes launches `hermes acp`");
        }
    }

    let opencode = profile("opencode").install_sources.first().unwrap();
    assert!(matches!(
        opencode,
        ProfileInstallSource::Binary {
            component: ProfileComponent::CombinedRuntime,
            version: "1.19.3",
            command: "opencode",
            ..
        }
    ));
    let cursor = profile("cursor").install_sources.first().unwrap();
    assert!(matches!(
        cursor,
        ProfileInstallSource::Binary {
            component: ProfileComponent::CombinedRuntime,
            version: "2026.10.16-e3cb207",
            command: "cursor-agent",
            ..
        }
    ));
    let antigravity = profile("antigravity").install_sources.first().unwrap();
    assert!(matches!(
        antigravity,
        ProfileInstallSource::Binary {
            component: ProfileComponent::CombinedRuntime,
            version: "1.4.1",
            command: "agy_acp_server",
            ..
        }
    ));
    let ProfileInstallSource::Binary {
        artifacts,
        entry,
        args,
        ..
    } = antigravity
    else {
        panic!("antigravity must be a binary");
    };
    assert_eq!(artifacts.len(), 6);
    assert!(artifacts.iter().any(|artifact| {
        artifact.platform == "darwin-x86_64"
            && artifact
                .archive_url
                .contains("agy-acp-server-1.4.1-darwin-x86_64.zip")
    }));
    let entry = entry
        .as_ref()
        .expect("antigravity keeps the extracted tree");
    assert_eq!(entry.unix, "agy_acp_server.par");
    assert!(
        profile("antigravity")
            .external_candidates
            .iter()
            .any(|candidate| candidate.executable == "agy_acp_server.par")
    );
    assert!(
        profile("antigravity")
            .external_candidates
            .iter()
            .all(|candidate| candidate.version_args.is_empty()),
        "agy_acp_server does not accept --version and blocks on stdio if spawned with --version"
    );
    assert_eq!(entry.windows, "agy_acp_server.exe");
    assert_eq!(entry.unix_siblings, &["localharness_external"]);
    if cfg!(target_os = "linux") {
        assert_eq!(*args, ["--uid="]);
    } else {
        assert!(args.is_empty());
    }

    let ProfileInstallSource::Binary {
        artifacts: opencode_artifacts,
        ..
    } = opencode
    else {
        panic!("opencode must be a binary");
    };
    let opencode_hash = |platform: &str| {
        opencode_artifacts
            .iter()
            .find(|artifact| artifact.platform == platform)
            .and_then(|artifact| artifact.sha256)
            .unwrap_or_else(|| panic!("missing OpenCode hash for {platform}"))
    };
    assert_eq!(
        opencode_hash("darwin-aarch64"),
        "c2d0fecd27acf6e08be02c1f5d384614d07495587766bcc4a6bff3971749bb64"
    );
    assert_eq!(
        opencode_hash("darwin-x86_64"),
        "4e29dbe2f61ace728370523c88027d0742b3a79edcdd2c70e404f616d4ef8f36"
    );
    assert_eq!(
        opencode_hash("linux-aarch64"),
        "7900818a6a98881edbbadab4b7525940eff3b9750040c200481f9f56cacee405"
    );
    assert_eq!(
        opencode_hash("linux-x86_64"),
        "13a8fb2978302071b86f9d7e00da9c8895f9cd846978379c3bdc6a5333536c9b"
    );
    assert_eq!(
        opencode_hash("windows-aarch64"),
        "c1b9daf18c97564b2d171703279621f7edc3613e70750d796ef78db87257ad89"
    );
    assert_eq!(
        opencode_hash("windows-x86_64"),
        "e4ce9117f55fc068414513789f8c7d1049f855d7518bb4e350b9170a3a20d8c3"
    );

    let ProfileInstallSource::Binary {
        artifacts: cursor_artifacts,
        ..
    } = cursor
    else {
        panic!("cursor must be a binary");
    };
    let cursor_hash = |platform: &str| {
        cursor_artifacts
            .iter()
            .find(|artifact| artifact.platform == platform)
            .and_then(|artifact| artifact.sha256)
            .unwrap_or_else(|| panic!("missing Cursor hash for {platform}"))
    };
    assert_eq!(
        cursor_hash("darwin-aarch64"),
        "5f04d196a84ddb5c20a4a466bdd74e3695bfb447e3c4a1e6071364b2b9497dd0"
    );
    assert_eq!(
        cursor_hash("darwin-x86_64"),
        "93372e384e9397b54b1e4fdb1812662f68e7b61c0c60cb3f2f4b788c9e0779c4"
    );
    assert_eq!(
        cursor_hash("linux-aarch64"),
        "4cf077f150eb8d1e270bf1dea69700184c39a4847fe192d523f5bb34d4b62597"
    );
    assert_eq!(
        cursor_hash("linux-x86_64"),
        "3aa3f48cd7a3909a98c9b3f2a4085f0c021088bf826690b22c61f424c843e552"
    );
    assert_eq!(
        cursor_hash("windows-aarch64"),
        "2cc883fbd67b18f55cd9f65455a472f62abe577da6fbebbd33b0130d0d79d9d0"
    );
    assert_eq!(
        cursor_hash("windows-x86_64"),
        "8ec735f06234310c062c07d68d2940a249356aff49a40fb158b27af210310848"
    );
}

#[test]
fn openclaw_cline_and_pi_skip_session_mcp() {
    let catalog = BuiltInProfileCatalog::bundled();
    for profile in catalog.profiles() {
        let delivers = profile.delivers_session_mcp();
        let skips = matches!(profile.agent_id.as_str(), "openclaw" | "cline" | "pi");
        assert_eq!(
            delivers, !skips,
            "{} session MCP delivery",
            profile.agent_id
        );
    }
    assert!(!agents::profile_delivers_session_mcp(
        &AgentId::parse("openclaw").unwrap()
    ));
    assert!(!agents::profile_delivers_session_mcp(
        &AgentId::parse("cline").unwrap()
    ));
    assert!(!agents::profile_delivers_session_mcp(
        &AgentId::parse("pi").unwrap()
    ));
    assert!(agents::profile_delivers_session_mcp(
        &AgentId::parse("claude_code").unwrap()
    ));
    assert!(
        agents::profile_delivers_session_mcp(&AgentId::parse("vendor-agent").unwrap()),
        "unknown agents default to delivering session MCP"
    );
}

/// Every Profile must resolve to a non-ambiguous ACP invocation, and the two
/// places that can declare it must not disagree. An external candidate that
/// declares `acp_args` while its install source pins different args would make
/// the same Agent launch differently depending on how it was obtained.
#[test]
fn acp_launch_args_have_one_answer_per_profile() {
    let catalog = BuiltInProfileCatalog::bundled();
    for profile in catalog.profiles() {
        for candidate in profile.external_candidates {
            if candidate.acp_args.is_empty() {
                continue;
            }
            let pinned = profile
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
                    } if *component == candidate.component => Some(*args),
                    _ => None,
                });
            if let Some(pinned) = pinned {
                assert_eq!(
                    candidate.acp_args,
                    pinned,
                    "{}: candidate `{}` declares ACP args that disagree with its install source",
                    profile.agent_id.as_str(),
                    candidate.executable
                );
            }
        }

        let acp_candidate = profile.external_candidates.iter().find(|candidate| {
            matches!(
                candidate.component,
                ProfileComponent::AcpAdapter | ProfileComponent::CombinedRuntime
            )
        });
        assert!(
            acp_candidate.is_some(),
            "{}: no external candidate can serve ACP",
            profile.agent_id.as_str()
        );
    }
}

/// Qoder CLI starts its interactive TUI when launched bare; only `--acp` makes
/// it an ACP stdio server. Both published bin names must resolve to it.
#[test]
fn qoder_launches_as_an_acp_server_under_both_bin_names() {
    let catalog = BuiltInProfileCatalog::bundled();
    let qoder = catalog.profile(&AgentId::parse("qoder").unwrap()).unwrap();

    let names = qoder
        .external_candidates
        .iter()
        .map(|candidate| candidate.executable)
        .collect::<Vec<_>>();
    assert_eq!(names, ["qoder", "qodercli"]);

    for candidate in qoder.external_candidates {
        assert_eq!(candidate.acp_args, ["--acp"]);
        assert_eq!(
            agents::acp_launch_args(qoder, candidate.component),
            vec!["--acp".to_string()]
        );
    }

    assert!(matches!(
        qoder.install_sources.first().unwrap(),
        ProfileInstallSource::Npx {
            component: ProfileComponent::CombinedRuntime,
            package: "@qoder-ai/qodercli",
            version: "1.1.73",
            command: "qodercli",
            args: ["--acp"],
            ..
        }
    ));
    assert_eq!(
        qoder.registry_binding.as_ref().unwrap().registry_id,
        "qoder"
    );
    assert_eq!(qoder.management_actions[0].programs[0].args, &["login"]);
    assert!(
        qoder
            .settings_features
            .contains(&AgentSettingsFeature::AuthenticationMode)
    );
}

#[test]
fn native_acp_cli_agents_launch_with_the_documented_server_args() {
    let catalog = BuiltInProfileCatalog::bundled();

    let kiro = catalog.profile(&AgentId::parse("kiro").unwrap()).unwrap();
    assert_eq!(
        kiro.external_candidates
            .iter()
            .map(|candidate| candidate.executable)
            .collect::<Vec<_>>(),
        ["kiro-cli"]
    );
    assert!(matches!(
        kiro.install_sources.first().unwrap(),
        ProfileInstallSource::Binary {
            command: "kiro-cli",
            args: ["acp"],
            version: "2.32.0",
            ..
        }
    ));
    assert!(kiro.registry_binding.is_none());

    let auggie = catalog.profile(&AgentId::parse("auggie").unwrap()).unwrap();
    assert_eq!(
        auggie.registry_binding.as_ref().unwrap().registry_id,
        "auggie"
    );
    assert!(matches!(
        auggie.install_sources.first().unwrap(),
        ProfileInstallSource::Npx {
            package: "@augmentcode/auggie",
            version: "0.36.0",
            command: "auggie",
            args: ["--acp"],
            ..
        }
    ));

    let trae = catalog.profile(&AgentId::parse("trae").unwrap()).unwrap();
    assert_eq!(
        trae.external_candidates
            .iter()
            .map(|candidate| candidate.executable)
            .collect::<Vec<_>>(),
        ["traex", "traecli", "trae-cli"]
    );
    assert!(matches!(
        trae.install_sources.first().unwrap(),
        ProfileInstallSource::Binary {
            command: "traex",
            args: ["acp", "serve"],
            version: "0.209.1",
            ..
        }
    ));

    let command_code = catalog
        .profile(&AgentId::parse("command_code").unwrap())
        .unwrap();
    assert_eq!(
        command_code
            .external_candidates
            .iter()
            .map(|candidate| candidate.executable)
            .collect::<Vec<_>>(),
        ["command-code", "cmdc", "commandcode"]
    );
    assert!(
        command_code
            .external_candidates
            .iter()
            .all(|candidate| candidate.executable != "cmd")
    );
    assert!(matches!(
        command_code.install_sources.first().unwrap(),
        ProfileInstallSource::Npx {
            package: "command-code",
            version: "1.84.0",
            command: "command-code",
            args: ["acp"],
            ..
        }
    ));
    assert!(
        command_code
            .settings_features
            .contains(&AgentSettingsFeature::NativeSkills)
    );
    assert!(
        command_code
            .settings_features
            .contains(&AgentSettingsFeature::NativeMcp)
    );

    let zcode = catalog.profile(&AgentId::parse("zcode").unwrap()).unwrap();
    assert!(zcode.registry_binding.is_none());
    assert_eq!(zcode.management_actions.len(), 1);
    assert_eq!(zcode.management_actions[0].id, "login");
    assert_eq!(
        zcode
            .external_candidates
            .iter()
            .map(|candidate| (candidate.executable, candidate.acp_args))
            .collect::<Vec<_>>(),
        [("zcode-acp-server", &["server"][..])]
    );
    assert!(
        zcode
            .external_candidates
            .iter()
            .all(|candidate| candidate.executable != "zcode")
    );
    assert!(matches!(
        zcode.install_sources.first().unwrap(),
        ProfileInstallSource::Npx {
            package: "zcode-acp-server",
            version: "0.72.0",
            command: "zcode-acp-server",
            args: ["server"],
            node_requirement: ">=22",
            integrity: "sha512-zQzsh/c35NNqLr3iyGwM+UBOyx+93sZ4R3GUFB4ZWjU35r1ThBkDh2Gp/s0d6RpeBI9bysk/bLZlI5DDealBOw==",
            ..
        }
    ));
    assert!(
        zcode
            .settings_features
            .contains(&AgentSettingsFeature::NativeSkills)
    );
    assert!(
        zcode
            .settings_features
            .contains(&AgentSettingsFeature::NativeMcp)
    );
    assert!(zcode.account_evidence.is_none());
    assert!(zcode.runtime_executable_env.is_none());

    for profile in [kiro, auggie, trae, command_code, zcode] {
        for candidate in profile.external_candidates {
            assert_eq!(
                agents::acp_launch_args(profile, candidate.component),
                candidate
                    .acp_args
                    .iter()
                    .map(|argument| (*argument).to_string())
                    .collect::<Vec<_>>(),
                "{}",
                profile.agent_id.as_str()
            );
            assert!(!candidate.acp_args.is_empty());
        }
        assert!(profile.authentication_required_by_default);
        assert!(profile.account_evidence.is_none());
    }
}

#[test]
fn mimo_code_management_profile_is_not_a_permanent_member() {
    let bundled = BuiltInProfileCatalog::bundled();
    let management = BuiltInProfileCatalog::management();
    let mimo_id = AgentId::parse("mimo_code").unwrap();
    assert!(bundled.profile(&mimo_id).is_none());
    let mimo = management
        .profile(&mimo_id)
        .expect("community management profile");
    assert_eq!(mimo.display_name, "MiMo Code");
    assert_eq!(mimo.install_sources.len(), 1);
    assert!(matches!(
        &mimo.install_sources[0],
        ProfileInstallSource::Npx {
            package: "@mimo-ai/cli",
            version: "0.1.14",
            command: "mimo",
            args,
            ..
        } if *args == ["acp"]
    ));
    assert!(
        mimo.settings_features
            .contains(&AgentSettingsFeature::AuthenticationMode)
    );
    assert!(
        mimo.settings_features
            .contains(&AgentSettingsFeature::OpenCodeProviders)
    );
    assert!(
        mimo.settings_features
            .contains(&AgentSettingsFeature::OpenCodePlugins)
    );
    assert_eq!(
        mimo.management_actions[0].programs[0].args,
        &["auth", "login"]
    );
}

#[test]
fn built_in_profiles_are_declarative_and_bind_explicitly() {
    let catalog = BuiltInProfileCatalog::bundled();
    let ids = catalog
        .profiles()
        .iter()
        .map(|profile| profile.agent_id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        AgentKind::built_in_bar_order()
            .map(AgentKind::as_str)
            .collect::<Vec<_>>()
    );
    assert_eq!(
        ids,
        [
            "claude_code",
            "codex",
            "pi",
            "opencode",
            "grok",
            "cursor",
            "deepseek_harness",
            "antigravity",
            "cline",
            "openclaw",
            "hermes",
            "codebuddy",
            "kimi_code",
            "qoder",
            "kiro",
            "auggie",
            "trae",
            "command_code",
            "zcode",
            "omp",
        ]
    );

    for profile in catalog.profiles() {
        assert!(!profile.display_name.trim().is_empty());
        assert!(!profile.description.trim().is_empty());
        assert!(profile.icon.light.starts_with("/agents/"));
        assert!(profile.icon.dark.starts_with("/agents/"));
        assert!(!profile.supported_platforms.is_empty());
        assert!(!profile.install_sources.is_empty());
        assert!(!profile.external_candidates.is_empty());
        if let Some(binding) = profile.registry_binding.as_ref() {
            assert!(
                !binding.registry_id.is_empty(),
                "{} declares an empty Registry id",
                profile.agent_id.as_str()
            );
        }
        assert!(!profile.dependencies.is_empty());
        assert!(profile.dependencies.iter().all(|dependency| {
            !dependency.id.is_empty()
                && !dependency.label.is_empty()
                && !dependency.executable.is_empty()
        }));
        assert!(profile.install_sources.iter().all(|source| match source {
            ProfileInstallSource::Npx { integrity, .. } => !integrity.trim().is_empty(),
            ProfileInstallSource::Uvx { package, .. } => package.contains("=="),
            ProfileInstallSource::Binary { artifacts, .. } => !artifacts.is_empty(),
        }));
    }

    for id in ["claude_code", "codex", "kimi_code", "grok", "cursor"] {
        let profile = catalog.profile(&AgentId::parse(id).unwrap()).unwrap();
        assert!(profile.management_actions.iter().any(|action| {
            action.kind == ProfileManagementActionKind::Login && !action.programs.is_empty()
        }));
    }

    // Adapter-backed Agents install the adapter alone; the adapter carries the
    // vendor CLI and is therefore a declared login entry point, or an installed
    // Agent would report its account actions as unavailable.
    for (id, adapter) in [("claude_code", "claude-agent-acp"), ("codex", "codex-acp")] {
        let profile = catalog.profile(&AgentId::parse(id).unwrap()).unwrap();
        let login = profile
            .management_actions
            .iter()
            .find(|action| action.kind == ProfileManagementActionKind::Login)
            .unwrap();
        assert!(
            login.programs.iter().any(|entry| entry.program == adapter),
            "{id} login must be drivable by `{adapter}`"
        );
    }

    for id in ["claude_code", "codex"] {
        let profile = catalog.profile(&AgentId::parse(id).unwrap()).unwrap();
        assert!(profile.management_actions.iter().any(|action| {
            action.kind == ProfileManagementActionKind::Subscription && action.url.is_some()
        }));
    }

    let renamed = RegistryEntryIdentity {
        registry_id: "claude-acp".to_string(),
        display_name: "Renamed by upstream".to_string(),
    };
    assert_eq!(
        catalog.resolve_registry_entry(&renamed),
        Some(&AgentId::parse("claude_code").unwrap())
    );

    let similar_but_unbound = RegistryEntryIdentity {
        registry_id: "claude-acp-community".to_string(),
        display_name: "Claude Agent".to_string(),
    };
    assert_eq!(catalog.resolve_registry_entry(&similar_but_unbound), None);

    let runtime_bindings = catalog
        .profiles()
        .iter()
        .map(|profile| (profile.agent_id.as_str(), profile.runtime_executable_env))
        .collect::<Vec<_>>();
    assert_eq!(
        runtime_bindings,
        [
            ("claude_code", None),
            ("codex", None),
            ("pi", None),
            ("opencode", None),
            ("grok", None),
            ("cursor", None),
            ("deepseek_harness", None),
            ("antigravity", None),
            ("cline", None),
            ("openclaw", None),
            ("hermes", None),
            ("codebuddy", None),
            ("kimi_code", None),
            ("qoder", None),
            ("kiro", None),
            ("auggie", None),
            ("trae", None),
            ("command_code", None),
            ("zcode", None),
            ("omp", None),
        ]
    );
    assert!(
        catalog
            .profile(&AgentId::parse("claude_code").unwrap())
            .unwrap()
            .adapter_bundles_runtime()
    );
    assert!(
        catalog
            .profile(&AgentId::parse("codex").unwrap())
            .unwrap()
            .adapter_bundles_runtime()
    );
    assert!(
        !catalog
            .profile(&AgentId::parse("pi").unwrap())
            .unwrap()
            .adapter_bundles_runtime()
    );
}

#[test]
fn codeg_account_action_matrix_is_complete() {
    let catalog = BuiltInProfileCatalog::bundled();
    for (agent_id, expected) in [
        ("claude_code", &["login", "logout", "subscription"][..]),
        ("codex", &["login", "logout", "subscription"][..]),
        ("antigravity", &["login"][..]),
        ("openclaw", &["onboard"][..]),
        ("opencode", &["login", "logout"][..]),
        ("cline", &["login"][..]),
        ("hermes", &["setup", "model"][..]),
        ("codebuddy", &["login"][..]),
        ("kimi_code", &["login", "logout"][..]),
        ("pi", &["login"][..]),
        ("grok", &["login", "logout", "subscription"][..]),
        ("cursor", &["login", "logout", "subscription"][..]),
        ("deepseek_harness", &["setup"][..]),
        ("omp", &["login"][..]),
    ] {
        let profile = catalog.profile(&AgentId::parse(agent_id).unwrap()).unwrap();
        assert_eq!(
            profile
                .management_actions
                .iter()
                .map(|action| action.id)
                .collect::<Vec<_>>(),
            expected,
            "{agent_id} account actions"
        );
        assert!(profile.management_actions.iter().all(|action| {
            (!action.programs.is_empty() && action.url.is_none())
                || (action.programs.is_empty() && action.url.is_some())
        }));
    }
}

#[test]
fn every_built_in_binary_has_an_expected_sha256() {
    for profile in BuiltInProfileCatalog::bundled().profiles() {
        for source in &profile.install_sources {
            let ProfileInstallSource::Binary { artifacts, .. } = source else {
                continue;
            };
            for artifact in artifacts {
                if let Some(digest) = artifact.sha256 {
                    assert_eq!(digest.len(), 64);
                    assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));
                }
            }
        }
    }
}

#[test]
fn built_in_profiles_keep_codeg_advanced_configuration_contract() {
    let catalog = BuiltInProfileCatalog::bundled();

    for (agent_id, field_ids) in [
        (
            "claude_code",
            &[
                "haiku_model",
                "sonnet_model",
                "opus_model",
                "claude_send_attribution_header",
                "claude_disable_nonessential_traffic",
            ][..],
        ),
        (
            "codex",
            &[
                "codex_approval_policy",
                "codex_responses_websockets",
                "codex_network_access",
                "codex_exclude_tmpdir",
                "codex_exclude_slash_tmp",
            ][..],
        ),
        (
            "antigravity",
            &[
                "antigravity_tool_permission",
                "antigravity_agent_mode",
                "antigravity_terminal_sandbox",
                "antigravity_telemetry",
                "antigravity_permissions",
            ][..],
        ),
        (
            "kimi_code",
            &[
                "kimi_provider_env",
                "kimi_support_efforts",
                "kimi_default_effort",
            ][..],
        ),
        ("pi", &["pi_custom_providers"][..]),
        (
            "grok",
            &[
                "grok_custom_model_id",
                "grok_api_backend",
                "grok_context_window",
                "grok_auto_compact_threshold",
            ][..],
        ),
        (
            "cursor",
            &["cursor_model", "cursor_force", "cursor_sandbox_mode"][..],
        ),
        ("deepseek_harness", &["deepseek_harness_api_key"][..]),
    ] {
        for field_id in field_ids {
            native_field(&catalog, agent_id, field_id);
        }
    }

    let hermes_provider = native_field(&catalog, "hermes", "hermes_provider");
    assert_eq!(hermes_provider.kind, NativeConfigFieldKind::Select);
    assert_eq!(hermes_provider.options.len(), 37);
    for provider in [
        "openrouter",
        "anthropic",
        "kimi-coding-cn",
        "openai-codex",
        "google-gemini-cli",
        "bedrock",
    ] {
        assert!(
            hermes_provider
                .options
                .iter()
                .any(|(value, _)| *value == provider),
            "missing Hermes provider {provider}"
        );
    }

    assert_eq!(
        native_field(&catalog, "claude_code", "haiku_model").path,
        ["env", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]
    );
    assert_eq!(
        native_field(&catalog, "grok", "grok_permission").path,
        ["ui", "permission_mode"]
    );
    assert_eq!(
        native_field(&catalog, "grok", "grok_permission")
            .options
            .iter()
            .map(|(value, _)| *value)
            .collect::<Vec<_>>(),
        ["ask", "auto", "always-approve"]
    );
    assert_eq!(
        native_field(&catalog, "cursor", "cursor_sandbox_mode").path,
        ["sandbox", "mode"]
    );
    assert_eq!(
        native_field(&catalog, "deepseek_harness", "deepseek_harness_api_key").path,
        ["refs", "DEEPSEEK_API_KEY"]
    );
}

#[test]
fn codeg_directory_semantics_and_settings_capabilities_are_profile_declared() {
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = |id: &str| catalog.profile(&AgentId::parse(id).unwrap()).unwrap();

    let antigravity = profile("antigravity");
    assert_eq!(
        antigravity.native_config[0].directory_override_env,
        Some("GEMINI_HOME")
    );
    assert_eq!(
        antigravity.native_config[0].override_relative_path,
        "antigravity-acp/settings.json"
    );
    assert_eq!(
        antigravity.native_config[1].override_relative_path,
        "antigravity-cli/settings.json"
    );
    assert_eq!(
        antigravity
            .account_evidence
            .as_ref()
            .unwrap()
            .override_relative_directory,
        "antigravity-acp"
    );
    assert!(
        antigravity
            .settings_features
            .contains(&AgentSettingsFeature::AuthenticationMode)
    );
    assert!(
        antigravity
            .settings_features
            .contains(&AgentSettingsFeature::ReusableModelProviders)
    );

    let cline = profile("cline");
    assert!(
        cline
            .native_config
            .iter()
            .all(|binding| binding.directory_override_env == Some("CLINE_DIR"))
    );
    assert_eq!(
        cline
            .account_evidence
            .as_ref()
            .unwrap()
            .directory_override_env,
        Some("CLINE_DIR")
    );

    let codebuddy = profile("codebuddy");
    assert_eq!(
        codebuddy.native_config[0].directory_override_env,
        Some("CODEBUDDY_CONFIG_DIR")
    );
    assert!(
        profile("cursor").account_evidence.is_none(),
        "Cursor account login is stored in the platform secret store, not a config file"
    );
    assert!(
        profile("opencode")
            .settings_features
            .contains(&AgentSettingsFeature::OpenCodeProviders)
    );
    assert!(
        profile("deepseek_harness")
            .settings_features
            .contains(&AgentSettingsFeature::AuthenticationMode)
    );
    assert!(
        profile("omp")
            .settings_features
            .contains(&AgentSettingsFeature::AuthenticationMode)
    );
    assert!(
        profile("omp")
            .settings_features
            .contains(&AgentSettingsFeature::ReusableModelProviders)
    );
    assert!(
        profile("deepseek_harness")
            .settings_features
            .contains(&AgentSettingsFeature::DshPlugins)
    );
    assert!(
        profile("grok")
            .settings_features
            .contains(&AgentSettingsFeature::GrokPlugins)
    );
    assert!(
        profile("pi")
            .settings_features
            .contains(&AgentSettingsFeature::PiPlugins)
    );
    assert!(
        profile("pi")
            .settings_features
            .contains(&AgentSettingsFeature::ReusableModelProviders)
    );
    for id in [
        "claude_code",
        "codex",
        "antigravity",
        "gemini",
        "kimi_code",
        "pi",
        "grok",
        "hermes",
        "openclaw",
        "cline",
        "codebuddy",
        "qoder",
        "auggie",
        "trae",
        "command_code",
        "zcode",
        "omp",
    ] {
        assert!(
            catalog.supports_reusable_model_providers(&AgentId::parse(id).unwrap()),
            "{id} exposes reusable Model Providers and must be able to probe them"
        );
    }
    for id in ["cursor", "opencode", "deepseek_harness", "kiro"] {
        assert!(
            !catalog.supports_reusable_model_providers(&AgentId::parse(id).unwrap()),
            "{id} does not expose reusable Model Providers"
        );
    }

    for id in [
        "claude_code",
        "codex",
        "antigravity",
        "opencode",
        "cline",
        "hermes",
        "codebuddy",
        "kimi_code",
        "grok",
        "cursor",
        "deepseek_harness",
        "qoder",
        "kiro",
        "auggie",
        "trae",
        "command_code",
        "zcode",
        "omp",
    ] {
        assert!(
            profile(id)
                .settings_features
                .contains(&AgentSettingsFeature::NativeMcp),
            "{id} must declare native MCP support"
        );
    }
    for id in ["openclaw", "pi"] {
        assert!(
            !profile(id)
                .settings_features
                .contains(&AgentSettingsFeature::NativeMcp),
            "{id} must not be offered as a native MCP target"
        );
    }
    for id in [
        "claude_code",
        "codex",
        "antigravity",
        "openclaw",
        "opencode",
        "cline",
        "hermes",
        "codebuddy",
        "kimi_code",
        "pi",
        "grok",
        "cursor",
        "deepseek_harness",
        "qoder",
        "kiro",
        "auggie",
        "trae",
        "command_code",
        "zcode",
        "omp",
    ] {
        assert!(
            profile(id)
                .settings_features
                .contains(&AgentSettingsFeature::NativeSkills),
            "{id} must declare native Skills support"
        );
    }
}

#[test]
fn native_config_surfaces_keep_runtime_fields_out_of_authentication() {
    let catalog = BuiltInProfileCatalog::bundled();
    let surface =
        |agent_id: &str, field_id: &str| native_field(&catalog, agent_id, field_id).surface;

    assert_eq!(
        surface("claude_code", "anthropic_base_url"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("claude_code", "anthropic_api_key"),
        NativeConfigSurface::Authentication
    );
    for field_id in ["haiku_model", "sonnet_model", "opus_model"] {
        assert_eq!(
            surface("claude_code", field_id),
            NativeConfigSurface::Authentication,
            "{field_id} belongs on the official API authentication surface"
        );
    }
    for field_id in [
        "effort_level",
        "permission_mode",
        "include_co_authored_by",
        "claude_send_attribution_header",
        "claude_disable_nonessential_traffic",
        "auto_updates_channel",
    ] {
        assert_eq!(
            surface("claude_code", field_id),
            NativeConfigSurface::Configuration,
            "{field_id} must stay in configuration management"
        );
    }

    assert_eq!(
        surface("codex", "openai_api_key"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("codex", "codex_openai_base_url"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("codex", "codex_model_provider"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("codex", "codex_reasoning_effort"),
        NativeConfigSurface::Configuration
    );
    assert_eq!(
        surface("codex", "codex_approval_policy"),
        NativeConfigSurface::Configuration
    );
    assert_eq!(
        surface("codex", "codex_responses_websockets"),
        NativeConfigSurface::Configuration
    );

    assert_eq!(
        surface("antigravity", "antigravity_api_key"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("antigravity", "antigravity_auth"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("antigravity", "antigravity_cloud_project"),
        NativeConfigSurface::Authentication
    );
    for field_id in [
        "antigravity_tool_permission",
        "antigravity_agent_mode",
        "antigravity_terminal_sandbox",
        "antigravity_telemetry",
        "antigravity_permissions",
    ] {
        assert_eq!(
            surface("antigravity", field_id),
            NativeConfigSurface::Configuration,
            "{field_id} must stay in configuration management"
        );
    }

    assert_eq!(
        surface("grok", "grok_base_url"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("grok", "grok_api_key"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("grok", "grok_effort"),
        NativeConfigSurface::Configuration
    );
    assert_eq!(
        surface("opencode", "opencode_anthropic_api_key"),
        NativeConfigSurface::Authentication
    );
    assert_eq!(
        surface("opencode", "opencode_share"),
        NativeConfigSurface::Configuration
    );
    assert_eq!(
        surface("grok", "grok_permission"),
        NativeConfigSurface::Configuration
    );
    assert_eq!(
        surface("cursor", "cursor_model"),
        NativeConfigSurface::Configuration
    );
    assert_eq!(
        surface("cursor", "cursor_force"),
        NativeConfigSurface::Configuration
    );
}

#[test]
fn codex_native_reasoning_effort_includes_max_and_ultra() {
    let catalog = BuiltInProfileCatalog::bundled();
    let values: Vec<_> = native_field(&catalog, "codex", "codex_reasoning_effort")
        .options
        .iter()
        .map(|(value, _)| *value)
        .collect();

    assert_eq!(
        values,
        ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]
    );
}

#[test]
fn official_account_evidence_requires_a_live_token_not_residue() {
    let catalog = BuiltInProfileCatalog::bundled();
    let evidence = |id: &str| {
        catalog
            .profile(&AgentId::parse(id).unwrap())
            .unwrap()
            .account_evidence
            .as_ref()
            .unwrap()
    };

    let claude = evidence("claude_code");
    assert!(claude.matches(&serde_json::json!({
        "claudeAiOauth": { "accessToken": "tok" }
    })));
    assert!(!claude.matches(&serde_json::json!({
        "claudeAiOauth": {}
    })));
    assert!(!claude.matches(&serde_json::json!({})));

    let codex = evidence("codex");
    assert!(codex.matches(&serde_json::json!({
        "tokens": { "access_token": "tok" }
    })));
    assert!(!codex.matches(&serde_json::json!({
        "tokens": { "refresh_token": "stale" }
    })));
    assert!(!codex.matches(&serde_json::json!({ "tokens": {} })));
}

#[test]
fn acp_adapter_relation_covers_only_wrapper_agents() {
    let claude = agents::acp_adapter_relation("claude_code").expect("claude relation");
    assert_eq!(claude.native_cmd, "claude");
    assert_eq!(claude.shared_config_dir, "~/.claude");
    assert!(claude.extra_dirs.contains(&".claude/local"));
    assert!(claude.extra_dirs.contains(&".local/bin"));
    assert_eq!(claude.docs_url, agents::ACP_ADAPTER_DOCS_URL);

    let codex = agents::acp_adapter_relation("codex").expect("codex relation");
    assert_eq!(codex.native_cmd, "codex");
    assert_eq!(codex.shared_config_dir, "~/.codex");
    assert!(codex.extra_dirs.contains(&".local/bin"));

    let zcode = agents::acp_adapter_relation("zcode").expect("zcode relation");
    assert_eq!(zcode.native_cmd, "zcode");
    assert_eq!(zcode.shared_config_dir, "~/.zcode");
    assert!(zcode.extra_dirs.contains(&".local/bin"));

    for direct in [
        "opencode",
        "gemini",
        "grok",
        "kimi_code",
        "codebuddy",
        "cline",
        "hermes",
        "openclaw",
        "qoder",
        "deepseek_harness",
        "cursor",
        "kiro",
        "antigravity",
        "pi",
    ] {
        assert!(
            agents::acp_adapter_relation(direct).is_none(),
            "{direct} ships native ACP or separate runtime policy and must not declare a wrapper relation"
        );
    }
}

#[test]
fn resolve_vendor_cli_hits_extra_dirs_while_spawn_ignores_vendor_cli() {
    let temp = tempfile::tempdir().unwrap();
    let claude_local = temp.path().join(".claude").join("local");
    std::fs::create_dir_all(&claude_local).unwrap();
    #[cfg(windows)]
    let claude_bin = claude_local.join("claude.exe");
    #[cfg(not(windows))]
    let claude_bin = claude_local.join("claude");
    std::fs::write(&claude_bin, b"fake-claude").unwrap();

    let relation = agents::acp_adapter_relation("claude_code").unwrap();
    let resolved = agents::resolve_vendor_cli_in_extra_dirs(
        relation.native_cmd,
        relation.extra_dirs,
        temp.path(),
    );
    assert_eq!(resolved.as_deref(), Some(claude_bin.as_path()));

    let claude_id = AgentId::parse("claude_code").unwrap();
    assert!(
        agents::launch_program_is_vendor_cli(&claude_id, &claude_bin),
        "claude binary must be recognized as vendor CLI and rejected for ACP launch"
    );
    assert!(
        agents::discover_acp_launch_lock_in_dirs(&claude_id, std::slice::from_ref(&claude_local))
            .is_none(),
        "ACP spawn discovery must never select vendor CLI even when its directory is searched"
    );

    #[cfg(windows)]
    let adapter_bin = claude_local.join("claude-agent-acp.cmd");
    #[cfg(not(windows))]
    let adapter_bin = claude_local.join("claude-agent-acp");
    std::fs::write(&adapter_bin, b"fake-adapter").unwrap();
    assert!(!agents::launch_program_is_vendor_cli(
        &claude_id,
        &adapter_bin
    ));
    let lock = agents::discover_acp_launch_lock_in_dirs(&claude_id, &[claude_local])
        .expect("adapter binary should be accepted for ACP launch");
    assert_eq!(lock.absolute_acp_program, adapter_bin);
}

#[test]
fn omp_native_config_exposes_approval_mode_select_field() {
    let catalog = BuiltInProfileCatalog::bundled();
    let field = native_field(&catalog, "omp", "omp_approval_mode");
    assert_eq!(field.label, "工具审批模式");
    assert_eq!(field.path, &["tools", "approvalMode"]);
    assert_eq!(field.kind, NativeConfigFieldKind::Select);
    assert_eq!(field.surface, NativeConfigSurface::Configuration);
    let values: Vec<_> = field.options.iter().map(|(value, _)| *value).collect();
    assert_eq!(
        values,
        ["always-ask", "always-ask-cached", "write", "yolo"]
    );
}

