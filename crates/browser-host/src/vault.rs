use std::{
    fs,
    io::Write as _,
    path::{Path, PathBuf},
};

use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use url::Url;
use uuid::Uuid;

use crate::error::BrowserHostError;

const VAULT_VERSION: u32 = 1;
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;
const VAULT_FILENAME: &str = "credentials.vault";
const DPAPI_KEY_FILENAME: &str = "vault.key.dpapi";
#[cfg(not(any(windows, target_os = "macos")))]
const UNIX_FALLBACK_KEY_FILENAME: &str = "vault.key";

#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "dimo-browser-vault";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredCredential {
    pub id: String,
    pub name: String,
    pub url: String,
    pub origin: String,
    pub host: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub note: String,
    pub source: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialSummary {
    pub id: String,
    pub name: String,
    pub url: String,
    pub origin: String,
    pub host: String,
    pub username: String,
    #[serde(default)]
    pub note: String,
    pub source: String,
    pub updated_at: i64,
}

impl From<&StoredCredential> for CredentialSummary {
    fn from(value: &StoredCredential) -> Self {
        Self {
            id: value.id.clone(),
            name: value.name.clone(),
            url: value.url.clone(),
            origin: value.origin.clone(),
            host: value.host.clone(),
            username: value.username.clone(),
            note: value.note.clone(),
            source: value.source.clone(),
            updated_at: value.updated_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedVaultFile {
    version: u32,
    key_backend: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Clone)]
pub struct CredentialUpsertInput {
    pub name: String,
    pub url: String,
    pub username: String,
    pub password: String,
    pub note: String,
    pub source: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CredentialMergeStats {
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone)]
pub enum KeyProtector {
    Os {
        profile_dir: PathBuf,
        profile_id: String,
    },
    #[cfg(test)]
    Memory([u8; KEY_LEN]),
}

impl KeyProtector {
    fn backend_name(&self) -> &'static str {
        match self {
            KeyProtector::Os { .. } => {
                if cfg!(windows) {
                    "dpapi"
                } else if cfg!(target_os = "macos") {
                    "keychain"
                } else {
                    "secret-tool"
                }
            }
            #[cfg(test)]
            KeyProtector::Memory(_) => "memory-test",
        }
    }

    fn load_or_create_key(&self) -> Result<[u8; KEY_LEN], BrowserHostError> {
        match self {
            KeyProtector::Os {
                profile_dir,
                profile_id,
            } => load_or_create_os_key(profile_dir, profile_id),
            #[cfg(test)]
            KeyProtector::Memory(key) => Ok(*key),
        }
    }

    fn load_existing_key(&self) -> Result<Option<[u8; KEY_LEN]>, BrowserHostError> {
        match self {
            KeyProtector::Os {
                profile_dir,
                profile_id,
            } => load_existing_os_key(profile_dir, profile_id),
            #[cfg(test)]
            KeyProtector::Memory(key) => Ok(Some(*key)),
        }
    }

    #[allow(irrefutable_let_patterns)]
    fn delete_key(&self) {
        if let KeyProtector::Os {
            profile_dir,
            profile_id,
        } = self
        {
            delete_os_key(profile_dir, profile_id);
        }
    }
}

pub fn sanitize_profile_id(profile_id: &str) -> String {
    let cleaned: String = profile_id
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "default".to_owned()
    } else {
        cleaned
    }
}

pub fn normalize_credential_url(raw: &str) -> Option<(String, String, String)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    let parsed = Url::parse(&candidate).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    let port_suffix = parsed
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    let origin = format!("{}://{host}{port_suffix}", parsed.scheme());
    Some((parsed.to_string(), origin, host))
}

