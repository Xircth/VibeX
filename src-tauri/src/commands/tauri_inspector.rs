use std::{
    fs,
    path::{Path, PathBuf},
};

use db::models::{workspace::Workspace, workspace_repo::WorkspaceRepo};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use crate::{error::AppError, state::AppState};

const REDLINE_DEPENDENCY: &str = "tauri-plugin-redline = \"=0.1.0\"";
const COMPANION_DEPENDENCY: &str =
    "tauri-plugin-vibex-inspector = { path = \"../.vibex/tauri-plugin-vibex-inspector\" }";
const BUILDER_MARKER: &str = "tauri_plugin_vibex_inspector::init()";

const COMPANION_CARGO_TOML: &str = r#"[package]
name = "tauri-plugin-vibex-inspector"
version = "0.1.0"
edition = "2021"
publish = false
links = "tauri-plugin-vibex-inspector"

[lib]
crate-type = ["rlib"]

[dependencies]
tauri = { version = "2", features = [] }
serde_json = "1"

[build-dependencies]
tauri-plugin = { version = "2", features = ["build"] }
"#;

const COMPANION_BUILD_RS: &str = r#"fn main() {
    tauri_plugin::Builder::new(&["submit_capture", "take_control"]).build();
}
"#;

const COMPANION_PERMISSION: &str = r#"[default]
description = "Allow the VibeX development inspector bridge"
permissions = ["allow-submit-capture", "allow-take-control"]
"#;

const COMPANION_LIB_RS: &str = r####"use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{command, plugin::Builder, plugin::TauriPlugin, Runtime};

fn project_root() -> Result<PathBuf, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(|path| path.parent())
        .map(PathBuf::from)
        .ok_or_else(|| "VibeX inspector project root is unavailable".to_string())
}

#[command]
fn submit_capture(json: String) -> Result<(), String> {
    if json.len() > 12 * 1024 * 1024 {
        return Err("Redline capture exceeds the 12 MB limit".to_string());
    }
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|error| format!("Invalid Redline capture: {error}"))?;
    let inbox = project_root()?.join(".vibex/inspector/inbox");
    fs::create_dir_all(&inbox).map_err(|error| error.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    fs::write(inbox.join(format!("{stamp}.json")), json).map_err(|error| error.to_string())
}

#[command]
fn take_control() -> Result<Option<String>, String> {
    let path = project_root()?.join(".vibex/inspector/control");
    if !path.is_file() {
        return Ok(None);
    }
    let command = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    fs::remove_file(path).map_err(|error| error.to_string())?;
    Ok(Some(command.trim().to_string()))
}

const BRIDGE_SCRIPT: &str = r#"
(function () {
  if (window.__vibexInspectorBridge) return;
  window.__vibexInspectorBridge = true;
  var invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!invoke) return;

  var blobs = new Map();
  var createObjectURL = URL.createObjectURL.bind(URL);
  var revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    var url = createObjectURL(blob);
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    window.setTimeout(function () { blobs.delete(url); }, 2000);
    return revokeObjectURL(url);
  };

  var anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var blob = blobs.get(this.href);
    if (
      blob &&
      blob.type === 'application/json' &&
      typeof this.download === 'string' &&
      this.download.endsWith('.json')
    ) {
      blob.text().then(function (text) {
        try {
          var value = JSON.parse(text);
          if (Array.isArray(value.annotations)) {
            invoke('plugin:vibex-inspector|submit_capture', { json: text });
          }
        } catch (_) {}
      });
    }
    return anchorClick.call(this);
  };

  window.setInterval(function () {
    invoke('plugin:vibex-inspector|take_control').then(function (command) {
      if (command === 'activate' && window.__redline_activate) {
        window.__redline_activate();
      } else if (command === 'deactivate' && window.__redline_deactivate) {
        window.__redline_deactivate();
      }
    }).catch(function () {});
  }, 400);
})();
"#;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("vibex-inspector")
        .js_init_script(BRIDGE_SCRIPT.to_string())
        .invoke_handler(tauri::generate_handler![submit_capture, take_control])
        .build()
}
"####;

const THIRD_PARTY_NOTICE: &str = r#"# Third-party notice

This development integration uses `tauri-plugin-redline` 0.1 from
https://github.com/twiced-technology-gmbh/redline-plugin-tauri.

