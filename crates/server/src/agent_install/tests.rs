use agents::{
    LockedInstallSource, PlannedDistributionKind, PlannedInstallComponent,
    managed_node_download_urls_for_proxy, managed_uv_download_urls_for_proxy,
    node_verified_for_install, uv_verified_for_install,
};

use super::*;

#[test]
fn raw_gzip_archive_installs_as_the_single_binary() {
    use flate2::{Compression, write::GzEncoder};

    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(b"traex-binary").unwrap();
    let bytes = encoder.finish().unwrap();
    let destination = std::env::temp_dir().join(format!("dimo-gz-test-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&destination).unwrap();
    extract_archive(
        &bytes,
        "https://example.invalid/traex-windows-x86_64.exe.gz",
        &destination,
    )
    .unwrap();
    let staged = find_staged_executable(&destination, "traex").unwrap();
    assert_eq!(std::fs::read(&staged).unwrap(), b"traex-binary");
    let _ = std::fs::remove_dir_all(&destination);
}

#[test]
fn host_install_plans_npx_without_a_system_node() {
    let platform = current_platform();
    assert!(
        node_verified_for_install(false, &platform),
        "Host ACP install must plan npx distributions on {platform} without a system Node"
    );
}

#[test]
fn connected_app_host_install_downloads_node_with_mirrors() {
    let artifact = managed_node_artifact("linux-x86_64").expect("linux node");
    let with_proxy = managed_node_download_urls_for_proxy(&artifact, true);
    assert!(
        with_proxy[0].starts_with("https://nodejs.org/dist/"),
        "{}",
        with_proxy[0]
    );
    assert!(
        with_proxy.iter().any(|url| url.contains("npmmirror.com")),
        "a self-hosted Host must be able to bootstrap Node without SSH upload"
    );
    assert!(
        with_proxy
            .iter()
            .any(|url| url.contains("mirror.dimo-ai.com")),
        "Dimo mirror must be included as fallback"
    );

    let no_proxy = managed_node_download_urls_for_proxy(&artifact, false);
    assert!(
        no_proxy[0].contains("npmmirror.com"),
        "direct traffic must prefer public China mirror first: {}",
        no_proxy[0]
    );
    assert!(no_proxy.iter().any(|url| url.contains("mirror.dimo-ai.com")));
    assert!(no_proxy.last().unwrap().starts_with("https://nodejs.org/dist/"));
}

#[test]
fn host_install_routes_uv_and_kiro_sources_by_proxy_state() {
    let artifact = managed_uv_artifact("linux-x86_64").expect("linux uv");
    let uv_proxy = managed_uv_download_urls_for_proxy(&artifact, true);
    assert!(uv_proxy[0].starts_with("https://github.com/astral-sh/uv/releases/download/"));
    assert!(uv_proxy[1].starts_with("https://mirror.dimo-ai.com/dl/github/astral-sh/uv/"));

    let uv_direct = managed_uv_download_urls_for_proxy(&artifact, false);
    assert!(uv_direct[0].starts_with("https://mirror.dimo-ai.com/dl/github/astral-sh/uv/"));
    assert!(uv_direct[1].starts_with("https://github.com/astral-sh/uv/releases/download/"));

    let pip_proxy = utils::mirror::uv_install_mirror_candidates_for_proxy(true);
    assert_eq!(pip_proxy[0].0, utils::mirror::OFFICIAL_PYPI_INDEX);
    assert_eq!(pip_proxy.last().unwrap().0, utils::mirror::DIMO_PYPI_INDEX);

    let pip_direct = utils::mirror::uv_install_mirror_candidates_for_proxy(false);
    assert_eq!(pip_direct[0].0, utils::mirror::PUBLIC_PYPI_TUNA_INDEX);
    assert!(
        pip_direct
            .iter()
            .any(|(idx, _)| *idx == utils::mirror::DIMO_PYPI_INDEX)
    );
    assert_eq!(pip_direct.last().unwrap().0, utils::mirror::OFFICIAL_PYPI_INDEX);

    let kiro_direct = utils::mirror::download_url_candidates_for_proxy(
        "https://prod.download.cli.kiro.dev/stable/latest/manifest.json",
        false,
    );
    assert_eq!(
        kiro_direct,
        vec![
            "https://mirror.dimo-ai.com/dl/kiro-prod/stable/latest/manifest.json",
            "https://prod.download.cli.kiro.dev/stable/latest/manifest.json",
        ]
    );
    let kiro_proxy = utils::mirror::download_url_candidates_for_proxy(
        "https://cli.kiro.dev/install.ps1",
        true,
    );
    assert_eq!(
        kiro_proxy,
        vec![
            "https://cli.kiro.dev/install.ps1",
            "https://mirror.dimo-ai.com/dl/kiro-cli/install.ps1",
        ]
    );
}

#[test]
fn host_install_plans_uvx_without_a_system_uv() {
    let platform = current_platform();
    assert!(
        uv_verified_for_install(false, &platform),
        "Host ACP install must plan uvx distributions on {platform} without a system uv"
    );
}

#[test]
fn managed_node_runtime_is_under_the_user_toolchain_root() {
    let root = PathBuf::from("/tmp/dimo-share");
    let runtime = managed_node_runtime(&root).expect("current platform has managed Node");
    let path = runtime.node.to_string_lossy().replace('\\', "/");
    assert!(
        path.contains("agent-tools/node"),
        "managed Node must live under agent-tools: {path}"
    );
    assert!(path.contains(MANAGED_NODE_VERSION));
}

fn adapter_plan(version: &str) -> ResolvedInstallPlan {
    ResolvedInstallPlan {
        agent_id: AgentId::parse("pi").unwrap(),
        source: LockedInstallSource::BuiltInProfile,
        version: version.into(),
        platform: "test".into(),
        components: vec![PlannedInstallComponent {
            component_id: "acp_adapter".into(),
            distribution_kind: PlannedDistributionKind::Npx,
            version: version.into(),
            resolved_source: format!("pi-acp@{version}"),
            command: "npm".into(),
            args: Vec::new(),
            env: Default::default(),
            trust: agents::ArtifactTrust::EcosystemIntegrityRequired,
        }],
    }
}

fn adapter_installation(version: &str) -> InstalledPlan {
    InstalledPlan {
        launch_lock: SessionLaunchLock {
            agent_id: AgentId::parse("pi").unwrap(),
            absolute_acp_program: PathBuf::from("/tmp/pi-acp"),
            args: Vec::new(),
            env: Default::default(),
            runtime_version: String::new(),
            acp_version: version.into(),
        },
        components: vec![InstalledComponent {
            kind: "acp_adapter".into(),
            absolute_path: PathBuf::from("/tmp/pi-acp"),
            version: version.into(),
            sha256: None,
        }],
    }
}

#[test]
fn host_update_rejects_a_lock_that_is_still_behind_npm_latest() {
    let error = ensure_installation_matches_plan(
        &adapter_plan("0.0.35"),
        &adapter_installation("pi-acp 0.0.30"),
    )
    .unwrap_err();
    assert!(error.to_string().contains("outdated"), "{error}");
}

#[test]
fn host_update_accepts_the_planned_adapter_version() {
    ensure_installation_matches_plan(&adapter_plan("0.0.35"), &adapter_installation("0.0.35"))
        .unwrap();
}

#[test]
fn kiro_powershell_installer_sanitization_removes_interactive_prompt_and_preserves_staged_msi() {
    let kiro = AgentId::parse("kiro").unwrap();
    assert!(is_kiro_official_installer(
        &kiro,
        "https://cli.kiro.dev/install.ps1"
    ));
    assert!(is_kiro_official_installer(
        &kiro,
        "https://cli.kiro.dev/install"
    ));
    assert!(!is_kiro_official_installer(
        &kiro,
        "https://prod.download.cli.kiro.dev/stable/2.33.1/kirocli-x86_64-linux.zip"
    ));

    let original = r#"
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "kiro-cli-install-$(Get-Random)"
Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
Read-Host "Press Enter to exit"
"#;
    let sanitized = sanitize_kiro_powershell_script(original);
    assert!(
        !sanitized.contains("Read-Host \"Press Enter to exit\""),
        "non-interactive execution must not block on Read-Host: {sanitized}"
    );
    assert!(
        !sanitized.lines().any(|line| line.trim()
            == "Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue"),
        "tempDir removal must be commented out so MSI fallback can reuse the downloaded file: {sanitized}"
    );
}

#[test]
fn antigravity_component_version_args_remain_empty_so_install_does_not_spawn_blocking_version_probe()
 {
    let antigravity = AgentId::parse("antigravity").unwrap();
    assert!(
        component_version_args(&antigravity, "combined_runtime", "").is_empty(),
        "Antigravity blocks on --version and must not be spawned for version probing"
    );
}

#[tokio::test]
async fn binary_install_replaces_in_use_executable_and_siblings_without_sharing_violation() {
    let temp = tempfile::tempdir().unwrap();
    let staging = temp.path().join("staging");
    let user_bin = temp.path().join("bin");
    tokio::fs::create_dir_all(&staging).await.unwrap();
    tokio::fs::create_dir_all(&user_bin).await.unwrap();

    let dest_exe = user_bin.join(if cfg!(windows) {
        "agy_acp_server.exe"
    } else {
        "agy_acp_server"
    });
    let dest_sibling = user_bin.join(if cfg!(windows) {
        "localharness_external.exe"
    } else {
        "localharness_external"
    });
    tokio::fs::write(&dest_exe, b"old-server").await.unwrap();
    tokio::fs::write(&dest_sibling, b"old-sibling")
        .await
        .unwrap();

    #[cfg(windows)]
    let (_locked_exe, _locked_sibling) = {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x00000001;
        const FILE_SHARE_DELETE: u32 = 0x00000004;
        let f1 = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
            .open(&dest_exe)
            .unwrap();
        let f2 = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_DELETE)
            .open(&dest_sibling)
            .unwrap();
        let direct_err = std::fs::copy(&dest_exe, &dest_exe).unwrap_err();
        assert_eq!(direct_err.raw_os_error(), Some(32));
        (f1, f2)
    };

    let staged_exe = staging.join(dest_exe.file_name().unwrap());
    let staged_sibling = staging.join(dest_sibling.file_name().unwrap());
    tokio::fs::write(&staged_exe, b"new-server").await.unwrap();
    tokio::fs::write(&staged_sibling, b"new-sibling")
        .await
        .unwrap();

    let sibling_name = dest_sibling.file_name().unwrap().to_str().unwrap();
    install_staged_binary_and_siblings(&staged_exe, &dest_exe, &user_bin, &[sibling_name])
        .await
        .expect("updating a running/locked binary and its sibling must succeed");

    assert_eq!(tokio::fs::read(&dest_exe).await.unwrap(), b"new-server");
    assert_eq!(
        tokio::fs::read(&dest_sibling).await.unwrap(),
        b"new-sibling"
    );
}

#[cfg(windows)]
#[tokio::test]
async fn run_npm_global_install_handles_spaced_npm_cmd_and_spaced_prefix() {
    let temp = tempfile::tempdir().unwrap();
    let node_dir = temp.path().join("Program Files").join("nodejs");
    let prefix_dir = temp.path().join("Program Files").join("npm global");
    tokio::fs::create_dir_all(&node_dir).await.unwrap();
    tokio::fs::create_dir_all(&prefix_dir).await.unwrap();

    let marker = prefix_dir.join("installed.txt");
    let npm_cmd = node_dir.join("npm.cmd");
    let script = format!(
        "@echo off\r\necho %~6^|%*> \"{}\"\r\nexit /b 0\r\n",
        marker.display()
    );
    tokio::fs::write(&npm_cmd, script).await.unwrap();

    let component = PlannedInstallComponent {
        component_id: "acp_adapter".into(),
        distribution_kind: PlannedDistributionKind::Npx,
        version: "0.0.34".into(),
        resolved_source: "pi-acp@0.0.34".into(),
        command: "npm".into(),
        args: Vec::new(),
        env: Default::default(),
        trust: agents::ArtifactTrust::EcosystemIntegrityRequired,
    };
    let user_env =
        UserEnvironmentLayout::for_current_user(temp.path()).with_npm_prefix(prefix_dir.clone());

    run_npm_global_install(&npm_cmd, &component, &user_env, None, &mut |_, _| {})
        .await
        .expect("npm.cmd in spaced Program Files path with spaced --prefix must succeed");

    let recorded = tokio::fs::read_to_string(&marker).await.unwrap();
    let trimmed = recorded.trim();
    assert!(
        trimmed.starts_with(&format!("{}|", prefix_dir.display())),
        "expected prefix `{}` in `{trimmed}`",
        prefix_dir.display()
    );
    assert!(
        trimmed.ends_with("pi-acp@0.0.34"),
        "expected package spec at end of `{trimmed}`"
    );
}

fn write_fake_version_cli(dir: &Path, stem: &str, version_output: &str) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    #[cfg(windows)]
    {
        let path = dir.join(format!("{stem}.cmd"));
        let script = format!(
            "@echo off\r\nif \"%~1\"==\"--version\" (\r\n  echo {version_output}\r\n  exit /b 0\r\n)\r\nexit /b 1\r\n"
        );
        std::fs::write(&path, script).unwrap();
        path
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(stem);
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then\n  echo \"{version_output}\"\n  exit 0\nfi\nexit 1\n"
        );
        std::fs::write(&path, script).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }
}