pub fn credential_matches_url(cred: &StoredCredential, tab_url: &str) -> bool {
    let Ok(parsed_tab) = Url::parse(tab_url.trim()) else {
        return false;
    };
    if !matches!(parsed_tab.scheme(), "http" | "https") {
        return false;
    }
    let Some(tab_host) = parsed_tab.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };

    let cred_parsed = Url::parse(&cred.origin)
        .or_else(|_| Url::parse(&cred.url))
        .ok();
    let (cred_scheme, cred_host, cred_port) = match cred_parsed {
        Some(url) => (
            url.scheme().to_ascii_lowercase(),
            url.host_str()
                .map(str::to_ascii_lowercase)
                .unwrap_or_else(|| cred.host.to_ascii_lowercase()),
            url.port(),
        ),
        None => ("https".to_owned(), cred.host.to_ascii_lowercase(), None),
    };

    if cred_host.is_empty() {
        return false;
    }
    // Never send an HTTPS credential onto an unencrypted HTTP page.
    if cred_scheme == "https" && parsed_tab.scheme() != "https" {
        return false;
    }
    if let (Some(c_port), Some(t_port)) = (cred_port, parsed_tab.port())
        && c_port != t_port
    {
        return false;
    }

    let strip_www = |h: &str| h.strip_prefix("www.").unwrap_or(h).to_owned();
    let tab_bare = strip_www(&tab_host);
    let cred_bare = strip_www(&cred_host);

    tab_host == cred_host || tab_bare == cred_bare || tab_host.ends_with(&format!(".{cred_bare}"))
}

pub fn build_autofill_script(username: &str, password: &str) -> Result<String, BrowserHostError> {
    let user_json = serde_json::to_string(username)
        .map_err(|err| BrowserHostError::new("browser_invalid", err.to_string()))?;
    let pass_json = serde_json::to_string(password)
        .map_err(|err| BrowserHostError::new("browser_invalid", err.to_string()))?;

    Ok(format!(
        r#"(function(){{
  try {{
    var uVal = {user_json};
    var pVal = {pass_json};
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    var setVal = function(el, val) {{
      if (!el) return false;
      el.focus();
      if (setter && setter.set) {{
        setter.set.call(el, val);
      }} else {{
        el.value = val;
      }}
      el.dispatchEvent(new Event('input', {{ bubbles: true }}));
      el.dispatchEvent(new Event('change', {{ bubbles: true }}));
      return true;
    }};
    var isVisible = function(el) {{
      if (!el || el.disabled || el.readOnly) return false;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;
      var r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    }};
    var collectInputs = function(root, out) {{
      var nodes = root.querySelectorAll('input');
      for (var i = 0; i < nodes.length; i++) out.push(nodes[i]);
      var all = root.querySelectorAll('*');
      for (var j = 0; j < all.length; j++) {{
        if (all[j].shadowRoot) collectInputs(all[j].shadowRoot, out);
      }}
    }};
    var inputs = [];
    collectInputs(document, inputs);
    var visible = inputs.filter(isVisible);
    var passField = visible.find(function(el) {{
      return (el.type || '').toLowerCase() === 'password';
    }}) || null;
    var isUserCandidate = function(el) {{
      var t = (el.type || 'text').toLowerCase();
      if (t !== 'text' && t !== 'email' && t !== 'tel' && t !== 'search') return false;
      var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
      var hint = ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '') + ' ' + ac).toLowerCase();
      return ac.indexOf('user') >= 0 || ac.indexOf('email') >= 0 || t === 'email' ||
        /user|email|login|account|phone|mobile|name|id/.test(hint);
    }};
    var userField = null;
    if (passField) {{
      var form = passField.form;
      var pool = form ? visible.filter(function(el) {{ return el.form === form; }}) : visible;
      var pIdx = pool.indexOf(passField);
      for (var k = pIdx - 1; k >= 0; k--) {{
        var cand = pool[k];
        var ct = (cand.type || 'text').toLowerCase();
        if (ct === 'text' || ct === 'email' || ct === 'tel') {{
          userField = cand;
          break;
        }}
      }}
    }}
    if (!userField) {{
      userField = visible.find(isUserCandidate) || null;
    }}
    var filledUser = false;
    var filledPass = false;
    if (userField && uVal) filledUser = setVal(userField, uVal);
    if (passField && pVal) filledPass = setVal(passField, pVal);
    return JSON.stringify({{
      ok: filledUser || filledPass,
      filledUsername: filledUser,
      filledPassword: filledPass,
      reason: (filledUser || filledPass) ? null : 'no_matching_login_fields'
    }});
  }} catch (e) {{
    return JSON.stringify({{ ok: false, filledUsername: false, filledPassword: false, reason: String(e && e.message || e) }});
  }}
}})()"#
    ))
}

