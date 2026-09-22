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
    pub fn allows(self, required: GrantLevel) -> bool {
        self.rank() >= required.rank()
    }

    fn rank(self) -> u8 {
        match self {
            GrantLevel::None => 0,
            GrantLevel::Read => 1,
            GrantLevel::Control => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGrant {
    pub level: GrantLevel,
    pub origin: String,
    pub granted_at: i64,
}

impl AgentGrant {
    pub fn covers(&self, origin: Option<&str>) -> bool {
        origin == Some(self.origin.as_str())
    }
}

pub fn level_of(grant: Option<&AgentGrant>) -> GrantLevel {
    grant.map_or(GrantLevel::None, |grant| grant.level)
}

pub fn origin_of(url: &url::Url) -> Option<String> {
    match url.scheme() {
        "http" | "https" => {
            let host = url.host_str()?;
            let port = url
                .port()
                .map(|port| format!(":{port}"))
                .unwrap_or_default();
            Some(format!("{}://{host}{port}", url.scheme()))
        }
        _ => None,
    }
}
