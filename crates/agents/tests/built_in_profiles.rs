use agents::{
    AgentId, BuiltInProfileCatalog, ProfileInstallSource, ProfileTopology, RegistryEntryIdentity,
};

#[test]
fn built_in_profiles_are_declarative_and_bind_explicitly() {
    let catalog = BuiltInProfileCatalog::bundled();
    let ids = catalog
        .profiles()
        .iter()
        .map(|profile| profile.agent_id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(ids, ["claude_code", "codex", "opencode", "pi"]);

    for profile in catalog.profiles() {
        assert!(!profile.display_name.trim().is_empty());
        assert!(!profile.description.trim().is_empty());
        assert!(profile.icon.light.starts_with("/agents/"));
        assert!(profile.icon.dark.starts_with("/agents/"));
        assert!(!profile.supported_platforms.is_empty());
        assert!(!profile.install_sources.is_empty());
        assert!(!profile.external_candidates.is_empty());
        assert!(profile.registry_binding.is_some());

        match profile.topology {
            ProfileTopology::NativeAcp => assert!(profile.install_sources.iter().any(
                |source| matches!(source, ProfileInstallSource::Binary { artifacts, .. } if !artifacts.is_empty() && artifacts.iter().all(|artifact| artifact.sha256.len() == 64))
            )),
            ProfileTopology::AdapterBacked => assert!(
                profile
                    .install_sources
                    .iter()
                    .any(|source| matches!(source, ProfileInstallSource::Npx { integrity, .. } if !integrity.trim().is_empty()))
            ),
        }
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
            ("claude_code", Some("CLAUDE_CODE_EXECUTABLE")),
            ("codex", Some("CODEX_PATH")),
            ("opencode", None),
            ("pi", None),
        ]
    );
}