#[test]
fn native_engine_profiles_report_native_engine_catalog_detail() {
    let catalog = BuiltInProfileCatalog::bundled();
    let claude = catalog
        .profile(&AgentId::parse("claude_code").unwrap())
        .unwrap();
    let codex = catalog.profile(&AgentId::parse("codex").unwrap()).unwrap();
    assert_eq!(profile_detail(claude), "native engine claude");
    assert_eq!(profile_detail(codex), "native engine codex");
}

#[tokio::test]
async fn native_engine_verify_handshake_uses_version_probe_and_rejects_legacy_shims() {
    let temp = tempfile::tempdir().unwrap();
    let bin = temp.path().join("bin");
    let claude_cli = write_fake_version_cli(&bin, "claude", "2.1.325 (Claude Code)");
    let codex_cli = write_fake_version_cli(&bin, "codex", "codex-cli 0.169.0");
    let legacy_claude_shim = write_fake_version_cli(&bin, "claude-agent-acp", "0.94.0");
    let legacy_codex_shim = write_fake_version_cli(&bin, "codex-acp", "2.2.2");

    let claude_id = AgentId::parse("claude_code").unwrap();
    let codex_id = AgentId::parse("codex").unwrap();

    for (agent_id, cli_path, version) in [
        (&claude_id, claude_cli, "2.1.325"),
        (&codex_id, codex_cli, "0.169.0"),
    ] {
        let lock = SessionLaunchLock {
            agent_id: agent_id.clone(),
            absolute_acp_program: cli_path,
            args: Vec::new(),
            env: Default::default(),
            runtime_version: version.into(),
            acp_version: version.into(),
        };
        verify_handshake(agent_id, &lock, temp.path())
            .await
            .expect("native engine handshake must succeed via --version without ACP stdio");
    }

    for (agent_id, shim_path) in [
        (&claude_id, legacy_claude_shim),
        (&codex_id, legacy_codex_shim),
    ] {
        let lock = SessionLaunchLock {
            agent_id: agent_id.clone(),
            absolute_acp_program: shim_path,
            args: Vec::new(),
            env: Default::default(),
            runtime_version: "1.0.0".into(),
            acp_version: "1.0.0".into(),
        };
        let err = verify_handshake(agent_id, &lock, temp.path())
            .await
            .expect_err("legacy ACP shim must be rejected for native engine profile");
        assert!(err.to_string().contains("legacy ACP shim"), "{err}");
    }
}

