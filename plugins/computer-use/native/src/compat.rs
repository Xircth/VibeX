//! VibeX compatibility modules used by `crate::computer`, `crate::acp::computer_tools`,
//! and `crate::commands::computer`.

pub mod acp_error {
    #[derive(Debug, thiserror::Error)]
    pub enum AcpError {
        #[error("{0}")]
        DownloadFailed(String),
        #[error("{0}")]
        Protocol(String),
    }
}

pub mod app_error {
    use serde::Serialize;

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct AppCommandError {
        pub code: String,
        pub message: String,
    }

    impl AppCommandError {
        pub fn configuration_invalid(message: impl Into<String>) -> Self {
            Self {
                code: "configuration_invalid".into(),
                message: message.into(),
            }
        }
    }

    impl std::fmt::Display for AppCommandError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(&self.message)
        }
    }
}

pub mod transport {
    use std::io;

    use serde::{Deserialize, Serialize};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Hard ceiling on a single IPC frame (16 MiB).
    pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

    /// Write one length-prefixed JSON frame.
    pub async fn write_frame<W, T>(stream: &mut W, value: &T) -> io::Result<()>
    where
        W: AsyncWriteExt + Unpin,
        T: Serialize,
    {
        let bytes = serde_json::to_vec(value)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("encode: {e}")))?;
        let len: u32 = bytes
            .len()
            .try_into()
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "frame > u32::MAX"))?;
        stream.write_all(&len.to_le_bytes()).await?;
        stream.write_all(&bytes).await?;
        stream.flush().await?;
        Ok(())
    }

    /// Read one length-prefixed JSON frame. Rejects frames larger than [`MAX_FRAME_BYTES`].
    pub async fn read_frame<R, T>(stream: &mut R) -> io::Result<T>
    where
        R: AsyncReadExt + Unpin,
        T: for<'de> Deserialize<'de>,
    {
        let mut len_buf = [0u8; 4];
        stream.read_exact(&mut len_buf).await?;
        let len = u32::from_le_bytes(len_buf) as usize;
        if len > MAX_FRAME_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("frame {len} bytes exceeds cap {MAX_FRAME_BYTES}"),
            ));
        }
        let mut body = vec![0u8; len];
        stream.read_exact(&mut body).await?;
        serde_json::from_slice(&body)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("decode: {e}")))
    }
}

pub mod registry {
    pub fn current_platform() -> &'static str {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            "darwin-aarch64"
        }
        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
        {
            "darwin-x86_64"
        }
        #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
        {
            "linux-aarch64"
        }
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            "linux-x86_64"
        }
        #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
        {
            "windows-aarch64"
        }
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        {
            "windows-x86_64"
        }
    }
}

pub mod binary_cache {
    use std::path::{Path, PathBuf};

    use sha2::{Digest, Sha256};

    use super::acp_error::AcpError;

    /// Base directory for cached binaries (`cua-driver`, etc.).
    pub fn cache_base_dir() -> Result<PathBuf, AcpError> {
        let cache = dirs::cache_dir().ok_or_else(|| {
            AcpError::DownloadFailed("Cannot determine system cache directory".into())
        })?;
        Ok(cache.join("vibex").join("acp-binaries"))
    }

    pub fn binary_file_name(cmd: &str) -> String {
        if cfg!(windows) && !cmd.ends_with(".exe") {
            format!("{cmd}.exe")
        } else {
            cmd.to_string()
        }
    }

    pub fn expected_tool_binary_path(
        id: &str,
        version: &str,
        cmd: &str,
    ) -> Result<PathBuf, AcpError> {
        Ok(cache_base_dir()?
            .join(id)
            .join(version)
            .join(binary_file_name(cmd)))
    }

    pub fn tool_binary_path(id: &str, version: &str, cmd: &str) -> Option<PathBuf> {
        let path = expected_tool_binary_path(id, version, cmd).ok()?;
        path.is_file().then_some(path)
    }

