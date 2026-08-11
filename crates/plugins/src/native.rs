use std::{
    fs,
    path::{Path, PathBuf},
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ConflictDecision, PluginError, PluginSourceKind};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeEcosystem {
    Codex,
    ClaudeCode,
}

impl NativeEcosystem {
    fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::ClaudeCode => "Claude Code",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeAdapterCapabilities {
    pub discover: bool,
    pub install: bool,
    pub enable: bool,
    pub update: bool,
    pub uninstall: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePluginDescriptor {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub ecosystem: NativeEcosystem,
    pub path: PathBuf,
    pub enabled: Option<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativePluginImportCommand {
    pub args: Vec<String>,
    pub display: String,
}

pub fn parse_official_plugin_import_commands(
    ecosystem: NativeEcosystem,
    input: &str,
) -> Result<Vec<NativePluginImportCommand>, PluginError> {
    if input.len() > 16 * 1024 {
        return Err(PluginError::native_command_rejected(
            "command input exceeds 16 KiB",
        ));
    }
    let expected_program = match ecosystem {
        NativeEcosystem::Codex => "codex",
        NativeEcosystem::ClaudeCode => "claude",
    };
    let mut commands = Vec::new();
    for line in input.lines().map(str::trim).filter(|line| !line.is_empty()) {
        let tokens = shlex::split(line).ok_or_else(|| {
            PluginError::native_command_rejected("command contains an unterminated quote")
        })?;
        let Some((program, args)) = tokens.split_first() else {
            continue;
        };
        if program != expected_program {
            return Err(PluginError::native_command_rejected(format!(
                "expected `{expected_program}` but received `{program}`"
            )));
        }
        if args.iter().any(|argument| {
            matches!(
                argument.as_str(),
                ";" | "&&" | "||" | "|" | ">" | ">>" | "<"
            )
        }) {
            return Err(PluginError::native_command_rejected(
                "shell operators are not supported",
            ));
        }
        let supported = match ecosystem {
            NativeEcosystem::Codex => {
                matches!(args, [plugin, action, ..] if plugin == "plugin" && action == "add")
                    || matches!(
                        args,
                        [plugin, marketplace, action, ..]
                            if plugin == "plugin"
                                && marketplace == "marketplace"
                                && action == "add"
                    )
            }
            NativeEcosystem::ClaudeCode => {
                matches!(
                    args,
                    [plugin, action, ..]
                        if plugin == "plugin" && action == "install"
                ) || matches!(
                    args,
                    [plugin, marketplace, action, ..]
                        if plugin == "plugin"
                            && marketplace == "marketplace"
                            && action == "add"
                )
            }
        };
        if !supported {
            return Err(PluginError::native_command_rejected(format!(
                "`{line}` is not a supported plugin import command"
            )));
        }
        commands.push(NativePluginImportCommand {
            args: args.to_vec(),
            display: line.to_owned(),
        });
        if commands.len() > 8 {
            return Err(PluginError::native_command_rejected(
                "at most 8 commands may be run at once",
            ));
        }
    }
    if commands.is_empty() {
        return Err(PluginError::native_command_rejected(
            "enter at least one official plugin import command",
        ));
    }
    Ok(commands)
}

#[async_trait]
pub trait NativePluginAdapter: Send + Sync {
    fn ecosystem(&self) -> NativeEcosystem;
    fn capabilities(&self) -> NativeAdapterCapabilities;
    async fn discover(&self) -> Result<Vec<NativePluginDescriptor>, PluginError>;
    async fn install(
        &self,
        source: &Path,
        source_kind: PluginSourceKind,
        decision: ConflictDecision,
    ) -> Result<NativePluginDescriptor, PluginError>;
    async fn set_enabled(&self, plugin_id: &str, enabled: bool) -> Result<(), PluginError>;
    async fn update(&self, plugin_id: &str) -> Result<(), PluginError>;
    async fn uninstall(&self, plugin_id: &str) -> Result<(), PluginError>;
}

pub struct FilesystemNativePluginAdapter {
    ecosystem: NativeEcosystem,
    root: PathBuf,
    manifest_path: &'static str,
    mutable: bool,
}

impl FilesystemNativePluginAdapter {
    pub fn codex(root: impl Into<PathBuf>) -> Self {
        Self {
            ecosystem: NativeEcosystem::Codex,
            root: root.into(),
            manifest_path: ".codex-plugin/plugin.json",
            mutable: true,
        }
    }

    pub fn claude_code(root: impl Into<PathBuf>) -> Self {
        Self {
            ecosystem: NativeEcosystem::ClaudeCode,
            root: root.into(),
            manifest_path: ".claude-plugin/plugin.json",
            mutable: true,
        }
    }

    pub fn read_only(mut self) -> Self {
        self.mutable = false;
        self
    }

    pub fn inspect_source(&self, source: &Path) -> Result<NativePluginDescriptor, PluginError> {
        self.descriptor(source)
    }

    fn descriptor(&self, root: &Path) -> Result<NativePluginDescriptor, PluginError> {
        let manifest_path = root.join(self.manifest_path);
        let manifest_text = fs::read_to_string(&manifest_path).map_err(|error| {
            PluginError::io(
                &format!("read native plugin manifest `{}`", manifest_path.display()),
                error,
            )
        })?;
        let manifest: Value = serde_json::from_str(&manifest_text)
            .map_err(|error| PluginError::invalid_manifest(error.to_string()))?;
        let object = manifest.as_object().ok_or_else(|| {
            PluginError::invalid_manifest("native plugin manifest must be a JSON object")
        })?;
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| PluginError::invalid_manifest("native plugin requires `name`"))?
            .to_owned();
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or(&name)
            .to_owned();
        validate_native_id(&id)?;
        let version = object
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_owned);
        Ok(NativePluginDescriptor {
            id,
            name,
            version,
            ecosystem: self.ecosystem,
            path: root.canonicalize().map_err(|error| {
                PluginError::io(
                    &format!("resolve native plugin `{}`", root.display()),
                    error,
                )
            })?,
            // The filesystem is authoritative for membership, but has no stable enable flag.
            enabled: None,
        })
    }

    fn find(&self, plugin_id: &str) -> Result<Option<NativePluginDescriptor>, PluginError> {
        Ok(self
            .discover_sync()?
            .into_iter()
            .find(|plugin| plugin.id == plugin_id))
    }

    fn discover_sync(&self) -> Result<Vec<NativePluginDescriptor>, PluginError> {
        if !self.root.is_dir() {
            return Ok(Vec::new());
        }
        let mut plugins = Vec::new();
        self.discover_directory(&self.root, 0, &mut plugins)?;
        plugins.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
        plugins.dedup_by(|left, right| left.id == right.id && left.path == right.path);
        Ok(plugins)
    }

    fn discover_directory(
        &self,
        directory: &Path,
        depth: usize,
        plugins: &mut Vec<NativePluginDescriptor>,
    ) -> Result<(), PluginError> {
        if depth > 4 {
            return Ok(());
        }
        let entries = fs::read_dir(directory)
            .map_err(|error| PluginError::io("read native plugin directory", error))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| PluginError::io("read native plugin entry", error))?;
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|error| PluginError::io("inspect native plugin entry", error))?;
            if !file_type.is_dir() && !file_type.is_symlink() {
                continue;
            }
            if path.join(self.manifest_path).is_file() {
                if let Ok(plugin) = self.descriptor(&path) {
                    plugins.push(plugin);
                }
                continue;
            }
            if file_type.is_dir() {
                self.discover_directory(&path, depth + 1, plugins)?;
            }
        }
        Ok(())
    }
}