Redline is Copyright (c) 2026 Twiced Technology GmbH and licensed under the
MIT License. Its full license is available in the crate package and at:
https://github.com/twiced-technology-gmbh/redline-plugin-tauri/blob/main/LICENSE
"#;

#[derive(Debug, Clone, Serialize)]
pub struct TauriInspectorStatus {
    pub is_tauri: bool,
    pub installed: bool,
    pub project_root: Option<String>,
    pub tauri_dir: Option<String>,
    pub message: String,
}

fn io_error(path: &Path, error: impl std::fmt::Display) -> AppError {
    AppError::Internal(format!("Failed to update {}: {error}", path.display()))
}

fn reject_symlink(path: &Path) -> Result<(), AppError> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(AppError::BadRequest(format!(
            "{} must not be a symbolic link",
            path.display()
        )));
    }
    Ok(())
}

fn find_builder_source(tauri_dir: &Path) -> Option<PathBuf> {
    ["src/lib.rs", "src/main.rs"]
        .into_iter()
        .map(|relative| tauri_dir.join(relative))
        .find(|path| fs::read_to_string(path).is_ok_and(|source| source.contains("tauri::Builder")))
}

fn inspect_project_root(project_root: &Path) -> Result<TauriInspectorStatus, AppError> {
    let tauri_dir = project_root.join("src-tauri");
    let cargo_path = tauri_dir.join("Cargo.toml");
    let config_exists = [
        "tauri.conf.json",
        "tauri.conf.json5",
        "Tauri.toml",
        "tauri.conf.toml",
    ]
    .into_iter()
    .any(|name| tauri_dir.join(name).is_file());

    if !cargo_path.is_file() || !config_exists {
        return Ok(TauriInspectorStatus {
            is_tauri: false,
            installed: false,
            project_root: Some(project_root.to_string_lossy().to_string()),
            tauri_dir: None,
            message: "No standard Tauri v2 source project was found".to_string(),
        });
    }

    let cargo = fs::read_to_string(&cargo_path).map_err(|error| io_error(&cargo_path, error))?;
    let is_tauri = cargo.contains("tauri =") || cargo.contains("tauri=");
    let builder_installed = find_builder_source(&tauri_dir)
        .and_then(|path| fs::read_to_string(path).ok())
        .is_some_and(|source| source.contains(BUILDER_MARKER));
    let installed = cargo.contains("tauri-plugin-redline")
        && cargo.contains("tauri-plugin-vibex-inspector")
        && builder_installed
        && project_root
            .join(".vibex/tauri-plugin-vibex-inspector/Cargo.toml")
            .is_file();

    Ok(TauriInspectorStatus {
        is_tauri,
        installed,
        project_root: Some(project_root.to_string_lossy().to_string()),
        tauri_dir: Some("src-tauri".to_string()),
        message: if installed {
            "VibeX Tauri inspector is installed".to_string()
        } else if is_tauri {
            "Tauri v2 project detected; inspector setup is available".to_string()
        } else {
            "The src-tauri manifest does not use Tauri v2".to_string()
        },
    })
}

fn patch_cargo_manifest(source: &str) -> Result<String, AppError> {
    let has_redline = source.contains("tauri-plugin-redline");
    let has_companion = source.contains("tauri-plugin-vibex-inspector");
    if has_redline && has_companion {
        return Ok(source.to_string());
    }
    let dependencies = source.find("[dependencies]").ok_or_else(|| {
        AppError::BadRequest("src-tauri/Cargo.toml has no [dependencies] table".into())
    })?;
    let insert_at = source[dependencies..]
        .find('\n')
        .map(|offset| dependencies + offset + 1)
        .unwrap_or(source.len());
    let mut additions = String::new();
    if !has_redline {
        additions.push_str(REDLINE_DEPENDENCY);
        additions.push('\n');
    }
    if !has_companion {
        additions.push_str(COMPANION_DEPENDENCY);
        additions.push('\n');
    }
    let mut output = source.to_string();
    output.insert_str(insert_at, &additions);
    Ok(output)
}