    pub fn clear_tool_cache(id: &str) -> Result<(), AcpError> {
        let dir = cache_base_dir()?.join(id);
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| {
                AcpError::DownloadFailed(format!("Failed to remove {}: {e}", dir.display()))
            })?;
        }
        Ok(())
    }

    pub fn tool_installed_versions(id: &str, cmd: &str) -> Result<Vec<String>, AcpError> {
        let dir = cache_base_dir()?.join(id);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok(Vec::new());
        };
        let bin = binary_file_name(cmd);
        let mut versions: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.path().join(&bin).is_file())
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        versions.sort_by(|a, b| compare_versions(b, a));
        Ok(versions)
    }

    fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
        let mut pa = a.split('.');
        let mut pb = b.split('.');
        loop {
            match (pa.next(), pb.next()) {
                (Some(sa), Some(sb)) => {
                    let ord = match (sa.parse::<u64>(), sb.parse::<u64>()) {
                        (Ok(na), Ok(nb)) => na.cmp(&nb),
                        _ => sa.cmp(sb),
                    };
                    if ord != std::cmp::Ordering::Equal {
                        return ord;
                    }
                }
                (Some(_), None) => return std::cmp::Ordering::Greater,
                (None, Some(_)) => return std::cmp::Ordering::Less,
                (None, None) => return std::cmp::Ordering::Equal,
            }
        }
    }

    pub fn download_progress_message(downloaded_mb: u64, total_bytes: Option<u64>) -> String {
        if let Some(total) = total_bytes {
            let total_mb = total as f64 / (1024.0 * 1024.0);
            format!("Downloading... {downloaded_mb} MB / {total_mb:.1} MB")
        } else {
            format!("Downloading... {downloaded_mb} MB")
        }
    }

    pub async fn ensure_tool_binary_with_progress(
        id: &str,
        version: &str,
        url: &str,
        cmd: &str,
        expected_sha256: Option<&str>,
        on_progress: impl Fn(&str),
    ) -> Result<PathBuf, AcpError> {
        let dest = expected_tool_binary_path(id, version, cmd)?;
        if dest.is_file() {
            return Ok(dest);
        }
        download_and_extract_single(&dest, url, cmd, expected_sha256, &on_progress).await?;
        Ok(dest)
    }

    async fn download_and_extract_single(
        dest: &Path,
        url: &str,
        cmd: &str,
        expected_sha256: Option<&str>,
        on_progress: &(impl Fn(&str) + ?Sized),
    ) -> Result<(), AcpError> {
        let bytes = fetch_archive_bytes(url, expected_sha256, on_progress).await?;

        let parent = dest
            .parent()
            .ok_or_else(|| AcpError::DownloadFailed("Invalid cache path".into()))?;
        std::fs::create_dir_all(parent)
            .map_err(|e| AcpError::DownloadFailed(format!("Failed to create cache dir: {e}")))?;

        on_progress("Extracting archive...");
        let bin_name = binary_file_name(cmd);
        let dest_buf = dest.to_path_buf();
        let url_owned = url.to_string();

        tokio::task::spawn_blocking(move || {
            if url_owned.ends_with(".zip") {
                extract_from_zip(&bytes, &bin_name, &dest_buf)
            } else if url_owned.ends_with(".tar.gz") || url_owned.ends_with(".tgz") {
                extract_from_tar_gz(&bytes, &bin_name, &dest_buf)
            } else {
                Err(AcpError::DownloadFailed(format!(
                    "Unsupported archive format in URL: {url_owned}"
                )))
            }
        })
        .await
        .map_err(|e| AcpError::DownloadFailed(format!("Archive extraction task failed: {e}")))??;

        set_executable(dest)?;
        on_progress("Binary ready");
        Ok(())
    }

    async fn fetch_archive_bytes(
        url: &str,
        expected_sha256: Option<&str>,
        on_progress: &(impl Fn(&str) + ?Sized),
    ) -> Result<Vec<u8>, AcpError> {
        use futures_util::StreamExt;

        let msg = format!("Downloading {url}");
        on_progress(&msg);

        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .read_timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| AcpError::DownloadFailed(format!("HTTP client error: {e}")))?;

        let response = client
            .get(url)
            .send()
            .await
            .map_err(|e| AcpError::DownloadFailed(format!("Download failed ({url}): {e}")))?;

        if !response.status().is_success() {
            return Err(AcpError::DownloadFailed(format!(
                "Download returned HTTP {} for {url}",
                response.status()
            )));
        }

        let total_size = response.content_length();
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::with_capacity(total_size.unwrap_or(0) as usize);
        let mut downloaded: u64 = 0;
        let mut last_reported_mb: u64 = 0;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|e| AcpError::DownloadFailed(format!("Failed to read response: {e}")))?;
            downloaded += chunk.len() as u64;
            bytes.extend_from_slice(&chunk);

            let current_mb = downloaded / (1024 * 1024);
            if current_mb > last_reported_mb {
                last_reported_mb = current_mb;
                on_progress(&download_progress_message(current_mb, total_size));
            }
        }

        let size_mb = bytes.len() as f64 / (1024.0 * 1024.0);
        on_progress(&format!("Download complete ({size_mb:.1} MB)"));

        if let Some(expected) = expected_sha256 {
            on_progress("Verifying checksum...");
            verify_sha256(&bytes, expected)?;
        }

        Ok(bytes)
    }

    pub fn verify_sha256(bytes: &[u8], expected_hex: &str) -> Result<(), AcpError> {
        let expected = expected_hex.trim();
        let digest = Sha256::digest(bytes);
        let actual: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(AcpError::DownloadFailed(format!(
                "Archive SHA-256 mismatch: expected {expected}, got {actual}"
            )));
        }
        Ok(())
    }

    fn extract_from_zip(data: &[u8], bin_name: &str, dest: &Path) -> Result<(), AcpError> {
        use std::io::{Cursor, Read};

        let reader = Cursor::new(data);
        let mut archive = zip::ZipArchive::new(reader)
            .map_err(|e| AcpError::DownloadFailed(format!("Invalid zip archive: {e}")))?;

        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| AcpError::DownloadFailed(format!("Zip entry error: {e}")))?;
            let Some(enclosed) = file.enclosed_name() else {
                continue;
            };
            let file_name = enclosed.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if file_name == bin_name && !file.is_dir() {
                let mut buf = Vec::new();
                file.read_to_end(&mut buf).map_err(|e| {
                    AcpError::DownloadFailed(format!("Failed to read zip entry: {e}"))
                })?;
                write_binary_atomic(dest, &buf)?;
                return Ok(());
            }
        }
        Err(AcpError::DownloadFailed(format!(
            "Binary '{bin_name}' not found inside zip archive"
        )))
    }

    fn extract_from_tar_gz(data: &[u8], bin_name: &str, dest: &Path) -> Result<(), AcpError> {
        use std::io::{Cursor, Read};

        let gz = flate2::read::GzDecoder::new(Cursor::new(data));
        let mut archive = tar::Archive::new(gz);
        let entries = archive
            .entries()
            .map_err(|e| AcpError::DownloadFailed(format!("Invalid tar archive: {e}")))?;

        for entry in entries {
            let mut entry =
                entry.map_err(|e| AcpError::DownloadFailed(format!("Tar entry error: {e}")))?;
            let path = entry
                .path()
                .map_err(|e| AcpError::DownloadFailed(format!("Tar path error: {e}")))?;
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if file_name == bin_name && entry.header().entry_type().is_file() {
                let mut buf = Vec::new();
                entry.read_to_end(&mut buf).map_err(|e| {
                    AcpError::DownloadFailed(format!("Failed to read tar entry: {e}"))
                })?;
                write_binary_atomic(dest, &buf)?;
                return Ok(());
            }
        }
        Err(AcpError::DownloadFailed(format!(
            "Binary '{bin_name}' not found inside tar.gz archive"
        )))
    }

    fn write_binary_atomic(dest: &Path, data: &[u8]) -> Result<(), AcpError> {
        let parent = dest
            .parent()
            .ok_or_else(|| AcpError::DownloadFailed("Invalid destination path".into()))?;
        let tmp = parent.join(format!(".tmp-{}", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, data)
            .map_err(|e| AcpError::DownloadFailed(format!("Failed to write temp file: {e}")))?;
        std::fs::rename(&tmp, dest).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            AcpError::DownloadFailed(format!(
                "Failed to rename temp file to {}: {e}",
                dest.display()
            ))
        })?;
        Ok(())
    }

    fn set_executable(_path: &Path) -> Result<(), AcpError> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(_path)
                .map_err(|e| AcpError::DownloadFailed(format!("Metadata error: {e}")))?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(_path, perms)
                .map_err(|e| AcpError::DownloadFailed(format!("chmod error: {e}")))?;
        }
        Ok(())
    }
}

