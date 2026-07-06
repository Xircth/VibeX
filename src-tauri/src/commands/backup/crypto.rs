//! Optional passphrase encryption for portable backups (P3-4).
//!
//! When a passphrase is supplied, the plaintext backup JSON is wrapped in a
//! `VIBEXBAK` envelope: an unencrypted header (magic + KDF params + salt + nonce
//! prefix) followed by the payload encrypted with AES-256-GCM in a chunked
//! STREAM construction. The header is plaintext because the salt/nonce must be
//! readable before the key can be derived; the GCM tag authenticates the
//! passphrase (a wrong passphrase fails to decrypt).
//!
//! Ported from the sibling reference (codeg `commands/backup/crypto.rs`), adapted
//! to VibeX's in-memory payload (bytes in / bytes out, no file streaming and no
//! cancellation token) and `AppError`.

// aes-gcm 0.10's STREAM API is built on `generic_array` 0.14, whose compat shim a
// transitively-pulled generic-array 1.x marks deprecated. We deliberately use the
// documented aes-gcm 0.10 nonce API; this is ecosystem migration churn, not a
// crypto concern. Scope the allow to this module only.
#![allow(deprecated)]

use std::io::{self, Cursor, Read};

use aes_gcm::aead::generic_array::GenericArray;
use aes_gcm::aead::stream::{DecryptorBE32, EncryptorBE32};
use aes_gcm::{Aes256Gcm, KeyInit};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// First 8 bytes of an encrypted backup.
pub const ENVELOPE_MAGIC: &[u8; 8] = b"VIBEXBAK";
pub const ENVELOPE_HEADER_VERSION: u8 = 1;

/// Plaintext chunk size fed to the STREAM cipher. Ciphertext chunks are this
/// plus [`GCM_TAG_LEN`].
pub const DEFAULT_CHUNK_SIZE: usize = 64 * 1024;
const GCM_TAG_LEN: usize = 16;
/// STREAM-BE32 reserves 5 of the 12 GCM nonce bytes (4 counter + 1 last-block
/// flag), leaving a 7-byte random prefix.
const NONCE_PREFIX_LEN: usize = 7;
const SALT_LEN: usize = 16;

// Bounds enforced on a decrypted envelope's attacker-controlled header.
const MIN_SALT_LEN: usize = 8;
const MAX_SALT_LEN: usize = 64;
const MIN_CHUNK_SIZE: usize = 4 * 1024;
const MAX_CHUNK_SIZE: usize = 1024 * 1024;
// Bound an attacker-controlled encrypted header to the product-supported KDF
// envelope (we only ever emit m=64 MiB / t=3 / p=1). A hostile file therefore
// can't drive >256 MiB / 10-pass Argon2 work during inspect/restore before the
// GCM tag fails. Widen these only alongside a header-version bump.
const MAX_M_COST: u32 = 256 * 1024; // 256 MiB (Argon2 m_cost is in KiB)
const MAX_T_COST: u32 = 10;
const MAX_P_COST: u32 = 4;

// Argon2id defaults. 64 MiB / 3 passes / 1 lane is a reasonable interactive cost
// that still meaningfully slows brute force on a leaked archive.
const DEFAULT_M_COST: u32 = 64 * 1024;
const DEFAULT_T_COST: u32 = 3;
const DEFAULT_P_COST: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KdfParams {
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    /// Argon2 version constant: `0x13` (19) for the modern V0x13.
    pub version: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self {
            m_cost: DEFAULT_M_COST,
            t_cost: DEFAULT_T_COST,
            p_cost: DEFAULT_P_COST,
            version: 0x13,
        }
    }
}

/// Cleartext header at the front of a `VIBEXBAK` payload. Carries everything
/// needed to re-derive the key and decrypt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvelopeHeader {
    pub algo: String,
    pub kdf: String,
    pub kdf_params: KdfParams,
    pub salt_b64: String,
    pub nonce_prefix_b64: String,
    pub chunk_size: usize,
}

/// Cheap probe of the first bytes to tell an encrypted envelope from plaintext.
pub fn is_encrypted(bytes: &[u8]) -> bool {
    bytes.len() >= ENVELOPE_MAGIC.len() && &bytes[..ENVELOPE_MAGIC.len()] == ENVELOPE_MAGIC
}

fn derive_key(passphrase: &str, salt: &[u8], params: &KdfParams) -> Result<[u8; 32], AppError> {
    let p = Params::new(params.m_cost, params.t_cost, params.p_cost, Some(32))
        .map_err(|e| AppError::Internal(format!("Invalid KDF parameters: {e}")))?;
    let version = if params.version == 0x10 {
        Version::V0x10
    } else {
        Version::V0x13
    };
    let argon2 = Argon2::new(Algorithm::Argon2id, version, p);
    let mut key = [0u8; 32];
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| AppError::Internal(format!("Key derivation failed: {e}")))?;
    Ok(key)
}

