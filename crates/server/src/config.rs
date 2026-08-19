use std::{
    collections::BTreeSet,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
};

use remote_protocol::ReachabilityOrigin;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ListenPolicyError;

impl std::fmt::Display for ListenPolicyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("non-loopback listening requires explicit LAN opt-in")
    }
}

impl std::error::Error for ListenPolicyError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerConfig {
    pub listen_addr: SocketAddr,
    pub server_version: String,
    pub minimum_client_version: String,
    pub allowed_origins: BTreeSet<String>,
    pub static_root: Option<PathBuf>,
    pub host_id: String,
    pub reachability: Vec<ReachabilityOrigin>,
}

impl ServerConfig {
    pub fn with_listen_addr(
        mut self,
        listen_addr: SocketAddr,
        allow_lan: bool,
    ) -> Result<Self, ListenPolicyError> {
        if !listen_addr.ip().is_loopback() && !allow_lan {
            return Err(ListenPolicyError);
        }
        self.listen_addr = listen_addr;
        Ok(self)
    }

    pub fn with_allowed_origins(
        mut self,
        origins: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        self.allowed_origins = origins.into_iter().map(Into::into).collect();
        self
    }

    pub fn with_static_root(mut self, root: impl AsRef<Path>) -> Self {
        self.static_root = Some(root.as_ref().to_path_buf());
        self
    }

    pub fn with_host_identity(
        mut self,
        host_id: impl Into<String>,
        reachability: impl IntoIterator<Item = ReachabilityOrigin>,
    ) -> Self {
        self.host_id = host_id.into();
        self.reachability = reachability.into_iter().collect();
        self
    }

    pub fn bind_ip(allow_lan: bool) -> Ipv4Addr {
        if allow_lan {
            Ipv4Addr::UNSPECIFIED
        } else {
            Ipv4Addr::LOCALHOST
        }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            listen_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3080),
            server_version: env!("CARGO_PKG_VERSION").to_string(),
            minimum_client_version: "0.1.0".to_string(),
            allowed_origins: BTreeSet::new(),
            static_root: None,
            host_id: String::new(),
            reachability: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use super::ServerConfig;

    #[test]
    fn lan_opt_in_changes_the_bind_address() {
        assert_eq!(ServerConfig::bind_ip(false), Ipv4Addr::LOCALHOST);
        assert_eq!(ServerConfig::bind_ip(true), Ipv4Addr::UNSPECIFIED);
    }
}
