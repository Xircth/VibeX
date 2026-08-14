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

struct FakeIpResolver;

#[async_trait]
impl HostResolver for FakeIpResolver {
    async fn resolve(&self, _host: &str, _port: u16) -> Result<Vec<IpAddr>, PortError> {
        Ok(vec![
            "198.18.0.42".parse().expect("proxy synthetic address"),
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

#[tokio::test]
async fn trusted_github_downloads_can_use_a_system_proxy_fake_ip() {
    let downloader = HttpDownloader::with_resolver(
        Arc::new(FakeIpResolver),
        Duration::from_millis(50),
        Duration::from_millis(50),
        1024,
    );

    let error = downloader
        .fetch(
            "https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.140/officecli-mac-arm64",
        )
        .await
        .expect_err("the short test timeout should stop before a real download");

    assert!(
        !error.to_string().contains("public IP"),
        "trusted GitHub downloads should progress past proxy fake-IP validation: {error}"
    );
}

#[tokio::test]
async fn trusted_nodejs_downloads_can_use_a_system_proxy_fake_ip() {
    let downloader = HttpDownloader::with_resolver(
        Arc::new(FakeIpResolver),
        Duration::from_millis(50),
        Duration::from_millis(50),
        1024,
    );

    let error = downloader
        .fetch("https://nodejs.org/dist/v22.22.3/node-v22.22.3-darwin-arm64.tar.gz")
        .await
        .expect_err("the short test timeout should stop before a real download");

    assert!(
        !error.to_string().contains("public IP"),
        "the pinned Node.js distribution should progress past proxy fake-IP validation: {error}"
    );
}

#[tokio::test]
async fn untrusted_hosts_cannot_use_a_system_proxy_fake_ip() {
    let downloader = HttpDownloader::with_resolver(
        Arc::new(FakeIpResolver),
        Duration::from_millis(50),
        Duration::from_millis(50),
        1024,
    );

    let error = downloader
        .fetch("https://downloads.example.com/officecli")
        .await
        .expect_err("untrusted fake-IP resolution must be rejected");

    assert!(error.to_string().contains("public IP"));
}