#[async_trait]
impl NativePluginAdapter for FilesystemNativePluginAdapter {
    fn ecosystem(&self) -> NativeEcosystem {
        self.ecosystem
    }

    fn capabilities(&self) -> NativeAdapterCapabilities {
        NativeAdapterCapabilities {
            discover: true,
            install: self.mutable,
            enable: false,
            update: false,
            uninstall: self.mutable,
        }
    }

    async fn discover(&self) -> Result<Vec<NativePluginDescriptor>, PluginError> {
        self.discover_sync()
    }

    async fn install(
        &self,
        source: &Path,
        source_kind: PluginSourceKind,
        decision: ConflictDecision,
    ) -> Result<NativePluginDescriptor, PluginError> {
        if !self.mutable {
            return Err(PluginError::native_unsupported(
                self.ecosystem.label(),
                "install",
            ));
        }
        let incoming = self.descriptor(source)?;
        fs::create_dir_all(&self.root)
            .map_err(|error| PluginError::io("create native plugin directory", error))?;
        let target = self.root.join(&incoming.id);
        if let Some(installed) = self.find(&incoming.id)? {
            match decision {
                ConflictDecision::Reject => return Err(PluginError::conflict(&incoming.id)),
                ConflictDecision::KeepInstalled => return Ok(installed),
                ConflictDecision::Replace => remove_path(&target)?,
            }
        } else if target.exists() {
            return Err(PluginError::conflict(&incoming.id));
        }

        match source_kind {
            PluginSourceKind::DeveloperLink => create_directory_link(source, &target)?,
            _ => copy_directory(source, &target)?,
        }
        self.descriptor(&target)
    }