pub struct ProfileCredentialStore {
    vault_path: Option<PathBuf>,
    protector: KeyProtector,
}

impl ProfileCredentialStore {
    pub fn open(data_dir: Option<&Path>, profile_id: &str) -> Result<Self, BrowserHostError> {
        let safe_id = sanitize_profile_id(profile_id);
        match data_dir {
            Some(root) if safe_id != "ephemeral" => {
                let profile_dir = root.join(&safe_id);
                ensure_private_dir(&profile_dir)?;
                Ok(Self {
                    vault_path: Some(profile_dir.join(VAULT_FILENAME)),
                    protector: KeyProtector::Os {
                        profile_dir,
                        profile_id: safe_id,
                    },
                })
            }
            _ => Err(BrowserHostError::new(
                "browser_invalid",
                "persistent vault directory is not configured",
            )),
        }
    }

    #[cfg(test)]
    pub fn open_with_protector(vault_path: Option<PathBuf>, protector: KeyProtector) -> Self {
        Self {
            vault_path,
            protector,
        }
    }

    pub fn load_all(&self) -> Result<Vec<StoredCredential>, BrowserHostError> {
        let Some(path) = &self.vault_path else {
            return Ok(Vec::new());
        };
        if !path.is_file() {
            return Ok(Vec::new());
        }
        let raw = fs::read_to_string(path).map_err(|err| {
            BrowserHostError::new(
                "browser_read_failed",
                format!("failed to read vault: {err}"),
            )
        })?;
        if raw.trim().is_empty() {
            return Ok(Vec::new());
        }
        let envelope: EncryptedVaultFile = serde_json::from_str(&raw).map_err(|err| {
            BrowserHostError::new(
                "browser_read_failed",
                format!("corrupted credential vault envelope: {err}"),
            )
        })?;
        if envelope.version != VAULT_VERSION {
            return Err(BrowserHostError::new(
                "browser_read_failed",
                format!("unsupported credential vault version {}", envelope.version),
            ));
        }
        let Some(key_bytes) = self.protector.load_existing_key()? else {
            return Err(BrowserHostError::new(
                "browser_read_failed",
                "vault encryption key is missing from OS key store",
            ));
        };
        let nonce_bytes = BASE64.decode(envelope.nonce.trim()).map_err(|err| {
            BrowserHostError::new("browser_read_failed", format!("invalid vault nonce: {err}"))
        })?;
        let ciphertext = BASE64.decode(envelope.ciphertext.trim()).map_err(|err| {
            BrowserHostError::new(
                "browser_read_failed",
                format!("invalid vault ciphertext: {err}"),
            )
        })?;
        let nonce_arr: [u8; NONCE_LEN] = nonce_bytes.try_into().map_err(|_| {
            BrowserHostError::new("browser_read_failed", "invalid vault nonce length")
        })?;
        let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(key_bytes));
        let aad_str = self.aad_string();
        let plaintext = cipher
            .decrypt(
                &Nonce::from(nonce_arr),
                Payload {
                    msg: ciphertext.as_slice(),
                    aad: aad_str.as_bytes(),
                },
            )
            .map_err(|_| {
                BrowserHostError::new("browser_read_failed", "failed to decrypt credential vault")
            })?;
        let items: Vec<StoredCredential> = serde_json::from_slice(&plaintext).map_err(|err| {
            BrowserHostError::new(
                "browser_read_failed",
                format!("invalid decrypted credential payload: {err}"),
            )
        })?;
        Ok(items)
    }

    pub fn save_all(&self, items: &[StoredCredential]) -> Result<(), BrowserHostError> {
        let Some(path) = &self.vault_path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            ensure_private_dir(parent)?;
        }
        let key_bytes = self.protector.load_or_create_key()?;
        let mut nonce_bytes = [0u8; NONCE_LEN];
        getrandom::getrandom(&mut nonce_bytes).map_err(|_| {
            BrowserHostError::new("browser_write_failed", "failed to generate random nonce")
        })?;
        let cipher = Aes256Gcm::new(&Key::<Aes256Gcm>::from(key_bytes));
        let plaintext = serde_json::to_vec(items).map_err(|err| {
            BrowserHostError::new("browser_write_failed", format!("serialize vault: {err}"))
        })?;
        let aad_str = self.aad_string();
        let ciphertext = cipher
            .encrypt(
                &Nonce::from(nonce_bytes),
                Payload {
                    msg: plaintext.as_slice(),
                    aad: aad_str.as_bytes(),
                },
            )
            .map_err(|_| {
                BrowserHostError::new("browser_write_failed", "failed to encrypt credential vault")
            })?;

        let envelope = EncryptedVaultFile {
            version: VAULT_VERSION,
            key_backend: self.protector.backend_name().to_owned(),
            nonce: BASE64.encode(nonce_bytes),
            ciphertext: BASE64.encode(&ciphertext),
        };
        let serialized = serde_json::to_vec_pretty(&envelope).map_err(|err| {
            BrowserHostError::new("browser_write_failed", format!("serialize envelope: {err}"))
        })?;
        write_private_atomic(path, &serialized)
    }

    pub fn clear(&self) -> Result<(), BrowserHostError> {
        if let Some(path) = &self.vault_path
            && path.exists()
        {
            fs::remove_file(path).map_err(|err| {
                BrowserHostError::new(
                    "browser_write_failed",
                    format!("failed to remove credential vault: {err}"),
                )
            })?;
        }
        self.protector.delete_key();
        Ok(())
    }

    fn aad_string(&self) -> String {
        match &self.protector {
            KeyProtector::Os { profile_id, .. } => format!("dimo-browser-vault.v1:{profile_id}"),
            #[cfg(test)]
            KeyProtector::Memory(_) => "dimo-browser-vault.v1:test".to_owned(),
        }
    }
}

