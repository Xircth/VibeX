//! Discover Pi extension slash commands that `pi-acp` omits from ACP.
//!
//! `pi-acp` calls Pi `get_commands` then drops every command with
//! `source === "extension"` (`includeExtensionCommands: false`). Those
//! commands still execute when the user sends `/name`, because unknown
//! `/` prompts fall through to Pi RPC. This module restores discovery so
//! the composer `/` menu can list them.

use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use regex::Regex;
use serde_json::Value;

use crate::{AgentAvailableCommand, pi_trust::pi_agent_dir};

const MAX_FILES: usize = 400;
const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_WALK_DEPTH: usize = 6;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiExtensionCommand {
    pub name: String,
    pub description: Option<String>,
}

pub fn merge_pi_extension_commands(
    advertised: Vec<AgentAvailableCommand>,
    discovered: &[PiExtensionCommand],
) -> Vec<AgentAvailableCommand> {
    let mut seen = advertised
        .iter()
        .map(|command| normalize_command_name(&command.name))
        .collect::<std::collections::HashSet<_>>();
    let mut merged = advertised;
    for command in discovered {
        let name = normalize_command_name(&command.name);
        if name.is_empty() || !seen.insert(name.clone()) {
            continue;
        }
        merged.push(AgentAvailableCommand {
            name,
            description: command.description.clone(),
            input_schema: None,
        });
    }
    merged
}

pub fn merge_available_command_lists(
    advertised: Vec<AgentAvailableCommand>,
    extra: Vec<AgentAvailableCommand>,
) -> Vec<AgentAvailableCommand> {
    let discovered = extra
        .into_iter()
        .map(|command| PiExtensionCommand {
            name: command.name,
            description: command.description,
        })
        .collect::<Vec<_>>();
    merge_pi_extension_commands(advertised, &discovered)
}

/// Restore Pi extension commands that current `pi-acp` versions omit from ACP.
/// Other agents pass `advertised` through unchanged.
pub fn enrich_pi_available_commands(
    agent_id: &str,
    env: &HashMap<String, String>,
    working_dir: &Path,
    advertised: Vec<AgentAvailableCommand>,
) -> Vec<AgentAvailableCommand> {
    if agent_id != "pi" {
        return advertised;
    }
    let home = env
        .get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .map(PathBuf::from)
        .or_else(dirs::home_dir);
    let Some(home) = home else {
        return advertised;
    };
    let agent_dir = pi_agent_dir(&home, env);
    let discovered = discover_pi_extension_commands(&agent_dir, working_dir);
    merge_pi_extension_commands(advertised, &discovered)
}

pub fn discover_pi_extension_commands(agent_dir: &Path, cwd: &Path) -> Vec<PiExtensionCommand> {
    let mut commands = BTreeMap::new();
    let mut files_read = 0usize;

    scan_extension_tree(agent_dir.join("extensions"), &mut commands, &mut files_read);
    scan_extension_tree(
        cwd.join(".pi").join("extensions"),
        &mut commands,
        &mut files_read,
    );
    scan_extension_tree(agent_dir.join("npm"), &mut commands, &mut files_read);
    scan_extension_tree(agent_dir.join("git"), &mut commands, &mut files_read);
    scan_extension_tree(cwd.join(".pi").join("npm"), &mut commands, &mut files_read);
    scan_extension_tree(cwd.join(".pi").join("git"), &mut commands, &mut files_read);

    let settings = read_json_object(&agent_dir.join("settings.json"));
    let project_settings = read_json_object(&cwd.join(".pi").join("settings.json"));
    for settings in [&settings, &project_settings] {
        collect_settings_extension_files(settings, agent_dir, cwd, &mut commands, &mut files_read);
    }

    commands.into_values().collect()
}

