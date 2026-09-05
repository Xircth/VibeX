use std::{
    collections::BTreeMap,
    fs,
    io::Write as _,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::{PluginError, PluginId};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageFormat {
    VibeX,
    Codex,
    ClaudeCode,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginSourceKind {
    Builtin,
    Snapshot,
    Marketplace,
    DeveloperLink,
    CodexNative,
    ClaudeCodeNative,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSource {
    pub kind: PluginSourceKind,
    pub path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_sha: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub locked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_tree: Option<bool>,
}

impl PluginSource {
    pub fn new(kind: PluginSourceKind, path: PathBuf) -> Self {
        Self {
            kind,
            path,
            origin: None,
            git_ref: None,
            git_sha: None,
            locked: false,
            show_tree: None,
        }
    }

    pub fn with_lock(
        mut self,
        origin: Option<String>,
        git_ref: Option<String>,
        git_sha: Option<String>,
        locked: bool,
    ) -> Self {
        self.origin = origin;
        self.git_ref = git_ref;
        self.git_sha = git_sha;
        self.locked = locked;
        self
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSkill {
    pub id: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageWarning {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contribution: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntrypoints {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_runtime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_document: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRequest {
    #[serde(default)]
    pub id: String,
    pub capability: String,
    #[serde(default)]
    pub scope: Value,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub optional: bool,
    #[serde(default = "default_permission_trust_tier")]
    pub trust_tier: String,
}

fn default_permission_trust_tier() -> String {
    "sandboxed_worker".to_owned()
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOpenerContribution {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub file_name_suffixes: Vec<String>,
    #[serde(default)]
    pub media_types: Vec<String>,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub target: FileOpenerTarget,
    pub handler: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileOpenerTarget {
    #[default]
    PreviewProvider,
    AppSurface,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageAppContributions {
    #[serde(default)]
    pub file_openers: Vec<FileOpenerContribution>,
    #[serde(default)]
    pub preview_providers: Vec<PreviewProviderContribution>,
    #[serde(default)]
    pub surfaces: Vec<AppSurfaceContribution>,
}

impl PackageAppContributions {
    fn is_empty(&self) -> bool {
        self.file_openers.is_empty()
            && self.preview_providers.is_empty()
            && self.surfaces.is_empty()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSurfaceContribution {
    pub id: String,
    pub label: String,
    pub slot: String,
    pub app_entrypoint: String,
    #[serde(default)]
    pub route: Option<String>,
    pub handler: String,
    #[serde(default)]
    pub allowed_methods: Vec<String>,
    #[serde(default)]
    pub min_height: Option<u32>,
    #[serde(default)]
    pub native_renderer: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewProviderContribution {
    pub id: String,
    #[serde(default)]
    pub media_types: Vec<String>,
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default = "default_preview_concurrency")]
    pub max_concurrent_previews: u32,
    pub handler: String,
    #[serde(default)]
    pub process: Option<PreviewProcessContribution>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewProcessContribution {
    pub argv: Vec<String>,
    #[serde(default = "default_preview_ready_timeout_seconds")]
    pub ready_timeout_seconds: u64,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
}

fn default_preview_ready_timeout_seconds() -> u64 {
    15
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum RuntimeInstall {
    Existing,
    Binary {
        url: String,
        #[serde(default)]
        sha256: Option<String>,
    },
    Archive {
        url: String,
        #[serde(default)]
        sha256: Option<String>,
    },
    Npm {
        package: String,
    },
    Pipx {
        package: String,
    },
    Cargo {
        crate_name: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeContribution {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default = "external_runtime_target")]
    pub target: String,
    #[serde(default)]
    pub content_digest: String,
    #[serde(default)]
    pub probe: Vec<String>,
    pub install: RuntimeInstall,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InvocationKind {
    Action,
    Command,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvocationDefinition {
    pub id: String,
    pub label: String,
    pub prompt: String,
    #[serde(default)]
    pub skill: Option<String>,
    #[serde(default)]
    pub required_skills: Vec<String>,
    #[serde(default)]
    pub required_runtimes: Vec<String>,
    #[serde(default)]
    pub handler: Option<String>,
    #[serde(default)]
    pub artifact_intent: Option<crate::ArtifactIntent>,
    pub kind: InvocationKind,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackage {
    #[serde(default = "legacy_manifest_version")]
    pub manifest_version: u32,
    #[serde(default = "legacy_api_version")]
    pub api_version: String,
    pub id: PluginId,
    #[serde(default)]
    pub publisher: Option<String>,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default = "default_readme_path")]
    pub readme_path: String,
    #[serde(default)]
    pub content_index: PluginContentIndex,
    #[serde(default = "default_plugin_config")]
    pub config: Value,
    #[serde(default)]
    pub config_schema: Option<Value>,
    #[serde(default)]
    pub minimum_host_version: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub entrypoints: PluginEntrypoints,
    #[serde(default = "default_package_class")]
    pub package_class: String,
    #[serde(default)]
    pub permissions: Vec<CapabilityRequest>,
    #[serde(default)]
    pub app: PackageAppContributions,
    #[serde(default)]
    pub mcp: Value,
    pub source: PluginSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_root: Option<PathBuf>,
    pub formats: Vec<PackageFormat>,
    pub skills: Vec<PackageSkill>,
    pub runtimes: Vec<RuntimeContribution>,
    #[serde(default)]
    pub invocations: Vec<InvocationDefinition>,
    pub warnings: Vec<PackageWarning>,
    pub extensions: Map<String, Value>,
    pub manifest: Value,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginContentIndex {
    #[serde(default = "content_index_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub items: Vec<PluginContentItem>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginContentItem {
    pub path: String,
    pub kind: String,
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginProductDetail {
    pub summary: String,
    pub readme: String,
    pub contents: Vec<PluginContentDocument>,
    pub config: Value,
    pub config_schema: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginContentDocument {
    pub path: String,
    pub kind: String,
    pub title: String,
    pub content: String,
}

fn content_index_version() -> u32 {
    1
}

fn default_package_class() -> String {
    "full-trust".to_owned()
}

fn default_readme_path() -> String {
    "README.md".to_owned()
}

fn app_content_documents(app: &PackageAppContributions) -> Vec<PluginContentDocument> {
    let bound_handlers: std::collections::BTreeSet<&str> = app
        .file_openers
        .iter()
        .map(|opener| opener.handler.as_str())
        .collect();
    let mut documents = Vec::new();
    for opener in &app.file_openers {
        let mut suffixes = opener
            .extensions
            .iter()
            .map(|ext| format!(".{ext}"))
            .chain(opener.file_name_suffixes.iter().cloned())
            .collect::<Vec<_>>();
        suffixes.sort();
        suffixes.dedup();
        documents.push(PluginContentDocument {
            path: format!("app/openers/{}.md", opener.id),
            kind: "file_opener".to_owned(),
            title: opener.label.clone(),
            content: if suffixes.is_empty() {
                opener.label.clone()
            } else {
                format!("{}\n{}", opener.label, suffixes.join(" "))
            },
        });
    }
    for provider in &app.preview_providers {
        if bound_handlers.contains(provider.id.as_str()) {
            continue;
        }
        documents.push(PluginContentDocument {
            path: format!("app/previews/{}.md", provider.id),
            kind: "preview_provider".to_owned(),
            title: provider.id.clone(),
            content: provider.id.clone(),
        });
    }
    for surface in &app.surfaces {
        if bound_handlers.contains(surface.id.as_str()) {
            continue;
        }
        documents.push(PluginContentDocument {
            path: format!("app/surfaces/{}.md", surface.id),
            kind: "app_surface".to_owned(),
            title: surface.label.clone(),
            content: surface.label.clone(),
        });
    }
    documents
}

fn default_plugin_config() -> Value {
    Value::Object(Map::new())
}

impl PluginPackage {
    pub fn content_root(&self) -> &Path {
        self.execution_root
            .as_deref()
            .unwrap_or(self.source.path.as_path())
    }

    pub fn product_detail(&self) -> Result<PluginProductDetail, PluginError> {
        let root = self.source.path.as_path();
        let readme = fs::read_to_string(checked_package_path(root, &self.readme_path)?)
            .map_err(|error| PluginError::io("read Plugin README", error))?;
        let mut contents = Vec::with_capacity(self.content_index.items.len());
        for item in &self.content_index.items {
            let path = checked_package_path(root, &item.path)?;
            if fs::metadata(&path)
                .map_err(|error| PluginError::io("inspect Plugin content", error))?
                .len()
                > 1024 * 1024
            {
                return Err(PluginError::invalid_manifest(format!(
                    "Plugin content exceeds 1 MiB: {}",
                    item.path
                )));
            }
            contents.push(PluginContentDocument {
                path: item.path.clone(),
                kind: item.kind.clone(),
                title: item.title.clone(),
                content: fs::read_to_string(path)
                    .map_err(|error| PluginError::io("read Plugin content", error))?,
            });
        }
        contents.extend(app_content_documents(&self.app));
        Ok(PluginProductDetail {
            summary: self.summary.clone(),
            readme: strip_readme_frontmatter(&readme).to_owned(),
            contents,
            config: self.read_config()?,
            config_schema: self
                .config_schema
                .clone()
                .unwrap_or_else(|| serde_json::json!({ "type": "object" })),
        })
    }

    fn read_config(&self) -> Result<Value, PluginError> {
        if !self.source.path.join("config.json").is_file() {
            return Ok(self.config.clone());
        }
        let source = fs::read_to_string(checked_package_path(&self.source.path, "config.json")?)
            .map_err(|error| PluginError::io("read Plugin config", error))?;
        let config: Value = serde_json::from_str(&source).map_err(|error| {
            PluginError::invalid_manifest(format!("invalid config.json: {error}"))
        })?;
        if !config.is_object() {
            return Err(PluginError::invalid_manifest(
                "root config.json must be a JSON object",
            ));
        }
        if let Some(schema) = &self.config_schema {
            validate_config_value(schema, &config, "config")?;
        }
        Ok(config)
    }

    pub fn adopt_installed_config(&self, previous: &Value) -> Result<Value, PluginError> {
        let Some(schema) = &self.config_schema else {
            return if previous.is_object() {
                Ok(previous.clone())
            } else {
                Ok(self.config.clone())
            };
        };
        adopt_config_value(schema, previous, &self.config, "config")
    }

    pub fn write_adopted_config(&self, previous: Value) -> Result<(), PluginError> {
        self.write_config(self.adopt_installed_config(&previous)?)
    }

    pub fn write_config(&self, config: Value) -> Result<(), PluginError> {
        if !config.is_object() {
            return Err(PluginError::invalid_manifest(
                "Plugin config must be a JSON object",
            ));
        }
        if let Some(schema) = &self.config_schema {
            validate_config_value(schema, &config, "config")?;
        }
        let path = self.source.path.join("config.json");
        let parent = path.parent().ok_or_else(|| {
            PluginError::invalid_manifest("Plugin config path has no parent directory")
        })?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)
            .map_err(|error| PluginError::io("create Plugin config transaction", error))?;
        serde_json::to_writer_pretty(&mut temporary, &config)
            .map_err(|error| PluginError::invalid_manifest(error.to_string()))?;
        temporary
            .write_all(b"\n")
            .map_err(|error| PluginError::io("write Plugin config", error))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|error| PluginError::io("sync Plugin config", error))?;
        temporary
            .persist(path)
            .map_err(|error| PluginError::io("publish Plugin config", error.error))?;
        Ok(())
    }

    pub fn freeze_execution_root(
        &mut self,
        storage_root: &Path,
        expected_digest: &str,
    ) -> Result<(), PluginError> {
        if expected_digest.len() != 64
            || !expected_digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(PluginError::invalid_manifest(
                "candidate digest must be lowercase SHA-256 hex",
            ));
        }
        validate_storage_segment(self.id.as_str())?;
        let publisher = self.publisher.as_deref().unwrap_or("local");
        validate_storage_segment(publisher)?;
        fs::create_dir_all(storage_root)
            .map_err(|error| PluginError::io("create candidate storage", error))?;
        let storage_root = storage_root
            .canonicalize()
            .map_err(|error| PluginError::io("resolve candidate storage", error))?;
        let parent = storage_root.join(publisher).join(self.id.as_str());
        fs::create_dir_all(&parent)
            .map_err(|error| PluginError::io("create candidate identity storage", error))?;
        let target = parent.join(expected_digest);
        if !target.exists() {
            let staging = parent.join(format!(".{expected_digest}.incoming"));
            if staging.exists() {
                remove_snapshot_path(&staging)?;
            }
            copy_digest_files(&self.source.path, &staging)?;
            if self.source.path.join("config.json").is_file() {
                let config_source = checked_package_path(&self.source.path, "config.json")?;
                fs::copy(config_source, staging.join("config.json"))
                    .map_err(|error| PluginError::io("copy Plugin config into candidate", error))?;
            }
            Self::inspect(&staging, self.source.kind)?;
            let staged_digest = package_content_digest(&staging)?;
            if staged_digest != expected_digest {
                remove_snapshot_path(&staging)?;
                return Err(PluginError::invalid_manifest(
                    "linked source changed while the candidate was being frozen",
                ));
            }
            fs::rename(&staging, &target)
                .map_err(|error| PluginError::io("publish frozen candidate", error))?;
        }
        if package_content_digest(&target)? != expected_digest {
            return Err(PluginError::invalid_manifest(
                "frozen candidate digest does not match its content address",
            ));
        }
        self.execution_root = Some(
            target
                .canonicalize()
                .map_err(|error| PluginError::io("resolve frozen candidate", error))?,
        );
        Ok(())
    }

    pub fn materialize(
        source: &Path,
        storage_root: &Path,
        source_kind: PluginSourceKind,
    ) -> Result<Self, PluginError> {
        if !matches!(
            source_kind,
            PluginSourceKind::Snapshot | PluginSourceKind::Marketplace
        ) {
            return Self::inspect(source, source_kind);
        }
        let incoming = Self::inspect(source, source_kind)?;
        validate_storage_segment(incoming.id.as_str())?;
        fs::create_dir_all(storage_root)
            .map_err(|error| PluginError::io("create plugin snapshot directory", error))?;
        let storage_root = storage_root
            .canonicalize()
            .map_err(|error| PluginError::io("resolve plugin snapshot directory", error))?;
        let target = storage_root.join(incoming.id.as_str());
        if source.canonicalize().ok().as_ref() == Some(&target) {
            return Self::inspect(&target, source_kind);
        }
        let staging = storage_root.join(format!(".{}.incoming", incoming.id.as_str()));
        if staging.exists() {
            remove_snapshot_path(&staging)?;
        }
        copy_snapshot_directory(source, &staging)?;
        let installed_config = target.join("config.json");
        if installed_config.is_file() {
            let previous = fs::read_to_string(&installed_config)
                .map_err(|error| PluginError::io("read installed Plugin config", error))?;
            let previous: Value = serde_json::from_str(&previous).map_err(|error| {
                PluginError::invalid_manifest(format!("installed config.json is invalid: {error}"))
            })?;
            let preserved = incoming
                .adopt_installed_config(&previous)
                .inspect_err(|_| {
                    let _ = remove_snapshot_path(&staging);
                })?;
            fs::write(
                staging.join("config.json"),
                format!(
                    "{}\n",
                    serde_json::to_string_pretty(&preserved)
                        .map_err(|error| { PluginError::invalid_manifest(error.to_string()) })?
                ),
            )
            .map_err(|error| PluginError::io("preserve installed Plugin config", error))?;
        }
        // Validate the complete staged tree before replacing a prior snapshot.
        Self::inspect(&staging, source_kind)?;
        if target.exists() {
            remove_snapshot_path(&target)?;
        }
        fs::rename(&staging, &target)
            .map_err(|error| PluginError::io("activate plugin snapshot", error))?;
        Self::inspect(&target, source_kind)
    }

    pub fn inspect(root: &Path, source_kind: PluginSourceKind) -> Result<Self, PluginError> {
        let source_path = root.canonicalize().map_err(|error| {
            PluginError::io(
                &format!("resolve plugin source `{}`", root.display()),
                error,
            )
        })?;
        let vibex_path = root.join(".vibex-plugin/plugin.json");
        if !vibex_path.is_file() {
            return Err(PluginError::invalid_manifest(format!(
                "missing `{}`",
                vibex_path.display()
            )));
        }

        let manifest_text = fs::read_to_string(&vibex_path)
            .map_err(|error| PluginError::io("read portable plugin manifest", error))?;
        let mut manifest: Value = serde_json::from_str(&manifest_text)
            .map_err(|error| PluginError::invalid_manifest(error.to_string()))?;
        normalize_product_manifest(root, &mut manifest)?;
        let object = manifest.as_object().ok_or_else(|| {
            PluginError::invalid_manifest("portable plugin manifest must be a JSON object")
        })?;
        let id = required_string(object, "id")?;
        let name = required_string(object, "name")?;
        let version = required_string(object, "version")?;
        let manifest_version = object
            .get("manifestVersion")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or_else(legacy_manifest_version);
        let api_version = object
            .get("apiVersion")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(legacy_api_version);
        let publisher = object
            .get("publisher")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let readme_path = "README.md".to_owned();
        let uses_product_contract = object
            .get("_productContract")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let (summary, content_index, config, config_schema) = if uses_product_contract {
            read_product_contract(root, object, &readme_path)?
        } else {
            (
                object
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                PluginContentIndex::default(),
                Value::Object(Map::new()),
                None,
            )
        };
        let minimum_host_version = object
            .get("minimumHostVersion")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let description = if uses_product_contract {
            Some(summary.clone())
        } else {
            object
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_owned)
        };

        let mut formats = vec![PackageFormat::VibeX];
        if root.join(".codex-plugin/plugin.json").is_file() {
            formats.push(PackageFormat::Codex);
        }
        if root.join(".claude-plugin/plugin.json").is_file() {
            formats.push(PackageFormat::ClaudeCode);
        }

        let mut warnings = Vec::new();
        let skills = parse_or_discover_skills(root, object, &mut warnings)?;
        let runtimes = parse_runtimes(object, &mut warnings);
        let mut invocations = parse_canonical_invocations(object, &mut warnings);
        if invocations.is_empty() {
            invocations = parse_invocations(
                agent_contribution(object, "actions"),
                InvocationKind::Action,
                &mut warnings,
            );
            invocations.extend(parse_invocations(
                agent_contribution(object, "commands"),
                InvocationKind::Command,
                &mut warnings,
            ));
        }
        let entrypoints = parse_entrypoints(root, object, &mut warnings);
        let permissions = parse_permissions(object, &mut warnings);
        let app = parse_app_contributions(object, &mut warnings);
        if manifest_version >= 4 {
            validate_v4_contract(V4Contract {
                object,
                api_version: &api_version,
                publisher: publisher.as_deref(),
                entrypoints: &entrypoints,
                app: &app,
                permissions: &permissions,
                runtimes: &runtimes,
                warnings: &warnings,
            })?;
        }
        let mcp = canonical_contribution(object, "agent.mcp")
            .or_else(|| agent_contribution(object, "mcp"))
            .cloned()
            .unwrap_or(Value::Null);
        let has_mcp = mcp.as_object().is_some_and(|mcp| !mcp.is_empty());
        if skills.is_empty()
            && runtimes.is_empty()
            && invocations.is_empty()
            && app.is_empty()
            && !has_mcp
        {
            return Err(PluginError::contribution_required(&id));
        }
        let known = [
            "$schema",
            "manifestVersion",
            "apiVersion",
            "id",
            "publisher",
            "name",
            "version",
            "minimumHostVersion",
            "description",
            "readme",
            "content",
            "config",
            "_productContract",
            "author",
            "icon",
            "entrypoints",
            "permissions",
            "contributes",
            "skills",
            "runtimes",
            "mcp",
            "actions",
            "commands",
            "interface",
        ];
        let extensions = object
            .iter()
            .filter(|(key, _)| !known.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();

        Ok(Self {
            manifest_version,
            api_version,
            id: PluginId::from_string(id),
            publisher,
            name,
            version,
            summary,
            readme_path,
            content_index,
            config,
            config_schema,
            minimum_host_version,
            description,
            entrypoints,
            package_class: object
                .get("packageClass")
                .and_then(Value::as_str)
                .unwrap_or("full-trust")
                .to_owned(),
            permissions,
            app,
            mcp,
            source: PluginSource::new(source_kind, source_path),
            execution_root: None,
            formats,
            skills,
            runtimes,
            invocations,
            warnings,
            extensions,
            manifest,
        })
    }

    #[doc(hidden)]
    pub fn for_test(
        id: &str,
        name: &str,
        version: &str,
        source_kind: PluginSourceKind,
        root: &Path,
    ) -> Self {
        Self {
            manifest_version: 4,
            api_version: "1.0".to_owned(),
            id: PluginId::from_string(id.to_owned()),
            publisher: Some("dev.vibex.test".to_owned()),
            name: name.to_owned(),
            version: version.to_owned(),
            summary: String::new(),
            readme_path: default_readme_path(),
            content_index: PluginContentIndex::default(),
            config: Value::Object(Map::new()),
            config_schema: None,
            minimum_host_version: None,
            description: None,
            entrypoints: PluginEntrypoints::default(),
            package_class: default_package_class(),
            permissions: Vec::new(),
            app: PackageAppContributions::default(),
            mcp: Value::Null,
            source: PluginSource::new(
                source_kind,
                root.canonicalize().unwrap_or_else(|_| root.to_path_buf()),
            ),
            execution_root: None,
            formats: vec![PackageFormat::VibeX],
            skills: vec![PackageSkill {
                id: "test".to_owned(),
                path: "skills/test/SKILL.md".to_owned(),
            }],
            runtimes: Vec::new(),
            invocations: Vec::new(),
            warnings: Vec::new(),
            extensions: Map::new(),
            manifest: serde_json::json!({"id": id, "name": name, "version": version}),
        }
    }
}

fn normalize_product_manifest(root: &Path, manifest: &mut Value) -> Result<(), PluginError> {
    let object = manifest.as_object_mut().ok_or_else(|| {
        PluginError::invalid_manifest("portable plugin manifest must be a JSON object")
    })?;
    let Some(integrations) = object.remove("integrations") else {
        return Ok(());
    };
    let integrations = integrations
        .as_array()
        .ok_or_else(|| PluginError::invalid_manifest("v4 `integrations` must be an array"))?;
    if integrations.is_empty() {
        return Err(PluginError::invalid_manifest(
            "v4 product plugins require at least one integration",
        ));
    }

    let mut contributes = Map::new();
    let mut skills = Vec::new();
    let mut invocations = Vec::new();
    let mut file_openers = Vec::new();
    let mut preview_providers = Vec::new();
    let mut surfaces = Vec::new();
    let mut mcp = Map::new();

    for integration in integrations {
        let integration = integration.as_object().ok_or_else(|| {
            PluginError::invalid_manifest("each v4 integration must be an object")
        })?;
        let id = required_string(integration, "id")?;
        let kind = required_string(integration, "kind")?;
        match kind.as_str() {
            "content.skill" => {
                let resource = required_string(integration, "resource")?;
                let mut value = serde_json::json!({
                    "id": id,
                    "kindVersion": 1,
                    "path": resource,
                });
                if let Some(targets) = integration.get("targets") {
                    value["targets"] = targets.clone();
                }
                skills.push(value);
            }
            "workflow.binding" => {
                let resource = required_string(integration, "resource")?;
                let path = checked_package_path(root, &resource)?;
                let mut workflow: Value = serde_json::from_str(
                    &fs::read_to_string(&path)
                        .map_err(|error| PluginError::io("read workflow resource", error))?,
                )
                .map_err(|error| PluginError::invalid_manifest(error.to_string()))?;
                let workflow = workflow.as_object_mut().ok_or_else(|| {
                    PluginError::invalid_manifest("workflow resource must be a JSON object")
                })?;
                workflow.insert("id".to_owned(), Value::String(id));
                workflow.insert("kindVersion".to_owned(), Value::from(1));
                invocations.push(Value::Object(workflow.clone()));
            }
            "content.mcp" => {
                let resource = required_string(integration, "resource")?;
                let path = checked_package_path(root, &resource)?;
                let config: Value = serde_json::from_str(
                    &fs::read_to_string(&path)
                        .map_err(|error| PluginError::io("read MCP resource", error))?,
                )
                .map_err(|error| PluginError::invalid_manifest(error.to_string()))?;
                mcp.insert(id, config);
            }
            "file.opener" => file_openers.push(integration_contribution(integration, &id)),
            "artifact.preview" => {
                preview_providers.push(integration_contribution(integration, &id))
            }
            "app.surface" => {
                let slot = integration
                    .get("slot")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if slot == "conversation.timeline.card" {
                    return Err(PluginError::coded(
                        "app_surface_slot_unsupported",
                        "app.surface slot conversation.timeline.card is not a closed Host surface",
                    ));
                }
                surfaces.push(integration_contribution(integration, &id));
            }
            "content.hook"
            | "app.command"
            | "app.toolbar"
            | "app.status"
            | "app.composer.slash"
            | "app.timeline.card"
            | "app.settings.section"
            | "host.service" => {}
            other => {
                return Err(PluginError::invalid_manifest(format!(
                    "unknown v4 integration kind `{other}`"
                )));
            }
        }
    }

    if !skills.is_empty() {
        contributes.insert("agent.skills".to_owned(), Value::Array(skills));
    }
    if !invocations.is_empty() {
        contributes.insert("agent.invocations".to_owned(), Value::Array(invocations));
    }
    if !mcp.is_empty() {
        contributes.insert("agent.mcp".to_owned(), Value::Object(mcp));
    }
    if !file_openers.is_empty() {
        contributes.insert("app.fileOpeners".to_owned(), Value::Array(file_openers));
    }
    if !preview_providers.is_empty() {
        contributes.insert(
            "artifact.previewProviders".to_owned(),
            Value::Array(preview_providers),
        );
    }
    if !surfaces.is_empty() {
        contributes.insert("app.surfaces".to_owned(), Value::Array(surfaces));
    }

    if let Some(dependencies) = object.remove("dependencies") {
        let dependencies = dependencies
            .as_array()
            .ok_or_else(|| PluginError::invalid_manifest("v4 `dependencies` must be an array"))?;
        let mut runtimes = Vec::new();
        for dependency in dependencies {
            let dependency = dependency.as_object().ok_or_else(|| {
                PluginError::invalid_manifest("each v4 dependency must be an object")
            })?;
            if dependency.get("kind").and_then(Value::as_str) != Some("runtime") {
                return Err(PluginError::coded(
                    "dependency_kind_unsupported",
                    "dependencies.kind=plugin is not supported; only runtime dependencies are allowed",
                ));
            }
            let descriptor = required_string(dependency, "descriptor")?;
            let path = checked_package_path(root, &descriptor)?;
            let mut runtime: Value = serde_json::from_str(
                &fs::read_to_string(&path)
                    .map_err(|error| PluginError::io("read Runtime dependency", error))?,
            )
            .map_err(|error| PluginError::invalid_manifest(error.to_string()))?;
            let runtime = runtime.as_object_mut().ok_or_else(|| {
                PluginError::invalid_manifest("Runtime descriptor must be a JSON object")
            })?;
            runtime.remove("$schema");
            runtime.insert("kindVersion".to_owned(), Value::from(1));
            runtimes.push(Value::Object(runtime.clone()));
        }
        if !runtimes.is_empty() {
            contributes.insert("runtimes".to_owned(), Value::Array(runtimes));
        }
    }

    object.insert("contributes".to_owned(), Value::Object(contributes));
    object.insert("_productContract".to_owned(), Value::Bool(true));
    Ok(())
}

fn integration_contribution(integration: &Map<String, Value>, id: &str) -> Value {
    let mut contribution = integration.clone();
    contribution.remove("kind");
    contribution.remove("resource");
    contribution.insert("id".to_owned(), Value::String(id.to_owned()));
    contribution.insert("kindVersion".to_owned(), Value::from(1));
    Value::Object(contribution)
}

fn checked_package_path(root: &Path, relative: &str) -> Result<PathBuf, PluginError> {
    if !safe_relative_path(relative) {
        return Err(PluginError::invalid_manifest(format!(
            "unsafe package path `{relative}`"
        )));
    }
    let path = root.join(relative);
    if !path.is_file() {
        return Err(PluginError::invalid_manifest(format!(
            "missing package file `{relative}`"
        )));
    }
    Ok(path)
}

fn read_product_contract(
    root: &Path,
    object: &Map<String, Value>,
    readme_path: &str,
) -> Result<(String, PluginContentIndex, Value, Option<Value>), PluginError> {
    if readme_path != "README.md" {
        return Err(PluginError::invalid_manifest(
            "v4 product plugins require root README.md",
        ));
    }
    let readme = fs::read_to_string(checked_package_path(root, readme_path)?)
        .map_err(|error| PluginError::io("read Plugin README", error))?;
    let summary = read_readme_summary(&readme)?;

    let content = object
        .get("content")
        .and_then(Value::as_object)
        .ok_or_else(|| PluginError::invalid_manifest("v4 product plugins require `content`"))?;
    if content.get("root").and_then(Value::as_str) != Some("contents") {
        return Err(PluginError::invalid_manifest(
            "v4 product content root must be `contents`",
        ));
    }
    let index_path = content
        .get("index")
        .and_then(Value::as_str)
        .ok_or_else(|| PluginError::invalid_manifest("content.index is required"))?;
    let content_index: PluginContentIndex = serde_json::from_str(
        &fs::read_to_string(checked_package_path(root, index_path)?)
            .map_err(|error| PluginError::io("read Plugin content index", error))?,
    )
    .map_err(|error| PluginError::invalid_manifest(error.to_string()))?;
    if content_index.schema_version != 1 {
        return Err(PluginError::invalid_manifest(
            "unsupported content index version",
        ));
    }
    for item in &content_index.items {
        if !item.path.starts_with("contents/") || checked_package_path(root, &item.path).is_err() {
            return Err(PluginError::invalid_manifest(format!(
                "content index path is missing or outside contents: `{}`",
                item.path
            )));
        }
    }

    let config: Value = serde_json::from_str(
        &fs::read_to_string(checked_package_path(root, "config.json")?)
            .map_err(|error| PluginError::io("read Plugin config", error))?,
    )
    .map_err(|error| PluginError::invalid_manifest(format!("invalid config.json: {error}")))?;
    if !config.is_object() {
        return Err(PluginError::invalid_manifest(
            "root config.json must be a JSON object",
        ));
    }
    let config_schema = object
        .get("config")
        .and_then(Value::as_object)
        .and_then(|config| config.get("schema"))
        .cloned();
    let config_schema = config_schema.ok_or_else(|| {
        PluginError::invalid_manifest("v4 product plugins require `config.schema`")
    })?;
    validate_config_value(&config_schema, &config, "config")?;
    Ok((summary, content_index, config, Some(config_schema)))
}

fn read_readme_summary(readme: &str) -> Result<String, PluginError> {
    let mut lines = readme.lines();
    if lines.next() != Some("---") {
        return Err(PluginError::invalid_manifest(
            "README.md must start with a frontmatter summary tag",
        ));
    }
    let mut summary = None;
    for line in &mut lines {
        if line == "---" {
            break;
        }
        if let Some(value) = line.strip_prefix("summary:") {
            summary = Some(value.trim().trim_matches(['\'', '"']).to_owned());
        }
    }
    let summary = summary.filter(|value| !value.is_empty()).ok_or_else(|| {
        PluginError::invalid_manifest("README.md requires a non-empty `summary` tag")
    })?;
    if summary.len() > 200 || summary.contains(['\n', '\r']) {
        return Err(PluginError::invalid_manifest(
            "README.md summary must be one sentence of at most 200 characters",
        ));
    }
    Ok(summary)
}

fn strip_readme_frontmatter(readme: &str) -> &str {
    // The delimiters have to tolerate CRLF. A Windows checkout stores the
    // README with \r\n, so matching only LF leaves the whole YAML block in the
    // README that the plugin's product page renders to the user.
    for (open, close) in [("---\n", "\n---\n"), ("---\r\n", "\r\n---\r\n")] {
        if let Some(rest) = readme.strip_prefix(open)
            && let Some((_, body)) = rest.split_once(close)
        {
            // Frontmatter is followed by a blank line; the product page should
            // start at the first heading, not at that gap.
            return body.trim_start_matches(['\r', '\n']);
        }
    }
    readme
}

fn adopt_config_value(
    schema: &Value,
    previous: &Value,
    defaults: &Value,
    path: &str,
) -> Result<Value, PluginError> {
    if validate_config_value(schema, previous, path).is_ok() {
        return Ok(previous.clone());
    }

    let schema_object = schema
        .as_object()
        .ok_or_else(|| PluginError::invalid_manifest("config schema must be an object"))?;
    match schema_object.get("type").and_then(Value::as_str) {
        Some("object") => {
            let mut adopted = match defaults {
                Value::Object(map) => map.clone(),
                _ => Map::new(),
            };
            let properties = schema_object.get("properties").and_then(Value::as_object);
            let additional_properties = schema_object
                .get("additionalProperties")
                .and_then(Value::as_bool)
                != Some(false);
            if let Some(previous) = previous.as_object() {
                for (name, value) in previous {
                    if let Some(property_schema) =
                        properties.and_then(|properties| properties.get(name))
                    {
                        let property_default = defaults
                            .as_object()
                            .and_then(|defaults| defaults.get(name))
                            .cloned()
                            .unwrap_or(Value::Null);
                        adopted.insert(
                            name.clone(),
                            adopt_config_value(
                                property_schema,
                                value,
                                &property_default,
                                &format!("{path}.{name}"),
                            )?,
                        );
                    } else if additional_properties {
                        adopted.insert(name.clone(), value.clone());
                    }
                }
            }
            let adopted = Value::Object(adopted);
            validate_config_value(schema, &adopted, path)?;
            Ok(adopted)
        }
        _ if validate_config_value(schema, defaults, path).is_ok() => Ok(defaults.clone()),
        _ => Err(PluginError::invalid_manifest(format!(
            "{path} from the previous installation is incompatible with the updated schema"
        ))),
    }
}

fn validate_config_value(schema: &Value, value: &Value, path: &str) -> Result<(), PluginError> {
    let schema = schema
        .as_object()
        .ok_or_else(|| PluginError::invalid_manifest("config schema must be an object"))?;
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array)
        && !allowed.contains(value)
    {
        return Err(PluginError::invalid_manifest(format!(
            "{path} is not one of the allowed values"
        )));
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("object") => {
            let object = value.as_object().ok_or_else(|| {
                PluginError::invalid_manifest(format!("{path} must be an object"))
            })?;
            if let Some(required) = schema.get("required").and_then(Value::as_array) {
                for name in required.iter().filter_map(Value::as_str) {
                    if !object.contains_key(name) {
                        return Err(PluginError::invalid_manifest(format!(
                            "{path}.{name} is required"
                        )));
                    }
                }
            }
            let properties = schema.get("properties").and_then(Value::as_object);
            if schema.get("additionalProperties").and_then(Value::as_bool) == Some(false)
                && let Some(name) = object.keys().find(|name| {
                    properties.is_none_or(|properties| !properties.contains_key(*name))
                })
            {
                return Err(PluginError::invalid_manifest(format!(
                    "unknown config field `{name}`"
                )));
            }
            if let Some(properties) = properties {
                for (name, property_schema) in properties {
                    if let Some(property) = object.get(name) {
                        validate_config_value(
                            property_schema,
                            property,
                            &format!("{path}.{name}"),
                        )?;
                    }
                }
            }
        }
        Some("string") if !value.is_string() => {
            return Err(PluginError::invalid_manifest(format!(
                "{path} must be a string"
            )));
        }
        Some("boolean") if !value.is_boolean() => {
            return Err(PluginError::invalid_manifest(format!(
                "{path} must be a boolean"
            )));
        }
        Some("integer") if value.as_i64().is_none() && value.as_u64().is_none() => {
            return Err(PluginError::invalid_manifest(format!(
                "{path} must be an integer"
            )));
        }
        Some("number") if !value.is_number() => {
            return Err(PluginError::invalid_manifest(format!(
                "{path} must be a number"
            )));
        }
        Some("array") if !value.is_array() => {
            return Err(PluginError::invalid_manifest(format!(
                "{path} must be an array"
            )));
        }
        Some("null") if !value.is_null() => {
            return Err(PluginError::invalid_manifest(format!(
                "{path} must be null"
            )));
        }
        _ => {}
    }
    if let Some(number) = value.as_f64() {
        if let Some(minimum) = schema.get("minimum").and_then(Value::as_f64)
            && number < minimum
        {
            return Err(PluginError::invalid_manifest(format!(
                "{path} must be at least {minimum}"
            )));
        }
        if let Some(maximum) = schema.get("maximum").and_then(Value::as_f64)
            && number > maximum
        {
            return Err(PluginError::invalid_manifest(format!(
                "{path} must be at most {maximum}"
            )));
        }
    }
    Ok(())
}

fn legacy_manifest_version() -> u32 {
    3
}

fn legacy_api_version() -> String {
    "0.3".to_owned()
}

fn parse_entrypoints(
    root: &Path,
    object: &Map<String, Value>,
    warnings: &mut Vec<PackageWarning>,
) -> PluginEntrypoints {
    let Some(value) = object.get("entrypoints") else {
        return PluginEntrypoints::default();
    };
    let Some(entrypoints) = value.as_object() else {
        warnings.push(PackageWarning {
            code: "entrypoint_invalid".to_owned(),
            message: "`entrypoints` must be an object".to_owned(),
            contribution: None,
        });
        return PluginEntrypoints::default();
    };
    let mut parsed = PluginEntrypoints::default();
    for (key, target) in [("worker", &mut parsed.worker), ("app", &mut parsed.app)] {
        let Some(value) = entrypoints.get(key) else {
            continue;
        };
        let Some(path) = Some(value).and_then(|value| {
            value.as_str().or_else(|| {
                let entrypoint = value.as_object()?;
                if key == "worker" {
                    entrypoint.get("path")?.as_str()
                } else {
                    entrypoint.get("root")?.as_str()
                }
            })
        }) else {
            warnings.push(PackageWarning {
                code: "entrypoint_invalid".to_owned(),
                message: format!("`{key}` entrypoint requires a string path"),
                contribution: Some(key.to_owned()),
            });
            continue;
        };
        let target_exists = if key == "app" {
            root.join(path).is_dir() || root.join(path).is_file()
        } else {
            root.join(path).is_file()
        };
        if safe_relative_path(path) && target_exists {
            *target = Some(path.to_owned());
            if key == "worker" {
                parsed.worker_runtime = value
                    .as_object()
                    .and_then(|entrypoint| compiled_worker_runtime(entrypoint).ok());
            }
            if key == "app" {
                let document = value
                    .as_object()
                    .and_then(|entrypoint| entrypoint.get("document"))
                    .and_then(Value::as_str);
                if let Some(document) = document {
                    let full_document = root.join(path).join(document);
                    if safe_relative_path(document) && full_document.is_file() {
                        parsed.app_document = Some(document.to_owned());
                    } else {
                        warnings.push(PackageWarning {
                            code: "entrypoint_invalid".to_owned(),
                            message: "ignored missing or unsafe `app.document` entrypoint"
                                .to_owned(),
                            contribution: Some("app".to_owned()),
                        });
                    }
                }
            }
        } else {
            warnings.push(PackageWarning {
                code: "entrypoint_invalid".to_owned(),
                message: format!("ignored missing or unsafe `{key}` entrypoint"),
                contribution: Some(key.to_owned()),
            });
        }
    }
    parsed
}

fn parse_permissions(
    object: &Map<String, Value>,
    warnings: &mut Vec<PackageWarning>,
) -> Vec<CapabilityRequest> {
    let Some(value) = object.get("permissions") else {
        return Vec::new();
    };
    if let Some(permissions) = value.as_array() {
        return permissions
            .iter()
            .filter_map(|permission| serde_json::from_value(permission.clone()).ok())
            .collect();
    }
    let Some(permissions) = value.as_object() else {
        warnings.push(PackageWarning {
            code: "permissions_invalid".to_owned(),
            message: "ignored invalid permission declarations".to_owned(),
            contribution: None,
        });
        return Vec::new();
    };
    permissions
        .iter()
        .map(|(capability, scope)| CapabilityRequest {
            id: capability.replace('.', "-"),
            capability: capability.clone(),
            scope: scope.clone(),
            reason: String::new(),
            optional: false,
            trust_tier: default_permission_trust_tier(),
        })
        .collect()
}

fn parse_app_contributions(
    object: &Map<String, Value>,
    warnings: &mut Vec<PackageWarning>,
) -> PackageAppContributions {
    let file_openers = canonical_contribution(object, "app.fileOpeners")
        .or_else(|| {
            object
                .get("contributes")
                .and_then(Value::as_object)
                .and_then(|contributes| contributes.get("app"))
                .and_then(Value::as_object)
                .and_then(|app| app.get("fileOpeners"))
        })
        .and_then(Value::as_array);
    let mut parsed = Vec::new();
    for value in file_openers.into_iter().flatten() {
        let candidate = value
            .as_object()
            .and_then(|opener| {
                let id = opener.get("id")?.as_str()?.to_owned();
                let (handler, target) = match (
                    opener.get("previewProvider").and_then(Value::as_str),
                    opener.get("editorSurface").and_then(Value::as_str),
                ) {
                    (Some(handler), None) => {
                        (handler.to_owned(), FileOpenerTarget::PreviewProvider)
                    }
                    (None, Some(handler)) => (handler.to_owned(), FileOpenerTarget::AppSurface),
                    (None, None) => (
                        opener.get("handler")?.as_str()?.to_owned(),
                        FileOpenerTarget::PreviewProvider,
                    ),
                    (Some(_), Some(_)) => return None,
                };
                Some(FileOpenerContribution {
                    label: opener
                        .get("label")
                        .and_then(Value::as_str)
                        .unwrap_or(&id)
                        .to_owned(),
                    handler,
                    target,
                    extensions: string_array(opener.get("extensions")),
                    file_name_suffixes: string_array(opener.get("fileNameSuffixes")),
                    media_types: string_array(opener.get("mediaTypes")),
                    priority: opener
                        .get("priority")
                        .and_then(Value::as_i64)
                        .and_then(|value| i32::try_from(value).ok())
                        .unwrap_or_default(),
                    id,
                })
            })
            .filter(|opener| {
                !opener.id.trim().is_empty()
                    && !opener.handler.trim().is_empty()
                    && (!opener.extensions.is_empty()
                        || !opener.file_name_suffixes.is_empty()
                        || !opener.media_types.is_empty())
                    && opener.extensions.iter().all(|extension| {
                        !extension.is_empty()
                            && extension
                                .chars()
                                .all(|character| character.is_ascii_alphanumeric())
                    })
                    && opener.file_name_suffixes.iter().all(|suffix| {
                        suffix.starts_with('.')
                            && suffix.len() > 1
                            && suffix.chars().all(|character| {
                                character.is_ascii_alphanumeric()
                                    || matches!(character, '.' | '-' | '_')
                            })
                    })
            });
        match candidate {
            Some(mut opener) => {
                opener.extensions = opener
                    .extensions
                    .into_iter()
                    .map(|extension| extension.to_ascii_lowercase())
                    .collect();
                opener.file_name_suffixes = opener
                    .file_name_suffixes
                    .into_iter()
                    .map(|suffix| suffix.to_ascii_lowercase())
                    .collect();
                parsed.push(opener);
            }
            None => warnings.push(PackageWarning {
                code: "app_file_opener_invalid".to_owned(),
                message: "ignored invalid App file opener contribution".to_owned(),
                contribution: value.get("id").and_then(Value::as_str).map(str::to_owned),
            }),
        }
    }
    let preview_providers = canonical_contribution(object, "artifact.previewProviders")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| serde_json::from_value(value.clone()).ok())
        .collect();
    let surface_values = canonical_contribution(object, "app.surfaces").and_then(Value::as_array);
    let mut surfaces = Vec::new();
    for value in surface_values.into_iter().flatten() {
        let candidate = (|| {
            let surface = value.as_object()?;
            let id = surface.get("id")?.as_str()?.to_owned();
            let label = surface
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_owned();
            let slot = surface.get("slot")?.as_str()?.to_owned();
            let app_entrypoint = surface.get("appEntrypoint")?.as_str()?.to_owned();
            let handler = surface.get("handler")?.as_str()?.to_owned();
            let allowed_methods = string_array(surface.get("allowedMethods"));
            let min_height = surface
                .get("minHeight")
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok());
            let route = surface
                .get("route")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let native_renderer = surface
                .get("nativeRenderer")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let valid = !id.is_empty()
                && matches!(slot.as_str(), "plugin.detail.panel" | "artifact.editor")
                && app_entrypoint == "app"
                && handler == "surface.createSession"
                && allowed_methods.iter().all(|method| {
                    !method.is_empty()
                        && method.chars().all(|character| {
                            character.is_ascii_alphanumeric()
                                || matches!(character, '.' | '-' | '_')
                        })
                })
                && min_height.is_none_or(|height| (240..=900).contains(&height))
                && route
                    .as_deref()
                    .is_none_or(|route| route.starts_with('/') && !route.starts_with("//"))
                && native_renderer.as_deref().is_none_or(|renderer| {
                    renderer == "host.renderer.workflow.studio" || renderer == "workflow.studio"
                });
            valid.then_some(AppSurfaceContribution {
                id,
                label,
                slot,
                app_entrypoint,
                route,
                handler,
                allowed_methods,
                min_height,
                native_renderer,
            })
        })();
        if let Some(surface) = candidate {
            surfaces.push(surface);
        } else {
            warnings.push(PackageWarning {
                code: "app_surface_invalid".to_owned(),
                message: "ignored invalid App surface contribution".to_owned(),
                contribution: value.get("id").and_then(Value::as_str).map(str::to_owned),
            });
        }
    }
    PackageAppContributions {
        file_openers: parsed,
        preview_providers,
        surfaces,
    }
}

fn required_string(object: &Map<String, Value>, key: &str) -> Result<String, PluginError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| PluginError::invalid_manifest(format!("missing non-empty string `{key}`")))
}

fn parse_or_discover_skills(
    root: &Path,
    object: &Map<String, Value>,
    warnings: &mut Vec<PackageWarning>,
) -> Result<Vec<PackageSkill>, PluginError> {
    if let Some(value) = canonical_contribution(object, "agent.skills")
        .or_else(|| agent_contribution(object, "skills"))
    {
        let Some(items) = value.as_array() else {
            warnings.push(PackageWarning {
                code: "skills_invalid".to_owned(),
                message: "`skills` must be an array; falling back to discovery".to_owned(),
                contribution: None,
            });
            return discover_skills(root);
        };
        let mut skills = Vec::new();
        for item in items {
            let parsed = match item {
                Value::String(path) => skill_from_path(path),
                Value::Object(skill) => skill
                    .get("path")
                    .and_then(Value::as_str)
                    .and_then(skill_from_path),
                _ => None,
            };
            match parsed {
                Some(mut skill) if safe_relative_path(&skill.path) => {
                    let declared = root.join(&skill.path);
                    if declared.is_dir() && declared.join("SKILL.md").is_file() {
                        skill.path = format!("{}/SKILL.md", skill.path.trim_end_matches('/'));
                        skills.push(skill);
                    } else if declared.is_file() {
                        skills.push(skill);
                    } else {
                        warnings.push(PackageWarning {
                            code: "skill_invalid".to_owned(),
                            message: "ignored invalid or missing Skill contribution".to_owned(),
                            contribution: Some(skill.id),
                        });
                    }
                }
                _ => warnings.push(PackageWarning {
                    code: "skill_invalid".to_owned(),
                    message: "ignored invalid or missing Skill contribution".to_owned(),
                    contribution: None,
                }),
            }
        }
        return Ok(skills);
    }
    discover_skills(root)
}

fn discover_skills(root: &Path) -> Result<Vec<PackageSkill>, PluginError> {
    let skills_root = root.join("skills");
    if !skills_root.is_dir() {
        return Ok(Vec::new());
    }
    let mut skills = Vec::new();
    let entries = fs::read_dir(&skills_root)
        .map_err(|error| PluginError::io("discover plugin Skills", error))?;
    for entry in entries {
        let entry = entry.map_err(|error| PluginError::io("read Skill entry", error))?;
        if !entry.path().is_dir() {
            continue;
        }
        let skill_path = entry.path().join("SKILL.md");
        if skill_path.is_file() {
            let id = entry.file_name().to_string_lossy().into_owned();
            skills.push(PackageSkill {
                path: format!("skills/{id}/SKILL.md"),
                id,
            });
        }
    }
    skills.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(skills)
}

fn skill_from_path(path: &str) -> Option<PackageSkill> {
    let declared = Path::new(path);
    let id = if declared.file_name()?.to_str()? == "SKILL.md" {
        declared.parent()?.file_name()?.to_str()?.to_owned()
    } else {
        declared.file_name()?.to_str()?.to_owned()
    };
    Some(PackageSkill {
        id,
        path: path.to_owned(),
    })
}

fn safe_relative_path(path: &str) -> bool {
    !Path::new(path).is_absolute()
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn parse_runtimes(
    object: &Map<String, Value>,
    warnings: &mut Vec<PackageWarning>,
) -> Vec<RuntimeContribution> {
    let Some(items) = object
        .get("runtimes")
        .or_else(|| {
            object
                .get("contributes")
                .and_then(Value::as_object)
                .and_then(|contributes| contributes.get("runtimes"))
        })
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut runtimes = Vec::new();
    for item in items {
        let contribution = item.as_object().and_then(|runtime| {
            let id = runtime.get("id")?.as_str()?.to_owned();
            let command = runtime
                .get("command")
                .or_else(|| runtime.get("entrypoint"))?
                .as_str()?
                .to_owned();
            let (install, target, content_digest) = if let Some(install) = runtime.get("install") {
                (
                    serde_json::from_value::<RuntimeInstall>(install.clone()).ok()?,
                    external_runtime_target(),
                    String::new(),
                )
            } else if runtime.get("kind").and_then(Value::as_str) == Some("existing") {
                (
                    RuntimeInstall::Existing,
                    current_runtime_target(),
                    String::new(),
                )
            } else {
                let target = current_runtime_target();
                let distribution = runtime
                    .get("distributions")
                    .and_then(Value::as_object)
                    .and_then(|items| items.get(&target))?
                    .as_object()?;
                let sha256 = distribution.get("sha256")?.as_str()?.to_owned();
                (
                    RuntimeInstall::Binary {
                        url: distribution.get("url")?.as_str()?.to_owned(),
                        sha256: Some(sha256.clone()),
                    },
                    target,
                    format!("sha256:{sha256}"),
                )
            };
            let version = runtime
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let probe = runtime
                .get("probe")
                .and_then(|value| {
                    value.as_array().or_else(|| {
                        value
                            .as_object()
                            .and_then(|probe| probe.get("argv"))
                            .and_then(Value::as_array)
                    })
                })
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            Some(RuntimeContribution {
                id,
                command,
                version,
                target,
                content_digest,
                probe,
                install,
            })
        });
        match contribution {
            Some(runtime) => runtimes.push(runtime),
            None => {
                let id = item.get("id").and_then(Value::as_str).map(str::to_owned);
                warnings.push(PackageWarning {
                    code: "runtime_unsupported".to_owned(),
                    message: "ignored invalid or unsupported Runtime contribution".to_owned(),
                    contribution: id,
                });
            }
        }
    }
    runtimes
}

fn external_runtime_target() -> String {
    "external".to_owned()
}

fn current_runtime_target() -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "win32"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    format!("{os}-{arch}")
}

pub fn package_content_digest(root: &Path) -> Result<String, PluginError> {
    let root = root
        .canonicalize()
        .map_err(|error| PluginError::io("canonicalize Plugin package", error))?;
    let mut files = Vec::new();
    collect_digest_files(&root, &root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut rows = Vec::with_capacity(files.len());
    for (relative, absolute) in files {
        let contents = fs::read(&absolute)
            .map_err(|error| PluginError::io("read Plugin package file", error))?;
        rows.push(format!(
            "{}\0{}\0{:x}",
            relative,
            contents.len(),
            Sha256::digest(&contents)
        ));
    }
    Ok(format!("{:x}", Sha256::digest(rows.join("\n").as_bytes())))
}

fn collect_digest_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(String, PathBuf)>,
) -> Result<(), PluginError> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| PluginError::io("read Plugin package directory", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| PluginError::io("read Plugin package entry", error))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|error| PluginError::io("inspect Plugin package entry", error))?;
        if file_type.is_symlink() {
            return Err(PluginError::invalid_manifest(format!(
                "package symlink is not allowed: {}",
                entry.path().display()
            )));
        }
        let name = entry.file_name();
        if file_type.is_dir() && matches!(name.to_str(), Some(".git" | "node_modules")) {
            continue;
        }
        if file_type.is_dir() {
            collect_digest_files(root, &entry.path(), files)?;
            continue;
        }
        if !file_type.is_file() {
            return Err(PluginError::invalid_manifest(format!(
                "unsupported package entry: {}",
                entry.path().display()
            )));
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|error| PluginError::invalid_manifest(error.to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        if relative.ends_with(".vxp")
            || matches!(
                relative.as_str(),
                "config.json"
                    | ".vibex-plugin/package.lock.json"
                    | ".vibex-plugin/developer-link.json"
            )
        {
            continue;
        }
        files.push((relative, entry.path()));
    }
    Ok(())
}

fn copy_digest_files(source: &Path, target: &Path) -> Result<(), PluginError> {
    let mut files = Vec::new();
    collect_digest_files(source, source, &mut files)?;
    fs::create_dir_all(target)
        .map_err(|error| PluginError::io("create frozen candidate", error))?;
    for (relative, absolute) in files {
        let destination = target.join(&relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| PluginError::io("create candidate directory", error))?;
        }
        fs::copy(&absolute, &destination)
            .map_err(|error| PluginError::io("copy candidate file", error))?;
    }
    Ok(())
}

struct V4Contract<'a> {
    object: &'a Map<String, Value>,
    api_version: &'a str,
    publisher: Option<&'a str>,
    entrypoints: &'a PluginEntrypoints,
    app: &'a PackageAppContributions,
    permissions: &'a [CapabilityRequest],
    runtimes: &'a [RuntimeContribution],
    warnings: &'a [PackageWarning],
}

fn validate_v4_contract(contract: V4Contract<'_>) -> Result<(), PluginError> {
    let V4Contract {
        object,
        api_version,
        publisher,
        entrypoints,
        app,
        permissions,
        runtimes,
        warnings,
    } = contract;
    const TOP_LEVEL: &[&str] = &[
        "$schema",
        "manifestVersion",
        "apiVersion",
        "id",
        "publisher",
        "version",
        "name",
        "description",
        "readme",
        "content",
        "config",
        "_productContract",
        "engines",
        "entrypoints",
        "permissions",
        "contributes",
        "interface",
    ];
    if let Some(field) = object
        .keys()
        .find(|field| !TOP_LEVEL.contains(&field.as_str()))
    {
        return Err(PluginError::invalid_manifest(format!(
            "unknown v4 manifest field `{field}`"
        )));
    }
    if api_version != "1.0" {
        return Err(PluginError::invalid_manifest(format!(
            "unsupported v4 apiVersion `{api_version}`"
        )));
    }
    if publisher.is_none_or(str::is_empty) {
        return Err(PluginError::invalid_manifest(
            "v4 plugins require a non-empty publisher",
        ));
    }
    if !app.surfaces.is_empty()
        && (entrypoints.app.is_none()
            || entrypoints.app_document.is_none()
            || entrypoints.worker.is_none())
    {
        return Err(PluginError::invalid_manifest(
            "v4 App surfaces require valid App and Worker entrypoints",
        ));
    }
    if !app.preview_providers.is_empty() && entrypoints.worker.is_none() {
        return Err(PluginError::invalid_manifest(
            "v4 preview providers require a Worker entrypoint",
        ));
    }
    if let Some(entrypoints_value) = object.get("entrypoints") {
        let entrypoints_object = entrypoints_value
            .as_object()
            .ok_or_else(|| PluginError::invalid_manifest("v4 entrypoints must be an object"))?;
        if let Some(kind) = entrypoints_object
            .keys()
            .find(|kind| !matches!(kind.as_str(), "worker" | "app"))
        {
            return Err(PluginError::invalid_manifest(format!(
                "unknown v4 entrypoint `{kind}`"
            )));
        }
        if let Some(worker) = entrypoints_object.get("worker") {
            let worker = worker.as_object().ok_or_else(|| {
                PluginError::invalid_manifest("worker entrypoint must be an object")
            })?;
            let compiled_runtime = compiled_worker_runtime(worker)?;
            if !matches!(compiled_runtime.as_str(), "node" | "python" | "native") {
                return Err(PluginError::invalid_manifest(
                    "Worker must declare runtime node|python|native and protocol 1.1",
                ));
            }
        }
        if let Some(app) = entrypoints_object.get("app") {
            validate_v4_object_keys(app, "App entrypoint", &["root", "document", "protocol"])?;
            let app = app.as_object().expect("validated object");
            if app.get("protocol").and_then(Value::as_str) != Some("1.0")
                || app.get("document").and_then(Value::as_str).is_none()
            {
                return Err(PluginError::invalid_manifest(
                    "v4 App entrypoint requires document and protocol 1.0",
                ));
            }
        }
    }
    if let Some(warning) = warnings.iter().find(|warning| {
        matches!(
            warning.code.as_str(),
            "entrypoint_invalid"
                | "permissions_invalid"
                | "runtime_unsupported"
                | "app_file_opener_invalid"
                | "app_surface_invalid"
                | "preview_provider_invalid"
                | "invocation_invalid"
        )
    }) {
        return Err(PluginError::invalid_manifest(format!(
            "v4 package is incompatible: {}",
            warning.message
        )));
    }
    let declared_permission_count = object
        .get("permissions")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if declared_permission_count != permissions.len() {
        return Err(PluginError::invalid_manifest(
            "v4 package contains an invalid permission declaration",
        ));
    }
    if let Some(declarations) = object.get("permissions").and_then(Value::as_array) {
        let mut ids = std::collections::BTreeSet::new();
        let mut capabilities = std::collections::BTreeSet::new();
        for declaration in declarations {
            validate_v4_object_keys(
                declaration,
                "permission",
                &[
                    "id",
                    "capability",
                    "scope",
                    "reason",
                    "optional",
                    "trustTier",
                ],
            )?;
            let id = declaration
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| PluginError::invalid_manifest("v4 permission id is required"))?;
            if !ids.insert(id) {
                return Err(PluginError::invalid_manifest(format!(
                    "duplicate v4 permission `{id}`"
                )));
            }
            let capability = declaration
                .get("capability")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    PluginError::invalid_manifest("v4 permission capability is required")
                })?;
            if !capabilities.insert(capability) {
                return Err(PluginError::invalid_manifest(format!(
                    "duplicate v4 capability `{capability}`"
                )));
            }
        }
    }
    const CAPABILITIES: &[&str] = &["runtime.execute", "artifact.preview"];
    if let Some(permission) = permissions
        .iter()
        .find(|permission| !CAPABILITIES.contains(&permission.capability.as_str()))
    {
        return Err(PluginError::invalid_manifest(format!(
            "unknown v4 capability `{}`",
            permission.capability
        )));
    }
    if let Some(contributes) = object.get("contributes").and_then(Value::as_object) {
        const KINDS: &[&str] = &[
            "agent.skills",
            "agent.invocations",
            "agent.mcp",
            "app.fileOpeners",
            "app.surfaces",
            "artifact.previewProviders",
            "runtimes",
        ];
        if let Some(kind) = contributes
            .keys()
            .find(|kind| !KINDS.contains(&kind.as_str()))
        {
            return Err(PluginError::invalid_manifest(format!(
                "unknown required contribution kind `{kind}`"
            )));
        }
        for (kind, declarations) in contributes {
            if kind == "agent.mcp" {
                continue;
            }
            let declarations = declarations.as_array().ok_or_else(|| {
                PluginError::invalid_manifest(format!("v4 contribution `{kind}` must be an array"))
            })?;
            let mut ids = std::collections::BTreeSet::new();
            for declaration in declarations {
                validate_v4_contribution(kind, declaration)?;
                let id = declaration
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        PluginError::invalid_manifest(format!(
                            "v4 contribution `{kind}` requires id"
                        ))
                    })?;
                if !ids.insert(id) {
                    return Err(PluginError::invalid_manifest(format!(
                        "duplicate v4 contribution `{kind}/{id}`"
                    )));
                }
            }
        }
        validate_v4_contribution_references(contributes)?;
    }
    let engines = object
        .get("engines")
        .and_then(Value::as_object)
        .ok_or_else(|| PluginError::invalid_manifest("v4 plugins require engines"))?;
    if let Some(name) = engines
        .keys()
        .find(|name| !matches!(name.as_str(), "vibex" | "pluginSdk"))
    {
        return Err(PluginError::invalid_manifest(format!(
            "unknown v4 engine `{name}`"
        )));
    }
    for (name, actual) in [("vibex", env!("CARGO_PKG_VERSION")), ("pluginSdk", "1.0.0")] {
        let requirement = engines
            .get(name)
            .and_then(Value::as_str)
            .ok_or_else(|| PluginError::invalid_manifest(format!("engines.{name} is required")))?;
        let normalized_requirement = requirement
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(", ");
        let requirement = semver::VersionReq::parse(&normalized_requirement).map_err(|error| {
            PluginError::invalid_manifest(format!("invalid engines.{name}: {error}"))
        })?;
        let actual = semver::Version::parse(actual).map_err(|error| {
            PluginError::invalid_manifest(format!("invalid host {name} version: {error}"))
        })?;
        if !requirement.matches(&actual) {
            return Err(PluginError::invalid_manifest(format!(
                "engines.{name} does not support {actual}"
            )));
        }
    }
    if runtimes.iter().any(|runtime| {
        !matches!(
            runtime.install,
            RuntimeInstall::Existing
                | RuntimeInstall::Binary { .. }
                | RuntimeInstall::Archive { .. }
        )
    }) {
        return Err(PluginError::invalid_manifest(
            "v4 Runtime contributions must use existing, verified binary, or verified archive installers",
        ));
    }
    Ok(())
}

fn compiled_worker_runtime(worker: &Map<String, Value>) -> Result<String, PluginError> {
    if let Some(runtime) = worker.get("runtime").and_then(Value::as_str) {
        if worker.contains_key("format") {
            return Err(PluginError::invalid_manifest(
                "Worker format is not a public field; write runtime only",
            ));
        }
        if worker.get("protocol").and_then(Value::as_str) != Some("1.1") {
            return Err(PluginError::invalid_manifest(
                "Worker protocol must be 1.1 when runtime is declared",
            ));
        }
        return Ok(runtime.to_owned());
    }
    Err(PluginError::invalid_manifest(
        "Worker must declare runtime node|python|native and protocol 1.1",
    ))
}

fn validate_v4_contribution_references(
    contributes: &Map<String, Value>,
) -> Result<(), PluginError> {
    let ids = |kind: &str| {
        contributes
            .get(kind)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("id").and_then(Value::as_str))
            .collect::<std::collections::BTreeSet<_>>()
    };
    let skills = ids("agent.skills");
    let runtimes = ids("runtimes");
    let previews = ids("artifact.previewProviders");
    let surfaces = ids("app.surfaces");
    let require_reference =
        |kind: &str, reference: &str, available: &std::collections::BTreeSet<&str>| {
            if available.contains(reference) {
                Ok(())
            } else {
                Err(PluginError::invalid_manifest(format!(
                    "v4 {kind} references missing contribution `{reference}`"
                )))
            }
        };
    for opener in contributes
        .get("app.fileOpeners")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(provider) = opener.get("previewProvider").and_then(Value::as_str) {
            require_reference("file opener", provider, &previews)?;
        }
        if let Some(surface) = opener.get("editorSurface").and_then(Value::as_str) {
            require_reference("file opener", surface, &surfaces)?;
            let editor_surface = contributes
                .get("app.surfaces")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(surface));
            if editor_surface
                .and_then(|candidate| candidate.get("slot"))
                .and_then(Value::as_str)
                != Some("artifact.editor")
            {
                return Err(PluginError::invalid_manifest(format!(
                    "v4 file opener references non-editor App surface `{surface}`"
                )));
            }
        }
    }
    for provider in contributes
        .get("artifact.previewProviders")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(runtime) = provider.get("runtime").and_then(Value::as_str) {
            require_reference("preview provider", runtime, &runtimes)?;
        }
    }
    for invocation in contributes
        .get("agent.invocations")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(requires) = invocation.get("requires") {
            for skill in string_array(requires.get("skills")) {
                require_reference("invocation Skill", &skill, &skills)?;
            }
            for runtime in string_array(requires.get("runtimes")) {
                require_reference("invocation Runtime", &runtime, &runtimes)?;
            }
        }
        if let Some(provider) = invocation
            .pointer("/artifactIntent/previewProvider")
            .and_then(Value::as_str)
        {
            require_reference("invocation preview", provider, &previews)?;
        }
    }
    Ok(())
}

