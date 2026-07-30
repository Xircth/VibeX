use std::collections::BTreeSet;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Principal {
    LocalDesktop,
    Remote {
        subject: String,
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
            scopes: scopes.into_iter().collect(),
        }
    }

    pub(crate) fn allows(&self, required_scope: &str) -> bool {
        match self {
            Self::LocalDesktop => true,
            Self::Remote { scopes, .. } => scopes.contains(required_scope),
        }
    }
}
