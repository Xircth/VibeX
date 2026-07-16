//! Plugins: "Skill + Web console" integrations (dashi-ppt, vibe-motion, …).
//!
//! A plugin is a manifest: an agent-skill install command, a web-console
//! start command, and a hook message the frontend prefills into the session
//! composer. The unified activation contract is agent-driven: VibeX never
//! starts the console itself. `plugin_activate` allocates a port and renders
//! the command/URL templates so the hook can hand the agent an exact port and
//! address; the agent starts the console, and the frontend polls
//! `plugin_probe_console` until the agreed URL is reachable, then opens it in
//! the Web Preview.

use chrono::Utc;
use db::models::plugin::{Plugin, PluginInput};
use serde::Serialize;
use ts_rs::TS;
use utils::shell::{get_shell_command, resolve_executable_path};
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

/// Skill installs run headless; a hung interactive prompt must not wedge the
/// command forever.
const INSTALL_TIMEOUT_SECS: u64 = 300;

/// One reachability probe must stay well under the frontend's poll interval.
const PROBE_TIMEOUT_MS: u64 = 1_500;

const PORT_PLACEHOLDER: &str = "{{port}}";

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct PluginActivation {
    /// Console start command with `{{port}}` resolved — information for the
    /// agent (via the hook), never executed by VibeX.
    pub console_command: String,
    /// Console URL with `{{port}}` resolved; None when the plugin has no URL
    /// configured (the preview then cannot auto-open).
    pub console_url: Option<String>,
    /// The allocated port, when any template used `{{port}}`.
    pub port: Option<u16>,
}

fn validate_input(input: &PluginInput) -> Result<(), AppError> {
    let required = [
        ("name", &input.name),
        ("skill name", &input.skill_name),
        ("console command", &input.console_command),
        ("hook message", &input.hook_message),
        ("install command", &input.install_command),
    ];
    for (label, value) in required {
        if value.trim().is_empty() {
            return Err(AppError::BadRequest(format!("plugin {label} is required")));
        }
    }
    Ok(())
}

