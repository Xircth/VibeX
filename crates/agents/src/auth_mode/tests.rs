use std::collections::HashMap;

use api_types::{AgentAuthModeKind, AgentId};

use super::{
    PI_COMMAND_ENV, apply_built_in_auth_mode_policy, apply_built_in_launch_argument_policy,
    apply_built_in_launch_policy, apply_built_in_launch_policy_for_program, auth_mode_kind,
    auto_approve_mode_for_launch, bind_pi_acp_pi_command, built_in_auth_mode_policy,
    codex_initial_agent_mode_from_toml, is_non_official_api_url, official_api_url,
    resolve_built_in_auth_mode, resolve_pi_acp_command,
};

#[test]
fn cline_launch_pins_in_process_runtime_and_disables_self_update() {
    let mut env = HashMap::new();
    apply_built_in_launch_policy(&AgentId::parse("cline").unwrap(), &mut env, &mut Vec::new());
    assert_eq!(env["CLINE_SESSION_BACKEND_MODE"], "local");
    assert_eq!(env["CLINE_NO_AUTO_UPDATE"], "1");

    let mut override_env = HashMap::from([
        ("CLINE_SESSION_BACKEND_MODE".to_string(), "hub".to_string()),
        ("CLINE_NO_AUTO_UPDATE".to_string(), "0".to_string()),
    ]);
    apply_built_in_launch_policy(
        &AgentId::parse("cline").unwrap(),
        &mut override_env,
        &mut Vec::new(),
    );
    assert_eq!(override_env["CLINE_SESSION_BACKEND_MODE"], "hub");
    assert_eq!(override_env["CLINE_NO_AUTO_UPDATE"], "0");
}

#[test]
fn codex_initial_agent_mode_maps_sandbox_and_approval() {
    assert_eq!(
        codex_initial_agent_mode_from_toml("sandbox_mode = \"read-only\"\n").as_deref(),
        Some("read-only")
    );
    assert_eq!(
        codex_initial_agent_mode_from_toml("sandbox_mode = \"workspace-write\"\n").as_deref(),
        Some("workspace-write")
    );
    assert_eq!(
        codex_initial_agent_mode_from_toml(
            "sandbox_mode = \"workspace-write\"\napproval_policy = \"never\"\n"
        )
        .as_deref(),
        Some("agent")
    );
    assert_eq!(
        codex_initial_agent_mode_from_toml(
            "sandbox_mode = \"danger-full-access\"\napproval_policy = \"never\"\n"
        )
        .as_deref(),
        Some("agent-full-access")
    );
    assert_eq!(
        codex_initial_agent_mode_from_toml("sandbox_mode = \"danger-full-access\"\n")
            .as_deref(),
        Some("workspace-write")
    );
    assert_eq!(
        codex_initial_agent_mode_from_toml(
            "sandbox_mode = \"read-only\"\ndefault_permissions = \":read-only\"\n"
        ),
        None
    );
    assert_eq!(codex_initial_agent_mode_from_toml(""), None);
}

#[test]
fn codex_launch_injects_config_derived_initial_agent_mode() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("config.toml"),
        "sandbox_mode = \"read-only\"\n",
    )
    .unwrap();
    let mut env = HashMap::from([(
        "CODEX_HOME".to_string(),
        temp.path().to_string_lossy().into_owned(),
    )]);
    apply_built_in_launch_policy(&AgentId::parse("codex").unwrap(), &mut env, &mut Vec::new());
    assert_eq!(env["INITIAL_AGENT_MODE"], "read-only");
    assert_eq!(env["DISABLE_MCP_CONFIG_FILTERING"], "true");

    env.insert(
        "INITIAL_AGENT_MODE".to_string(),
        "agent-full-access".to_string(),
    );
    apply_built_in_launch_policy(&AgentId::parse("codex").unwrap(), &mut env, &mut Vec::new());
    assert_eq!(env["INITIAL_AGENT_MODE"], "agent-full-access");
}

