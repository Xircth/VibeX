use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, SqlitePool};
use uuid::Uuid;

use super::*;

pub(crate) async fn purge_space_collection(
    pool: &SqlitePool,
    space_id: &str,
    workspace_id_str: &str,
) -> Result<(), CollaborationError> {
    let items: Vec<(String, String)> = sqlx::query_as(
        "SELECT project_id, file_path FROM collaboration_space_collection_items WHERE space_id = ?",
    )
    .bind(space_id)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    sqlx::query(
        "DELETE FROM collaboration_space_collection_reads WHERE item_id IN (SELECT id FROM collaboration_space_collection_items WHERE space_id = ?)",
    )
    .bind(space_id)
    .execute(pool)
    .await
    .map_err(db)?;
    sqlx::query("DELETE FROM collaboration_space_collection_items WHERE space_id = ?")
        .bind(space_id)
        .execute(pool)
        .await
        .map_err(db)?;

    let mut project_ids = std::collections::HashSet::new();
    for (pid, file_path) in items {
        if !pid.trim().is_empty() {
            project_ids.insert(pid);
        }
        let path = std::path::Path::new(&file_path);
        if is_team_space_collection_file(path) {
            let _ = std::fs::remove_file(path);
        }
    }
    let resolved_pid = resolve_space_project_id(pool, workspace_id_str).await;
    if !resolved_pid.trim().is_empty() {
        project_ids.insert(resolved_pid);
    }
    for pid in project_ids {
        let dir = space_collection_dir(&pid, space_id);
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
            if let Some(parent) = dir.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }
    Ok(())
}

pub const SPACE_COLLECTION_MAX_BYTES: u64 = 200 * 1024 * 1024;
pub(crate) const SPACE_COLLECTION_TEXT_PREVIEW_CAP: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, FromRow)]
pub struct SpaceCollectionReadRecord {
    pub reader_key: String,
    pub reader_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reader_conversation_id: Option<String>,
    pub reader_nickname: String,
    pub read_count: i64,
    pub first_read_at: String,
    pub last_read_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpaceCollectionItemRecord {
    pub id: String,
    pub space_id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub creator_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator_conversation_id: Option<String>,
    pub creator_nickname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator_agent_id: Option<String>,
    pub item_kind: String,
    pub file_name: String,
    pub file_path: String,
    pub mime_type: String,
    pub byte_size: i64,
    pub note: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_content: Option<String>,
    pub read_receipts: Vec<SpaceCollectionReadRecord>,
}

#[derive(Debug, Clone)]
pub struct AddSpaceCollectionItem {
    pub caller_id: Option<Uuid>,
    pub space_id: String,
    pub content: Option<String>,
    pub source_path: Option<String>,
    pub base64_data: Option<String>,
    pub file_name: Option<String>,
    pub note: Option<String>,
    pub operation_id: Uuid,
}

pub(crate) fn vibex_team_spaces_root_dir() -> std::path::PathBuf {
    if let Ok(custom) = std::env::var("VIBEX_TEAM_SPACES_ROOT") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return std::path::PathBuf::from(trimmed);
        }
    }
    utils::path::expand_tilde("~/.vibex")
}