#[tokio::test]
async fn native_engine_try_adopt_discovers_standalone_claude_and_codex_extra_dirs() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    write_fake_version_cli(
        &home.join(".local").join("bin"),
        "claude",
        "2.1.325 (Claude Code)",
    );
    write_fake_version_cli(
        &home
            .join("AppData")
            .join("Local")
            .join("Programs")
            .join("OpenAI")
            .join("Codex")
            .join("bin"),
        "codex",
        "codex-cli 0.169.0",
    );
    let user_env = UserEnvironmentLayout::for_current_user(home);

    for (raw_id, pkg, version, cmd) in [
        (
            "claude_code",
            "@anthropic-ai/claude-code",
            "2.1.325",
            "claude",
        ),
        ("codex", "@openai/codex", "0.169.0", "codex"),
    ] {
        let agent_id = AgentId::parse(raw_id).unwrap();
        let plan = ResolvedInstallPlan {
            agent_id: agent_id.clone(),
            source: LockedInstallSource::BuiltInProfile,
            version: version.into(),
            platform: current_platform(),
            components: vec![PlannedInstallComponent {
                component_id: "combined_runtime".into(),
                distribution_kind: PlannedDistributionKind::Npx,
                version: version.into(),
                resolved_source: format!("{pkg}@{version}"),
                command: cmd.into(),
                args: Vec::new(),
                env: Default::default(),
                trust: agents::ArtifactTrust::EcosystemIntegrityRequired,
            }],
        };
        let adopted = try_adopt_with_options(&agent_id, &plan, &user_env, Some(home), false)
            .await
            .unwrap()
            .unwrap_or_else(|| panic!("expected standalone {raw_id} CLI to be adopted"));
        assert_eq!(adopted.components.len(), 1);
        assert_eq!(adopted.components[0].kind, "combined_runtime");
        assert!(adopted.launch_lock.runtime_version.contains(version));
        assert!(adopted.launch_lock.acp_version.contains(version));
    }
}