pub mod browser_agent {
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
    #[serde(rename_all = "kebab-case")]
    pub enum GrantLevel {
        #[default]
        None,
        Read,
        Control,
    }

    impl GrantLevel {
        pub fn allows(self, needed: GrantLevel) -> bool {
            let rank = |g: GrantLevel| match g {
                GrantLevel::None => 0u8,
                GrantLevel::Read => 1,
                GrantLevel::Control => 2,
            };
            rank(self) >= rank(needed)
        }
    }
}

pub mod event_bridge {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use serde::{ser::SerializeStruct, Serialize, Serializer};
    use tokio::sync::broadcast;

    use crate::computer::agent::{ComputerActivityPayload, AGENT_ACTIVITY_EVENT};

    const MAX_ACTIVITY_HISTORY: usize = 50;

    #[derive(Clone)]
    pub enum EventEmitter {
        Web(Arc<WebEventBroadcaster>),
    }

    #[derive(Clone, Debug)]
    pub struct WebEvent {
        pub channel: String,
        pub payload: Arc<serde_json::Value>,
    }

    impl Serialize for WebEvent {
        fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            let mut state = serializer.serialize_struct("WebEvent", 2)?;
            state.serialize_field("channel", &self.channel)?;
            state.serialize_field("payload", self.payload.as_ref())?;
            state.end()
        }
    }

    pub struct WebEventBroadcaster {
        sender: broadcast::Sender<WebEvent>,
        activity_history: Mutex<VecDeque<ComputerActivityPayload>>,
    }

    impl Default for WebEventBroadcaster {
        fn default() -> Self {
            Self::new()
        }
    }

    impl WebEventBroadcaster {
        pub fn new() -> Self {
            let (sender, _) = broadcast::channel(1024);
            Self {
                sender,
                activity_history: Mutex::new(VecDeque::with_capacity(MAX_ACTIVITY_HISTORY)),
            }
        }

        pub fn send(
            &self,
            channel: &str,
            payload: &impl Serialize,
        ) -> Option<Arc<serde_json::Value>> {
            let value = Arc::new(serde_json::to_value(payload).ok()?);
            if channel == AGENT_ACTIVITY_EVENT {
                if let Ok(activity) =
                    serde_json::from_value::<ComputerActivityPayload>((*value).clone())
                {
                    let mut hist = self
                        .activity_history
                        .lock()
                        .unwrap_or_else(|p| p.into_inner());
                    hist.push_front(activity);
                    while hist.len() > MAX_ACTIVITY_HISTORY {
                        hist.pop_back();
                    }
                }
            }
            if self.sender.receiver_count() > 0 {
                let _ = self.sender.send(WebEvent {
                    channel: channel.to_string(),
                    payload: value.clone(),
                });
            }
            Some(value)
        }

        pub fn recent_activity(&self) -> Vec<ComputerActivityPayload> {
            self.activity_history
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .iter()
                .cloned()
                .collect()
        }

        pub fn clear_activity(&self) {
            self.activity_history
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .clear();
        }
    }

    pub fn emit_event(emitter: &EventEmitter, channel: &str, payload: &impl Serialize) {
        match emitter {
            EventEmitter::Web(broadcaster) => {
                let _ = broadcaster.send(channel, payload);
            }
        }
    }
}

pub mod models {
    pub mod agent {
        pub fn is_valid_custom_agent_id(id: &str) -> bool {
            id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        }
    }
}