pub fn merge_credentials(
    existing: &mut Vec<StoredCredential>,
    incoming: Vec<CredentialUpsertInput>,
) -> CredentialMergeStats {
    let mut stats = CredentialMergeStats::default();
    for item in incoming {
        let Some((normalized_url, origin, host)) = normalize_credential_url(&item.url) else {
            stats.skipped += 1;
            continue;
        };
        if item.password.is_empty() && item.username.trim().is_empty() {
            stats.skipped += 1;
            continue;
        }
        let username = item.username.trim().to_owned();
        let name = if item.name.trim().is_empty() {
            host.clone()
        } else {
            item.name.trim().to_owned()
        };

        if let Some(found) = existing.iter_mut().find(|entry| {
            entry.origin.eq_ignore_ascii_case(&origin)
                && entry.username.eq_ignore_ascii_case(&username)
        }) {
            if found.password != item.password
                || (!name.is_empty() && found.name != name)
                || (!item.note.trim().is_empty() && found.note != item.note.trim())
            {
                found.password = item.password;
                found.name = name;
                found.url = normalized_url;
                found.host = host;
                if !item.note.trim().is_empty() {
                    found.note = item.note.trim().to_owned();
                }
                found.source = item.source;
                found.updated_at = item.updated_at;
                stats.updated += 1;
            } else {
                stats.skipped += 1;
            }
        } else {
            existing.push(StoredCredential {
                id: Uuid::new_v4().to_string(),
                name,
                url: normalized_url,
                origin,
                host,
                username,
                password: item.password,
                note: item.note.trim().to_owned(),
                source: item.source,
                updated_at: item.updated_at,
            });
            stats.added += 1;
        }
    }
    existing.sort_by(|a, b| {
        a.host
            .cmp(&b.host)
            .then_with(|| a.username.cmp(&b.username))
    });
    stats
}