#[test]
fn resolve_npm_package_bin_name_reads_package_json_bin_map_and_string() {
    let temp = tempfile::tempdir().unwrap();
    let kimi_pkg = temp
        .path()
        .join("node_modules")
        .join("@moonshot-ai")
        .join("kimi-code");
    std::fs::create_dir_all(&kimi_pkg).unwrap();
    std::fs::write(
        kimi_pkg.join("package.json"),
        r#"{"name":"@moonshot-ai/kimi-code","bin":{"kimi":"dist/main.mjs"}}"#,
    )
    .unwrap();
    assert_eq!(
        installers::resolve_npm_package_bin_name(temp.path(), "@moonshot-ai/kimi-code"),
        "kimi"
    );

    let unix_prefix = temp.path().join("unix");
    let string_pkg = unix_prefix
        .join("lib")
        .join("node_modules")
        .join("@scope")
        .join("custom-cli");
    std::fs::create_dir_all(&string_pkg).unwrap();
    std::fs::write(
        string_pkg.join("package.json"),
        r#"{"name":"@scope/custom-cli","bin":"./dist/index.js"}"#,
    )
    .unwrap();
    assert_eq!(
        installers::resolve_npm_package_bin_name(&unix_prefix, "@scope/custom-cli"),
        "custom-cli"
    );
}

#[test]
fn build_installed_plan_strips_acp_arg_for_hermes_acp() {
    let temp = tempfile::tempdir().unwrap();
    let hermes = AgentId::parse("hermes").unwrap();
    let user_env = UserEnvironmentLayout::for_current_user(temp.path());
    let plan = ResolvedInstallPlan {
        agent_id: hermes.clone(),
        source: LockedInstallSource::BuiltInProfile,
        version: "0.22.2".into(),
        platform: current_platform(),
        components: vec![PlannedInstallComponent {
            component_id: "combined_runtime".into(),
            distribution_kind: PlannedDistributionKind::Uvx,
            version: "0.22.2".into(),
            resolved_source: "hermes-agent[acp]".into(),
            command: "hermes".into(),
            args: vec!["acp".into()],
            env: Default::default(),
            trust: agents::ArtifactTrust::EcosystemIntegrityRequired,
        }],
    };
    let installed = build_installed_plan(
        &hermes,
        &plan,
        &user_env,
        vec![InstalledComponent {
            kind: "combined_runtime".into(),
            absolute_path: temp.path().join("hermes-acp"),
            version: "0.22.2".into(),
            sha256: None,
        }],
    )
    .unwrap();
    assert!(installed.launch_lock.args.is_empty());
}
