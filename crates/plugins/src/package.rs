use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

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
    DeveloperLink,
    CodexNative,
    ClaudeCodeNative,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSource {
    pub kind: PluginSourceKind,
    pub path: PathBuf,
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
    Shell {
        command: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeContribution {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub version: Option<String>,
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
    pub kind: InvocationKind,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackage {
    pub id: PluginId,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub source: PluginSource,
    pub formats: Vec<PackageFormat>,
    pub skills: Vec<PackageSkill>,
    pub runtimes: Vec<RuntimeContribution>,
    #[serde(default)]
    pub invocations: Vec<InvocationDefinition>,
    pub warnings: Vec<PackageWarning>,
    pub extensions: Map<String, Value>,
    pub manifest: Value,
}

impl PluginPackage {
    pub fn materialize(
        source: &Path,
        storage_root: &Path,
        source_kind: PluginSourceKind,
    ) -> Result<Self, PluginError> {
        if source_kind != PluginSourceKind::Snapshot {
            return Self::inspect(source, source_kind);
        }
        let incoming = Self::inspect(source, PluginSourceKind::Snapshot)?;
        validate_storage_segment(incoming.id.as_str())?;
        fs::create_dir_all(storage_root)
            .map_err(|error| PluginError::io("create plugin snapshot directory", error))?;
        let storage_root = storage_root
            .canonicalize()
            .map_err(|error| PluginError::io("resolve plugin snapshot directory", error))?;
        let target = storage_root.join(incoming.id.as_str());
        if source.canonicalize().ok().as_ref() == Some(&target) {
            return Self::inspect(&target, PluginSourceKind::Snapshot);
        }
        let staging = storage_root.join(format!(".{}.incoming", incoming.id.as_str()));
        if staging.exists() {
            remove_snapshot_path(&staging)?;
        }
        copy_snapshot_directory(source, &staging)?;
        // Validate the complete staged tree before replacing a prior snapshot.
        Self::inspect(&staging, PluginSourceKind::Snapshot)?;
        if target.exists() {
            remove_snapshot_path(&target)?;
        }
        fs::rename(&staging, &target)
            .map_err(|error| PluginError::io("activate plugin snapshot", error))?;
        Self::inspect(&target, PluginSourceKind::Snapshot)
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
        let manifest: Value = serde_json::from_str(&manifest_text)
            .map_err(|error| PluginError::invalid_manifest(error.to_string()))?;
        let object = manifest.as_object().ok_or_else(|| {
            PluginError::invalid_manifest("portable plugin manifest must be a JSON object")
        })?;
        let id = required_string(object, "id")?;
        let name = required_string(object, "name")?;
        let version = required_string(object, "version")?;
        let description = object
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned);

        let mut formats = vec![PackageFormat::VibeX];
        if root.join(".codex-plugin/plugin.json").is_file() {
            formats.push(PackageFormat::Codex);
        }
        if root.join(".claude-plugin/plugin.json").is_file() {
            formats.push(PackageFormat::ClaudeCode);
        }

        let mut warnings = Vec::new();
        let skills = parse_or_discover_skills(root, object, &mut warnings)?;
        if skills.is_empty() {
            return Err(PluginError::skill_required(&id));
        }
        let runtimes = parse_runtimes(object, &mut warnings);
        let mut invocations =
            parse_invocations(object.get("actions"), InvocationKind::Action, &mut warnings);
        invocations.extend(parse_invocations(
            object.get("commands"),
            InvocationKind::Command,
            &mut warnings,
        ));
        let known = [
            "$schema",
            "id",
            "name",
            "version",
            "description",
            "author",
            "icon",
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
            id: PluginId::from_string(id),
            name,
            version,
            description,
            source: PluginSource {
                kind: source_kind,
                path: source_path,
            },
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
            id: PluginId::from_string(id.to_owned()),
            name: name.to_owned(),
            version: version.to_owned(),
            description: None,
            source: PluginSource {
                kind: source_kind,
                path: root.canonicalize().unwrap_or_else(|_| root.to_path_buf()),
            },
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
    if let Some(value) = object.get("skills") {
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
                Some(skill)
                    if safe_relative_path(&skill.path) && root.join(&skill.path).is_file() =>
                {
                    skills.push(skill);
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
    let id = Path::new(path).parent()?.file_name()?.to_str()?.to_owned();
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
    let Some(items) = object.get("runtimes").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut runtimes = Vec::new();
    for item in items {
        let contribution = item.as_object().and_then(|runtime| {
            let id = runtime.get("id")?.as_str()?.to_owned();
            let command = runtime.get("command")?.as_str()?.to_owned();
            let install = runtime.get("install")?.clone();
            let install = serde_json::from_value::<RuntimeInstall>(install).ok()?;
            let version = runtime
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let probe = runtime
                .get("probe")
                .and_then(Value::as_array)
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
        invocations.push(InvocationDefinition {
            id: id.to_owned(),
            label,
            prompt,
            skill: object
                .get("skill")
                .and_then(Value::as_str)
                .map(str::to_owned),
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
