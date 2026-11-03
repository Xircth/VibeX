use std::{
    collections::BTreeSet,
    fmt,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
};

use remote_protocol::ReachabilityOrigin;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EmbeddedAsset {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

pub type StaticAssetResolver = Arc<dyn Fn(&str) -> Option<EmbeddedAsset> + Send + Sync>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ListenPolicyError;

impl std::fmt::Display for ListenPolicyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("non-loopback listening requires explicit LAN opt-in")
    }
}

impl std::error::Error for ListenPolicyError {}

#[derive(Clone)]
pub struct ServerConfig {
    pub listen_addr: SocketAddr,
    pub server_version: String,
    pub minimum_client_version: String,
    pub allowed_origins: BTreeSet<String>,
    pub static_root: Option<PathBuf>,
    pub static_asset_resolver: Option<StaticAssetResolver>,
    pub host_id: String,
    pub reachability: Vec<ReachabilityOrigin>,
}

impl fmt::Debug for ServerConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ServerConfig")
            .field("listen_addr", &self.listen_addr)
            .field("server_version", &self.server_version)
            .field("minimum_client_version", &self.minimum_client_version)
            .field("allowed_origins", &self.allowed_origins)
            .field("static_root", &self.static_root)
            .field(
                "static_asset_resolver",
                &self.static_asset_resolver.as_ref().map(|_| "<resolver>"),
            )
            .field("host_id", &self.host_id)
            .field("reachability", &self.reachability)
            .finish()
    }
}

impl PartialEq for ServerConfig {
    fn eq(&self, other: &Self) -> bool {
        self.listen_addr == other.listen_addr
            && self.server_version == other.server_version
            && self.minimum_client_version == other.minimum_client_version
            && self.allowed_origins == other.allowed_origins
            && self.static_root == other.static_root
            && self.static_asset_resolver.is_some() == other.static_asset_resolver.is_some()
            && self.host_id == other.host_id
            && self.reachability == other.reachability
    }
}

impl Eq for ServerConfig {}

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

    pub fn with_static_asset_resolver(mut self, resolver: StaticAssetResolver) -> Self {
        self.static_asset_resolver = Some(resolver);
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
            listen_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 17891),
            server_version: env!("CARGO_PKG_VERSION").to_string(),
            minimum_client_version: "0.1.0".to_string(),
            allowed_origins: BTreeSet::new(),
            static_root: None,
            static_asset_resolver: None,
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