fn patch_builder_source(source: &str) -> Result<String, AppError> {
    if source.contains(BUILDER_MARKER) {
        return Ok(source.to_string());
    }
    let marker = "tauri::Builder::default()";
    if !source.contains(marker) {
        return Err(AppError::BadRequest(
            "Could not find `tauri::Builder::default()`; register Redline manually for this custom Builder"
                .into(),
        ));
    }
    let replacement = r#"{
        let mut builder = tauri::Builder::default();
        if cfg!(debug_assertions) {
            builder = builder
                .plugin(tauri_plugin_redline::init())
                .plugin(tauri_plugin_vibex_inspector::init());
        }
        builder
    }"#;
    Ok(source.replacen(marker, replacement, 1))
}

fn patch_capability(path: &Path) -> Result<(), AppError> {
    let source = fs::read_to_string(path).map_err(|error| io_error(path, error))?;
    let mut document: Value =
        serde_json::from_str(&source).map_err(|error| io_error(path, error))?;
    let permissions = document
        .get_mut("permissions")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            AppError::BadRequest(format!("{} has no JSON permissions array", path.display()))
        })?;
    for permission in ["redline:default", "vibex-inspector:default"] {
        if !permissions
            .iter()
            .any(|value| value.as_str() == Some(permission))
        {
            permissions.push(Value::String(permission.to_string()));
        }
    }
    let output = serde_json::to_string_pretty(&document).map_err(|error| io_error(path, error))?;
    fs::write(path, format!("{output}\n")).map_err(|error| io_error(path, error))
}

fn install_companion(project_root: &Path) -> Result<(), AppError> {
    reject_symlink(&project_root.join(".vibex"))?;
    let plugin_root = project_root.join(".vibex/tauri-plugin-vibex-inspector");
    for (relative, contents) in [
        ("Cargo.toml", COMPANION_CARGO_TOML),
        ("build.rs", COMPANION_BUILD_RS),
        ("permissions/default.toml", COMPANION_PERMISSION),
        ("src/lib.rs", COMPANION_LIB_RS),
        ("THIRD_PARTY_NOTICES.md", THIRD_PARTY_NOTICE),
    ] {
        let path = plugin_root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
        }
        fs::write(&path, contents).map_err(|error| io_error(&path, error))?;
    }
    let runtime_ignore = project_root.join(".vibex/.gitignore");
    if !runtime_ignore.exists() {
        fs::write(&runtime_ignore, "inspector/\n")
            .map_err(|error| io_error(&runtime_ignore, error))?;
    }
    Ok(())
}

fn install_project_root(project_root: &Path) -> Result<TauriInspectorStatus, AppError> {
    let status = inspect_project_root(project_root)?;
    if !status.is_tauri {
        return Err(AppError::BadRequest(status.message));
    }
    if status.installed {
        return Ok(status);
    }

    let tauri_dir = project_root.join("src-tauri");
    let cargo_path = tauri_dir.join("Cargo.toml");
    let cargo = fs::read_to_string(&cargo_path).map_err(|error| io_error(&cargo_path, error))?;
    let patched_cargo = patch_cargo_manifest(&cargo)?;

    let builder_path = find_builder_source(&tauri_dir).ok_or_else(|| {
        AppError::BadRequest("Could not find the Tauri Builder in src-tauri/src".into())
    })?;
    let builder =
        fs::read_to_string(&builder_path).map_err(|error| io_error(&builder_path, error))?;
    let patched_builder = patch_builder_source(&builder)?;

    let capabilities_dir = tauri_dir.join("capabilities");
    let mut capability_paths = if capabilities_dir.is_dir() {
        fs::read_dir(&capabilities_dir)
            .map_err(|error| io_error(&capabilities_dir, error))?
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    capability_paths.sort();
    let capability = capability_paths.first().ok_or_else(|| {
        AppError::BadRequest(
            "No JSON capability file found; add redline:default and vibex-inspector:default manually"
                .into(),
        )
    })?;
    for path in [&cargo_path, &builder_path, capability] {
        reject_symlink(path)?;
    }

    // Finish all compatibility checks before changing the target project.
    let capability_source =
        fs::read_to_string(capability).map_err(|error| io_error(capability, error))?;
    let capability_document: Value =
        serde_json::from_str(&capability_source).map_err(|error| io_error(capability, error))?;
    if !capability_document
        .get("permissions")
        .is_some_and(Value::is_array)
    {
        return Err(AppError::BadRequest(format!(
            "{} has no JSON permissions array",
            capability.display()
        )));
    }

    fs::write(&cargo_path, patched_cargo).map_err(|error| io_error(&cargo_path, error))?;
    fs::write(&builder_path, patched_builder).map_err(|error| io_error(&builder_path, error))?;
    patch_capability(capability)?;
    install_companion(project_root)?;
    inspect_project_root(project_root)
}

async fn workspace_project_roots(
    state: &AppState,
    workspace_id: Uuid,
) -> Result<Vec<PathBuf>, AppError> {
    let pool = &state.deployment.db().pool;
    let mut workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id} not found")))?;
    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;
    workspace.container_ref = Some(container_ref.clone());
    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    if repos.is_empty() {
        return Ok(vec![PathBuf::from(container_ref)]);
    }
    Ok(repos
        .iter()
        .map(|repo| {
            workspace
                .repo_path(repo)
                .unwrap_or_else(|| PathBuf::from(&container_ref).join(&repo.name))
        })
        .collect())
}