// ── CRUD commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn plugin_list(state: tauri::State<'_, AppState>) -> Result<Vec<Plugin>, AppError> {
    Plugin::list(&state.deployment.db().pool)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn plugin_create(
    state: tauri::State<'_, AppState>,
    input: PluginInput,
) -> Result<Plugin, AppError> {
    validate_input(&input)?;
    Plugin::create(&state.deployment.db().pool, Uuid::new_v4(), &input)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn plugin_update(
    state: tauri::State<'_, AppState>,
    id: Uuid,
    input: PluginInput,
) -> Result<Plugin, AppError> {
    validate_input(&input)?;
    Plugin::update(&state.deployment.db().pool, id, &input)
        .await
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn plugin_delete(state: tauri::State<'_, AppState>, id: Uuid) -> Result<(), AppError> {
    let pool = &state.deployment.db().pool;
    let Some(plugin) = Plugin::find_by_id(pool, id).await? else {
        return Ok(());
    };
    if plugin.builtin {
        return Err(AppError::BadRequest(
            "builtin plugins cannot be deleted; disable them instead".to_string(),
        ));
    }
    Plugin::delete(pool, id).await.map_err(AppError::from)
}

/// Enable/disable a plugin. Only enabled plugins appear in the workspace
/// sidebar; enabling a built-in preset counts as configuring it (the
/// frontend follows up with the skill install).
#[tauri::command]
pub async fn plugin_set_enabled(
    state: tauri::State<'_, AppState>,
    id: Uuid,
    enabled: bool,
) -> Result<Plugin, AppError> {
    let pool = &state.deployment.db().pool;
    if Plugin::find_by_id(pool, id).await?.is_none() {
        return Err(AppError::NotFound(format!("plugin {id} not found")));
    }
    Plugin::set_enabled(pool, id, enabled).await?;
    Plugin::find_by_id(pool, id)
        .await?
        .ok_or_else(|| AppError::Internal("plugin vanished during toggle".to_string()))
}

// ── Built-in presets ───────────────────────────────────────────────────────

const BUILTIN_AUTHOR: &str = "VibeX 内置";

/// Built-in presets reuse the dev-kit example manifests as their single
/// source of truth; fixed ids keep the seeding idempotent across launches.
const BUILTIN_PLUGINS: &[(&str, &str)] = &[
    (
        "3f8e2b10-7c44-4c5e-9a11-d2af01000001",
        include_str!("plugin_devkit/examples/dashi-ppt.vibex-plugin.json"),
    ),
    (
        "3f8e2b10-7c44-4c5e-9a11-d2af01000002",
        include_str!("plugin_devkit/examples/vibe-motion.vibex-plugin.json"),
    ),
    (
        "3f8e2b10-7c44-4c5e-9a11-d2af01000003",
        include_str!("plugin_devkit/examples/understand-anything.vibex-plugin.json"),
    ),
];

/// Seed the built-in plugin presets (disabled) on startup. Existing rows —
/// including user-edited ones — are never overwritten.
pub async fn ensure_builtin_plugins(pool: &sqlx::SqlitePool) -> Result<(), AppError> {
    for (id, manifest) in BUILTIN_PLUGINS {
        let mut input: PluginInput = serde_json::from_str(manifest).map_err(|error| {
            AppError::Internal(format!("builtin plugin manifest invalid: {error}"))
        })?;
        input.author = Some(BUILTIN_AUTHOR.to_string());
        let id = Uuid::parse_str(id)
            .map_err(|error| AppError::Internal(format!("builtin plugin id invalid: {error}")))?;
        if Plugin::insert_builtin_if_missing(pool, id, &input).await? {
            tracing::info!("seeded builtin plugin {}", input.name);
        }
    }
    Ok(())
}

// ── Development kit ────────────────────────────────────────────────────────

const DEV_KIT_DIR_NAME: &str = "vibex-plugin-devkit";

/// The dev kit ships inside the binary: docs + packaging skill + example
/// manifests + the standalone usability test program.
const DEV_KIT_FILES: &[(&str, &str)] = &[
    ("README.md", include_str!("plugin_devkit/README.md")),
    (
        "skills/vibex-plugin-packager/SKILL.md",
        include_str!("plugin_devkit/SKILL.md"),
    ),
    (
        "skills/vibex-plugin-packager/references/plugin-spec.md",
        include_str!("plugin_devkit/plugin-spec.md"),
    ),
    (
        "skills/vibex-plugin-packager/references/examples/dashi-ppt.vibex-plugin.json",
        include_str!("plugin_devkit/examples/dashi-ppt.vibex-plugin.json"),
    ),
    (
        "skills/vibex-plugin-packager/references/examples/vibe-motion.vibex-plugin.json",
        include_str!("plugin_devkit/examples/vibe-motion.vibex-plugin.json"),
    ),
    (
        "skills/vibex-plugin-packager/references/examples/understand-anything.vibex-plugin.json",
        include_str!("plugin_devkit/examples/understand-anything.vibex-plugin.json"),
    ),
    (
        "test/test-plugin.mjs",
        include_str!("plugin_devkit/test-plugin.mjs"),
    ),
];

fn write_dev_kit(target_dir: &std::path::Path) -> Result<std::path::PathBuf, AppError> {
    if !target_dir.is_dir() {
        return Err(AppError::BadRequest(format!(
            "target directory does not exist: {}",
            target_dir.display()
        )));
    }
    let kit_root = target_dir.join(DEV_KIT_DIR_NAME);
    for (relative_path, content) in DEV_KIT_FILES {
        let path = kit_root.join(relative_path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                AppError::Internal(format!("failed to create {}: {error}", parent.display()))
            })?;
        }
        std::fs::write(&path, content).map_err(|error| {
            AppError::Internal(format!("failed to write {}: {error}", path.display()))
        })?;
    }
    Ok(kit_root)
}

/// Write the plugin development kit into the chosen directory and return the
/// kit root path.
#[tauri::command]
pub async fn plugin_download_dev_kit(target_dir: String) -> Result<String, AppError> {
    let kit_root = write_dev_kit(std::path::Path::new(&target_dir))?;
    Ok(kit_root.to_string_lossy().into_owned())
}

// ── Skill installation ─────────────────────────────────────────────────────

/// `skills add` prompts for confirmation; force non-interactive runs. Other
/// installers (e.g. `npx dashi-ppt-skill@latest`) already run unattended and
/// may not accept `-y`, so leave them untouched.
fn with_auto_yes(command: &str) -> String {
    let has_yes = command
        .split_whitespace()
        .any(|token| token == "-y" || token == "--yes");
    if command.contains("skills add") && !has_yes {
        format!("{command} -y")
    } else {
        command.to_string()
    }
}

async fn run_skill_install(install_command: &str) -> Result<(), String> {
    for tool in ["node", "npx"] {
        if resolve_executable_path(tool).await.is_none() {
            return Err(format!("`{tool}` was not found on PATH"));
        }
    }

    let command = with_auto_yes(install_command);
    let (shell_cmd, shell_arg) = get_shell_command();
    let mut install = utils::process::new_hidden_tokio_command(&shell_cmd, [shell_arg, &command]);
    install.stdin(std::process::Stdio::null());

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(INSTALL_TIMEOUT_SECS),
        install.output(),
    )
    .await
    .map_err(|_| format!("install command timed out after {INSTALL_TIMEOUT_SECS}s"))?
    .map_err(|error| format!("failed to run install command: {error}"))?;

    if output.status.success() {
        return Ok(());
    }
    Err(utils::process::command_output_detail(&output)
        .unwrap_or_else(|| format!("install command exited with status {}", output.status)))
}