pub(crate) fn sanitize_collection_segment(raw: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric()
            || matches!(ch, '-' | '_' | '.')
            || (!ch.is_control()
                && !matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let cleaned = out.trim_matches(|c| c == '.' || c == ' ').to_string();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

pub fn space_collection_dir(project_id: &str, space_id: &str) -> std::path::PathBuf {
    let safe_project = sanitize_collection_segment(project_id, "default-project");
    let safe_space = sanitize_collection_segment(space_id, "default-space");
    vibex_team_spaces_root_dir()
        .join(safe_project)
        .join("TeamSpaces")
        .join(safe_space)
        .join("Collection")
}

pub fn is_team_space_collection_file(path: &std::path::Path) -> bool {
    let root = vibex_team_spaces_root_dir();
    let canonical_root = std::fs::canonicalize(&root).unwrap_or(root);
    let canonical_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let Ok(rel) = canonical_path.strip_prefix(&canonical_root) else {
        return false;
    };
    let components: Vec<String> = rel
        .components()
        .filter_map(|comp| match comp {
            std::path::Component::Normal(seg) => Some(seg.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    components.len() == 5 && components[1] == "TeamSpaces" && components[3] == "Collection"
}

pub(crate) async fn resolve_space_project_id(pool: &SqlitePool, workspace_id_str: &str) -> String {
    if let Ok(wid) = Uuid::parse_str(workspace_id_str) {
        let project_uuid: Option<Uuid> = sqlx::query_scalar(
            r#"SELECT COALESCE(
                 w.project_id,
                 (SELECT t.project_id FROM tasks t WHERE t.id = w.task_id LIMIT 1)
               )
               FROM workspaces w
               WHERE w.id = ?
               LIMIT 1"#,
        )
        .bind(wid)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
        if let Some(pid) = project_uuid {
            return pid.to_string();
        }
    }
    workspace_id_str.to_string()
}

pub(crate) async fn resolve_collection_source_path(
    pool: &SqlitePool,
    workspace_id_str: &str,
    raw_path: &str,
) -> Result<std::path::PathBuf, CollaborationError> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err(CollaborationError::new(
            "invalid_argument",
            "source_path must not be empty",
        ));
    }
    let expanded = utils::path::expand_tilde(trimmed);
    if expanded.is_absolute() {
        return Ok(expanded);
    }
    if let Ok(wid) = Uuid::parse_str(workspace_id_str)
        && let Ok(Some(workspace)) = db::models::workspace::Workspace::find_by_id(pool, wid).await
    {
        let repos = db::models::workspace_repo::WorkspaceRepo::find_repos_for_workspace(pool, wid)
            .await
            .unwrap_or_default();
        let container_ref = workspace.container_ref.clone().unwrap_or_default();
        let base_dir = crate::host::resolve_absolute_workspace_agent_working_dir(
            &workspace,
            &container_ref,
            &repos,
        );
        if !base_dir.trim().is_empty() {
            return Ok(std::path::PathBuf::from(base_dir).join(expanded));
        }
    }
    Ok(expanded)
}

pub(crate) fn collection_mime_and_kind(
    path: &std::path::Path,
    explicit_text: bool,
) -> (&'static str, &'static str) {
    if explicit_text {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase);
        let mime = match ext.as_deref() {
            Some("txt") => "text/plain",
            Some("json") => "application/json",
            _ => "text/markdown",
        };
        return (mime, "text");
    }
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => ("image/png", "image"),
        Some("jpg") | Some("jpeg") => ("image/jpeg", "image"),
        Some("gif") => ("image/gif", "image"),
        Some("webp") => ("image/webp", "image"),
        Some("bmp") => ("image/bmp", "image"),
        Some("svg") => ("image/svg+xml", "image"),
        Some("avif") => ("image/avif", "image"),
        Some("heic") => ("image/heic", "image"),
        Some("heif") => ("image/heif", "image"),
        Some("pdf") => ("application/pdf", "file"),
        Some("txt") => ("text/plain", "file"),
        Some("md") | Some("markdown") => ("text/markdown", "file"),
        Some("json") => ("application/json", "file"),
        Some("csv") => ("text/csv", "file"),
        Some("html") | Some("htm") => ("text/html", "file"),
        Some("doc") => ("application/msword", "file"),
        Some("docx") => (
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "file",
        ),
        Some("xls") => ("application/vnd.ms-excel", "file"),
        Some("xlsx") => (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "file",
        ),
        Some("ppt") => ("application/vnd.ms-powerpoint", "file"),
        Some("pptx") => (
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "file",
        ),
        Some("zip") => ("application/zip", "file"),
        Some("mp4") => ("video/mp4", "file"),
        Some("webm") => ("video/webm", "file"),
        Some("mov") => ("video/quicktime", "file"),
        _ => ("application/octet-stream", "file"),
    }
}

pub(crate) fn allocate_collection_file_path(
    dir: &std::path::Path,
    desired_name: &str,
    default_ext: Option<&str>,
) -> (String, std::path::PathBuf) {
    let mut safe_name = sanitize_collection_segment(desired_name, "item");
    if let Some(ext) = default_ext
        && std::path::Path::new(&safe_name).extension().is_none()
    {
        safe_name = format!("{safe_name}.{ext}");
    }
    let initial = dir.join(&safe_name);
    if !initial.exists() {
        return (safe_name, initial);
    }
    let path_obj = std::path::Path::new(&safe_name);
    let stem = path_obj
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("item");
    let ext = path_obj.extension().and_then(|e| e.to_str());
    for idx in 2..10_000 {
        let candidate_name = match ext {
            Some(e) if !e.is_empty() => format!("{stem}-{idx}.{e}"),
            _ => format!("{stem}-{idx}"),
        };
        let candidate_path = dir.join(&candidate_name);
        if !candidate_path.exists() {
            return (candidate_name, candidate_path);
        }
    }
    let fallback_name = match ext {
        Some(e) if !e.is_empty() => format!("{stem}-{}.{e}", &Uuid::new_v4().to_string()[..8]),
        _ => format!("{stem}-{}", &Uuid::new_v4().to_string()[..8]),
    };
    let fallback_path = dir.join(&fallback_name);
    (fallback_name, fallback_path)
}

