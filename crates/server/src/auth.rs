use std::fmt;

use sha2::{Digest, Sha256};

/// Plaintext bearer token accepted only at the composition boundary.
///
/// The server runtime immediately converts this value to a SHA-256 digest and
/// never stores the plaintext in router state.
pub struct ServerToken(String);

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("server token must contain at least 32 bytes")]
pub struct ServerTokenError;

impl ServerToken {
    pub fn new(value: impl Into<String>) -> Self {
        Self::try_new(value).expect("server token must contain at least 32 bytes")
    }

    pub fn try_new(value: impl Into<String>) -> Result<Self, ServerTokenError> {
        let value = value.into();
        if value.len() < 32 {
            return Err(ServerTokenError);
        }
        Ok(Self(value))
    }

    pub(crate) fn digest(&self) -> TokenDigest {
        TokenDigest(Sha256::digest(self.0.as_bytes()).into())
    }

    /// Consume a newly-issued token so a composition root can display it once.
    pub fn expose_once(self) -> String {
        self.0
    }
}

impl fmt::Debug for ServerToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ServerToken([REDACTED])")
    }
}

#[derive(Clone)]
pub(crate) struct TokenDigest([u8; 32]);

impl TokenDigest {
    pub(crate) const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub(crate) const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub(crate) fn verifies(&self, candidate: &str) -> bool {
        let candidate: [u8; 32] = Sha256::digest(candidate.as_bytes()).into();
        self.0
            .iter()
            .zip(candidate)
            .fold(0_u8, |difference, (expected, actual)| {
                difference | (expected ^ actual)
            })
            == 0
    }
}

/// Opaque, clonable authentication material containing only a token digest.
#[derive(Clone)]
pub struct ServerCredentials {
    pub(crate) token_digest: TokenDigest,
}

impl ServerCredentials {
    pub(crate) fn from_token(token: &ServerToken) -> Self {
        Self {
            token_digest: token.digest(),
        }
    }

    pub(crate) const fn from_digest(token_digest: TokenDigest) -> Self {
        Self { token_digest }
    }
}

impl fmt::Debug for ServerCredentials {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ServerCredentials([SHA-256])")
    }
}