#[test]
fn codex_and_pi_force_required_acp_capability_environment() {
    let mut codex = HashMap::from([(
        "DISABLE_MCP_CONFIG_FILTERING".to_string(),
        "false".to_string(),
    )]);
    apply_built_in_launch_policy(
        &AgentId::parse("codex").unwrap(),
        &mut codex,
        &mut Vec::new(),
    );
    assert_eq!(codex["DISABLE_MCP_CONFIG_FILTERING"], "true");

    let temp = tempfile::tempdir().unwrap();
    let omp_home = temp.path();
    let mut omp = HashMap::from([
        ("HOME".to_string(), omp_home.to_string_lossy().into_owned()),
        (
            "USERPROFILE".to_string(),
            omp_home.to_string_lossy().into_owned(),
        ),
        (
            "PI_CODING_AGENT_DIR".to_string(),
            omp_home
                .join(".pi")
                .join("agent")
                .to_string_lossy()
                .into_owned(),
        ),
        (
            "PI_ACP_ENABLE_EMBEDDED_CONTEXT".to_string(),
            "true".to_string(),
        ),
        (
            "PI_CODING_AGENT_SESSION_DIR".to_string(),
            omp_home
                .join(".pi")
                .join("agent")
                .join("sessions")
                .to_string_lossy()
                .into_owned(),
        ),
    ]);
    apply_built_in_launch_policy(&AgentId::parse("omp").unwrap(), &mut omp, &mut Vec::new());
    assert_eq!(
        omp.get("PI_CODING_AGENT_DIR").map(String::as_str),
        Some(
            omp_home
                .join(".omp")
                .join("agent")
                .to_string_lossy()
                .as_ref()
        )
    );
    assert!(!omp.contains_key("PI_ACP_ENABLE_EMBEDDED_CONTEXT"));
    assert!(!omp.contains_key("PI_CODING_AGENT_SESSION_DIR"));

    let mut pi = HashMap::from([(
        "HOME".to_string(),
        temp.path().to_string_lossy().into_owned(),
    )]);
    apply_built_in_launch_policy(&AgentId::parse("pi").unwrap(), &mut pi, &mut Vec::new());
    assert_eq!(pi["PI_ACP_ENABLE_EMBEDDED_CONTEXT"], "true");
    assert_eq!(pi["PI_ACP_ENABLE_EXTENSION_COMMANDS"], "true");
}

#[test]
fn pi_launch_exports_the_bound_provider_key_and_config_dir() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let agent_dir = home.join(".pi/agent");
    std::fs::create_dir_all(&agent_dir).unwrap();
    std::fs::write(
        agent_dir.join("settings.json"),
        br#"{"defaultProvider":"private-gateway","defaultModel":"private-model"}"#,
    )
    .unwrap();
    std::fs::write(
        agent_dir.join("auth.json"),
        br#"{"private-gateway":{"type":"api_key","key":"sk-pi"}}"#,
    )
    .unwrap();

    let mut env = HashMap::from([("HOME".to_string(), home.to_string_lossy().into_owned())]);
    apply_built_in_launch_policy(&AgentId::parse("pi").unwrap(), &mut env, &mut Vec::new());

    assert_eq!(
        env.get("PI_CODING_AGENT_DIR").map(String::as_str),
        Some(agent_dir.to_string_lossy().as_ref())
    );
    assert_eq!(env.get("PI_API_KEY").map(String::as_str), Some("sk-pi"));
    assert_eq!(env["PI_ACP_ENABLE_EMBEDDED_CONTEXT"], "true");
    assert_eq!(env["PI_ACP_ENABLE_EXTENSION_COMMANDS"], "true");
}

#[test]
fn pi_launch_keeps_an_explicit_config_dir_and_does_not_clobber_an_existing_key() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let custom_dir = home.join("custom-pi");
    std::fs::create_dir_all(&custom_dir).unwrap();
    std::fs::write(
        custom_dir.join("settings.json"),
        br#"{"defaultProvider":"gateway"}"#,
    )
    .unwrap();
    std::fs::write(
        custom_dir.join("auth.json"),
        br#"{"gateway":{"type":"api_key","key":"sk-from-dir"}}"#,
    )
    .unwrap();

    let mut env = HashMap::from([
        ("HOME".to_string(), home.to_string_lossy().into_owned()),
        (
            "PI_CODING_AGENT_DIR".to_string(),
            custom_dir.to_string_lossy().into_owned(),
        ),
        ("PI_API_KEY".to_string(), "sk-explicit".to_string()),
    ]);
    apply_built_in_launch_policy(&AgentId::parse("pi").unwrap(), &mut env, &mut Vec::new());

    assert_eq!(
        env.get("PI_CODING_AGENT_DIR").map(String::as_str),
        Some(custom_dir.to_string_lossy().as_ref())
    );
    assert_eq!(
        env.get("PI_API_KEY").map(String::as_str),
        Some("sk-explicit")
    );

    env.remove("PI_API_KEY");
    apply_built_in_launch_policy(&AgentId::parse("pi").unwrap(), &mut env, &mut Vec::new());
    assert_eq!(
        env.get("PI_API_KEY").map(String::as_str),
        Some("sk-from-dir")
    );
}

