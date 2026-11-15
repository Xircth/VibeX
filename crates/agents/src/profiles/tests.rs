    use super::*;

    #[test]
    fn omp_profile_marks_bun_dependency_as_required_and_repairable() {
        let catalog = BuiltInProfileCatalog::bundled();
        let omp = catalog
            .profile(&AgentId::parse("omp").unwrap())
            .expect("omp profile");
        let bun = omp
            .dependencies
            .iter()
            .find(|dep| dep.id == "bun")
            .expect("omp bun dependency");
        assert_eq!(bun.executable, "bun");
        assert_eq!(bun.requirement, ">=1.3.14");
        assert!(bun.required);
        assert!(bun.repairable);
    }

    #[test]
    fn flagship_profiles_resolve_native_engine_topology_first_and_honor_acp_override() {
        let catalog = BuiltInProfileCatalog::bundled();
        let claude = catalog
            .profile(&AgentId::parse("claude_code").unwrap())
            .expect("claude_code profile");
        let codex = catalog
            .profile(&AgentId::parse("codex").unwrap())
            .expect("codex profile");
        let opencode = catalog
            .profile(&AgentId::parse("opencode").unwrap())
            .expect("opencode profile");

        assert_eq!(
            claude.native_engine_kind(),
            Some(crate::engine::NativeEngineKind::ClaudeNative)
        );
        assert_eq!(
            codex.native_engine_kind(),
            Some(crate::engine::NativeEngineKind::CodexNative)
        );
        assert_eq!(opencode.native_engine_kind(), None);

        assert_eq!(
            claude.topology,
            ProfileTopology::NativeEngine(crate::engine::NativeEngineKind::ClaudeNative)
        );
        assert_eq!(
            codex.topology,
            ProfileTopology::NativeEngine(crate::engine::NativeEngineKind::CodexNative)
        );
        assert_eq!(
            claude.effective_topology(crate::engine::EngineRuntimePreference::NativeFirst, None),
            ProfileTopology::NativeEngine(crate::engine::NativeEngineKind::ClaudeNative)
        );
        assert_eq!(
            claude.effective_topology(crate::engine::EngineRuntimePreference::AcpOnly, None),
            ProfileTopology::NativeEngine(crate::engine::NativeEngineKind::ClaudeNative)
        );
        assert_eq!(
            codex.effective_topology(crate::engine::EngineRuntimePreference::NativeFirst, None),
            ProfileTopology::NativeEngine(crate::engine::NativeEngineKind::CodexNative)
        );
        assert_eq!(
            claude.effective_topology(
                crate::engine::EngineRuntimePreference::NativeFirst,
                Some("acp")
            ),
            ProfileTopology::AdapterBacked
        );
        assert_eq!(
            opencode.effective_topology(crate::engine::EngineRuntimePreference::NativeFirst, None),
            ProfileTopology::NativeAcp
        );
    }

    #[test]
    fn resolve_native_engine_cli_finds_standalone_install_dirs() {
        let home = tempfile::tempdir().unwrap();
        let claude_dir = home.path().join(".claude").join("local");
        let codex_dir = home
            .path()
            .join("AppData/Local/Programs/OpenAI/Codex/bin");
        std::fs::create_dir_all(&claude_dir).unwrap();
        std::fs::create_dir_all(&codex_dir).unwrap();
        #[cfg(windows)]
        let (claude_bin, codex_bin) = (claude_dir.join("claude.exe"), codex_dir.join("codex.exe"));
        #[cfg(not(windows))]
        let (claude_bin, codex_bin) = (claude_dir.join("claude"), codex_dir.join("codex"));
        std::fs::write(&claude_bin, b"claude").unwrap();
        std::fs::write(&codex_bin, b"codex").unwrap();

        assert_eq!(
            resolve_native_engine_cli("claude_code", home.path()),
            Some(claude_bin)
        );
        assert_eq!(
            resolve_native_engine_cli("codex", home.path()),
            Some(codex_bin)
        );
        assert_eq!(
            suppressed_registry_ids_for_built_ins(),
            &["claude-acp", "claude-code-acp", "codex-acp"]
        );
    }