/// Encrypt `plaintext` into a `VIBEXBAK` envelope.
pub fn encrypt_bytes(plaintext: &[u8], passphrase: &str) -> Result<Vec<u8>, AppError> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_prefix = [0u8; NONCE_PREFIX_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    rand::rngs::OsRng.fill_bytes(&mut nonce_prefix);

    let kdf_params = KdfParams::default();
    let key = derive_key(passphrase, &salt, &kdf_params)?;

    let header = EnvelopeHeader {
        algo: "AES-256-GCM".to_string(),
        kdf: "Argon2id".to_string(),
        kdf_params,
        salt_b64: B64.encode(salt),
        nonce_prefix_b64: B64.encode(nonce_prefix),
        chunk_size: DEFAULT_CHUNK_SIZE,
    };
    let header_json = serde_json::to_vec(&header)
        .map_err(|e| AppError::Internal(format!("Serialize envelope header: {e}")))?;

    let mut out = Vec::with_capacity(plaintext.len() + header_json.len() + 64);
    out.extend_from_slice(ENVELOPE_MAGIC);
    out.push(ENVELOPE_HEADER_VERSION);
    out.extend_from_slice(&(header_json.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_json);

    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| AppError::Internal(format!("Cipher init failed: {e}")))?;
    let nonce = GenericArray::from_slice(&nonce_prefix);
    let mut enc = EncryptorBE32::from_aead(cipher, nonce);

    // An empty payload still emits one (empty) final chunk → just the GCM tag.
    let chunks: Vec<&[u8]> = if plaintext.is_empty() {
        vec![&[]]
    } else {
        plaintext.chunks(DEFAULT_CHUNK_SIZE).collect()
    };
    let last = chunks.len() - 1;
    for chunk in &chunks[..last] {
        let ct = enc
            .encrypt_next(*chunk)
            .map_err(|_| AppError::Internal("Encryption failed".to_string()))?;
        out.extend_from_slice(&ct);
    }
    let ct = enc
        .encrypt_last(chunks[last])
        .map_err(|_| AppError::Internal("Encryption failed".to_string()))?;
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Decrypt a `VIBEXBAK` envelope. A wrong passphrase (or tampering) surfaces as
/// a `BadRequest` authentication error.
pub fn decrypt_bytes(input: &[u8], passphrase: &str) -> Result<Vec<u8>, AppError> {
    let mut cursor = Cursor::new(input);
    let header = read_header(&mut cursor)?;
    // The header is attacker-controlled; validate every field that drives an
    // allocation (chunk_size) or CPU/memory work (Argon2 params) BEFORE deriving
    // the key, to deny a malformed file a memory/CPU DoS during inspect/restore.
    validate_header(&header)?;

    let salt = B64
        .decode(header.salt_b64.as_bytes())
        .map_err(|_| corrupt_header_error())?;
    let nonce_prefix = B64
        .decode(header.nonce_prefix_b64.as_bytes())
        .map_err(|_| corrupt_header_error())?;
    if nonce_prefix.len() != NONCE_PREFIX_LEN {
        return Err(corrupt_header_error());
    }
    if !(MIN_SALT_LEN..=MAX_SALT_LEN).contains(&salt.len()) {
        return Err(corrupt_header_error());
    }

    let key = derive_key(passphrase, &salt, &header.kdf_params)?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| AppError::Internal(format!("Cipher init failed: {e}")))?;
    let nonce = GenericArray::from_slice(&nonce_prefix);
    let mut dec = DecryptorBE32::from_aead(cipher, nonce);

    let body = &input[cursor.position() as usize..];
    let block = header.chunk_size + GCM_TAG_LEN;
    // A valid envelope always has at least the final chunk (>= GCM tag).
    if body.is_empty() {
        return Err(corrupt_header_error());
    }
    let chunks: Vec<&[u8]> = body.chunks(block).collect();
    let last = chunks.len() - 1;
    let mut out = Vec::with_capacity(body.len());
    for chunk in &chunks[..last] {
        let pt = dec
            .decrypt_next(*chunk)
            .map_err(|_| bad_passphrase_error())?;
        out.extend_from_slice(&pt);
    }
    let pt = dec
        .decrypt_last(chunks[last])
        .map_err(|_| bad_passphrase_error())?;
    out.extend_from_slice(&pt);
    Ok(out)
}