pub fn ensure_private_dir(dir: &Path) -> Result<(), BrowserHostError> {
    fs::create_dir_all(dir).map_err(|err| {
        BrowserHostError::new("browser_write_failed", format!("create dir failed: {err}"))
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

pub fn write_private_atomic(path: &Path, data: &[u8]) -> Result<(), BrowserHostError> {
    let parent = path.parent().ok_or_else(|| {
        BrowserHostError::new("browser_write_failed", "missing parent directory for vault")
    })?;
    ensure_private_dir(parent)?;
    let tmp_name = format!(
        ".{}.tmp-{}",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("vault"),
        Uuid::new_v4()
    );
    let tmp_path = parent.join(tmp_name);
    let mut options = fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp_path).map_err(|err| {
        BrowserHostError::new(
            "browser_write_failed",
            format!("open temp file failed: {err}"),
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
    }
    file.write_all(data).map_err(|err| {
        BrowserHostError::new("browser_write_failed", format!("write vault failed: {err}"))
    })?;
    let _ = file.sync_data();
    drop(file);
    fs::rename(&tmp_path, path).map_err(|err| {
        let _ = fs::remove_file(&tmp_path);
        BrowserHostError::new(
            "browser_write_failed",
            format!("rename vault failed: {err}"),
        )
    })?;
    Ok(())
}

fn load_or_create_os_key(
    profile_dir: &Path,
    profile_id: &str,
) -> Result<[u8; KEY_LEN], BrowserHostError> {
    if let Some(existing) = load_existing_os_key(profile_dir, profile_id)? {
        return Ok(existing);
    }
    let mut key = [0u8; KEY_LEN];
    getrandom::getrandom(&mut key).map_err(|_| {
        BrowserHostError::new(
            "browser_write_failed",
            "failed to generate vault master key",
        )
    })?;
    store_os_key(profile_dir, profile_id, &key)?;
    Ok(key)
}

fn load_existing_os_key(
    profile_dir: &Path,
    profile_id: &str,
) -> Result<Option<[u8; KEY_LEN]>, BrowserHostError> {
    #[cfg(windows)]
    {
        let _ = profile_id;
        let key_path = profile_dir.join(DPAPI_KEY_FILENAME);
        if !key_path.is_file() {
            return Ok(None);
        }
        let protected = fs::read(&key_path).map_err(|err| {
            BrowserHostError::new("browser_read_failed", format!("read DPAPI key: {err}"))
        })?;
        let raw = dpapi_unprotect(&protected)?;
        let arr: [u8; KEY_LEN] = raw.try_into().map_err(|_| {
            BrowserHostError::new("browser_read_failed", "invalid decrypted DPAPI key length")
        })?;
        Ok(Some(arr))
    }

    #[cfg(target_os = "macos")]
    {
        let _ = profile_dir;
        let output = std::process::Command::new("security")
            .args([
                "find-generic-password",
                "-s",
                KEYCHAIN_SERVICE,
                "-a",
                profile_id,
                "-w",
            ])
            .output()
            .map_err(|err| {
                BrowserHostError::new("browser_read_failed", format!("keychain lookup: {err}"))
            })?;
        if !output.status.success() {
            return Ok(None);
        }
        let encoded = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if encoded.is_empty() {
            return Ok(None);
        }
        let raw = BASE64.decode(encoded).map_err(|err| {
            BrowserHostError::new("browser_read_failed", format!("decode keychain key: {err}"))
        })?;
        let arr: [u8; KEY_LEN] = raw.try_into().map_err(|_| {
            BrowserHostError::new("browser_read_failed", "invalid keychain key length")
        })?;
        Ok(Some(arr))
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        if let Ok(output) = std::process::Command::new("secret-tool")
            .args([
                "lookup",
                "service",
                "dimo-browser-vault",
                "account",
                profile_id,
            ])
            .output()
            && output.status.success()
        {
            let encoded = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if !encoded.is_empty() {
                let raw = BASE64.decode(encoded).map_err(|err| {
                    BrowserHostError::new("browser_read_failed", format!("decode key: {err}"))
                })?;
                if let Ok(arr) = <[u8; KEY_LEN]>::try_from(raw) {
                    return Ok(Some(arr));
                }
            }
        }
        let fallback_path = profile_dir.join(UNIX_FALLBACK_KEY_FILENAME);
        if !fallback_path.is_file() {
            return Ok(None);
        }
        let raw = fs::read(&fallback_path).map_err(|err| {
            BrowserHostError::new("browser_read_failed", format!("read fallback key: {err}"))
        })?;
        let arr: [u8; KEY_LEN] = raw.try_into().map_err(|_| {
            BrowserHostError::new("browser_read_failed", "invalid fallback key length")
        })?;
        Ok(Some(arr))
    }
}

fn store_os_key(
    profile_dir: &Path,
    profile_id: &str,
    key: &[u8; KEY_LEN],
) -> Result<(), BrowserHostError> {
    #[cfg(windows)]
    {
        let _ = profile_id;
        let protected = dpapi_protect(key)?;
        write_private_atomic(&profile_dir.join(DPAPI_KEY_FILENAME), &protected)
    }

    #[cfg(target_os = "macos")]
    {
        let _ = profile_dir;
        let encoded = BASE64.encode(key);
        let output = std::process::Command::new("security")
            .args([
                "add-generic-password",
                "-U",
                "-s",
                KEYCHAIN_SERVICE,
                "-a",
                profile_id,
                "-w",
                &encoded,
            ])
            .output()
            .map_err(|err| {
                BrowserHostError::new("browser_write_failed", format!("keychain write: {err}"))
            })?;
        if !output.status.success() {
            return Err(BrowserHostError::new(
                "browser_write_failed",
                format!(
                    "macOS Keychain write failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ),
            ));
        }
        return Ok(());
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let encoded = BASE64.encode(key);
        if let Ok(mut child) = std::process::Command::new("secret-tool")
            .args([
                "store",
                "--label=Dimo Browser Vault",
                "service",
                "dimo-browser-vault",
                "account",
                profile_id,
            ])
            .stdin(std::process::Stdio::piped())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(encoded.as_bytes());
            }
            if let Ok(status) = child.wait()
                && status.success()
            {
                return Ok(());
            }
        }
        write_private_atomic(&profile_dir.join(UNIX_FALLBACK_KEY_FILENAME), key)
    }
}

fn delete_os_key(profile_dir: &Path, profile_id: &str) {
    #[cfg(windows)]
    {
        let _ = profile_id;
        let _ = fs::remove_file(profile_dir.join(DPAPI_KEY_FILENAME));
    }

    #[cfg(target_os = "macos")]
    {
        let _ = profile_dir;
        let _ = std::process::Command::new("security")
            .args([
                "delete-generic-password",
                "-s",
                KEYCHAIN_SERVICE,
                "-a",
                profile_id,
            ])
            .output();
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = std::process::Command::new("secret-tool")
            .args([
                "clear",
                "service",
                "dimo-browser-vault",
                "account",
                profile_id,
            ])
            .output();
        let _ = fs::remove_file(profile_dir.join(UNIX_FALLBACK_KEY_FILENAME));
    }
}

#[cfg(windows)]
fn dpapi_protect(plaintext: &[u8]) -> Result<Vec<u8>, BrowserHostError> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData},
    };

    let cb_data = u32::try_from(plaintext.len()).map_err(|_| {
        BrowserHostError::new("browser_write_failed", "DPAPI plaintext exceeds u32::MAX")
    })?;
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: cb_data,
        pbData: plaintext.as_ptr().cast_mut(),
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    unsafe {
        let ok = CryptProtectData(
            &raw const in_blob,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &raw mut out_blob,
        );
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            if !out_blob.pbData.is_null() {
                let _ = LocalFree(out_blob.pbData.cast());
            }
            return Err(BrowserHostError::new(
                "browser_write_failed",
                format!("CryptProtectData failed: {err}"),
            ));
        }
        let protected = if out_blob.cbData > 0 && !out_blob.pbData.is_null() {
            std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec()
        } else {
            Vec::new()
        };
        if !out_blob.pbData.is_null() {
            let _ = LocalFree(out_blob.pbData.cast());
        }
        Ok(protected)
    }
}