    async fn set_enabled(&self, _plugin_id: &str, _enabled: bool) -> Result<(), PluginError> {
        Err(PluginError::native_unsupported(
            self.ecosystem.label(),
            "enable",
        ))
    }

    async fn update(&self, _plugin_id: &str) -> Result<(), PluginError> {
        Err(PluginError::native_unsupported(
            self.ecosystem.label(),
            "update",
        ))
    }

    async fn uninstall(&self, plugin_id: &str) -> Result<(), PluginError> {
        if !self.mutable {
            return Err(PluginError::native_unsupported(
                self.ecosystem.label(),
                "uninstall",
            ));
        }
        validate_native_id(plugin_id)?;
        let Some(plugin) = self.find(plugin_id)? else {
            return Err(PluginError::not_found(plugin_id));
        };
        let target = self.root.join(plugin_id);
        let _discovered = plugin;
        remove_path(&target)
    }
}

/// Lifecycle adapter backed exclusively by the Agent's official plugin CLI.
///
/// It deliberately does not install from arbitrary filesystem paths: imports
/// remain subject to each CLI's supported package/marketplace contract.
pub struct OfficialCliNativePluginAdapter {
    ecosystem: NativeEcosystem,
    program: PathBuf,
}

impl OfficialCliNativePluginAdapter {
    pub fn codex(program: impl Into<PathBuf>) -> Self {
        Self {
            ecosystem: NativeEcosystem::Codex,
            program: program.into(),
        }
    }

    pub fn claude_code(program: impl Into<PathBuf>) -> Self {
        Self {
            ecosystem: NativeEcosystem::ClaudeCode,
            program: program.into(),
        }
    }

    async fn list_json(&self) -> Result<Value, PluginError> {
        let output =
            utils::process::new_hidden_tokio_command(&self.program, ["plugin", "list", "--json"])
                .output()
                .await
                .map_err(|error| PluginError::io("run official plugin list command", error))?;
        if !output.status.success() {
            return Err(PluginError::native_command_failed(
                self.ecosystem.label(),
                "list",
                command_error(&output),
            ));
        }
        serde_json::from_slice(&output.stdout).map_err(|error| {
            PluginError::native_command_failed(
                self.ecosystem.label(),
                "list",
                format!("invalid JSON output: {error}"),
            )
        })
    }