fn validate_v4_contribution(kind: &str, declaration: &Value) -> Result<(), PluginError> {
    let keys: &[&str] = match kind {
        "agent.skills" => &["id", "kindVersion", "path", "targets", "required"],
        "agent.invocations" => &[
            "id",
            "kindVersion",
            "label",
            "entrypoints",
            "handler",
            "promptBlocks",
            "requires",
            "artifactIntent",
            "required",
        ],
        "app.fileOpeners" => &[
            "id",
            "kindVersion",
            "label",
            "extensions",
            "fileNameSuffixes",
            "mediaTypes",
            "priority",
            "previewProvider",
            "editorSurface",
            "required",
        ],
        "app.surfaces" => &[
            "id",
            "kindVersion",
            "label",
            "slot",
            "appEntrypoint",
            "route",
            "handler",
            "allowedMethods",
            "minHeight",
            "nativeRenderer",
            "required",
        ],
        "artifact.previewProviders" => &[
            "id",
            "kindVersion",
            "mediaTypes",
            "runtime",
            "maxConcurrentPreviews",
            "handler",
            "process",
            "required",
        ],
        "runtimes" => &[
            "id",
            "kindVersion",
            "kind",
            "version",
            "entrypoint",
            "distributions",
            "probe",
            "required",
        ],
        _ => return Ok(()),
    };
    validate_v4_object_keys(declaration, kind, keys)?;
    if declaration.get("kindVersion").and_then(Value::as_u64) != Some(1) {
        return Err(PluginError::invalid_manifest(format!(
            "unsupported v4 contribution version for `{kind}`"
        )));
    }
    match kind {
        "app.fileOpeners" => {
            let has_preview = declaration
                .get("previewProvider")
                .and_then(Value::as_str)
                .is_some();
            let has_editor = declaration
                .get("editorSurface")
                .and_then(Value::as_str)
                .is_some();
            if has_preview == has_editor {
                return Err(PluginError::invalid_manifest(
                    "v4 file opener requires exactly one of previewProvider or editorSurface",
                ));
            }
        }
        "agent.invocations" => {
            if let Some(requires) = declaration.get("requires") {
                validate_v4_object_keys(requires, "invocation requires", &["skills", "runtimes"])?;
            }
            if let Some(intent) = declaration.get("artifactIntent") {
                validate_v4_object_keys(
                    intent,
                    "invocation artifactIntent",
                    &["mediaTypes", "previewProvider"],
                )?;
            }
            if let Some(blocks) = declaration.get("promptBlocks").and_then(Value::as_array) {
                for block in blocks {
                    validate_v4_object_keys(block, "invocation prompt block", &["type", "text"])?;
                }
            }
        }
        "artifact.previewProviders" => {
            if let Some(process) = declaration.get("process") {
                validate_v4_object_keys(
                    process,
                    "preview process",
                    &["argv", "readyTimeoutSeconds", "environment"],
                )?;
            }
        }
        "runtimes" => {
            if let Some(probe) = declaration.get("probe") {
                validate_v4_object_keys(
                    probe,
                    "Runtime probe",
                    &["argv", "timeoutSeconds", "versionPattern"],
                )?;
            }
            if let Some(distributions) = declaration.get("distributions").and_then(Value::as_object)
            {
                for distribution in distributions.values() {
                    validate_v4_object_keys(
                        distribution,
                        "Runtime distribution",
                        &["url", "sha256"],
                    )?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_v4_object_keys(value: &Value, label: &str, keys: &[&str]) -> Result<(), PluginError> {
    let object = value
        .as_object()
        .ok_or_else(|| PluginError::invalid_manifest(format!("v4 {label} must be an object")))?;
    if let Some(field) = object.keys().find(|field| !keys.contains(&field.as_str())) {
        return Err(PluginError::invalid_manifest(format!(
            "unknown v4 {label} field `{field}`"
        )));
    }
    Ok(())
}

fn agent_contribution<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    object.get(key).or_else(|| {
        object
            .get("contributes")
            .and_then(Value::as_object)
            .and_then(|contributes| contributes.get("agent"))
            .and_then(Value::as_object)
            .and_then(|agent| agent.get(key))
    })
}

fn canonical_contribution<'a>(object: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    object
        .get("contributes")
        .and_then(Value::as_object)
        .and_then(|contributes| contributes.get(key))
}

fn parse_canonical_invocations(
    object: &Map<String, Value>,
    warnings: &mut Vec<PackageWarning>,
) -> Vec<InvocationDefinition> {
    let Some(items) = canonical_contribution(object, "agent.invocations").and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut invocations = Vec::new();
    for item in items {
        let Some(definition) = item.as_object() else {
            warnings.push(invalid_invocation_warning(None));
            continue;
        };
        let Some(id) = definition.get("id").and_then(Value::as_str) else {
            warnings.push(invalid_invocation_warning(None));
            continue;
        };
        let label = definition
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_owned();
        let prompt = definition
            .get("promptBlocks")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|block| block.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        let required_skills = definition
            .get("requires")
            .and_then(Value::as_object)
            .and_then(|requires| requires.get("skills"))
            .map(|value| string_array(Some(value)))
            .unwrap_or_default();
        let required_runtimes = definition
            .get("requires")
            .and_then(Value::as_object)
            .and_then(|requires| requires.get("runtimes"))
            .map(|value| string_array(Some(value)))
            .unwrap_or_default();
        let skill = required_skills.first().cloned();
        let handler = definition
            .get("handler")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let artifact_intent = definition
            .get("artifactIntent")
            .and_then(Value::as_object)
            .and_then(|intent| {
                Some(crate::ArtifactIntent {
                    media_types: string_array(intent.get("mediaTypes")),
                    provider: intent.get("previewProvider")?.as_str()?.to_owned(),
                })
            });
        let kinds = definition
            .get("entrypoints")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter_map(|value| match value {
                "action" => Some(InvocationKind::Action),
                "command" => Some(InvocationKind::Command),
                _ => None,
            });
        for kind in kinds {
            invocations.push(InvocationDefinition {
                id: id.to_owned(),
                label: label.clone(),
                prompt: prompt.clone(),
                skill: skill.clone(),
                required_skills: required_skills.clone(),
                required_runtimes: required_runtimes.clone(),
                handler: handler.clone(),
                artifact_intent: artifact_intent.clone(),
                kind,
            });
        }
    }
    invocations
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn default_preview_concurrency() -> u32 {
    4
}

fn parse_invocations(
    value: Option<&Value>,
    kind: InvocationKind,
    warnings: &mut Vec<PackageWarning>,
) -> Vec<InvocationDefinition> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut invocations = Vec::new();
    for item in items {
        let Some(object) = item.as_object() else {
            warnings.push(invalid_invocation_warning(None));
            continue;
        };
        let Some(id) = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
        else {
            warnings.push(invalid_invocation_warning(None));
            continue;
        };
        let label = object
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_owned();
        let prompt = object
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                object
                    .get("promptBlocks")
                    .and_then(Value::as_array)
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter_map(|block| block.get("text").and_then(Value::as_str))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
            })
            .unwrap_or_default();
        let skill = object
            .get("skill")
            .and_then(Value::as_str)
            .map(str::to_owned);
        invocations.push(InvocationDefinition {
            id: id.to_owned(),
            label,
            prompt,
            required_skills: skill.iter().cloned().collect(),
            required_runtimes: Vec::new(),
            skill,
            handler: object
                .get("handler")
                .and_then(Value::as_str)
                .map(str::to_owned),
            artifact_intent: None,
            kind,
        });
    }
    invocations
}

fn invalid_invocation_warning(id: Option<String>) -> PackageWarning {
    PackageWarning {
        code: "invocation_invalid".to_owned(),
        message: "ignored invalid PluginAction or Plugin Command contribution".to_owned(),
        contribution: id,
    }
}

fn validate_storage_segment(id: &str) -> Result<(), PluginError> {
    if id.is_empty()
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err(PluginError::invalid_manifest(format!(
            "plugin id `{id}` cannot be used as a snapshot directory"
        )));
    }
    Ok(())
}

