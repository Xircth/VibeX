use std::{net::IpAddr, sync::Arc, time::Duration};

use async_trait::async_trait;
use tool_runtime::{Downloader, HostResolver, HttpDownloader, PortError};

struct MetadataResolver;

#[async_trait]
impl HostResolver for MetadataResolver {
    async fn resolve(&self, _host: &str, _port: u16) -> Result<Vec<IpAddr>, PortError> {
        Ok(vec![
            "169.254.169.254"
                .parse()
                .expect("link-local metadata address"),
        ])
    }
}

#[tokio::test]
async fn resolved_private_addresses_are_rejected_before_network_access() {
    let downloader = HttpDownloader::with_resolver(
        Arc::new(MetadataResolver),
        Duration::from_secs(1),
        Duration::from_secs(1),
        1024,
    );

    let error = downloader
        .fetch("https://downloads.example.com/officecli")
        .await
        .expect_err("private resolution must be rejected");

    assert!(error.to_string().contains("public IP"));
}
