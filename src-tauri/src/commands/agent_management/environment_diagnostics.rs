use super::*;

const DIAGNOSTIC_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const SAFE_ENVIRONMENT_KEYS: &[&str] = &[
    "SHELL",
    "LANG",
    "NVM_DIR",
    "FNM_DIR",
    "FNM_MULTISHELL_PATH",
    "VOLTA_HOME",
    "ASDF_DATA_DIR",
    "MISE_DATA_DIR",
    "N_PREFIX",
    "HOMEBREW_PREFIX",
    "npm_config_prefix",
];

#[derive(Debug, Default)]
struct TerminalPathProbe {
    command_path: Option<String>,
    extra_directories: Vec<String>,
    note: Option<String>,
}

#[derive(Debug)]
struct InstalledComponentDiagnostic {
    kind: String,
    path: String,
    version: String,
    ownership: String,
    exists: bool,
}

pub(super) async fn collect(
    _app: &AppHandle,
    state: &AppState,
    agent_id: AgentId,
) -> Result<AgentEnvironmentDiagnosticsView, AgentManagementErrorView> {
    let catalog = BuiltInProfileCatalog::bundled();
    let profile = catalog.profile(&agent_id).ok_or_else(|| {
        management_error(
            AgentManagementErrorCode::InvalidState,
            "环境诊断当前只适用于内置 Agent",
            Some(agent_id.clone()),
        )
    })?;
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM agent_membership WHERE agent_id = ?)",
    )
    .bind(agent_id.as_str())
    .fetch_one(&state.deployment.db().pool)
    .await
    .map_err(internal_error)?;
    if !exists {
        return Err(management_error(
            AgentManagementErrorCode::NotFound,
            "Agent 尚未添加",
            Some(agent_id),
        ));
    }

    let app_path = std::env::var_os("PATH").unwrap_or_default();
    let app_path_entries = std::env::split_paths(&app_path)
        .filter(|path| !path.as_os_str().is_empty())
        .collect::<Vec<_>>();
    let target_command = profile
        .external_candidates
        .iter()
        .find(|candidate| {
            matches!(
                candidate.component,
                ProfileComponent::AcpAdapter | ProfileComponent::CombinedRuntime
            )
        })
        .or_else(|| profile.external_candidates.first())
        .map(|candidate| candidate.executable)
        .unwrap_or(profile.agent_id.as_str());
    let target_on_app_path = resolve_on_current_path(target_command).await;
    let terminal = terminal_path_probe(target_command, &app_path_entries).await;
    let installed_components = installed_components(&state.deployment.db().pool, &agent_id).await?;

    let mut runtime_checks = vec![
        check(
            "os_arch",
            "agents.environmentDiagnosticOsArch",
            format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
            AgentEnvironmentDiagnosticLevel::Info,
            None,
        ),
        check(
            "app_version",
            "agents.environmentDiagnosticAppVersion",
            env!("CARGO_PKG_VERSION").to_string(),
            AgentEnvironmentDiagnosticLevel::Info,
            None,
        ),
        check(
            "shell",
            "agents.environmentDiagnosticShell",
            std::env::var("SHELL").unwrap_or_else(|_| "N/A".to_string()),
            AgentEnvironmentDiagnosticLevel::Info,
            None,
        ),
        check(
            "app_path",
            "agents.environmentDiagnosticAppPath",
            app_path_entries.len().to_string(),
            AgentEnvironmentDiagnosticLevel::Info,
            Some("agents.environmentDiagnosticAppPathHint"),
        ),
    ];
    runtime_checks.extend(SAFE_ENVIRONMENT_KEYS.iter().filter_map(|key| {
        std::env::var(key).ok().map(|value| {
            check(
                &format!("environment.{key}"),
                "agents.environmentDiagnosticSafeEnvironment",
                format!("{key}={value}"),
                AgentEnvironmentDiagnosticLevel::Info,
                None,
            )
        })
    }));

    let mut dependency_checks = Vec::with_capacity(profile.dependencies.len());
    let mut missing_required_dependency = false;
    for dependency in profile.dependencies {
        let path = resolve_on_current_path(dependency.executable).await;
        let version = match path.as_ref() {
            Some(path) => probe_first_output_line(path, dependency.version_args).await,
            None => None,
        };
        let version_ok = version
            .as_deref()
            .and_then(|version| dependency_version_satisfied(dependency.requirement, version))
            .unwrap_or(path.is_some());
        let healthy = path.is_some() && version_ok;
        if dependency.required && !healthy {
            missing_required_dependency = true;
        }
        let level = if healthy {
            AgentEnvironmentDiagnosticLevel::Ok
        } else if dependency.required {
            AgentEnvironmentDiagnosticLevel::Error
        } else {
            AgentEnvironmentDiagnosticLevel::Warning
        };
        let value = match (version, path) {
            (Some(version), Some(path)) => format!("{version} ({})", path.display()),
            (None, Some(path)) => path.display().to_string(),
            _ => format!("NOT FOUND · {}", dependency.requirement),
        };
        dependency_checks.push(check(
            &format!("dependency.{}", dependency.id),
            &format!("agents.environmentDiagnosticDependency.{}", dependency.id),
            value,
            level,
            (!healthy).then_some(if dependency.required {
                "agents.environmentDiagnosticDependencyRequired"
            } else {
                "agents.environmentDiagnosticDependencyOptional"
            }),
        ));
    }
    if dependency_checks.is_empty() {
        dependency_checks.push(check(
            "dependency.none",
            "agents.environmentDiagnosticNoDependencies",
            "N/A".to_string(),
            AgentEnvironmentDiagnosticLevel::Info,
            None,
        ));
    }

    let managed_launchable = installed_components.iter().any(|component| {
        component.exists && matches!(component.kind.as_str(), "acp_adapter" | "combined_runtime")
    });
    let externally_launchable = target_on_app_path.is_some();
    let launchable = managed_launchable || externally_launchable;
    let mut installation_checks = installed_components
        .iter()
        .map(|component| {
            check(
                &format!("component.{}", component.kind),
                &format!("agents.environmentDiagnosticComponent.{}", component.kind),
                format!(
                    "{} · {} · {}",
                    component.version, component.ownership, component.path
                ),
                if component.exists {
                    AgentEnvironmentDiagnosticLevel::Ok
                } else {
                    AgentEnvironmentDiagnosticLevel::Error
                },
                (!component.exists).then_some("agents.environmentDiagnosticComponentMissing"),
            )
        })
        .collect::<Vec<_>>();
    installation_checks.push(check(
        "target_command",
        "agents.environmentDiagnosticTargetCommand",
        target_on_app_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| {
                if managed_launchable {
                    "user environment".to_string()
                } else {
                    "NOT RESOLVED".to_string()
                }
            }),
        if launchable {
            AgentEnvironmentDiagnosticLevel::Ok
        } else {
            AgentEnvironmentDiagnosticLevel::Error
        },
        managed_launchable.then_some("agents.environmentDiagnosticManagedLaunch"),
    ));

    let terminal_has_gap = target_on_app_path.is_none() && terminal.command_path.is_some();
    let mut terminal_checks = vec![check(
        "terminal_command",
        "agents.environmentDiagnosticTerminalCommand",
        terminal
            .command_path
            .clone()
            .or(terminal.note.clone())
            .unwrap_or_else(|| "NOT RESOLVED".to_string()),
        if terminal_has_gap {
            AgentEnvironmentDiagnosticLevel::Warning
        } else {
            AgentEnvironmentDiagnosticLevel::Info
        },
        terminal_has_gap.then_some("agents.environmentDiagnosticTerminalGap"),
    )];
    terminal_checks.push(check(
        "terminal_extra_paths",
        "agents.environmentDiagnosticTerminalExtraPaths",
        if terminal.extra_directories.is_empty() {
            "none".to_string()
        } else {
            terminal.extra_directories.join("\n")
        },
        if terminal.extra_directories.is_empty() {
            AgentEnvironmentDiagnosticLevel::Ok
        } else {
            AgentEnvironmentDiagnosticLevel::Warning
        },
        (!terminal.extra_directories.is_empty())
            .then_some("agents.environmentDiagnosticTerminalExtraPathsHint"),
    ));

    let (verdict_code, verdict_level) = if missing_required_dependency {
        ("dependency_missing", AgentEnvironmentDiagnosticLevel::Error)
    } else if !launchable && terminal_has_gap {
        (
            "terminal_path_gap",
            AgentEnvironmentDiagnosticLevel::Warning,
        )
    } else if !launchable {
        ("agent_not_resolved", AgentEnvironmentDiagnosticLevel::Error)
    } else if installed_components
        .iter()
        .any(|component| !component.exists)
    {
        (
            "installation_invalid",
            AgentEnvironmentDiagnosticLevel::Error,
        )
    } else {
        ("ok", AgentEnvironmentDiagnosticLevel::Ok)
    };

    let sections = vec![
        section(
            "runtime",
            "agents.environmentDiagnosticRuntime",
            runtime_checks,
        ),
        section(
            "dependencies",
            "agents.environmentDiagnosticDependencies",
            dependency_checks,
        ),
        section(
            "installation",
            "agents.environmentDiagnosticInstallation",
            installation_checks,
        ),
        section(
            "terminal",
            "agents.environmentDiagnosticTerminal",
            terminal_checks,
        ),
    ];
    let generated_at = Utc::now().to_rfc3339();
    let plain_text = render_plain_text(
        &agent_id,
        verdict_code,
        &sections,
        &generated_at,
        &app_path_entries,
    );
    Ok(AgentEnvironmentDiagnosticsView {
        agent_id,
        verdict_code: verdict_code.to_string(),
        verdict_level,
        sections,
        generated_at,
        plain_text,
    })
}