    fn entries<'a>(&self, value: &'a Value) -> &'a [Value] {
        if let Some(entries) = value.as_array() {
            return entries;
        }
        let object = value.as_object();
        for key in ["installed", "plugins", "installedPlugins"] {
            if let Some(entries) = object
                .and_then(|object| object.get(key))
                .and_then(Value::as_array)
            {
                return entries;
            }
        }
        &[]
    }

    fn selector(entry: &Value) -> Option<&str> {
        ["pluginId", "id", "name"]
            .into_iter()
            .find_map(|key| entry.get(key).and_then(Value::as_str))
    }

    fn entry_name(entry: &Value) -> Option<&str> {
        ["name", "displayName", "pluginId", "id"]
            .into_iter()
            .find_map(|key| entry.get(key).and_then(Value::as_str))
    }

    fn entry_path(entry: &Value) -> Option<PathBuf> {
        ["installPath", "path", "cachePath"]
            .into_iter()
            .find_map(|key| entry.get(key).and_then(Value::as_str))
            .map(PathBuf::from)
            .or_else(|| {
                entry
                    .get("source")
                    .and_then(|source| source.get("path"))
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
            })
    }

    async fn installed_entry(&self, plugin_id: &str) -> Result<Value, PluginError> {
        let document = self.list_json().await?;
        let matches = self
            .entries(&document)
            .iter()
            .filter(|entry| {
                let selector = Self::selector(entry).unwrap_or_default();
                let name = Self::entry_name(entry).unwrap_or_default();
                selector == plugin_id
                    || name == plugin_id
                    || selector.split('@').next() == Some(plugin_id)
            })
            .cloned()
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [entry] => Ok(entry.clone()),
            [] => Err(PluginError::not_found(plugin_id)),
            _ => Err(PluginError::native_command_failed(
                self.ecosystem.label(),
                "resolve",
                format!("plugin ID `{plugin_id}` is ambiguous"),
            )),
        }
    }

    async fn run_operation(&self, operation: &str, args: Vec<String>) -> Result<(), PluginError> {
        let output = utils::process::new_hidden_tokio_command(&self.program, args)
            .output()
            .await
            .map_err(|error| PluginError::io("run official plugin command", error))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(PluginError::native_command_failed(
                self.ecosystem.label(),
                operation,
                command_error(&output),
            ))
        }
    }

    fn scope(entry: &Value) -> Option<&str> {
        entry.get("scope").and_then(Value::as_str)
    }
}

#[async_trait]
impl NativePluginAdapter for OfficialCliNativePluginAdapter {
    fn ecosystem(&self) -> NativeEcosystem {
        self.ecosystem
    }

    fn capabilities(&self) -> NativeAdapterCapabilities {
        match self.ecosystem {
            NativeEcosystem::Codex => NativeAdapterCapabilities {
                discover: true,
                install: false,
                enable: false,
                update: false,
                uninstall: true,
            },
            NativeEcosystem::ClaudeCode => NativeAdapterCapabilities {
                discover: true,
                install: false,
                enable: true,
                update: true,
                uninstall: true,
            },
        }
    }

    async fn discover(&self) -> Result<Vec<NativePluginDescriptor>, PluginError> {
        let document = self.list_json().await?;
        let mut plugins = self
            .entries(&document)
            .iter()
            .filter_map(|entry| {
                let id = Self::selector(entry)?.to_owned();
                let path = Self::entry_path(entry)?;
                let name = Self::entry_name(entry)
                    .unwrap_or_else(|| id.split('@').next().unwrap_or(&id))
                    .to_owned();
                Some(NativePluginDescriptor {
                    id,
                    name,
                    version: entry
                        .get("version")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    ecosystem: self.ecosystem,
                    path,
                    enabled: entry.get("enabled").and_then(Value::as_bool),
                })
            })
            .collect::<Vec<_>>();
        plugins.sort_by(|left, right| left.name.cmp(&right.name).then(left.id.cmp(&right.id)));
        Ok(plugins)
    }

    async fn install(
        &self,
        _source: &Path,
        _source_kind: PluginSourceKind,
        _decision: ConflictDecision,
    ) -> Result<NativePluginDescriptor, PluginError> {
        Err(PluginError::native_unsupported(
            self.ecosystem.label(),
            "install_from_path",
        ))
    }

