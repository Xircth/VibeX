use std::collections::BTreeSet;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Principal {
    LocalDesktop,
    Remote {
        subject: String,
        credential_id: Option<String>,
        device_id: Option<String>,
        scopes: BTreeSet<String>,
    },
}

impl Principal {
    pub const fn local_desktop() -> Self {
        Self::LocalDesktop
    }

    pub fn remote(subject: impl Into<String>, scopes: impl IntoIterator<Item = String>) -> Self {
        Self::Remote {
            subject: subject.into(),
            credential_id: None,
            device_id: None,
            scopes: scopes.into_iter().collect(),
        }
    }

    pub fn remote_credential(
        subject: impl Into<String>,
        credential_id: impl Into<String>,
        device_id: Option<String>,
        scopes: impl IntoIterator<Item = String>,
    ) -> Self {
        Self::Remote {
            subject: subject.into(),
            credential_id: Some(credential_id.into()),
            device_id,
            scopes: scopes.into_iter().collect(),
        }
    }

    pub fn credential_id(&self) -> Option<&str> {
        match self {
            Self::LocalDesktop => None,
            Self::Remote { credential_id, .. } => credential_id.as_deref(),
        }
    }

    pub fn device_id(&self) -> Option<&str> {
        match self {
            Self::LocalDesktop => None,
            Self::Remote { device_id, .. } => device_id.as_deref(),
        }
    }

    pub(crate) fn allows(&self, required_scope: &str) -> bool {
        match self {
            Self::LocalDesktop => true,
            Self::Remote { scopes, .. } => scopes.contains(required_scope),
        }
    }
}