async fn installed_components(
    pool: &sqlx::SqlitePool,
    agent_id: &AgentId,
) -> Result<Vec<InstalledComponentDiagnostic>, AgentManagementErrorView> {
    let rows = sqlx::query_as::<_, (String, String, String, String)>(
        r#"SELECT component.component_kind, component.absolute_path,
                  component.version, component.ownership
           FROM agent_installation installation
           JOIN agent_install_component component
             ON component.lock_id = installation.current_lock_id
           WHERE installation.agent_id = ?
           ORDER BY component.component_kind"#,
    )
    .bind(agent_id.as_str())
    .fetch_all(pool)
    .await
    .map_err(internal_error)?;
    Ok(rows
        .into_iter()
        .map(
            |(kind, path, version, ownership)| InstalledComponentDiagnostic {
                exists: Path::new(&path).is_file(),
                kind,
                path,
                version,
                ownership,
            },
        )
        .collect())
}

async fn resolve_on_current_path(executable: &str) -> Option<PathBuf> {
    if executable.trim().is_empty() {
        return None;
    }
    let executable = executable.to_string();
    tokio::task::spawn_blocking(move || which::which(executable).ok())
        .await
        .ok()
        .flatten()
}

async fn probe_first_output_line(path: &Path, args: &[&str]) -> Option<String> {
    let mut command = utils::process::new_hidden_tokio_command(path, args.iter().copied());
    command.kill_on_drop(true);
    let output = tokio::time::timeout(DIAGNOSTIC_COMMAND_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(redact_operation_output)
}

#[cfg(not(windows))]
async fn terminal_path_probe(command: &str, app_path: &[PathBuf]) -> TerminalPathProbe {
    if !command
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return TerminalPathProbe {
            note: Some("unsafe command name rejected".to_string()),
            ..TerminalPathProbe::default()
        };
    }
    let Some(shell) = std::env::var_os("SHELL").map(PathBuf::from) else {
        return TerminalPathProbe {
            note: Some("SHELL is not set".to_string()),
            ..TerminalPathProbe::default()
        };
    };
    if !shell.is_absolute() || !shell.is_file() {
        return TerminalPathProbe {
            note: Some("configured shell is unavailable".to_string()),
            ..TerminalPathProbe::default()
        };
    }
    let script =
        format!("printf 'VIBEX_PATH=%s\\n' \"$PATH\"; command -v {command} 2>/dev/null || true");
    let mut process =
        utils::process::new_hidden_tokio_command(&shell, ["-lic", script.as_str()].into_iter());
    process.kill_on_drop(true);
    let output = match tokio::time::timeout(DIAGNOSTIC_COMMAND_TIMEOUT, process.output()).await {
        Ok(Ok(output)) if output.status.success() => output,
        _ => {
            return TerminalPathProbe {
                note: Some("login shell probe failed or timed out".to_string()),
                ..TerminalPathProbe::default()
            };
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut shell_path = Vec::new();
    let mut command_path = None;
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Some(path) = line.strip_prefix("VIBEX_PATH=") {
            shell_path = std::env::split_paths(path).collect();
        } else if command_path.is_none() && Path::new(line).is_absolute() {
            command_path = Some(line.to_string());
        }
    }
    let app_paths = app_path.iter().collect::<HashSet<_>>();
    TerminalPathProbe {
        command_path,
        extra_directories: shell_path
            .iter()
            .filter(|path| !app_paths.contains(path))
            .map(|path| path.display().to_string())
            .collect(),
        note: None,
    }
}

#[cfg(windows)]
async fn terminal_path_probe(_command: &str, _app_path: &[PathBuf]) -> TerminalPathProbe {
    TerminalPathProbe {
        note: Some("login shell comparison is unavailable on Windows".to_string()),
        ..TerminalPathProbe::default()
    }
}

fn check(
    id: &str,
    label_key: &str,
    value: String,
    level: AgentEnvironmentDiagnosticLevel,
    detail_key: Option<&str>,
) -> AgentEnvironmentDiagnosticCheckView {
    AgentEnvironmentDiagnosticCheckView {
        id: id.to_string(),
        label_key: label_key.to_string(),
        value,
        level,
        detail_key: detail_key.map(ToOwned::to_owned),
    }
}

fn section(
    id: &str,
    title_key: &str,
    checks: Vec<AgentEnvironmentDiagnosticCheckView>,
) -> AgentEnvironmentDiagnosticSectionView {
    AgentEnvironmentDiagnosticSectionView {
        id: id.to_string(),
        title_key: title_key.to_string(),
        checks,
    }
}

fn render_plain_text(
    agent_id: &AgentId,
    verdict: &str,
    sections: &[AgentEnvironmentDiagnosticSectionView],
    generated_at: &str,
    app_path: &[PathBuf],
) -> String {
    let mut lines = vec![
        "===== VibeX Agent environment diagnostics =====".to_string(),
        format!("agent: {agent_id}"),
        format!("verdict: {verdict}"),
        format!("generated_at: {generated_at}"),
    ];
    for section in sections {
        lines.push(String::new());
        lines.push(format!("[{}]", section.id));
        lines.extend(
            section
                .checks
                .iter()
                .map(|check| format!("{} [{:?}]: {}", check.id, check.level, check.value)),
        );
    }
    lines.push(String::new());
    lines.push("[app PATH]".to_string());
    lines.extend(app_path.iter().map(|path| path.display().to_string()));
    let mut report = lines.join("\n");
    const MAX_REPORT_BYTES: usize = 128 * 1024;
    if report.len() > MAX_REPORT_BYTES {
        let mut boundary = MAX_REPORT_BYTES;
        while boundary > 0 && !report.is_char_boundary(boundary) {
            boundary -= 1;
        }
        report.truncate(boundary);
        report.push_str("\n[report truncated]");
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copied_diagnostics_include_only_declared_checks_and_path() {
        let agent_id = AgentId::parse("codex").unwrap();
        let sections = vec![section(
            "runtime",
            "agents.environmentDiagnosticRuntime",
            vec![check(
                "shell",
                "agents.environmentDiagnosticShell",
                "/bin/zsh".to_string(),
                AgentEnvironmentDiagnosticLevel::Info,
                None,
            )],
        )];
        let report = render_plain_text(
            &agent_id,
            "ok",
            &sections,
            "2026-08-05T00:00:00Z",
            &[PathBuf::from("/usr/bin")],
        );
        assert!(report.contains("agent: codex"));
        assert!(report.contains("shell [Info]: /bin/zsh"));
        assert!(report.contains("/usr/bin"));
        assert!(!report.contains("API_KEY"));
    }
}