/// Check node/npx and run the plugin's skill install command globally.
/// The outcome is persisted on the plugin row and returned; an install
/// failure is data, not an error (the frontend toasts it).
#[tauri::command]
pub async fn plugin_install_skill(
    state: tauri::State<'_, AppState>,
    id: Uuid,
) -> Result<Plugin, AppError> {
    let pool = &state.deployment.db().pool;
    let plugin = Plugin::find_by_id(pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("plugin {id} not found")))?;

    Plugin::set_install_status(pool, id, "installing", None).await?;
    let result = run_skill_install(&plugin.install_command).await;
    match &result {
        Ok(()) => Plugin::set_install_status(pool, id, "installed", None).await?,
        Err(error) => Plugin::set_install_status(pool, id, "failed", Some(error)).await?,
    }

    Plugin::find_by_id(pool, id)
        .await?
        .ok_or_else(|| AppError::Internal("plugin vanished during install".to_string()))
}

// ── Activation (agent-driven console) ──────────────────────────────────────

fn allocate_free_port() -> Result<u16, AppError> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| AppError::Internal(format!("failed to allocate a free port: {error}")))?;
    let port = listener
        .local_addr()
        .map_err(|error| AppError::Internal(format!("failed to read allocated port: {error}")))?
        .port();
    Ok(port)
}

/// Resolve the `{{port}}` placeholder in the console command and URL
/// template. A port is only allocated when some template actually uses the
/// placeholder (`force_port` covers the hook message), and all templates
/// then agree on it.
fn resolve_console_templates(
    console_command: &str,
    console_url: Option<&str>,
    force_port: bool,
) -> Result<(String, Option<String>, Option<u16>), AppError> {
    let needs_port = force_port
        || console_command.contains(PORT_PLACEHOLDER)
        || console_url.is_some_and(|url| url.contains(PORT_PLACEHOLDER));
    if !needs_port {
        return Ok((
            console_command.to_string(),
            console_url.map(str::to_string),
            None,
        ));
    }
    let port = allocate_free_port()?;
    let port_text = port.to_string();
    Ok((
        console_command.replace(PORT_PLACEHOLDER, &port_text),
        console_url.map(|url| url.replace(PORT_PLACEHOLDER, &port_text)),
        Some(port),
    ))
}

/// Prepare a plugin activation: allocate a port and render the console
/// command/URL the hook hands to the agent. No process is started.
#[tauri::command]
pub async fn plugin_activate(
    state: tauri::State<'_, AppState>,
    id: Uuid,
) -> Result<PluginActivation, AppError> {
    let plugin = Plugin::find_by_id(&state.deployment.db().pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("plugin {id} not found")))?;
    if plugin.is_expired(Utc::now()) {
        return Err(AppError::BadRequest(format!(
            "plugin {} has expired",
            plugin.name
        )));
    }

    let (console_command, console_url, port) = resolve_console_templates(
        &plugin.console_command,
        plugin.console_url.as_deref(),
        plugin.hook_message.contains(PORT_PLACEHOLDER),
    )?;

    Ok(PluginActivation {
        console_command,
        console_url,
        port,
    })
}