#[derive(Debug, Clone, FromRow)]
pub(crate) struct SpaceCollectionItemRow {
    pub(crate) id: String,
    pub(crate) space_id: String,
    pub(crate) workspace_id: String,
    pub(crate) project_id: String,
    pub(crate) creator_kind: String,
    pub(crate) creator_conversation_id: Option<String>,
    pub(crate) creator_nickname: String,
    pub(crate) item_kind: String,
    pub(crate) file_name: String,
    pub(crate) file_path: String,
    pub(crate) mime_type: String,
    pub(crate) byte_size: i64,
    pub(crate) note: String,
    pub(crate) created_at: String,
}

pub(crate) async fn read_bounded_text_preview(path: &str, max_bytes: usize) -> Option<String> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path).await.ok()?;
    let mut buf = Vec::with_capacity(max_bytes.min(8192));
    file.take(max_bytes as u64)
        .read_to_end(&mut buf)
        .await
        .ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

pub(crate) async fn hydrate_collection_items(
    pool: &SqlitePool,
    rows: Vec<SpaceCollectionItemRow>,
    audience: MessageAudience,
) -> Result<Vec<SpaceCollectionItemRecord>, CollaborationError> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let mut reads_by_item: std::collections::HashMap<String, Vec<SpaceCollectionReadRecord>> =
        std::collections::HashMap::new();
    {
        let mut builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            r#"SELECT item_id, reader_key, reader_kind, reader_conversation_id, reader_nickname,
                      read_count, first_read_at, last_read_at
               FROM collaboration_space_collection_reads
               WHERE item_id IN ("#,
        );
        let mut separated = builder.separated(", ");
        for row in &rows {
            separated.push_bind(&row.id);
        }
        separated.push_unseparated(") ORDER BY last_read_at DESC, first_read_at DESC");
        let read_rows = builder
            .build_query_as::<(
                String,
                String,
                String,
                Option<String>,
                String,
                i64,
                String,
                String,
            )>()
            .fetch_all(pool)
            .await
            .map_err(db)?;
        for (
            item_id,
            reader_key,
            reader_kind,
            reader_conversation_id,
            reader_nickname,
            read_count,
            first_read_at,
            last_read_at,
        ) in read_rows
        {
            reads_by_item
                .entry(item_id)
                .or_default()
                .push(SpaceCollectionReadRecord {
                    reader_key,
                    reader_kind,
                    reader_conversation_id,
                    reader_nickname,
                    read_count,
                    first_read_at,
                    last_read_at,
                });
        }
    }

    let creator_cids: Vec<Uuid> = rows
        .iter()
        .filter_map(|row| row.creator_conversation_id.as_deref())
        .filter_map(|raw| Uuid::parse_str(raw.trim()).ok())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    let mut agent_by_cid: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    if !creator_cids.is_empty() {
        let mut s_builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            "SELECT id, agent_id FROM sessions WHERE id IN (",
        );
        let mut s_sep = s_builder.separated(", ");
        for cid in &creator_cids {
            s_sep.push_bind(*cid);
        }
        s_sep.push_unseparated(")");
        if let Ok(session_rows) = s_builder
            .build_query_as::<(Uuid, Option<String>)>()
            .fetch_all(pool)
            .await
        {
            for (cid, agent_id) in session_rows {
                if let Some(trimmed) = agent_id
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                {
                    agent_by_cid.insert(cid.to_string(), trimmed);
                }
            }
        }

        let missing_cids: Vec<String> = creator_cids
            .iter()
            .map(ToString::to_string)
            .filter(|cid| !agent_by_cid.contains_key(cid))
            .collect();
        if !missing_cids.is_empty() {
            let mut p_builder = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                "SELECT conversation_id, agent_id FROM conversation_personas WHERE conversation_id IN (",
            );
            let mut p_sep = p_builder.separated(", ");
            for cid in &missing_cids {
                p_sep.push_bind(cid);
            }
            p_sep.push_unseparated(")");
            if let Ok(persona_rows) = p_builder
                .build_query_as::<(String, Option<String>)>()
                .fetch_all(pool)
                .await
            {
                for (cid, agent_id) in persona_rows {
                    if let Some(trimmed) = agent_id
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                    {
                        agent_by_cid.entry(cid).or_insert(trimmed);
                    }
                }
            }
        }
    }

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let read_receipts = reads_by_item.remove(&row.id).unwrap_or_default();
        let creator_agent_id = row
            .creator_conversation_id
            .as_deref()
            .and_then(|cid| agent_by_cid.get(cid.trim()).cloned());
        let text_content = if audience == MessageAudience::User && row.item_kind == "text" {
            read_bounded_text_preview(&row.file_path, SPACE_COLLECTION_TEXT_PREVIEW_CAP).await
        } else {
            None
        };
        out.push(SpaceCollectionItemRecord {
            id: row.id,
            space_id: row.space_id,
            workspace_id: row.workspace_id,
            project_id: row.project_id,
            creator_kind: row.creator_kind,
            creator_conversation_id: row.creator_conversation_id,
            creator_nickname: row.creator_nickname,
            creator_agent_id,
            item_kind: row.item_kind,
            file_name: row.file_name,
            file_path: row.file_path,
            mime_type: row.mime_type,
            byte_size: row.byte_size,
            note: row.note,
            created_at: row.created_at,
            text_content,
            read_receipts,
        });
    }
    Ok(out)
}