#[test]
fn pi_spawn_prefers_a_sibling_exe_over_a_cmd_shim() {
    let temp = tempfile::tempdir().unwrap();
    let cmd = temp.path().join("pi.cmd");
    let exe = temp.path().join("pi.exe");
    std::fs::write(&cmd, b"@echo off\r\n").unwrap();
    std::fs::write(&exe, b"exe").unwrap();

    let mut env = HashMap::from([(
        PI_COMMAND_ENV.to_string(),
        cmd.to_string_lossy().into_owned(),
    )]);
    bind_pi_acp_pi_command(&mut env, Some(cmd.to_str().unwrap()));

    assert_eq!(
        std::path::Path::new(&env[PI_COMMAND_ENV])
            .file_name()
            .unwrap(),
        exe.file_name().unwrap()
    );
}

#[test]
fn pi_spawn_keeps_an_absolute_cmd_when_no_exe_exists() {
    let temp = tempfile::tempdir().unwrap();
    let cmd = temp.path().join("pi.cmd");
    std::fs::write(&cmd, b"@echo off\r\n").unwrap();

    let mut env = HashMap::new();
    bind_pi_acp_pi_command(&mut env, Some(cmd.to_str().unwrap()));

    assert_eq!(
        std::path::Path::new(&env[PI_COMMAND_ENV])
            .file_name()
            .unwrap(),
        cmd.file_name().unwrap()
    );
}

#[test]
fn pi_spawn_discovers_pi_from_path_when_unset() {
    let temp = tempfile::tempdir().unwrap();
    let bin = temp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let pi = bin.join("pi");
    std::fs::write(&pi, b"#!/bin/sh\n").unwrap();

    let mut env = HashMap::from([("PATH".to_string(), bin.to_string_lossy().into_owned())]);
    bind_pi_acp_pi_command(&mut env, None);

    assert_eq!(
        std::path::Path::new(&env[PI_COMMAND_ENV])
            .file_name()
            .unwrap(),
        pi.file_name().unwrap()
    );
}

#[test]
fn pi_spawn_falls_back_to_path_when_the_custom_command_is_missing() {
    let temp = tempfile::tempdir().unwrap();
    let bin = temp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let pi = bin.join("pi");
    std::fs::write(&pi, b"#!/bin/sh\n").unwrap();
    let missing = temp.path().join("missing.cmd");

    let mut env = HashMap::from([("PATH".to_string(), bin.to_string_lossy().into_owned())]);
    bind_pi_acp_pi_command(&mut env, Some(missing.to_str().unwrap()));

    assert_eq!(
        std::path::Path::new(&env[PI_COMMAND_ENV])
            .file_name()
            .unwrap(),
        pi.file_name().unwrap()
    );
}

#[test]
fn pi_spawn_skips_a_published_shim_when_a_user_runtime_exists() {
    let temp = tempfile::tempdir().unwrap();
    let shim_dir = temp.path().join("shim");
    let user_dir = temp.path().join("user");
    std::fs::create_dir_all(&shim_dir).unwrap();
    std::fs::create_dir_all(&user_dir).unwrap();
    let target = temp.path().join("managed-pi");
    std::fs::write(&target, b"managed").unwrap();
    let shim = shim_dir.join("pi");
    std::fs::write(
        &shim,
        format!(
            "#!/bin/sh\n# Dimo Agent CLI: pi\nexec '{}' \"$@\"\n",
            target.display()
        ),
    )
    .unwrap();
    let user = user_dir.join("pi");
    std::fs::write(&user, b"user").unwrap();

    let path = std::env::join_paths([&shim_dir, &user_dir]).unwrap();
    let resolved = resolve_pi_acp_command(None, Some(path.to_str().unwrap())).unwrap();
    assert_eq!(resolved.file_name().unwrap(), user.file_name().unwrap());
}

#[test]
fn pi_spawn_follows_a_published_shim_when_it_is_the_only_runtime() {
    let temp = tempfile::tempdir().unwrap();
    let shim_dir = temp.path().join("shim");
    std::fs::create_dir_all(&shim_dir).unwrap();
    let target = temp.path().join("managed-pi");
    std::fs::write(&target, b"managed").unwrap();
    let shim = shim_dir.join("pi");
    std::fs::write(
        &shim,
        format!(
            "#!/bin/sh\n# Dimo Agent CLI: pi\nexec '{}' \"$@\"\n",
            target.display()
        ),
    )
    .unwrap();

    let resolved = resolve_pi_acp_command(None, Some(shim_dir.to_str().unwrap())).unwrap();
    assert_eq!(resolved.file_name().unwrap(), target.file_name().unwrap());
}

#[cfg(windows)]
#[test]
fn pi_spawn_prefers_exe_before_cmd_on_windows_path() {
    let temp = tempfile::tempdir().unwrap();
    let cmd = temp.path().join("pi.cmd");
    let exe = temp.path().join("pi.exe");
    std::fs::write(&cmd, b"@echo off\r\n").unwrap();
    std::fs::write(&exe, b"exe").unwrap();

    let resolved = resolve_pi_acp_command(None, Some(temp.path().to_str().unwrap())).unwrap();
    assert_eq!(resolved.file_name().unwrap(), exe.file_name().unwrap());
}