/// TCP-probe the agent-started console. A plain connect (no HTTP) keeps the
/// check protocol-agnostic and avoids webview mixed-content restrictions.
#[tauri::command]
pub async fn plugin_probe_console(url: String) -> Result<bool, AppError> {
    let parsed = url::Url::parse(&url)
        .map_err(|error| AppError::BadRequest(format!("invalid console url: {error}")))?;
    let Some(host) = parsed.host_str() else {
        return Err(AppError::BadRequest("console url has no host".to_string()));
    };
    let Some(port) = parsed.port_or_known_default() else {
        return Err(AppError::BadRequest("console url has no port".to_string()));
    };

    let connect = tokio::net::TcpStream::connect((host.to_string(), port));
    Ok(
        tokio::time::timeout(std::time::Duration::from_millis(PROBE_TIMEOUT_MS), connect)
            .await
            .map(|result| result.is_ok())
            .unwrap_or(false),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_yes_only_touches_skills_add() {
        assert_eq!(
            with_auto_yes("npx skills add vibe-motion/skills"),
            "npx skills add vibe-motion/skills -y"
        );
        // Already non-interactive: left alone.
        assert_eq!(
            with_auto_yes("npx skills add foo/bar -y"),
            "npx skills add foo/bar -y"
        );
        assert_eq!(
            with_auto_yes("npx skills add foo/bar --yes"),
            "npx skills add foo/bar --yes"
        );
        // Not the skills CLI: never mutated.
        assert_eq!(
            with_auto_yes("npx dashi-ppt-skill@latest"),
            "npx dashi-ppt-skill@latest"
        );
    }

    #[test]
    fn port_placeholder_resolves_consistently() {
        let (command, resolved_url, port) = resolve_console_templates(
            "serve --port {{port}}",
            Some("http://127.0.0.1:{{port}}/"),
            false,
        )
        .expect("resolve");
        let port = port.expect("port allocated");
        // Command and URL must agree on the allocated port.
        assert_eq!(command, format!("serve --port {port}"));
        assert_eq!(resolved_url, Some(format!("http://127.0.0.1:{port}/")));

        // No placeholder → templates pass through untouched, no port burned.
        let (command, resolved_url, port) =
            resolve_console_templates("pnpm dev", Some("http://localhost:3000"), false)
                .expect("resolve");
        assert_eq!(command, "pnpm dev");
        assert_eq!(resolved_url, Some("http://localhost:3000".to_string()));
        assert_eq!(port, None);

        let (_, resolved_url, _) =
            resolve_console_templates("pnpm dev", None, false).expect("resolve");
        assert_eq!(resolved_url, None);

        // Hook-only {{port}} usage still forces an allocation.
        let (_, _, port) = resolve_console_templates("pnpm dev", None, true).expect("resolve");
        assert!(port.is_some());
    }

    #[tokio::test]
    async fn probe_detects_listening_and_closed_ports() {
        // A live listener probes true.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        assert!(
            plugin_probe_console(format!("http://127.0.0.1:{port}/x"))
                .await
                .expect("probe live")
        );

        // The same port probes false once the listener is gone.
        drop(listener);
        assert!(
            !plugin_probe_console(format!("http://127.0.0.1:{port}/"))
                .await
                .expect("probe dead")
        );

        // Garbage input is a hard error, not "unreachable".
        assert!(plugin_probe_console("not a url".to_string()).await.is_err());
    }

    /// Seeding must produce exactly the three disabled builtin presets with
    /// the VibeX author label, and stay idempotent across launches.
    #[tokio::test]
    async fn builtin_seeding_is_idempotent_and_labelled() {
        use std::str::FromStr;
        let options = sqlx::sqlite::SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("options")
            .foreign_keys(false);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect");
        sqlx::migrate!("../crates/db/migrations")
            .run(&pool)
            .await
            .expect("migrations");

        ensure_builtin_plugins(&pool).await.expect("seed");
        ensure_builtin_plugins(&pool).await.expect("re-seed");

        let plugins = Plugin::list(&pool).await.expect("list");
        assert_eq!(plugins.len(), BUILTIN_PLUGINS.len());
        for plugin in &plugins {
            assert!(plugin.builtin);
            assert!(!plugin.enabled, "{} must start disabled", plugin.name);
            assert_eq!(plugin.author.as_deref(), Some(BUILTIN_AUTHOR));
        }
    }

    /// The bundled example manifests must always deserialize into the real
    /// `PluginInput` shape and pass the same validation the settings form
    /// enforces — otherwise the dev kit teaches a stale schema.
    #[test]
    fn dev_kit_examples_match_plugin_input_schema() {
        for (relative_path, content) in DEV_KIT_FILES {
            if !relative_path.ends_with(".vibex-plugin.json") {
                continue;
            }
            let input: PluginInput = serde_json::from_str(content)
                .unwrap_or_else(|error| panic!("{relative_path} failed to parse: {error}"));
            validate_input(&input)
                .unwrap_or_else(|error| panic!("{relative_path} failed validation: {error}"));
        }
    }

    #[test]
    fn dev_kit_writes_all_files() {
        let target = std::env::temp_dir().join(format!("vibex-devkit-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&target).expect("create target");
        let kit_root = write_dev_kit(&target).expect("write kit");
        for (relative_path, content) in DEV_KIT_FILES {
            let written = std::fs::read_to_string(kit_root.join(relative_path)).expect("read back");
            assert_eq!(&written, content, "{relative_path} content mismatch");
        }
        // A missing target directory is a hard error, not a silent mkdir.
        assert!(write_dev_kit(&target.join("does-not-exist")).is_err());
        std::fs::remove_dir_all(&target).expect("cleanup");
    }

    #[test]
    fn validate_rejects_blank_required_fields() {
        let input = PluginInput {
            name: "Dashi".to_string(),
            skill_name: "dashi-ppt".to_string(),
            console_command: "npx serve".to_string(),
            console_url: None,
            hook_message: "hook".to_string(),
            install_command: "  ".to_string(),
            author: None,
            icon: None,
            expires_at: None,
            notes: None,
        };
        assert!(validate_input(&input).is_err());
        let valid = PluginInput {
            install_command: "npx skills add x/y".to_string(),
            ..input
        };
        assert!(validate_input(&valid).is_ok());
    }
}
