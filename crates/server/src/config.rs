use std::net::{IpAddr, Ipv4Addr, SocketAddr};

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
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            listen_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 3080),
            server_version: env!("CARGO_PKG_VERSION").to_string(),
            minimum_client_version: "0.1.0".to_string(),
        }
    }
}