#[test]
fn claude_and_antigravity_modes_remove_conflicting_launch_credentials() {
    let mut claude = HashMap::from([
        (
            "CLAUDE_AUTH_MODE".to_string(),
            "official_subscription".to_string(),
        ),
        ("ANTHROPIC_API_KEY".to_string(), "secret".to_string()),
        (
            "ANTHROPIC_BASE_URL".to_string(),
            "https://proxy.example".to_string(),
        ),
    ]);
    apply_built_in_auth_mode_policy(&AgentId::parse("claude_code").unwrap(), &mut claude);
    assert!(!claude.contains_key("ANTHROPIC_API_KEY"));
    assert!(!claude.contains_key("ANTHROPIC_BASE_URL"));

    let mut antigravity = HashMap::from([
        ("AGY_AUTH_METHOD".to_string(), "oauth-personal".to_string()),
        ("GEMINI_API_KEY".to_string(), "secret".to_string()),
        ("GOOGLE_CLOUD_PROJECT".to_string(), "project".to_string()),
    ]);
    apply_built_in_auth_mode_policy(&AgentId::parse("antigravity").unwrap(), &mut antigravity);
    assert!(!antigravity.contains_key("GEMINI_API_KEY"));
    assert!(!antigravity.contains_key("GOOGLE_CLOUD_PROJECT"));

    let mut legacy = HashMap::from([
        ("GEMINI_AUTH_MODE".to_string(), "gemini_api_key".to_string()),
        ("GEMINI_API_KEY".to_string(), "secret".to_string()),
        ("GOOGLE_API_KEY".to_string(), "google".to_string()),
    ]);
    apply_built_in_auth_mode_policy(&AgentId::parse("gemini").unwrap(), &mut legacy);
    assert_eq!(legacy.get("AGY_AUTH_METHOD").unwrap(), "gemini-api-key");
    assert_eq!(legacy.get("GEMINI_API_KEY").unwrap(), "secret");
    assert!(!legacy.contains_key("GOOGLE_API_KEY"));
}

#[test]
fn product_kinds_separate_subscription_official_api_and_provider() {
    let claude = AgentId::parse("claude_code").unwrap();
    let grok = AgentId::parse("grok").unwrap();
    let cursor = AgentId::parse("cursor").unwrap();
    let opencode = AgentId::parse("opencode").unwrap();
    let dsh = AgentId::parse("deepseek_harness").unwrap();

    assert_eq!(
        auth_mode_kind(&claude, "official_subscription"),
        AgentAuthModeKind::Subscription
    );
    assert_eq!(
        auth_mode_kind(&claude, "official_api"),
        AgentAuthModeKind::OfficialApi
    );
    assert_eq!(
        auth_mode_kind(&claude, "custom"),
        AgentAuthModeKind::OfficialApi
    );
    assert_eq!(
        auth_mode_kind(&claude, "model_provider"),
        AgentAuthModeKind::Provider
    );
    assert_eq!(auth_mode_kind(&grok, "custom"), AgentAuthModeKind::Provider);
    assert_eq!(
        auth_mode_kind(&cursor, "custom"),
        AgentAuthModeKind::OfficialApi
    );
    assert_eq!(
        auth_mode_kind(&opencode, "official_subscription"),
        AgentAuthModeKind::Subscription
    );
    assert_eq!(
        auth_mode_kind(&dsh, "deepseek"),
        AgentAuthModeKind::OfficialApi
    );
    assert_eq!(
        official_api_url(&claude, "official_api"),
        Some("https://api.anthropic.com")
    );
    assert_eq!(official_api_url(&cursor, "custom"), None);

    let qoder = AgentId::parse("qoder").unwrap();
    assert_eq!(
        auth_mode_kind(&qoder, "official_subscription"),
        AgentAuthModeKind::Subscription
    );
    assert_eq!(official_api_url(&qoder, "official_subscription"), None);

    let omp = AgentId::parse("omp").unwrap();
    assert_eq!(
        built_in_auth_mode_policy(&omp).unwrap().modes,
        ["official_subscription", "model_provider"]
    );
    assert_eq!(
        auth_mode_kind(&omp, "official_subscription"),
        AgentAuthModeKind::Subscription
    );

    let mimo = AgentId::parse("mimo_code").unwrap();
    assert_eq!(
        built_in_auth_mode_policy(&mimo).unwrap().modes,
        ["official_subscription", "official_api", "model_provider"]
    );
    assert_eq!(
        auth_mode_kind(&mimo, "official_subscription"),
        AgentAuthModeKind::Subscription
    );
    assert_eq!(
        auth_mode_kind(&mimo, "official_api"),
        AgentAuthModeKind::OfficialApi
    );
    assert_eq!(
        auth_mode_kind(&mimo, "model_provider"),
        AgentAuthModeKind::Provider
    );
}