fn collect_settings_extension_files(
    settings: &Value,
    agent_dir: &Path,
    cwd: &Path,
    commands: &mut BTreeMap<String, PiExtensionCommand>,
    files_read: &mut usize,
) {
    if let Some(entries) = settings.get("extensions").and_then(Value::as_array) {
        for entry in entries {
            let Some(raw) = entry
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            let path = resolve_pi_path(raw, agent_dir, cwd);
            if path.is_dir() {
                scan_extension_tree(path, commands, files_read);
            } else {
                scan_extension_file(&path, commands, files_read);
            }
        }
    }
    if let Some(entries) = settings.get("packages").and_then(Value::as_array) {
        for entry in entries {
            let source = match entry {
                Value::String(source) => source.as_str(),
                Value::Object(object) => object
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                _ => continue,
            };
            let path = package_source_path(source, agent_dir, cwd);
            if let Some(path) = path {
                scan_extension_tree(path, commands, files_read);
            }
        }
    }
}

fn package_source_path(source: &str, agent_dir: &Path, cwd: &Path) -> Option<PathBuf> {
    let source = source.trim();
    if source.is_empty() {
        return None;
    }
    if source.starts_with("npm:") {
        return None;
    }
    if source.starts_with("git:") || source.contains("://") {
        return None;
    }
    Some(resolve_pi_path(source, agent_dir, cwd))
}

fn resolve_pi_path(raw: &str, agent_dir: &Path, cwd: &Path) -> PathBuf {
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        return path;
    }
    if raw.starts_with("~/") {
        if let Some(home) = agent_dir.parent().and_then(Path::parent) {
            return home.join(&raw[2..]);
        }
    }
    if raw.starts_with(".pi/") || raw.starts_with("./") {
        return cwd.join(raw);
    }
    agent_dir.join(raw)
}

fn scan_extension_tree(
    root: PathBuf,
    commands: &mut BTreeMap<String, PiExtensionCommand>,
    files_read: &mut usize,
) {
    let mut stack = vec![(root, 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_WALK_DEPTH || *files_read >= MAX_FILES {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if *files_read >= MAX_FILES {
                break;
            }
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                if should_skip_dir(&path) {
                    continue;
                }
                stack.push((path, depth + 1));
                continue;
            }
            if file_type.is_file() && is_extension_source(&path) {
                scan_extension_file(&path, commands, files_read);
            }
        }
    }
}

fn should_skip_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    match name {
        ".git" | "coverage" | "test" | "tests" => true,
        // Published Pi packages often ship only compiled JS in `dist/`.
        // Walk that folder inside `npm/`/`git/` stores; skip user-extension
        // build output so `src/` remains the source of truth there.
        "dist" => !is_under_pi_package_store(path),
        // `pi install npm:` puts packages in `npm/node_modules`. Walk that
        // store, but skip nested dependency trees inside each package.
        "node_modules" => !is_pi_package_store(path),
        _ => false,
    }
}

fn is_pi_package_store(node_modules: &Path) -> bool {
    matches!(
        node_modules
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str()),
        Some("npm" | "git")
    )
}

fn is_under_pi_package_store(path: &Path) -> bool {
    path.ancestors().any(|ancestor| {
        ancestor.file_name().and_then(|name| name.to_str()) == Some("node_modules")
            && is_pi_package_store(ancestor)
    })
}

fn is_extension_source(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("ts" | "js" | "mts" | "mjs" | "cts" | "cjs")
    )
}

fn scan_extension_file(
    path: &Path,
    commands: &mut BTreeMap<String, PiExtensionCommand>,
    files_read: &mut usize,
) {
    if *files_read >= MAX_FILES {
        return;
    }
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return;
    }
    let Ok(source) = fs::read_to_string(path) else {
        return;
    };
    *files_read += 1;
    for command in parse_register_commands(&source) {
        commands.entry(command.name.clone()).or_insert(command);
    }
}

fn parse_register_commands(source: &str) -> Vec<PiExtensionCommand> {
    let pattern = register_command_pattern();
    let matches = pattern
        .captures_iter(source)
        .filter_map(|captures| {
            let name = normalize_command_name(captures.get(1)?.as_str());
            if name.is_empty() {
                return None;
            }
            Some((name, captures.get(0)?.end()))
        })
        .collect::<Vec<_>>();
    matches
        .iter()
        .map(|(name, end)| {
            let rest = source.get(*end..).unwrap_or("");
            let window_end = rest.len().min(1200);
            let window = rest.get(..window_end).unwrap_or(rest);
            PiExtensionCommand {
                name: name.clone(),
                description: parse_description(window),
            }
        })
        .collect()
}