    async fn set_enabled(&self, plugin_id: &str, enabled: bool) -> Result<(), PluginError> {
        if !self.capabilities().enable {
            return Err(PluginError::native_unsupported(
                self.ecosystem.label(),
                if enabled { "enable" } else { "disable" },
            ));
        }
        let entry = self.installed_entry(plugin_id).await?;
        let selector = Self::selector(&entry).ok_or_else(|| PluginError::not_found(plugin_id))?;
        let mut args = vec![
            "plugin".to_owned(),
            if enabled { "enable" } else { "disable" }.to_owned(),
            selector.to_owned(),
        ];
        if let Some(scope) = Self::scope(&entry) {
            args.extend(["--scope".to_owned(), scope.to_owned()]);
        }
        self.run_operation(if enabled { "enable" } else { "disable" }, args)
            .await
    }

    async fn update(&self, plugin_id: &str) -> Result<(), PluginError> {
        if !self.capabilities().update {
            return Err(PluginError::native_unsupported(
                self.ecosystem.label(),
                "update",
            ));
        }
        let entry = self.installed_entry(plugin_id).await?;
        let selector = Self::selector(&entry).ok_or_else(|| PluginError::not_found(plugin_id))?;
        let mut args = vec![
            "plugin".to_owned(),
            "update".to_owned(),
            selector.to_owned(),
        ];
        if let Some(scope) = Self::scope(&entry) {
            args.extend(["--scope".to_owned(), scope.to_owned()]);
        }
        self.run_operation("update", args).await
    }

    async fn uninstall(&self, plugin_id: &str) -> Result<(), PluginError> {
        let entry = self.installed_entry(plugin_id).await?;
        let selector = Self::selector(&entry).ok_or_else(|| PluginError::not_found(plugin_id))?;
        let mut args = match self.ecosystem {
            NativeEcosystem::Codex => vec![
                "plugin".to_owned(),
                "remove".to_owned(),
                selector.to_owned(),
                "--json".to_owned(),
            ],
            NativeEcosystem::ClaudeCode => vec![
                "plugin".to_owned(),
                "uninstall".to_owned(),
                selector.to_owned(),
                "--yes".to_owned(),
            ],
        };
        if self.ecosystem == NativeEcosystem::ClaudeCode
            && let Some(scope) = Self::scope(&entry)
        {
            args.extend(["--scope".to_owned(), scope.to_owned()]);
        }
        self.run_operation("uninstall", args).await
    }
}

fn command_error(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if !stderr.is_empty() {
        return stderr;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if stdout.is_empty() {
        format!("command exited with status {}", output.status)
    } else {
        stdout
    }
}

fn validate_native_id(id: &str) -> Result<(), PluginError> {
    if id.is_empty()
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err(PluginError::invalid_manifest(format!(
            "native plugin id `{id}` is not path-safe"
        )));
    }
    Ok(())
}

fn copy_directory(source: &Path, target: &Path) -> Result<(), PluginError> {
    fs::create_dir_all(target)
        .map_err(|error| PluginError::io("create native plugin target", error))?;
    for entry in
        fs::read_dir(source).map_err(|error| PluginError::io("read plugin source", error))?
    {
        let entry = entry.map_err(|error| PluginError::io("read plugin source entry", error))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| PluginError::io("inspect plugin source entry", error))?;
        if file_type.is_dir() {
            copy_directory(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path)
                .map_err(|error| PluginError::io("copy plugin source file", error))?;
        } else if file_type.is_symlink() {
            return Err(PluginError::invalid_manifest(format!(
                "snapshot import refuses source symlink `{}`",
                source_path.display()
            )));
        }
    }
    Ok(())
}

fn remove_path(path: &Path) -> Result<(), PluginError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| PluginError::io("inspect native plugin target", error))?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path).map_err(|error| PluginError::io("remove native plugin link", error))
    } else {
        fs::remove_dir_all(path)
            .map_err(|error| PluginError::io("remove native plugin directory", error))
    }
}

#[cfg(unix)]
fn create_directory_link(source: &Path, target: &Path) -> Result<(), PluginError> {
    std::os::unix::fs::symlink(source, target)
        .map_err(|error| PluginError::io("link native development plugin", error))
}

#[cfg(windows)]
fn create_directory_link(source: &Path, target: &Path) -> Result<(), PluginError> {
    std::os::windows::fs::symlink_dir(source, target)
        .map_err(|error| PluginError::io("link native development plugin", error))
}