async fn find_tauri_project_root(
    state: &AppState,
    workspace_id: Uuid,
) -> Result<(PathBuf, TauriInspectorStatus), AppError> {
    let roots = workspace_project_roots(state, workspace_id).await?;
    for root in &roots {
        let status = inspect_project_root(root)?;
        if status.is_tauri {
            return Ok((root.clone(), status));
        }
    }
    let root = roots
        .into_iter()
        .next()
        .ok_or_else(|| AppError::NotFound("Workspace has no source root".into()))?;
    let status = inspect_project_root(&root)?;
    Ok((root, status))
}

#[tauri::command]
pub async fn get_tauri_inspector_status(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<TauriInspectorStatus, AppError> {
    let (_, status) = find_tauri_project_root(&state, workspace_id).await?;
    Ok(status)
}

#[tauri::command]
pub async fn install_tauri_inspector(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<TauriInspectorStatus, AppError> {
    let (root, _) = find_tauri_project_root(&state, workspace_id).await?;
    install_project_root(&root)
}

#[tauri::command]
pub async fn control_tauri_inspector(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    action: String,
) -> Result<(), AppError> {
    if !matches!(action.as_str(), "activate" | "deactivate") {
        return Err(AppError::BadRequest("Unsupported inspector action".into()));
    }
    let (root, status) = find_tauri_project_root(&state, workspace_id).await?;
    if !status.installed {
        return Err(AppError::BadRequest(
            "Install the Tauri inspector before activating it".into(),
        ));
    }
    let inspector_dir = root.join(".vibex/inspector");
    reject_symlink(&root.join(".vibex"))?;
    reject_symlink(&inspector_dir)?;
    fs::create_dir_all(&inspector_dir).map_err(|error| io_error(&inspector_dir, error))?;
    let canonical_root = fs::canonicalize(&root).map_err(|error| io_error(&root, error))?;
    let canonical_inspector =
        fs::canonicalize(&inspector_dir).map_err(|error| io_error(&inspector_dir, error))?;
    if !canonical_inspector.starts_with(canonical_root) {
        return Err(AppError::BadRequest(
            "Inspector control directory must stay inside the workspace".into(),
        ));
    }
    let control = inspector_dir.join("control");
    fs::write(&control, action).map_err(|error| io_error(&control, error))
}

#[tauri::command]
pub async fn take_tauri_inspector_capture(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Option<Value>, AppError> {
    let (root, status) = find_tauri_project_root(&state, workspace_id).await?;
    if !status.installed {
        return Ok(None);
    }
    let inbox = root.join(".vibex/inspector/inbox");
    if !inbox.is_dir() {
        return Ok(None);
    }
    let canonical_root = fs::canonicalize(&root).map_err(|error| io_error(&root, error))?;
    let canonical_inbox = fs::canonicalize(&inbox).map_err(|error| io_error(&inbox, error))?;
    if !canonical_inbox.starts_with(&canonical_root) {
        return Err(AppError::BadRequest(
            "Inspector inbox must stay inside the workspace".into(),
        ));
    }
    let mut captures = fs::read_dir(&canonical_inbox)
        .map_err(|error| io_error(&canonical_inbox, error))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    captures.sort();
    let Some(path) = captures.first() else {
        return Ok(None);
    };
    let metadata = fs::metadata(path).map_err(|error| io_error(path, error))?;
    if metadata.len() > 12 * 1024 * 1024 {
        fs::remove_file(path).map_err(|error| io_error(path, error))?;
        return Err(AppError::BadRequest(
            "Redline capture exceeds the 12 MB limit".into(),
        ));
    }
    let source = fs::read_to_string(path).map_err(|error| io_error(path, error))?;
    let capture = match serde_json::from_str(&source) {
        Ok(capture) => capture,
        Err(error) => {
            fs::remove_file(path).map_err(|remove_error| io_error(path, remove_error))?;
            return Err(io_error(path, error));
        }
    };
    fs::remove_file(path).map_err(|error| io_error(path, error))?;
    Ok(Some(capture))
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path};

    use tempfile::tempdir;

    use super::{
        inspect_project_root, install_project_root, patch_builder_source, patch_cargo_manifest,
    };

    fn standard_tauri_project(root: &Path) {
        let tauri_dir = root.join("src-tauri");
        fs::create_dir_all(tauri_dir.join("src")).unwrap();
        fs::create_dir_all(tauri_dir.join("capabilities")).unwrap();
        fs::write(
            tauri_dir.join("Cargo.toml"),
            "[package]\nname = \"demo\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\
             [dependencies]\ntauri = \"2\"\n",
        )
        .unwrap();
        fs::write(tauri_dir.join("tauri.conf.json"), "{}").unwrap();
        fs::write(
            tauri_dir.join("capabilities/default.json"),
            r#"{"identifier":"default","windows":["main"],"permissions":[]}"#,
        )
        .unwrap();
        fs::write(
            tauri_dir.join("src/lib.rs"),
            "pub fn run() {\n  tauri::Builder::default()\n    .run(tauri::generate_context!())\n    .unwrap();\n}\n",
        )
        .unwrap();
    }

    #[test]
    fn detects_a_tauri_v2_project_before_installation() {
        let temp = tempdir().unwrap();
        standard_tauri_project(temp.path());

        let status = inspect_project_root(temp.path()).unwrap();

        assert!(status.is_tauri);
        assert!(!status.installed);
        assert_eq!(status.tauri_dir.as_deref(), Some("src-tauri"));
    }

    #[test]
    fn cargo_patch_adds_redline_and_companion_once() {
        let source = "[package]\nname = \"demo\"\n\n[dependencies]\ntauri = \"2\"\n";
        let once = patch_cargo_manifest(source).unwrap();
        let twice = patch_cargo_manifest(&once).unwrap();

        assert!(once.contains("tauri-plugin-redline = \"=0.1.0\""));
        assert!(once.contains("tauri-plugin-vibex-inspector"));
        assert_eq!(once, twice);
    }

    #[test]
    fn builder_patch_keeps_inspector_debug_only_and_is_idempotent() {
        let source = "pub fn run() {\n  tauri::Builder::default()\n    .run(tauri::generate_context!())\n    .unwrap();\n}\n";
        let once = patch_builder_source(source).unwrap();
        let twice = patch_builder_source(&once).unwrap();

        assert!(once.contains("if cfg!(debug_assertions)"));
        assert!(once.contains("tauri_plugin_redline::init()"));
        assert!(once.contains("tauri_plugin_vibex_inspector::init()"));
        assert_eq!(once, twice);
    }

    #[test]
    fn installs_the_bridge_and_capabilities_into_a_standard_project() {
        let temp = tempdir().unwrap();
        standard_tauri_project(temp.path());

        let status = install_project_root(temp.path()).unwrap();
        let capability =
            fs::read_to_string(temp.path().join("src-tauri/capabilities/default.json")).unwrap();

        assert!(status.installed);
        assert!(
            temp.path()
                .join(".vibex/tauri-plugin-vibex-inspector/src/lib.rs")
                .is_file()
        );
        assert!(capability.contains("redline:default"));
        assert!(capability.contains("vibex-inspector:default"));
        assert_eq!(
            fs::read_to_string(temp.path().join(".vibex/.gitignore")).unwrap(),
            "inspector/\n"
        );
    }
}