fn register_command_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(concat!(
            r#"registerCommand\(\s*(?:"|'|`)"#,
            r#"([0-9A-Za-z][0-9A-Za-z_.:\-]*)"#,
            r#"(?:"|'|`)"#,
        ))
        .expect("registerCommand pattern")
    })
}

fn parse_description(object_body: &str) -> Option<String> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(concat!(
            r#"description\s*:\s*(?:"|'|`)"#,
            r#"([^"'`]+)"#,
            r#"(?:"|'|`)"#,
        ))
        .expect("description pattern")
    });
    pattern
        .captures(object_body)
        .and_then(|captures| captures.get(1))
        .map(|value| value.as_str().trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_command_name(name: &str) -> String {
    name.trim().trim_start_matches('/').to_string()
}

fn read_json_object(path: &Path) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .filter(Value::is_object)
        .unwrap_or(Value::Object(Default::default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AgentAvailableCommand;

    #[test]
    fn merge_appends_extension_commands_the_adapter_dropped() {
        let advertised = vec![AgentAvailableCommand {
            name: "compact".into(),
            description: Some("Compact".into()),
            input_schema: None,
        }];
        let discovered = vec![
            PiExtensionCommand {
                name: "worktree".into(),
                description: Some("Manage worktrees".into()),
            },
            PiExtensionCommand {
                name: "/compact".into(),
                description: Some("duplicate".into()),
            },
        ];

        let merged = merge_pi_extension_commands(advertised, &discovered);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].name, "compact");
        assert_eq!(merged[1].name, "worktree");
        assert_eq!(merged[1].description.as_deref(), Some("Manage worktrees"));
    }

    #[test]
    fn discovers_register_command_calls_from_user_and_project_extensions() {
        let root = tempfile::tempdir().unwrap();
        let agent_dir = root.path().join("agent");
        let cwd = root.path().join("repo");
        fs::create_dir_all(agent_dir.join("extensions")).unwrap();
        fs::create_dir_all(cwd.join(".pi/extensions")).unwrap();
        fs::write(
            agent_dir.join("extensions/worktree.ts"),
            r#"
export default function (pi) {
  pi.registerCommand("worktree", {
    description: "Manage git worktrees",
    handler: async () => {},
  });
}
"#,
        )
        .unwrap();
        fs::write(
            cwd.join(".pi/extensions/review.js"),
            r#"
pi.registerCommand('review-pr', { description: 'Review the current PR', handler() {} });
"#,
        )
        .unwrap();

        let commands = discover_pi_extension_commands(&agent_dir, &cwd);
        let names = commands
            .iter()
            .map(|command| command.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["review-pr", "worktree"]);
        assert_eq!(
            commands
                .iter()
                .find(|command| command.name == "worktree")
                .and_then(|command| command.description.as_deref()),
            Some("Manage git worktrees")
        );
    }

    #[test]
    fn discovers_commands_from_npm_node_modules_packages() {
        let root = tempfile::tempdir().unwrap();
        let agent_dir = root.path().join("agent");
        let cwd = root.path().join("repo");
        let package = agent_dir.join("npm/node_modules/@scope/worktree/extensions");
        fs::create_dir_all(&package).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        fs::write(
            package.join("index.ts"),
            r#"pi.registerCommand("worktree", { description: "Manage git worktrees", handler() {} });"#,
        )
        .unwrap();
        let nested_dep = package.parent().unwrap().join("node_modules/left-pad");
        fs::create_dir_all(&nested_dep).unwrap();
        fs::write(
            nested_dep.join("index.js"),
            r#"pi.registerCommand("ignored-dep", { description: "dependency", handler() {} });"#,
        )
        .unwrap();

        let commands = discover_pi_extension_commands(&agent_dir, &cwd);
        let names = commands
            .iter()
            .map(|command| command.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["worktree"]);
        assert_eq!(
            commands[0].description.as_deref(),
            Some("Manage git worktrees")
        );
    }

    #[test]
    fn discovers_commands_from_compiled_dist_inside_npm_packages() {
        let root = tempfile::tempdir().unwrap();
        let agent_dir = root.path().join("agent");
        let cwd = root.path().join("repo");
        let dist = agent_dir.join("npm/node_modules/pi-jarvis/dist");
        let local_src = agent_dir.join("extensions/local/src");
        let local_dist = agent_dir.join("extensions/local/dist");
        fs::create_dir_all(&dist).unwrap();
        fs::create_dir_all(&local_src).unwrap();
        fs::create_dir_all(&local_dist).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        fs::write(
            dist.join("index.js"),
            r#"pi.registerCommand("jarvis", { description: "Ask Jarvis", handler() {} });"#,
        )
        .unwrap();
        fs::write(
            local_dist.join("index.js"),
            r#"pi.registerCommand("local-dist", { description: "user build output", handler() {} });"#,
        )
        .unwrap();
        fs::write(
            local_src.join("index.ts"),
            r#"pi.registerCommand("local-src", { description: "user source", handler() {} });"#,
        )
        .unwrap();

        let commands = discover_pi_extension_commands(&agent_dir, &cwd);
        let names = commands
            .iter()
            .map(|command| command.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["jarvis", "local-src"]);
    }

    #[test]
    fn discovers_path_package_and_settings_extension_files() {
        let root = tempfile::tempdir().unwrap();
        let agent_dir = root.path().join("agent");
        let cwd = root.path().join("repo");
        let package = root.path().join("local-package/extensions");
        fs::create_dir_all(&agent_dir).unwrap();
        fs::create_dir_all(&package).unwrap();
        fs::create_dir_all(cwd.join(".pi")).unwrap();
        fs::write(
            package.join("mcp.ts"),
            r#"pi.registerCommand("mcp", { description: "MCP adapter", handler: async () => {} });"#,
        )
        .unwrap();
        fs::write(
            agent_dir.join("settings.json"),
            serde_json::json!({
                "packages": [package.parent().unwrap().to_string_lossy()],
                "extensions": ["extra.ts"]
            })
            .to_string(),
        )
        .unwrap();
        fs::write(
            agent_dir.join("extra.ts"),
            r#"pi.registerCommand("jarvis", { description: "Ask Jarvis", handler() {} });"#,
        )
        .unwrap();

        let commands = discover_pi_extension_commands(&agent_dir, &cwd);
        let names = commands
            .iter()
            .map(|command| command.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["jarvis", "mcp"]);
    }

    #[test]
    fn discovers_commands_when_the_handler_object_contains_nested_braces() {
        let source = r#"
pi.registerCommand("nested", {
  handler: async () => { return 1; },
  description: "Works with nested braces",
});
"#;
        let commands = parse_register_commands(source);
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].name, "nested");
        assert_eq!(
            commands[0].description.as_deref(),
            Some("Works with nested braces")
        );
    }

    #[test]
    fn enrich_is_a_no_op_for_agents_that_already_advertise_plugin_commands() {
        let advertised = vec![AgentAvailableCommand {
            name: "compact".into(),
            description: Some("Compact".into()),
            input_schema: None,
        }];
        for agent_id in ["claude_code", "codex", "grok"] {
            let merged = enrich_pi_available_commands(
                agent_id,
                &HashMap::new(),
                Path::new("/tmp"),
                advertised.clone(),
            );
            assert_eq!(merged, advertised, "{agent_id} must keep ACP commands");
        }
    }

    #[test]
    fn enrich_seeds_pi_extension_commands_when_acp_omits_them() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path();
        let agent_dir = home.join(".pi/agent");
        let cwd = root.path().join("repo");
        fs::create_dir_all(agent_dir.join("extensions")).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        fs::write(
            agent_dir.join("extensions/worktree.ts"),
            r#"pi.registerCommand("worktree", { description: "Manage git worktrees", handler() {} });"#,
        )
        .unwrap();

        let env = HashMap::from([("HOME".to_string(), home.to_string_lossy().into_owned())]);
        let merged = enrich_pi_available_commands(
            "pi",
            &env,
            &cwd,
            vec![AgentAvailableCommand {
                name: "compact".into(),
                description: Some("Compact".into()),
                input_schema: None,
            }],
        );
        assert_eq!(
            merged
                .iter()
                .map(|command| command.name.as_str())
                .collect::<Vec<_>>(),
            vec!["compact", "worktree"]
        );
    }
}