/// Reject an envelope header whose fields are out of the bounds we ever produce,
/// before any of them drives an allocation or KDF work.
fn validate_header(h: &EnvelopeHeader) -> Result<(), AppError> {
    if h.algo != "AES-256-GCM" || h.kdf != "Argon2id" {
        return Err(corrupt_header_error());
    }
    if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&h.chunk_size) {
        return Err(corrupt_header_error());
    }
    let p = &h.kdf_params;
    if !(8..=MAX_M_COST).contains(&p.m_cost)
        || !(1..=MAX_T_COST).contains(&p.t_cost)
        || !(1..=MAX_P_COST).contains(&p.p_cost)
    {
        return Err(corrupt_header_error());
    }
    Ok(())
}

fn read_header<R: Read>(reader: &mut R) -> Result<EnvelopeHeader, AppError> {
    let mut magic = [0u8; 8];
    read_fill(reader, &mut magic).map_err(io_error)?;
    if &magic != ENVELOPE_MAGIC {
        return Err(corrupt_header_error());
    }
    let mut ver = [0u8; 1];
    read_fill(reader, &mut ver).map_err(io_error)?;
    if ver[0] != ENVELOPE_HEADER_VERSION {
        return Err(corrupt_header_error());
    }
    let mut len_buf = [0u8; 4];
    read_fill(reader, &mut len_buf).map_err(io_error)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    // Guard against an absurd declared header length (corruption / hostile file).
    if len > 1024 * 1024 {
        return Err(corrupt_header_error());
    }
    let mut json = vec![0u8; len];
    if read_fill(reader, &mut json).map_err(io_error)? != len {
        return Err(corrupt_header_error());
    }
    serde_json::from_slice(&json).map_err(|_| corrupt_header_error())
}

/// Read exactly `buf.len()` bytes, or fewer at EOF. Returns the count read.
fn read_fill<R: Read>(reader: &mut R, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        let n = reader.read(&mut buf[filled..])?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    Ok(filled)
}

fn io_error(e: io::Error) -> AppError {
    AppError::Internal(format!("Failed to read backup envelope: {e}"))
}

fn bad_passphrase_error() -> AppError {
    AppError::BadRequest("Incorrect passphrase or corrupted backup".to_string())
}

fn corrupt_header_error() -> AppError {
    AppError::BadRequest("Malformed backup envelope header".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(plain: &[u8]) {
        let enc = encrypt_bytes(plain, "hunter2").unwrap();
        assert!(is_encrypted(&enc));
        let dec = decrypt_bytes(&enc, "hunter2").unwrap();
        assert_eq!(dec, plain);
    }

    #[test]
    fn roundtrip_various_sizes() {
        roundtrip(b"");
        roundtrip(b"hello");
        roundtrip(&vec![7u8; DEFAULT_CHUNK_SIZE]); // exactly one chunk
        roundtrip(&vec![9u8; DEFAULT_CHUNK_SIZE + 1]); // one chunk + 1
        roundtrip(&vec![3u8; DEFAULT_CHUNK_SIZE * 2 + 123]); // multi-chunk + partial
    }

    #[test]
    fn plaintext_json_is_not_detected_as_encrypted() {
        assert!(!is_encrypted(b"{\"manifest\":{}}"));
        assert!(!is_encrypted(b""));
    }

    #[test]
    fn wrong_passphrase_fails() {
        let enc = encrypt_bytes(b"secret payload", "correct horse").unwrap();
        let err = decrypt_bytes(&enc, "battery staple").unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)));
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let mut enc = encrypt_bytes(b"secret payload", "pw").unwrap();
        let last = enc.len() - 1;
        enc[last] ^= 0xff;
        assert!(decrypt_bytes(&enc, "pw").is_err());
    }

    #[test]
    fn validate_header_rejects_out_of_bounds_fields() {
        let base = EnvelopeHeader {
            algo: "AES-256-GCM".to_string(),
            kdf: "Argon2id".to_string(),
            kdf_params: KdfParams::default(),
            salt_b64: B64.encode([0u8; SALT_LEN]),
            nonce_prefix_b64: B64.encode([0u8; NONCE_PREFIX_LEN]),
            chunk_size: DEFAULT_CHUNK_SIZE,
        };
        assert!(validate_header(&base).is_ok());

        let mut huge_chunk = base.clone();
        huge_chunk.chunk_size = 1 << 30; // 1 GiB buffer → reject
        assert!(validate_header(&huge_chunk).is_err());

        let mut huge_mem = base.clone();
        huge_mem.kdf_params.m_cost = 1 << 30; // absurd Argon2 memory → reject
        assert!(validate_header(&huge_mem).is_err());

        let mut over_envelope = base.clone();
        over_envelope.kdf_params.m_cost = 512 * 1024; // 512 MiB > product cap
        assert!(validate_header(&over_envelope).is_err());

        let mut bad_algo = base.clone();
        bad_algo.algo = "rot13".to_string();
        assert!(validate_header(&bad_algo).is_err());
    }
}