#[test]
fn cursor_and_grok_launch_knobs_become_root_arguments() {
    let mut cursor_args = vec!["acp".to_string()];
    apply_built_in_launch_argument_policy(
        &AgentId::parse("cursor").unwrap(),
        &HashMap::from([
            ("CURSOR_FORCE".to_string(), "1".to_string()),
            ("CURSOR_MODEL".to_string(), "composer-1".to_string()),
        ]),
        &mut cursor_args,
    );
    assert_eq!(cursor_args, ["--force", "--model", "composer-1", "acp"]);

    let mut grok_args = vec!["agent".to_string(), "stdio".to_string()];
    apply_built_in_launch_argument_policy(
        &AgentId::parse("grok").unwrap(),
        &HashMap::from([(
            "GROK_PERMISSION_MODE".to_string(),
            "acceptEdits".to_string(),
        )]),
        &mut grok_args,
    );
    assert_eq!(
        grok_args,
        [
            "--no-auto-update",
            "--permission-mode",
            "acceptEdits",
            "agent",
            "stdio"
        ]
    );

    let mut grok_bypass = vec!["agent".to_string(), "stdio".to_string()];
    apply_built_in_launch_argument_policy(
        &AgentId::parse("grok").unwrap(),
        &HashMap::from([(
            "GROK_PERMISSION_MODE".to_string(),
            "bypassPermissions".to_string(),
        )]),
        &mut grok_bypass,
    );
    assert_eq!(
        grok_bypass,
        ["--no-auto-update", "agent", "--always-approve", "stdio"]
    );
    let mut grok_always_approve = vec!["agent".to_string(), "stdio".to_string()];
    apply_built_in_launch_argument_policy(
        &AgentId::parse("grok").unwrap(),
        &HashMap::from([(
            "GROK_PERMISSION_MODE".to_string(),
            "always-approve".to_string(),
        )]),
        &mut grok_always_approve,
    );
    assert_eq!(
        grok_always_approve,
        ["--no-auto-update", "agent", "--always-approve", "stdio"]
    );
    assert_eq!(
        auto_approve_mode_for_launch(
            &AgentId::parse("grok").unwrap(),
            &HashMap::from([(
                "GROK_PERMISSION_MODE".to_string(),
                "always-approve".to_string(),
            )])
        ),
        crate::permissions::AgentAutoApproveMode::Yolo
    );

    let grok_home = tempfile::tempdir().unwrap();
    std::fs::write(
        grok_home.path().join("config.toml"),
        b"[ui]\npermission_mode = \"always-approve\"\n",
    )
    .unwrap();
    let mut grok_from_native = HashMap::from([(
        "GROK_HOME".to_string(),
        grok_home.path().to_string_lossy().into_owned(),
    )]);
    let mut grok_from_native_args = vec!["agent".to_string(), "stdio".to_string()];
    apply_built_in_launch_policy(
        &AgentId::parse("grok").unwrap(),
        &mut grok_from_native,
        &mut grok_from_native_args,
    );
    assert_eq!(
        grok_from_native
            .get("GROK_PERMISSION_MODE")
            .map(String::as_str),
        Some("always-approve")
    );
    assert_eq!(
        grok_from_native_args,
        ["--no-auto-update", "agent", "--always-approve", "stdio"]
    );
    assert_eq!(
        auto_approve_mode_for_launch(&AgentId::parse("grok").unwrap(), &grok_from_native),
        crate::permissions::AgentAutoApproveMode::Yolo
    );

    std::fs::write(
        grok_home.path().join("config.toml"),
        b"[ui]\npermission_mode = \"bypassPermissions\"\n",
    )
    .unwrap();
    let mut grok_bypass_native = HashMap::from([(
        "GROK_HOME".to_string(),
        grok_home.path().to_string_lossy().into_owned(),
    )]);
    apply_built_in_launch_policy(
        &AgentId::parse("grok").unwrap(),
        &mut grok_bypass_native,
        &mut Vec::new(),
    );
    assert_eq!(
        grok_bypass_native
            .get("GROK_PERMISSION_MODE")
            .map(String::as_str),
        Some("always-approve")
    );

    let mut grok_env_wins = HashMap::from([
        (
            "GROK_HOME".to_string(),
            grok_home.path().to_string_lossy().into_owned(),
        ),
        ("GROK_PERMISSION_MODE".to_string(), "ask".to_string()),
    ]);
    apply_built_in_launch_policy(
        &AgentId::parse("grok").unwrap(),
        &mut grok_env_wins,
        &mut Vec::new(),
    );
    assert_eq!(
        grok_env_wins
            .get("GROK_PERMISSION_MODE")
            .map(String::as_str),
        Some("ask")
    );

    let mut openclaw_args = vec!["acp".to_string()];
    apply_built_in_launch_argument_policy(
        &AgentId::parse("openclaw").unwrap(),
        &HashMap::from([
            (
                "OPENCLAW_GATEWAY_URL".to_string(),
                "wss://gateway.example".to_string(),
            ),
            ("OPENCLAW_SESSION_KEY".to_string(), "work".to_string()),
        ]),
        &mut openclaw_args,
    );
    assert_eq!(
        openclaw_args,
        ["acp", "--url", "wss://gateway.example", "--session", "work"]
    );
}

