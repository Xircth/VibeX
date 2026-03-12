use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use sacp::schema::{
    ReadTextFileRequest, ReadTextFileResponse, WriteTextFileRequest, WriteTextFileResponse,
};
use tokio::sync::Semaphore;

const FS_MAX_CONCURRENT_OPS: usize = 8;
const FS_IO_TIMEOUT: Duration = Duration::from_secs(30);
const FS_MAX_FILE_SIZE_BYTES: u64 = 16 * 1024 * 1024;
const FS_MAX_READ_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const FS_MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;
const FS_SLOW_OPERATION_MS: u128 = 200;

#[derive(Debug)]
pub enum FileSystemRuntimeError {
    InvalidParams(String),
    Internal(String),
}

impl FileSystemRuntimeError {
    pub fn into_rpc_error(self) -> sacp::Error {
        match self {
            Self::InvalidParams(message) => sacp::Error::invalid_params().data(message),
            Self::Internal(message) => sacp::util::internal_error(message),
        }
    }
}

#[derive(Clone)]
pub struct FileSystemRuntime {
    workspace_root: PathBuf,
    workspace_root_canonical: Option<PathBuf>,
    io_semaphore: Arc<Semaphore>,
}

impl FileSystemRuntime {
    pub fn new(workspace_root: PathBuf) -> Self {
        let workspace_root = if workspace_root.is_absolute() {
            workspace_root
        } else {
            std::env::current_dir()
                .unwrap_or_default()
                .join(workspace_root)
        };
        let workspace_root_canonical = std::fs::canonicalize(&workspace_root).ok();

        Self {
            workspace_root,
            workspace_root_canonical,
            io_semaphore: Arc::new(Semaphore::new(FS_MAX_CONCURRENT_OPS)),
        }
    }

    pub async fn read_text_file(
        &self,
        request: ReadTextFileRequest,
    ) -> Result<ReadTextFileResponse, FileSystemRuntimeError> {
        if !request.path.is_absolute() {
            return Err(FileSystemRuntimeError::InvalidParams(
                "fs/read_text_file requires an absolute path".to_string(),
            ));
        }
        if matches!(request.line, Some(0)) {
            return Err(FileSystemRuntimeError::InvalidParams(
                "fs/read_text_file line must be >= 1".to_string(),
            ));
        }

        let _permit = self
            .io_semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| {
                FileSystemRuntimeError::Internal("filesystem runtime closed".to_string())
            })?;

        let workspace_root = self.workspace_root.clone();
        let workspace_root_canonical = self.workspace_root_canonical.clone();
        let path = request.path;
        let line = request.line;
        let limit = request.limit;
        let started_at = Instant::now();
        let path_for_log = path.clone();

        let response = run_blocking_with_timeout("fs/read_text_file", move || {
            read_text_file_impl(
                &path,
                line,
                limit,
                &workspace_root,
                workspace_root_canonical.as_deref(),
            )
            .map(ReadTextFileResponse::new)
        })
        .await;

        log_if_slow("fs/read_text_file", &path_for_log, started_at);
        response
    }

    pub async fn write_text_file(
        &self,
        request: WriteTextFileRequest,
    ) -> Result<WriteTextFileResponse, FileSystemRuntimeError> {
        if !request.path.is_absolute() {
            return Err(FileSystemRuntimeError::InvalidParams(
                "fs/write_text_file requires an absolute path".to_string(),
            ));
        }
        if request.content.len() > FS_MAX_WRITE_BYTES {
            return Err(FileSystemRuntimeError::InvalidParams(format!(
                "write payload too large ({} bytes, limit {} bytes)",
                request.content.len(),
                FS_MAX_WRITE_BYTES
            )));
        }

        let _permit = self
            .io_semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| {
                FileSystemRuntimeError::Internal("filesystem runtime closed".to_string())
            })?;

        let workspace_root = self.workspace_root.clone();
        let workspace_root_canonical = self.workspace_root_canonical.clone();
        let path = request.path;
        let content = request.content;
        let started_at = Instant::now();
        let path_for_log = path.clone();

        let response = run_blocking_with_timeout("fs/write_text_file", move || {
            ensure_path_in_workspace(
                &path,
                &workspace_root,
                workspace_root_canonical.as_deref(),
                true,
            )?;
            atomic_write_text(&path, content.as_bytes())?;
            Ok(WriteTextFileResponse::new())
        })
        .await;

        log_if_slow("fs/write_text_file", &path_for_log, started_at);
        response
    }
}

