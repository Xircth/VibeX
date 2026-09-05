use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

use uuid::Uuid;

use crate::ServerToken;

pub const HOST_TOKEN_FILE: &str = "host.token";

pub fn host_token_path(data_dir: impl AsRef<Path>) -> PathBuf {
    data_dir.as_ref().join(HOST_TOKEN_FILE)
}

pub fn issue_host_token() -> ServerToken {
    ServerToken::new(format!(
        "vbx_{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    ))
}

pub fn read_host_token(data_dir: impl AsRef<Path>) -> Option<ServerToken> {
    let contents = fs::read_to_string(host_token_path(data_dir)).ok()?;
    ServerToken::try_new(contents.trim()).ok()
}

pub fn write_host_token(data_dir: impl AsRef<Path>, token: &ServerToken) -> io::Result<PathBuf> {
    let data_dir = data_dir.as_ref();
    fs::create_dir_all(data_dir)?;
    let path = host_token_path(data_dir);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)?;
    file.write_all(token.as_str().as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    restrict_host_token_permissions(&path);
    Ok(path)
}

pub fn resolve_console_token(data_dir: impl AsRef<Path>, rotate: bool) -> ServerToken {
    if !rotate && let Some(token) = read_host_token(&data_dir) {
        return token;
    }
    issue_host_token()
}

fn restrict_host_token_permissions(#[cfg_attr(not(unix), allow(unused_variables))] path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::{read_host_token, resolve_console_token, write_host_token};

    #[test]
    fn host_token_file_round_trips() {
        let data_dir = TempDir::new().expect("data dir");
        let token = resolve_console_token(data_dir.path(), true);
        write_host_token(data_dir.path(), &token).expect("write");
        let loaded = read_host_token(data_dir.path()).expect("read");
        assert_eq!(loaded.as_str(), token.as_str());
        let reused = resolve_console_token(data_dir.path(), false);
        assert_eq!(reused.as_str(), token.as_str());
        let rotated = resolve_console_token(data_dir.path(), true);
        assert_ne!(rotated.as_str(), token.as_str());
    }
}