/// Until the user chooses a mode, whatever this machine is configured with
/// decides — a bound Provider and a custom native endpoint both count.
#[test]
fn configuration_decides_the_mode_until_the_user_chooses_one() {
    let claude = AgentId::parse("claude_code").unwrap();
    let grok = AgentId::parse("grok").unwrap();
    let kimi = AgentId::parse("kimi_code").unwrap();
    let claude_policy = built_in_auth_mode_policy(&claude).unwrap();
    let grok_policy = built_in_auth_mode_policy(&grok).unwrap();
    let kimi_policy = built_in_auth_mode_policy(&kimi).unwrap();

    assert_eq!(
        resolve_built_in_auth_mode(&claude, claude_policy, &HashMap::new(), false, true, None,),
        "model_provider"
    );
    assert_eq!(
        resolve_built_in_auth_mode(&grok, grok_policy, &HashMap::new(), false, false, None),
        "subscription"
    );
    assert_eq!(
        resolve_built_in_auth_mode(&grok, grok_policy, &HashMap::new(), true, false, None),
        "model_provider"
    );
    assert_eq!(
        resolve_built_in_auth_mode(
            &kimi,
            kimi_policy,
            &HashMap::from([("KIMI_API_KEY".to_string(), "sk-kimi".to_string())]),
            false,
            false,
            None,
        ),
        "official_api"
    );
    assert_eq!(
        resolve_built_in_auth_mode(
            &kimi,
            kimi_policy,
            &HashMap::from([("KIMI_API_KEY".to_string(), "sk-kimi".to_string())]),
            true,
            false,
            None,
        ),
        "model_provider"
    );
    assert!(is_non_official_api_url(&claude, "https://api.deepseek.com"));
    assert!(!is_non_official_api_url(
        &claude,
        "https://api.anthropic.com/v1"
    ));
}

/// A stale Dimo overlay cannot hide the Provider the Agent config is
/// already using. Switching to subscription writes the native files first.
#[test]
fn a_bound_provider_outranks_a_stale_dimo_mode() {
    let claude = AgentId::parse("claude_code").unwrap();
    let grok = AgentId::parse("grok").unwrap();
    let claude_policy = built_in_auth_mode_policy(&claude).unwrap();
    let grok_policy = built_in_auth_mode_policy(&grok).unwrap();

    for (bound_provider, native_custom_endpoint) in [(true, false), (false, true), (true, true)]
    {
        assert_eq!(
            resolve_built_in_auth_mode(
                &claude,
                claude_policy,
                &HashMap::from([("CLAUDE_AUTH_MODE".to_string(), "official_api".to_string())]),
                bound_provider,
                native_custom_endpoint,
                None,
            ),
            "model_provider"
        );
        assert_eq!(
            resolve_built_in_auth_mode(
                &grok,
                grok_policy,
                &HashMap::from([("GROK_AUTH_MODE".to_string(), "subscription".to_string())]),
                bound_provider,
                native_custom_endpoint,
                None,
            ),
            "model_provider"
        );
    }
}

/// Choosing Provider routing with no Provider left to route to would strand
/// the Agent, so that selection still defers to the credentials on hand.
#[test]
fn a_stale_model_provider_choice_falls_back_to_credentials() {
    let grok = AgentId::parse("grok").unwrap();
    let grok_policy = built_in_auth_mode_policy(&grok).unwrap();

    assert_eq!(
        resolve_built_in_auth_mode(
            &grok,
            grok_policy,
            &HashMap::from([("GROK_AUTH_MODE".to_string(), "model_provider".to_string())]),
            false,
            false,
            None,
        ),
        "subscription"
    );
}

