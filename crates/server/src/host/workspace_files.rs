//! Read-only workspace browsing for Companion devices (`artifact.read`).
//!
//! Every path is relative to the workspace root and is resolved inside it; nothing
//! here can name an absolute path, leave the root through `..` or a symlink, or
//! read hidden files (apart from a few project config files), VCS internals and
//! credential files. A scratch workspace's root can be the user's home directory,
//! so the policy cannot rely on the root being a clean project.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use application::ApplicationError;
use db::models::{project::Project, workspace_repo::WorkspaceRepo};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

const MAX_ENTRIES: usize = 500;
const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_DIFF_BYTES: usize = 200 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspacePathArgs {
    workspace_id: Uuid,
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceArgs {
    workspace_id: Uuid,
}

#[derive(Debug, Serialize)]
struct TreeEntry {
    name: String,
    path: String,
    directory: bool,
}

#[derive(Debug, Serialize)]
struct Tree {
    path: String,
    entries: Vec<TreeEntry>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
struct FileContent {
    path: String,
    size: u64,
    binary: bool,
    truncated: bool,
    content: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSummary {
    id: Uuid,
    name: String,
    root_path: String,
    parent_project_id: Option<Uuid>,
    is_git: bool,
    is_home: bool,
    workspace_ids: Vec<Uuid>,
}

impl ServerApplicationDomains {
    /// Imported projects (matching the desktop's "已导入项目" list) with their workspaces,
    /// ensuring each project has a root workspace so Companion devices can start conversations in it.
    pub(crate) async fn conversation_projects(&self) -> Result<Value, ApplicationError> {
        let _ = self
            .deployment
            .project()
            .migrate_multi_repo_projects(&self.pool, self.deployment.repo())
            .await;
        let _ = self
            .deployment
            .project()
            .ensure_home_project(&self.pool, self.deployment.repo())
            .await;
        let projects = Project::find_all(&self.pool)
            .await
            .map_err(internal_error)?;
        for project in &projects {
            let _ = self.ensure_root_workspace(project.id, None).await;
        }
        let rows = sqlx::query_as::<_, (Uuid, Uuid)>(
            r#"SELECT project_id, id
               FROM workspaces
               WHERE project_id IS NOT NULL
               ORDER BY use_worktree ASC, created_at DESC"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(internal_error)?;
        let mut by_project: HashMap<Uuid, Vec<Uuid>> = HashMap::new();
        for (project_id, workspace_id) in rows {
            by_project.entry(project_id).or_default().push(workspace_id);
        }
        let summaries: Vec<ProjectSummary> = projects
            .into_iter()
            .map(|project| ProjectSummary {
                workspace_ids: by_project.remove(&project.id).unwrap_or_default(),
                id: project.id,
                name: project.name,
                root_path: project.root_path,
                parent_project_id: project.parent_project_id,
                is_git: project.is_git,
                is_home: project.is_home,
            })
            .collect();
        serialize(summaries)
    }

    /// The directory the Agent works in; scratch workspaces have one even without a repository.
    async fn browsable_root(&self, workspace_id: Uuid) -> Result<PathBuf, ApplicationError> {
        db::SqliteConversationRepository::new(self.pool.clone())
            .workspace_root(workspace_id)
            .await
            .map_err(internal_error)?
            .map(PathBuf::from)
            .ok_or_else(|| ApplicationError::not_found("workspace"))
    }

    pub(crate) async fn conversation_workspace_tree(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: WorkspacePathArgs = parse(args)?;
        let root = self.browsable_root(args.workspace_id).await?;
        let tree = tokio::task::spawn_blocking(move || list_directory(&root, &args.path))
            .await
            .map_err(internal_error)??;
        serialize(tree)
    }

    pub(crate) async fn conversation_workspace_file(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: WorkspacePathArgs = parse(args)?;
        let root = self.browsable_root(args.workspace_id).await?;
        let file = tokio::task::spawn_blocking(move || read_text_file(&root, &args.path))
            .await
            .map_err(internal_error)??;
        serialize(file)
    }

    /// Unified diffs of the working tree against HEAD, one entry per changed file.
    pub(crate) async fn conversation_workspace_diff(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: WorkspaceArgs = parse(args)?;
        let repositories = WorkspaceRepo::find_repos_for_workspace(&self.pool, args.workspace_id)
            .await
            .map_err(internal_error)?;
        if repositories.is_empty() {
            // A workspace without a repository simply has no changes to show.
            return Ok(Value::Array(Vec::new()));
        }
        let root = self.primary_worktree(args.workspace_id, None).await?;
        let root_for_untracked = root.clone();
        let mut diffs = self.git_read(root, git::GitService::get_file_diffs).await?;
        if let Some(entries) = diffs.as_array_mut() {
            for entry in entries {
                populate_missing_diff(&root_for_untracked, entry);
                bound_diff(entry);
            }
        }
        Ok(diffs)
    }
}

/// Populates a synthetic unified diff (`@@ -0,0 +1,N @@`) for untracked (`?`) or newly added (`A`)
/// text files whose `diff` payload from `git diff HEAD` is empty, so Companion devices can always
/// display their line-by-line additions.
fn populate_missing_diff(root: &Path, entry: &mut Value) {
    let Some(object) = entry.as_object_mut() else {
        return;
    };
    let is_binary = object
        .get("is_binary")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if is_binary {
        return;
    }
    let diff_empty = object
        .get("diff")
        .and_then(Value::as_str)
        .map(|s| s.trim().is_empty())
        .unwrap_or(true);
    if !diff_empty {
        return;
    }
    let status = object.get("status").and_then(Value::as_str).unwrap_or("");
    if status == "D" {
        return;
    }
    let Some(path) = object.get("path").and_then(Value::as_str) else {
        return;
    };
    let Ok(file) = read_text_file(root, path) else {
        return;
    };
    if file.binary {
        object.insert("is_binary".to_string(), Value::Bool(true));
        return;
    }
    let Some(content) = file.content else {
        return;
    };
    let mut lines: Vec<&str> = content.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    if lines.is_empty() {
        return;
    }
    let mut synth = format!("@@ -0,0 +1,{} @@\n", lines.len());
    for line in lines {
        synth.push('+');
        synth.push_str(line.trim_end_matches('\r'));
        synth.push('\n');
        if synth.len() > MAX_DIFF_BYTES {
            break;
        }
    }
    object.insert("diff".to_string(), Value::String(synth));
}

/// Keeps a phone-sized payload: an oversized diff is cut at a line boundary and flagged.
fn bound_diff(entry: &mut Value) {
    let Some(object) = entry.as_object_mut() else {
        return;
    };
    let mut truncated = false;
    if let Some(Value::String(diff)) = object.get_mut("diff")
        && diff.len() > MAX_DIFF_BYTES
    {
        let mut end = MAX_DIFF_BYTES;
        while !diff.is_char_boundary(end) {
            end -= 1;
        }
        let cut = diff[..end].rfind('\n').unwrap_or(end);
        diff.truncate(cut);
        truncated = true;
    }
    object.insert("truncated".to_string(), Value::Bool(truncated));
}

fn forbidden(reason: &str) -> ApplicationError {
    ApplicationError::forbidden(reason)
}

/// Hidden project files that are safe and useful to read from a phone.
const VISIBLE_DOT_NAMES: &[&str] = &[
    ".github",
    ".vscode",
    ".claude",
    ".agents",
    ".cursor",
    ".codex",
    ".vibex-plugin",
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".prettierrc",
    ".eslintrc",
    ".babelrc",
    ".npmrc",
    ".yarnrc",
    ".nvmrc",
    ".node-version",
];

/// Names that hold credentials wherever they appear.
fn is_credential_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".pem")
        || lower.ends_with(".key")
        || lower.ends_with(".p12")
        || lower.ends_with(".pfx")
        || lower.starts_with("id_rsa")
        || lower.starts_with("id_ed25519")
        || lower.starts_with("id_ecdsa")
        || lower == "credentials"
        || lower == ".netrc"
}

/// A name the phone may list and read.
fn is_readable_name(name: &str) -> bool {
    if is_credential_name(name) {
        return false;
    }
    !name.starts_with('.')
        || VISIBLE_DOT_NAMES
            .iter()
            .any(|allowed| name.starts_with(allowed))
}

/// Resolves `relative` below `root`, refusing anything that could escape or expose secrets.
fn resolve_inside(root: &Path, relative: &str) -> Result<PathBuf, ApplicationError> {
    let relative_path = Path::new(relative);
    for component in relative_path.components() {
        match component {
            Component::Normal(name) => {
                if !is_readable_name(&name.to_string_lossy()) {
                    return Err(forbidden("this path is not readable from a paired device"));
                }
            }
            Component::CurDir => {}
            _ => return Err(ApplicationError::bad_request("path must be relative")),
        }
    }
    let root = root
        .canonicalize()
        .map_err(|_| ApplicationError::not_found("workspace directory"))?;
    let resolved = root
        .join(relative_path)
        .canonicalize()
        .map_err(|_| ApplicationError::not_found(format!("path {relative}")))?;
    if !resolved.starts_with(&root) {
        return Err(forbidden("path is outside the workspace"));
    }
    Ok(resolved)
}

fn relative_string(root: &Path, resolved: &Path) -> String {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    resolved
        .strip_prefix(&root)
        .unwrap_or(resolved)
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn list_directory(root: &Path, relative: &str) -> Result<Tree, ApplicationError> {
    let directory = resolve_inside(root, relative)?;
    if !directory.is_dir() {
        return Err(ApplicationError::bad_request("path is not a directory"));
    }
    let base = relative_string(root, &directory);
    let mut entries = Vec::new();
    let mut truncated = false;
    let read = std::fs::read_dir(&directory).map_err(internal_error)?;
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !is_readable_name(&name) {
            continue;
        }
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let directory = entry.path().is_dir();
        let path = if base.is_empty() {
            name.clone()
        } else {
            format!("{base}/{name}")
        };
        entries.push(TreeEntry {
            name,
            path,
            directory,
        });
    }
    entries.sort_by(|left, right| {
        right
            .directory
            .cmp(&left.directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(Tree {
        path: base,
        entries,
        truncated,
    })
}

fn read_text_file(root: &Path, relative: &str) -> Result<FileContent, ApplicationError> {
    let file = resolve_inside(root, relative)?;
    let metadata = std::fs::metadata(&file).map_err(internal_error)?;
    if !metadata.is_file() {
        return Err(ApplicationError::bad_request("path is not a file"));
    }
    let size = metadata.len();
    let path = relative_string(root, &file);
    let mut bytes = Vec::new();
    {
        use std::io::Read;
        std::fs::File::open(&file)
            .map_err(internal_error)?
            .take(MAX_FILE_BYTES as u64)
            .read_to_end(&mut bytes)
            .map_err(internal_error)?;
    }
    if bytes.contains(&0) {
        return Ok(FileContent {
            path,
            size,
            binary: true,
            truncated: false,
            content: None,
        });
    }
    let truncated = size > MAX_FILE_BYTES as u64;
    // A cut can land inside a multi-byte character; lossy decoding keeps the readable prefix.
    let content = String::from_utf8_lossy(&bytes).into_owned();
    Ok(FileContent {
        path,
        size,
        binary: false,
        truncated,
        content: Some(content),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir.path().join("src/nested")).unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join("README.md"), "# hello\n").unwrap();
        std::fs::write(dir.path().join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(dir.path().join(".env"), "SECRET=1\n").unwrap();
        std::fs::write(dir.path().join(".gitignore"), "target\n").unwrap();
        std::fs::create_dir_all(dir.path().join(".ssh")).unwrap();
        std::fs::write(dir.path().join(".ssh/id_rsa"), "key").unwrap();
        std::fs::write(dir.path().join("server.pem"), "key").unwrap();
        std::fs::write(dir.path().join("blob.bin"), [0u8, 1, 2]).unwrap();
        dir
    }

    #[test]
    fn lists_one_level_directories_first_and_hides_secrets() {
        let dir = workspace();
        let root = list_directory(dir.path(), "").unwrap();
        let names: Vec<_> = root
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, ["src", ".gitignore", "blob.bin", "README.md"]);
        let src = list_directory(dir.path(), "src").unwrap();
        assert_eq!(src.path, "src");
        assert_eq!(
            src.entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["src/nested", "src/main.rs"]
        );
    }

    #[test]
    fn refuses_to_leave_the_workspace_or_read_secrets() {
        let dir = workspace();
        assert!(read_text_file(dir.path(), "../outside").is_err());
        assert!(read_text_file(dir.path(), "/etc/passwd").is_err());
        assert!(read_text_file(dir.path(), ".env").is_err());
        assert!(read_text_file(dir.path(), ".ssh/id_rsa").is_err());
        assert!(read_text_file(dir.path(), "server.pem").is_err());
        assert!(read_text_file(dir.path(), ".gitignore").is_ok());
        assert!(list_directory(dir.path(), ".git").is_err());
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(outside.path().join("secret.txt"), "x").unwrap();
            std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
            assert!(read_text_file(dir.path(), "link/secret.txt").is_err());
        }
    }

    #[test]
    fn reads_text_and_flags_binary_and_oversize() {
        let dir = workspace();
        let readme = read_text_file(dir.path(), "README.md").unwrap();
        assert_eq!(readme.content.as_deref(), Some("# hello\n"));
        assert!(!readme.binary && !readme.truncated);
        let blob = read_text_file(dir.path(), "blob.bin").unwrap();
        assert!(blob.binary && blob.content.is_none());
        std::fs::write(dir.path().join("big.txt"), "a".repeat(MAX_FILE_BYTES + 10)).unwrap();
        let big = read_text_file(dir.path(), "big.txt").unwrap();
        assert!(big.truncated);
        assert_eq!(big.content.unwrap().len(), MAX_FILE_BYTES);
    }

    #[test]
    fn oversized_diffs_are_cut_at_a_line_and_flagged() {
        let mut entry = serde_json::json!({ "path": "a", "diff": "x\n".repeat(MAX_DIFF_BYTES) });
        bound_diff(&mut entry);
        assert_eq!(entry["truncated"], true);
        assert!(entry["diff"].as_str().unwrap().len() <= MAX_DIFF_BYTES);
        let mut small = serde_json::json!({ "path": "a", "diff": "@@ -1 +1 @@\n-a\n+b\n" });
        bound_diff(&mut small);
        assert_eq!(small["truncated"], false);
    }
}