#[cfg(windows)]
fn dpapi_unprotect(ciphertext: &[u8]) -> Result<Vec<u8>, BrowserHostError> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
        },
    };

    let cb_data = u32::try_from(ciphertext.len()).map_err(|_| {
        BrowserHostError::new("browser_read_failed", "DPAPI ciphertext exceeds u32::MAX")
    })?;
    let in_blob = CRYPT_INTEGER_BLOB {
        cbData: cb_data,
        pbData: ciphertext.as_ptr().cast_mut(),
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };

    unsafe {
        let ok = CryptUnprotectData(
            &raw const in_blob,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &raw mut out_blob,
        );
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            if !out_blob.pbData.is_null() {
                let _ = LocalFree(out_blob.pbData.cast());
            }
            return Err(BrowserHostError::new(
                "browser_read_failed",
                format!("CryptUnprotectData failed: {err}"),
            ));
        }
        let plaintext = if out_blob.cbData > 0 && !out_blob.pbData.is_null() {
            std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec()
        } else {
            Vec::new()
        };
        if !out_blob.pbData.is_null() {
            let _ = LocalFree(out_blob.pbData.cast());
        }
        Ok(plaintext)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aes_gcm_vault_encrypts_at_rest_and_never_stores_plaintext() {
        let dir = tempfile::tempdir().expect("tempdir");
        let vault_path = dir.path().join(VAULT_FILENAME);
        let store = ProfileCredentialStore::open_with_protector(
            Some(vault_path.clone()),
            KeyProtector::Memory([7u8; KEY_LEN]),
        );

        let mut items = Vec::new();
        let stats = merge_credentials(
            &mut items,
            vec![CredentialUpsertInput {
                name: "GitHub".to_owned(),
                url: "https://github.com/login".to_owned(),
                username: "octocat".to_owned(),
                password: "super-secret-password-987".to_owned(),
                note: "work".to_owned(),
                source: "chrome-csv".to_owned(),
                updated_at: 1000,
            }],
        );
        assert_eq!(stats.added, 1);
        store.save_all(&items).expect("save encrypted vault");

        let disk_contents = fs::read_to_string(&vault_path).expect("read vault file");
        assert!(!disk_contents.contains("super-secret-password-987"));
        assert!(!disk_contents.contains("octocat"));
        assert!(disk_contents.contains("ciphertext"));

        let loaded = store.load_all().expect("decrypt vault");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].password, "super-secret-password-987");
        assert_eq!(loaded[0].origin, "https://github.com");

        let summary = CredentialSummary::from(&loaded[0]);
        let summary_json = serde_json::to_string(&summary).expect("serialize summary");
        assert!(!summary_json.contains("super-secret-password-987"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_dpapi_protects_and_unprotects_vault_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = ProfileCredentialStore::open(Some(dir.path()), "work-profile").expect("open");
        let mut items = Vec::new();
        merge_credentials(
            &mut items,
            vec![CredentialUpsertInput {
                name: "Linear".to_owned(),
                url: "https://linear.app/login".to_owned(),
                username: "dev@example.com".to_owned(),
                password: "dpapi-secret-value".to_owned(),
                note: String::new(),
                source: "edge-csv".to_owned(),
                updated_at: 2000,
            }],
        );
        store.save_all(&items).expect("save with DPAPI");

        let dpapi_key_bytes =
            fs::read(dir.path().join("work-profile").join(DPAPI_KEY_FILENAME)).expect("key file");
        assert!(!dpapi_key_bytes.is_empty());

        let reloaded = ProfileCredentialStore::open(Some(dir.path()), "work-profile")
            .expect("reopen")
            .load_all()
            .expect("decrypt with DPAPI");
        assert_eq!(reloaded.len(), 1);
        assert_eq!(reloaded[0].password, "dpapi-secret-value");
    }

    #[test]
    fn credential_origin_matching_is_strict_on_scheme_and_domain() {
        let cred = StoredCredential {
            id: "1".into(),
            name: "GitHub".into(),
            url: "https://github.com/login".into(),
            origin: "https://github.com".into(),
            host: "github.com".into(),
            username: "alice".into(),
            password: "pw".into(),
            note: String::new(),
            source: "csv".into(),
            updated_at: 1,
        };
        assert!(credential_matches_url(&cred, "https://github.com/settings"));
        assert!(credential_matches_url(&cred, "https://gist.github.com/"));
        assert!(credential_matches_url(
            &cred,
            "https://www.github.com/login"
        ));
        assert!(!credential_matches_url(&cred, "http://github.com/login"));
        assert!(!credential_matches_url(
            &cred,
            "https://evilgithub.com/login"
        ));
        assert!(!credential_matches_url(&cred, "about:blank"));
    }
}