#[test]
fn deepseek_harness_launch_policy_migrates_legacy_top_level_credentials_and_normalizes_env() {
    let temp = tempfile::tempdir().expect("tempdir");
    let cred_path = temp.path().join(".credentials.yaml");
    std::fs::write(&cred_path, "DEEPSEEK_API_KEY: sk-legacy-dsh\n").expect("write legacy");

    let dsh = AgentId::parse("deepseek_harness").unwrap();
    let mut env = HashMap::from([
        (
            "DSH_HOME".to_string(),
            temp.path().to_string_lossy().to_string(),
        ),
        (
            "DEEPSEEK_BASE_URL".to_string(),
            "https://api.deepseek.com/anthropic/".to_string(),
        ),
        ("DEEPSEEK_ACP_PROVIDER".to_string(), "custom-id".to_string()),
    ]);
    let mut args = Vec::new();
    apply_built_in_launch_policy(&dsh, &mut env, &mut args);

    assert_eq!(
        env.get("DEEPSEEK_API_KEY").map(String::as_str),
        Some("sk-legacy-dsh")
    );
    assert_eq!(
        env.get("DEEPSEEK_BASE_URL").map(String::as_str),
        Some("https://api.deepseek.com/anthropic")
    );
    assert_eq!(
        env.get("DEEPSEEK_ACP_PROVIDER").map(String::as_str),
        Some("deepseek-official")
    );

    let rewritten: serde_json::Value =
        serde_yaml::from_str(&std::fs::read_to_string(&cred_path).expect("read rewritten"))
            .expect("valid yaml");
    assert_eq!(rewritten["version"], serde_json::json!(1));
    assert!(rewritten.get("DEEPSEEK_API_KEY").is_none());
    assert_eq!(
        rewritten["refs"]["DEEPSEEK_API_KEY"],
        serde_json::json!("sk-legacy-dsh")
    );
}

#[test]
fn deepseek_harness_official_mode_preserves_anthropic_url_and_scrubs_custom_url() {
    let dsh = AgentId::parse("deepseek_harness").unwrap();
    let policy = built_in_auth_mode_policy(&dsh).unwrap();

    let anthropic_env = HashMap::from([
        (
            "DEEPSEEK_BASE_URL".to_string(),
            "https://api.deepseek.com/anthropic".to_string(),
        ),
        ("DEEPSEEK_API_KEY".to_string(), "sk-test".to_string()),
    ]);
    assert_eq!(
        resolve_built_in_auth_mode(&dsh, policy, &anthropic_env, true, true, None),
        "deepseek"
    );
    assert!(super::built_in_auth_mode_scrubbed_env_keys(&dsh, &anthropic_env).is_empty());

    let mut scrubbed_custom = HashMap::from([
        ("DSH_AUTH_MODE".to_string(), "deepseek".to_string()),
        (
            "DEEPSEEK_BASE_URL".to_string(),
            "https://gateway.example.com/v1".to_string(),
        ),
    ]);
    apply_built_in_auth_mode_policy(&dsh, &mut scrubbed_custom);
    assert!(!scrubbed_custom.contains_key("DEEPSEEK_BASE_URL"));
}

#[test]
fn omp_launch_auto_approve_mode_reflects_config_yml_yolo() {
    let temp = tempfile::tempdir().expect("tempdir");
    let agent_dir = temp.path().join(".omp").join("agent");
    std::fs::create_dir_all(&agent_dir).expect("create .omp/agent");
    let omp = AgentId::parse("omp").unwrap();
    let env = HashMap::from([(
        "HOME".to_string(),
        temp.path().to_string_lossy().to_string(),
    )]);

    assert_eq!(
        auto_approve_mode_for_launch(&omp, &env),
        crate::permissions::AgentAutoApproveMode::Off
    );

    std::fs::write(
        agent_dir.join("config.yml"),
        "tools:\n  approvalMode: write\n",
    )
    .expect("write config.yml");
    assert_eq!(
        auto_approve_mode_for_launch(&omp, &env),
        crate::permissions::AgentAutoApproveMode::Off
    );

    std::fs::write(
        agent_dir.join("config.yml"),
        "tools:\n  approvalMode: yolo\n",
    )
    .expect("write config.yml");
    assert_eq!(
        auto_approve_mode_for_launch(&omp, &env),
        crate::permissions::AgentAutoApproveMode::Yolo
    );
}