async fn run_blocking_with_timeout<T, F>(
    operation: &'static str,
    f: F,
) -> Result<T, FileSystemRuntimeError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, FileSystemRuntimeError> + Send + 'static,
{
    let task = tokio::task::spawn_blocking(f);
    let join_result = tokio::time::timeout(FS_IO_TIMEOUT, task)
        .await
        .map_err(|_| {
            FileSystemRuntimeError::Internal(format!(
                "{operation} timed out after {}s",
                FS_IO_TIMEOUT.as_secs()
            ))
        })?;

    let op_result = join_result.map_err(|err| {
        FileSystemRuntimeError::Internal(format!("{operation} worker failed: {err}"))
    })?;

    op_result
}

fn read_text_file_impl(
    path: &Path,
    line: Option<u32>,
    limit: Option<u32>,
    workspace_root: &Path,
    workspace_root_canonical: Option<&Path>,
) -> Result<String, FileSystemRuntimeError> {
    ensure_path_in_workspace(path, workspace_root, workspace_root_canonical, false)?;

    let metadata = std::fs::metadata(path).map_err(|err| map_io_error("read", path, err))?;
    if metadata.len() > FS_MAX_FILE_SIZE_BYTES {
        return Err(FileSystemRuntimeError::InvalidParams(format!(
            "file too large for fs/read_text_file ({} bytes, limit {} bytes)",
            metadata.len(),
            FS_MAX_FILE_SIZE_BYTES
        )));
    }

    let file = File::open(path).map_err(|err| map_io_error("read", path, err))?;
    let mut reader = BufReader::new(file);

    let start_line = usize::try_from(line.unwrap_or(1)).unwrap_or(usize::MAX);
    let max_lines = limit.map(|v| usize::try_from(v).unwrap_or(usize::MAX));

    let mut current_line = 1usize;
    let mut taken = 0usize;
    let mut out = String::with_capacity(
        usize::try_from(metadata.len())
            .unwrap_or(FS_MAX_READ_RESPONSE_BYTES)
            .min(FS_MAX_READ_RESPONSE_BYTES),
    );
    let mut line_buf = String::new();

    loop {
        line_buf.clear();
        let bytes_read = reader
            .read_line(&mut line_buf)
            .map_err(|err| map_io_error("read", path, err))?;
        if bytes_read == 0 {
            break;
        }

        if current_line >= start_line {
            if let Some(max) = max_lines {
                if taken >= max {
                    break;
                }
            }

            if out.len().saturating_add(line_buf.len()) > FS_MAX_READ_RESPONSE_BYTES {
                return Err(FileSystemRuntimeError::InvalidParams(format!(
                    "read result too large (limit {} bytes). Narrow with line/limit.",
                    FS_MAX_READ_RESPONSE_BYTES
                )));
            }

            out.push_str(&line_buf);
            taken += 1;
        }

        current_line = current_line.saturating_add(1);
    }

    Ok(out)
}

fn atomic_write_text(path: &Path, bytes: &[u8]) -> Result<(), FileSystemRuntimeError> {
    let parent = path.parent().ok_or_else(|| {
        FileSystemRuntimeError::InvalidParams(format!(
            "cannot determine parent directory for path: {}",
            path.display()
        ))
    })?;

    if !parent.exists() {
        return Err(FileSystemRuntimeError::InvalidParams(format!(
            "parent directory does not exist: {}",
            parent.display()
        )));
    }

    let temp_path = parent.join(format!(
        ".codeg-fs-{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));

    let existing_permissions = std::fs::metadata(path).ok().map(|m| m.permissions());

    let write_result = (|| {
        let mut tmp = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|err| map_io_error("create temporary file", &temp_path, err))?;

        tmp.write_all(bytes)
            .map_err(|err| map_io_error("write", &temp_path, err))?;
        tmp.sync_all()
            .map_err(|err| map_io_error("flush", &temp_path, err))?;

        if let Some(permissions) = existing_permissions {
            std::fs::set_permissions(&temp_path, permissions)
                .map_err(|err| map_io_error("set permissions", &temp_path, err))?;
        }

        replace_file(&temp_path, path)?;
        sync_directory(parent)?;

        Ok(())
    })();

    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }

    write_result
}

#[cfg(unix)]
fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), FileSystemRuntimeError> {
    std::fs::rename(temp_path, target_path).map_err(|err| map_io_error("replace", target_path, err))
}

#[cfg(target_os = "windows")]
fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), FileSystemRuntimeError> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    fn to_wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let src = to_wide(temp_path);
    let dst = to_wide(target_path);

    // SAFETY: pointers are valid, null-terminated UTF-16 buffers alive for the call.
    let ok = unsafe {
        MoveFileExW(
            src.as_ptr(),
            dst.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };

    if ok == 0 {
        let err = std::io::Error::last_os_error();
        return Err(map_io_error("atomically replace", target_path, err));
    }

    Ok(())
}