fn copy_snapshot_directory(source: &Path, target: &Path) -> Result<(), PluginError> {
    fs::create_dir_all(target)
        .map_err(|error| PluginError::io("create plugin snapshot target", error))?;
    let entries = fs::read_dir(source)
        .map_err(|error| PluginError::io("read plugin snapshot source", error))?;
    for entry in entries {
        let entry = entry.map_err(|error| PluginError::io("read plugin snapshot entry", error))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| PluginError::io("inspect plugin snapshot entry", error))?;
        if file_type.is_dir() {
            copy_snapshot_directory(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path)
                .map_err(|error| PluginError::io("copy plugin snapshot file", error))?;
        } else {
            return Err(PluginError::invalid_manifest(format!(
                "snapshot import refuses non-file entry `{}`",
                source_path.display()
            )));
        }
    }
    Ok(())
}

fn remove_snapshot_path(path: &Path) -> Result<(), PluginError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| PluginError::io("inspect plugin snapshot target", error))?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path).map_err(|error| PluginError::io("remove plugin snapshot file", error))
    } else {
        fs::remove_dir_all(path)
            .map_err(|error| PluginError::io("remove plugin snapshot directory", error))
    }
}

#[allow(dead_code)]
fn _stable_extension_map() -> BTreeMap<String, Value> {
    BTreeMap::new()
}