#[test]
fn grok_custom_auth_mode_preserves_xai_api_key_while_subscription_and_model_provider_scrub_it()
{
    let grok = AgentId::parse("grok").unwrap();

    let mut custom_env = HashMap::from([
        ("GROK_AUTH_MODE".to_string(), "custom".to_string()),
        ("XAI_API_KEY".to_string(), "xai-custom-secret".to_string()),
    ]);
    apply_built_in_auth_mode_policy(&grok, &mut custom_env);
    assert_eq!(
        custom_env.get("XAI_API_KEY").map(String::as_str),
        Some("xai-custom-secret"),
        "custom mode must keep XAI_API_KEY"
    );

    let mut subscription_env = HashMap::from([
        ("GROK_AUTH_MODE".to_string(), "subscription".to_string()),
        ("XAI_API_KEY".to_string(), "xai-sub-secret".to_string()),
    ]);
    apply_built_in_auth_mode_policy(&grok, &mut subscription_env);
    assert!(
        !subscription_env.contains_key("XAI_API_KEY"),
        "subscription mode must scrub XAI_API_KEY"
    );

    let mut provider_env = HashMap::from([
        ("GROK_AUTH_MODE".to_string(), "model_provider".to_string()),
        ("XAI_API_KEY".to_string(), "xai-provider-secret".to_string()),
    ]);
    apply_built_in_auth_mode_policy(&grok, &mut provider_env);
    assert!(
        !provider_env.contains_key("XAI_API_KEY"),
        "model_provider mode must scrub XAI_API_KEY"
    );
}

#[test]
fn hermes_launch_policy_strips_acp_for_hermes_acp_and_adds_for_hermes() {
    let hermes = AgentId::parse("hermes").unwrap();
    let mut env = HashMap::new();

    let mut hermes_acp_args = vec!["acp".to_string()];
    apply_built_in_launch_policy_for_program(
        &hermes,
        Some(std::path::Path::new("/usr/local/bin/hermes-acp")),
        &mut env,
        &mut hermes_acp_args,
    );
    assert!(
        hermes_acp_args.is_empty(),
        "hermes-acp must not receive a duplicate `acp` subcommand"
    );

    let mut hermes_args = Vec::new();
    apply_built_in_launch_policy_for_program(
        &hermes,
        Some(std::path::Path::new(r"C:\Users\dev\.local\bin\hermes.exe")),
        &mut env,
        &mut hermes_args,
    );
    assert_eq!(hermes_args, vec!["acp".to_string()]);
}

#[test]
fn kimi_official_api_projects_model_env_and_non_api_modes_scrub_keys() {
    let kimi = AgentId::parse("kimi_code").unwrap();
    let empty_home = tempfile::tempdir().unwrap();

    let mut api_env = HashMap::from([
        ("KIMI_AUTH_MODE".to_string(), "official_api".to_string()),
        ("KIMI_API_KEY".to_string(), "sk-kimi-test".to_string()),
        (
            "KIMI_BASE_URL".to_string(),
            "https://api.kimi.com/coding/v1".to_string(),
        ),
        (
            "KIMI_CODE_HOME".to_string(),
            empty_home.path().to_string_lossy().to_string(),
        ),
    ]);
    let mut args = vec!["acp".to_string()];
    apply_built_in_launch_policy(&kimi, &mut api_env, &mut args);
    assert_eq!(
        api_env.get("KIMI_MODEL_API_KEY").map(String::as_str),
        Some("sk-kimi-test")
    );
    assert_eq!(
        api_env.get("KIMI_MODEL_PROVIDER_TYPE").map(String::as_str),
        Some("kimi")
    );
    assert_eq!(
        api_env.get("KIMI_MODEL_BASE_URL").map(String::as_str),
        Some("https://api.kimi.com/coding/v1")
    );
    assert_eq!(
        api_env.get("KIMI_MODEL_NAME").map(String::as_str),
        Some("kimi-for-coding")
    );

    // Explicit overrides and config.toml default model must not be overwritten.
    let mut configured_env = HashMap::from([
        ("KIMI_AUTH_MODE".to_string(), "official_api".to_string()),
        ("KIMI_API_KEY".to_string(), "sk-kimi-test".to_string()),
        ("KIMI_MODEL_NAME".to_string(), "custom-kimi-model".to_string()),
    ]);
    apply_built_in_launch_policy(&kimi, &mut configured_env, &mut args);
    assert_eq!(
        configured_env.get("KIMI_MODEL_NAME").map(String::as_str),
        Some("custom-kimi-model")
    );

    // Switching to subscription/model_provider scrubs KIMI_API_KEY and KIMI_MODEL_* overlays.
    for mode in ["official_subscription", "model_provider"] {
        let mut scrubbed = api_env.clone();
        scrubbed.insert("KIMI_AUTH_MODE".to_string(), mode.to_string());
        apply_built_in_auth_mode_policy(&kimi, &mut scrubbed);
        assert!(!scrubbed.contains_key("KIMI_API_KEY"));
        assert!(!scrubbed.contains_key("KIMI_MODEL_API_KEY"));
        assert!(!scrubbed.contains_key("KIMI_MODEL_NAME"));
        assert!(!scrubbed.contains_key("KIMI_MODEL_BASE_URL"));
        assert!(!scrubbed.contains_key("KIMI_MODEL_PROVIDER_TYPE"));
    }
}