pub(crate) async fn hydrate_collection_item(
    pool: &SqlitePool,
    row: SpaceCollectionItemRow,
    audience: MessageAudience,
) -> Result<SpaceCollectionItemRecord, CollaborationError> {
    let mut items = hydrate_collection_items(pool, vec![row], audience).await?;
    items
        .pop()
        .ok_or_else(|| CollaborationError::new("not_found", "collection item was not found"))
}

pub(crate) async fn record_collection_item_read(
    pool: &SqlitePool,
    item_id: &str,
    reader_key: &str,
    reader_kind: &str,
    reader_conversation_id: Option<&str>,
    reader_nickname: &str,
) -> Result<(), CollaborationError> {
    let stamp = now_stamp();
    sqlx::query(
        r#"INSERT INTO collaboration_space_collection_reads
           (item_id, reader_key, reader_kind, reader_conversation_id, reader_nickname,
            read_count, first_read_at, last_read_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(item_id, reader_key) DO UPDATE SET
             reader_nickname = excluded.reader_nickname,
             read_count = collaboration_space_collection_reads.read_count + 1,
             last_read_at = excluded.last_read_at"#,
    )
    .bind(item_id)
    .bind(reader_key)
    .bind(reader_kind)
    .bind(reader_conversation_id)
    .bind(reader_nickname)
    .bind(&stamp)
    .bind(&stamp)
    .execute(pool)
    .await
    .map_err(db)?;
    Ok(())
}

pub async fn add_to_space_collection(
    pool: &SqlitePool,
    input: AddSpaceCollectionItem,
) -> Result<SpaceCollectionItemRecord, CollaborationError> {
    add_to_space_collection_with(pool, input, &DeliveryContext::default()).await
}

pub async fn add_to_space_collection_with(
    pool: &SqlitePool,
    input: AddSpaceCollectionItem,
    delivery: &DeliveryContext,
) -> Result<SpaceCollectionItemRecord, CollaborationError> {
    use base64::Engine as _;

    let space_id = input.space_id.trim();
    if space_id.is_empty() {
        return Err(CollaborationError::new(
            "invalid_argument",
            "space_id is required",
        ));
    }
    let space = load_space_or_unassigned(pool, space_id).await?;
    let (creator_kind, creator_conversation_id, creator_nickname) = match input.caller_id {
        Some(caller_id) => {
            let member = caller_seat(pool, space_id, caller_id).await?;
            (
                "agent".to_string(),
                Some(caller_id.to_string()),
                member.nickname,
            )
        }
        None => {
            let _ = ensure_user_member(pool, space_id).await;
            ("user".to_string(), None, "User".to_string())
        }
    };

    if input.caller_id.is_some()
        && input
            .base64_data
            .as_deref()
            .is_some_and(|v| !v.trim().is_empty())
    {
        return Err(CollaborationError::new(
            "invalid_argument",
            "agents cannot store raw binary blobs in space collection; pass content or source_path",
        ));
    }

    let note = input
        .note
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let request = json!({
        "caller_id": input.caller_id,
        "space_id": space_id,
        "content": input.content,
        "source_path": input.source_path,
        "file_name": input.file_name,
        "note": note,
        "has_base64": input.base64_data.as_deref().is_some_and(|v| !v.trim().is_empty()),
    });
    if let Some(stored) = load_stored_operation(pool, &input.operation_id.to_string()).await? {
        return decode_replay(accept_space_replay(&stored, Some(space_id), &request)?);
    }

    let has_content = input
        .content
        .as_deref()
        .is_some_and(|v| !v.trim().is_empty());
    let has_source = input
        .source_path
        .as_deref()
        .is_some_and(|v| !v.trim().is_empty());
    let has_base64 = input
        .base64_data
        .as_deref()
        .is_some_and(|v| !v.trim().is_empty());
    let provided_count =
        usize::from(has_content) + usize::from(has_source) + usize::from(has_base64);
    if provided_count == 0 {
        return Err(CollaborationError::new(
            "invalid_argument",
            "either content or source_path must be provided",
        ));
    }
    if provided_count > 1 {
        return Err(CollaborationError::new(
            "invalid_argument",
            "provide only one of content, source_path, or base64_data",
        ));
    }

    let project_id = resolve_space_project_id(pool, &space.workspace_id).await;
    let collection_dir = space_collection_dir(&project_id, space_id);
    tokio::fs::create_dir_all(&collection_dir)
        .await
        .map_err(|error| {
            CollaborationError::new(
                "conversation_control_failed",
                format!("failed to create space collection directory: {error}"),
            )
        })?;

    let item_id = input.operation_id.to_string();
    let (file_name, dest_path, mime_type, item_kind, byte_size) = if has_source {
        let raw_source = input.source_path.as_deref().unwrap_or_default().trim();
        let src_path =
            resolve_collection_source_path(pool, &space.workspace_id, raw_source).await?;
        let metadata = tokio::fs::metadata(&src_path).await.map_err(|_| {
            CollaborationError::new(
                "not_found",
                format!("source file was not found: {raw_source}"),
            )
        })?;
        if !metadata.is_file() {
            return Err(CollaborationError::new(
                "invalid_argument",
                "source_path must point to a regular file",
            ));
        }
        let len = metadata.len();
        if len > SPACE_COLLECTION_MAX_BYTES {
            return Err(CollaborationError::new(
                "file_too_large",
                "file exceeds maximum allowed size of 200MB",
            ));
        }
        let desired_name = input
            .file_name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .or_else(|| src_path.file_name().and_then(|v| v.to_str()))
            .unwrap_or("file");
        let (final_name, dest) = allocate_collection_file_path(&collection_dir, desired_name, None);
        if src_path != dest {
            tokio::fs::copy(&src_path, &dest).await.map_err(|error| {
                CollaborationError::new(
                    "conversation_control_failed",
                    format!("failed to copy file to space collection: {error}"),
                )
            })?;
        }
        let (mime, kind) = collection_mime_and_kind(&dest, false);
        (
            final_name,
            dest,
            mime.to_string(),
            kind.to_string(),
            len as i64,
        )
    } else if has_base64 {
        let raw_b64 = input.base64_data.as_deref().unwrap_or_default().trim();
        let payload_b64 = raw_b64
            .split_once(";base64,")
            .map(|(_, data)| data)
            .unwrap_or(raw_b64);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload_b64)
            .map_err(|error| {
                CollaborationError::new("invalid_argument", format!("invalid base64 data: {error}"))
            })?;
        if (bytes.len() as u64) > SPACE_COLLECTION_MAX_BYTES {
            return Err(CollaborationError::new(
                "file_too_large",
                "file exceeds maximum allowed size of 200MB",
            ));
        }
        let desired_name = input
            .file_name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or("attachment");
        let (final_name, dest) = allocate_collection_file_path(&collection_dir, desired_name, None);
        tokio::fs::write(&dest, &bytes).await.map_err(|error| {
            CollaborationError::new(
                "conversation_control_failed",
                format!("failed to write collection file: {error}"),
            )
        })?;
        let (mime, kind) = collection_mime_and_kind(&dest, false);
        (
            final_name,
            dest,
            mime.to_string(),
            kind.to_string(),
            bytes.len() as i64,
        )
    } else {
        let text = input.content.as_deref().unwrap_or_default().trim();
        let bytes = text.as_bytes();
        if (bytes.len() as u64) > SPACE_COLLECTION_MAX_BYTES {
            return Err(CollaborationError::new(
                "file_too_large",
                "content exceeds maximum allowed size of 200MB",
            ));
        }
        let mut title_end = 8.min(item_id.len());
        while title_end > 0 && !item_id.is_char_boundary(title_end) {
            title_end -= 1;
        }
        let default_title = format!("note-{}", &item_id[..title_end]);
        let desired_name = input
            .file_name
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or(&default_title);
        let (final_name, dest) =
            allocate_collection_file_path(&collection_dir, desired_name, Some("md"));
        tokio::fs::write(&dest, bytes).await.map_err(|error| {
            CollaborationError::new(
                "conversation_control_failed",
                format!("failed to write text collection file: {error}"),
            )
        })?;
        let (mime, kind) = collection_mime_and_kind(&dest, true);
        (
            final_name,
            dest,
            mime.to_string(),
            kind.to_string(),
            bytes.len() as i64,
        )
    };

    let created_at = now_stamp();
    let file_path_str = dest_path.to_string_lossy().replace('\\', "/");
    sqlx::query(
        r#"INSERT INTO collaboration_space_collection_items
           (id, space_id, workspace_id, project_id, creator_kind, creator_conversation_id,
            creator_nickname, item_kind, file_name, file_path, mime_type, byte_size, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&item_id)
    .bind(space_id)
    .bind(&space.workspace_id)
    .bind(&project_id)
    .bind(&creator_kind)
    .bind(creator_conversation_id.as_deref())
    .bind(&creator_nickname)
    .bind(&item_kind)
    .bind(&file_name)
    .bind(&file_path_str)
    .bind(&mime_type)
    .bind(byte_size)
    .bind(&note)
    .bind(&created_at)
    .execute(pool)
    .await
    .map_err(db)?;

    let audience = if input.caller_id.is_some() {
        MessageAudience::Agent
    } else {
        MessageAudience::User
    };
    let record = hydrate_collection_item(
        pool,
        SpaceCollectionItemRow {
            id: item_id.clone(),
            space_id: space_id.to_string(),
            workspace_id: space.workspace_id.clone(),
            project_id,
            creator_kind,
            creator_conversation_id,
            creator_nickname,
            item_kind,
            file_name,
            file_path: file_path_str,
            mime_type,
            byte_size,
            note,
            created_at,
        },
        audience,
    )
    .await?;

    let mut stored_record = record.clone();
    stored_record.text_content = None;
    store_operation(
        pool,
        &input.operation_id.to_string(),
        Some(space_id),
        &request,
        &stored_record,
    )
    .await?;

    if let Ok(workspace_uuid) = Uuid::parse_str(&space.workspace_id) {
        delivery.notify_space_changed(CollaborationSpaceChangedEvent {
            workspace_id: workspace_uuid,
            space_id: space_id.to_string(),
            seq: None,
            member_id: None,
        });
    }

    Ok(record)
}

pub async fn list_space_collection(
    pool: &SqlitePool,
    space_id: &str,
    caller_id: Option<Uuid>,
    limit: Option<i64>,
    audience: MessageAudience,
) -> Result<Vec<SpaceCollectionItemRecord>, CollaborationError> {
    list_space_collection_with(
        pool,
        space_id,
        caller_id,
        limit,
        audience,
        &DeliveryContext::default(),
    )
    .await
}

pub async fn list_space_collection_with(
    pool: &SqlitePool,
    space_id: &str,
    caller_id: Option<Uuid>,
    limit: Option<i64>,
    audience: MessageAudience,
    delivery: &DeliveryContext,
) -> Result<Vec<SpaceCollectionItemRecord>, CollaborationError> {
    let space = load_space_or_unassigned(pool, space_id).await?;
    let caller_member = match caller_id {
        Some(cid) => Some(caller_seat(pool, space_id, cid).await?),
        None => None,
    };
    let limit = limit
        .unwrap_or(SPACE_LIST_DEFAULT)
        .clamp(1, SPACE_LIST_HARD_CAP);
    let rows = sqlx::query_as::<_, SpaceCollectionItemRow>(
        r#"SELECT id, space_id, workspace_id, project_id, creator_kind, creator_conversation_id,
                  creator_nickname, item_kind, file_name, file_path, mime_type, byte_size, note, created_at
           FROM collaboration_space_collection_items
           WHERE space_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?"#,
    )
    .bind(space_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db)?;

    if let (Some(cid), Some(member)) = (caller_id, caller_member.as_ref())
        && audience == MessageAudience::Agent
        && !rows.is_empty()
    {
        let reader_key = format!("agent:{cid}");
        let cid_str = cid.to_string();
        for row in &rows {
            let _ = record_collection_item_read(
                pool,
                &row.id,
                &reader_key,
                "agent",
                Some(&cid_str),
                &member.nickname,
            )
            .await;
        }
        if let Ok(workspace_uuid) = Uuid::parse_str(&space.workspace_id) {
            delivery.notify_space_changed(CollaborationSpaceChangedEvent {
                workspace_id: workspace_uuid,
                space_id: space_id.to_string(),
                seq: None,
                member_id: None,
            });
        }
    }

    hydrate_collection_items(pool, rows, audience).await
}

pub async fn read_space_collection_item(
    pool: &SqlitePool,
    space_id: &str,
    item_id: &str,
    caller_id: Option<Uuid>,
    audience: MessageAudience,
) -> Result<SpaceCollectionItemRecord, CollaborationError> {
    read_space_collection_item_with(
        pool,
        space_id,
        item_id,
        caller_id,
        audience,
        &DeliveryContext::default(),
    )
    .await
}

pub async fn read_space_collection_item_with(
    pool: &SqlitePool,
    space_id: &str,
    item_id: &str,
    caller_id: Option<Uuid>,
    audience: MessageAudience,
    delivery: &DeliveryContext,
) -> Result<SpaceCollectionItemRecord, CollaborationError> {
    let space = load_space_or_unassigned(pool, space_id).await?;
    let (reader_key, reader_kind, reader_cid, reader_nickname) = match caller_id {
        Some(cid) => {
            let member = caller_seat(pool, space_id, cid).await?;
            (
                format!("agent:{cid}"),
                "agent".to_string(),
                Some(cid.to_string()),
                member.nickname,
            )
        }
        None => (
            "user".to_string(),
            "user".to_string(),
            None,
            "你".to_string(),
        ),
    };

    let row = sqlx::query_as::<_, SpaceCollectionItemRow>(
        r#"SELECT id, space_id, workspace_id, project_id, creator_kind, creator_conversation_id,
                  creator_nickname, item_kind, file_name, file_path, mime_type, byte_size, note, created_at
           FROM collaboration_space_collection_items
           WHERE id = ? AND space_id = ?
           LIMIT 1"#,
    )
    .bind(item_id.trim())
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .ok_or_else(|| CollaborationError::new("not_found", "collection item was not found"))?;

    record_collection_item_read(
        pool,
        &row.id,
        &reader_key,
        &reader_kind,
        reader_cid.as_deref(),
        &reader_nickname,
    )
    .await?;

    if let Ok(workspace_uuid) = Uuid::parse_str(&space.workspace_id) {
        delivery.notify_space_changed(CollaborationSpaceChangedEvent {
            workspace_id: workspace_uuid,
            space_id: space_id.to_string(),
            seq: None,
            member_id: None,
        });
    }

    hydrate_collection_item(pool, row, audience).await
}

pub async fn update_space_collection_item_note(
    pool: &SqlitePool,
    space_id: &str,
    item_id: &str,
    note: &str,
    audience: MessageAudience,
) -> Result<SpaceCollectionItemRecord, CollaborationError> {
    update_space_collection_item_note_with(
        pool,
        space_id,
        item_id,
        note,
        audience,
        &DeliveryContext::default(),
    )
    .await
}

pub async fn update_space_collection_item_note_with(
    pool: &SqlitePool,
    space_id: &str,
    item_id: &str,
    note: &str,
    audience: MessageAudience,
    delivery: &DeliveryContext,
) -> Result<SpaceCollectionItemRecord, CollaborationError> {
    let space = load_space_or_unassigned(pool, space_id).await?;
    let trimmed_id = item_id.trim();
    let trimmed_note = note.trim();
    let changed = sqlx::query(
        r#"UPDATE collaboration_space_collection_items
           SET note = ?
           WHERE id = ? AND space_id = ?"#,
    )
    .bind(trimmed_note)
    .bind(trimmed_id)
    .bind(space_id)
    .execute(pool)
    .await
    .map_err(db)?;
    if changed.rows_affected() == 0 {
        return Err(CollaborationError::new(
            "not_found",
            "collection item was not found",
        ));
    }

    let row = sqlx::query_as::<_, SpaceCollectionItemRow>(
        r#"SELECT id, space_id, workspace_id, project_id, creator_kind, creator_conversation_id,
                  creator_nickname, item_kind, file_name, file_path, mime_type, byte_size, note, created_at
           FROM collaboration_space_collection_items
           WHERE id = ? AND space_id = ?
           LIMIT 1"#,
    )
    .bind(trimmed_id)
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .ok_or_else(|| CollaborationError::new("not_found", "collection item was not found"))?;

    if let Ok(workspace_uuid) = Uuid::parse_str(&space.workspace_id) {
        delivery.notify_space_changed(CollaborationSpaceChangedEvent {
            workspace_id: workspace_uuid,
            space_id: space_id.to_string(),
            seq: None,
            member_id: None,
        });
    }

    hydrate_collection_item(pool, row, audience).await
}

pub async fn remove_space_collection_item(
    pool: &SqlitePool,
    space_id: &str,
    item_id: &str,
) -> Result<(), CollaborationError> {
    remove_space_collection_item_with(pool, space_id, item_id, &DeliveryContext::default()).await
}

pub async fn remove_space_collection_item_with(
    pool: &SqlitePool,
    space_id: &str,
    item_id: &str,
    delivery: &DeliveryContext,
) -> Result<(), CollaborationError> {
    let space = load_space_or_unassigned(pool, space_id).await?;
    let trimmed_id = item_id.trim();
    if trimmed_id.is_empty() {
        return Err(CollaborationError::new(
            "invalid_argument",
            "item_id is required",
        ));
    }

    let row = sqlx::query_as::<_, SpaceCollectionItemRow>(
        r#"SELECT id, space_id, workspace_id, project_id, creator_kind, creator_conversation_id,
                  creator_nickname, item_kind, file_name, file_path, mime_type, byte_size, note, created_at
           FROM collaboration_space_collection_items
           WHERE id = ? AND space_id = ?
           LIMIT 1"#,
    )
    .bind(trimmed_id)
    .bind(space_id)
    .fetch_optional(pool)
    .await
    .map_err(db)?
    .ok_or_else(|| CollaborationError::new("not_found", "collection item was not found"))?;

    sqlx::query("DELETE FROM collaboration_space_collection_reads WHERE item_id = ?")
        .bind(trimmed_id)
        .execute(pool)
        .await
        .map_err(db)?;
    let deleted = sqlx::query(
        "DELETE FROM collaboration_space_collection_items WHERE id = ? AND space_id = ?",
    )
    .bind(trimmed_id)
    .bind(space_id)
    .execute(pool)
    .await
    .map_err(db)?;
    if deleted.rows_affected() == 0 {
        return Err(CollaborationError::new(
            "not_found",
            "collection item was not found",
        ));
    }

    let path = std::path::Path::new(&row.file_path);
    if is_team_space_collection_file(path) {
        let _ = std::fs::remove_file(path);
    }

    if let Ok(workspace_uuid) = Uuid::parse_str(&space.workspace_id) {
        delivery.notify_space_changed(CollaborationSpaceChangedEvent {
            workspace_id: workspace_uuid,
            space_id: space_id.to_string(),
            seq: None,
            member_id: None,
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::test_support::*;

    #[tokio::test]
    async fn space_collection_stores_address_only_for_agents_and_tracks_read_receipts() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        create_session(&pool, b, workspace, Some("小B")).await;
        let space = space_of(&pool, a).await;
        add_space_member(&pool, a, &space, b, "小B", Uuid::new_v4())
            .await
            .unwrap();

        // Agent cannot pass raw binary base64_data directly
        let forbidden = add_to_space_collection(
            &pool,
            AddSpaceCollectionItem {
                caller_id: Some(a),
                space_id: space.clone(),
                content: None,
                source_path: None,
                base64_data: Some("YWJj".to_string()),
                file_name: Some("raw.bin".to_string()),
                note: None,
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(forbidden.code, "invalid_argument");

        // Agent adds text item to collection
        let added = add_to_space_collection(
            &pool,
            AddSpaceCollectionItem {
                caller_id: Some(a),
                space_id: space.clone(),
                content: Some("# Shared API Contract\nGET /v1/health".to_string()),
                source_path: None,
                base64_data: None,
                file_name: Some("api-contract.md".to_string()),
                note: Some("核心接口契约".to_string()),
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();

        assert_eq!(added.creator_nickname, "小A");
        assert_eq!(added.note, "核心接口契约");
        assert!(added.text_content.is_none());
        let saved_path = std::path::PathBuf::from(&added.file_path);
        assert!(saved_path.exists());
        assert!(is_team_space_collection_file(&saved_path));

        // Member B reads the collection item -> records read receipt, returns address only
        let read_by_b =
            read_space_collection_item(&pool, &space, &added.id, Some(b), MessageAudience::Agent)
                .await
                .unwrap();
        assert!(read_by_b.text_content.is_none());
        assert_eq!(read_by_b.read_receipts.len(), 1);
        assert_eq!(read_by_b.read_receipts[0].reader_nickname, "小B");
        assert_eq!(read_by_b.read_receipts[0].read_count, 1);

        // User audience sees text_content and read receipts
        let user_list = list_space_collection(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        assert_eq!(user_list.len(), 1);
        assert_eq!(
            user_list[0].text_content.as_deref(),
            Some("# Shared API Contract\nGET /v1/health")
        );
        assert_eq!(user_list[0].read_receipts.len(), 1);
        assert_eq!(user_list[0].read_receipts[0].reader_nickname, "小B");

        // User can update collection item note
        let updated = update_space_collection_item_note(
            &pool,
            &space,
            &added.id,
            "更新后的备注",
            MessageAudience::User,
        )
        .await
        .unwrap();
        assert_eq!(updated.note, "更新后的备注");

        let _ = std::fs::remove_file(saved_path);
    }

    #[tokio::test]
    async fn space_collection_item_can_be_removed() {
        let pool = setup_pool().await;
        let workspace = Uuid::new_v4();
        let a = Uuid::new_v4();
        create_session(&pool, a, workspace, Some("小A")).await;
        let space = space_of(&pool, a).await;

        let added = add_to_space_collection(
            &pool,
            AddSpaceCollectionItem {
                caller_id: Some(a),
                space_id: space.clone(),
                content: Some("temporary note".to_string()),
                source_path: None,
                base64_data: None,
                file_name: Some("temp.md".to_string()),
                note: Some("to delete".to_string()),
                operation_id: Uuid::new_v4(),
            },
        )
        .await
        .unwrap();
        let saved_path = std::path::PathBuf::from(&added.file_path);
        assert!(saved_path.exists());

        remove_space_collection_item(&pool, &space, &added.id)
            .await
            .unwrap();

        let remaining = list_space_collection(&pool, &space, None, None, MessageAudience::User)
            .await
            .unwrap();
        assert!(remaining.is_empty());
        assert!(!saved_path.exists());
    }
}