#[cfg(not(any(unix, target_os = "windows")))]
fn replace_file(temp_path: &Path, target_path: &Path) -> Result<(), FileSystemRuntimeError> {
    std::fs::rename(temp_path, target_path).map_err(|err| map_io_error("replace", target_path, err))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), FileSystemRuntimeError> {
    let dir = File::open(path).map_err(|err| map_io_error("sync directory", path, err))?;
    dir.sync_all()
        .map_err(|err| map_io_error("sync directory", path, err))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), FileSystemRuntimeError> {
    Ok(())
}

fn canonical_workspace_root(workspace_root: &Path, canonical: Option<&Path>) -> PathBuf {
    canonical
        .map(Path::to_path_buf)
        .or_else(|| std::fs::canonicalize(workspace_root).ok())
        .unwrap_or_else(|| workspace_root.to_path_buf())
}

fn ensure_path_in_workspace(
    path: &Path,
    workspace_root: &Path,
    workspace_root_canonical: Option<&Path>,
    for_write: bool,
) -> Result<(), FileSystemRuntimeError> {
    let root = canonical_workspace_root(workspace_root, workspace_root_canonical);
    let target = canonical_target_path(path, for_write)?;

    if !target.starts_with(&root) {
        return Err(FileSystemRuntimeError::InvalidParams(format!(
            "path is outside workspace root: {}",
            path.display()
        )));
    }

    Ok(())
}

fn canonical_target_path(path: &Path, for_write: bool) -> Result<PathBuf, FileSystemRuntimeError> {
    if !for_write || path.exists() {
        return std::fs::canonicalize(path).map_err(|err| map_io_error("access", path, err));
    }

    let parent = path.parent().ok_or_else(|| {
        FileSystemRuntimeError::InvalidParams(format!(
            "cannot determine parent directory for path: {}",
            path.display()
        ))
    })?;

    if !parent.exists() {
        return Err(FileSystemRuntimeError::InvalidParams(format!(
            "parent directory does not exist: {}",
            parent.display()
        )));
    }

    std::fs::canonicalize(parent).map_err(|err| map_io_error("access", parent, err))
}

fn map_io_error(action: &str, path: &Path, err: std::io::Error) -> FileSystemRuntimeError {
    match err.kind() {
        ErrorKind::NotFound
        | ErrorKind::PermissionDenied
        | ErrorKind::InvalidInput
        | ErrorKind::InvalidData => FileSystemRuntimeError::InvalidParams(format!(
            "failed to {action} {}: {err}",
            path.display()
        )),
        _ => FileSystemRuntimeError::Internal(format!(
            "failed to {action} {}: {err}",
            path.display()
        )),
    }
}

fn log_if_slow(operation: &str, path: &Path, started_at: Instant) {
    let elapsed = started_at.elapsed();
    if elapsed.as_millis() >= FS_SLOW_OPERATION_MS {
        eprintln!(
            "[ACP] {operation} slow path={} elapsed_ms={}",
            path.display(),
            elapsed.as_millis()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_workspace() -> PathBuf {
        let path = std::env::temp_dir().join(format!("codeg-fs-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create test workspace");
        path
    }

    #[tokio::test(flavor = "current_thread")]
    async fn read_honors_line_and_limit() {
        let workspace = temp_workspace();
        let file = workspace.join("sample.txt");
        fs::write(&file, "a\nb\nc\nd\n").expect("write file");

        let runtime = FileSystemRuntime::new(workspace.clone());
        let response = runtime
            .read_text_file(ReadTextFileRequest::new("sid", &file).line(2).limit(2))
            .await
            .expect("read file");

        assert_eq!(response.content, "b\nc\n");

        let _ = fs::remove_dir_all(workspace);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rejects_path_outside_workspace() {
        let workspace = temp_workspace();
        let outside = std::env::temp_dir().join(format!("outside-{}.txt", uuid::Uuid::new_v4()));
        fs::write(&outside, "x").expect("write outside file");

        let runtime = FileSystemRuntime::new(workspace.clone());
        let error = runtime
            .read_text_file(ReadTextFileRequest::new("sid", &outside))
            .await
            .expect_err("should reject outside path");

        match error {
            FileSystemRuntimeError::InvalidParams(message) => {
                assert!(message.contains("outside workspace"));
            }
            other => panic!("unexpected error: {other:?}"),
        }

        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(workspace);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn write_replaces_existing_content() {
        let workspace = temp_workspace();
        let file = workspace.join("target.txt");
        fs::write(&file, "old").expect("write old content");

        let runtime = FileSystemRuntime::new(workspace.clone());
        runtime
            .write_text_file(WriteTextFileRequest::new("sid", &file, "new-content"))
            .await
            .expect("write file");

        let content = fs::read_to_string(&file).expect("read file");
        assert_eq!(content, "new-content");

        let leaked_tmp = fs::read_dir(&workspace)
            .expect("read workspace")
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".codeg-fs-")
            });
        assert!(!leaked_tmp, "temporary file should be cleaned up");

        let _ = fs::remove_dir_all(workspace);
    }
}
