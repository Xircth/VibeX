use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

use agents::{
    BoundaryError, Clock, OfficialRegistryHttpFetcher, RegistryCache, RegistryCacheFreshness,
    RegistryFetchResponse, RegistryFetcher, RegistrySnapshotClient, SystemClock,
};
use async_trait::async_trait;
use chrono::{DateTime, Duration, TimeZone, Utc};

struct ScriptedFetcher {
    responses: Mutex<HashMap<String, VecDeque<Result<RegistryFetchResponse, BoundaryError>>>>,
    requests: Mutex<Vec<String>>,
}

impl ScriptedFetcher {
    fn new(
        responses: impl IntoIterator<
            Item = (
                &'static str,
                Vec<Result<RegistryFetchResponse, BoundaryError>>,
            ),
        >,
    ) -> Self {
        Self {
            responses: Mutex::new(
                responses
                    .into_iter()
                    .map(|(url, responses)| (url.to_string(), responses.into()))
                    .collect(),
            ),
            requests: Mutex::new(Vec::new()),
        }
    }

    fn request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

#[async_trait]
impl RegistryFetcher for ScriptedFetcher {
    async fn fetch(
        &self,
        url: &str,
        _etag: Option<&str>,
    ) -> Result<RegistryFetchResponse, BoundaryError> {
        self.requests.lock().unwrap().push(url.to_string());
        self.responses
            .lock()
            .unwrap()
            .get_mut(url)
            .and_then(VecDeque::pop_front)
            .unwrap_or_else(|| Err(BoundaryError::new(format!("no response for {url}"))))
    }
}

struct MutableClock(Mutex<DateTime<Utc>>);

impl MutableClock {
    fn advance(&self, duration: Duration) {
        *self.0.lock().unwrap() += duration;
    }
}

impl Clock for MutableClock {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock().unwrap()
    }
}

fn response(body: &str, etag: &str) -> Result<RegistryFetchResponse, BoundaryError> {
    Ok(RegistryFetchResponse {
        status: 200,
        body: body.as_bytes().to_vec(),
        etag: Some(etag.to_string()),
    })
}

fn registry(version: &str, agent_version: &str, icon: &str) -> String {
    format!(
        r#"{{
          "version": "{version}",
          "agents": [{{
            "id": "vendor-agent",
            "name": "Vendor Agent",
            "version": "{agent_version}",
            "description": "A generic ACP Agent",
            "repository": "https://example.test/vendor-agent",
            "distribution": {{
              "npx": {{ "package": "vendor-agent@{agent_version}" }}
            }},
            "icon": "{icon}"
          }}],
          "extensions": []
        }}"#
    )
}

#[tokio::test]
async fn registry_cache_keeps_last_valid_snapshot_on_invalid_refresh() {
    let registry_url = RegistrySnapshotClient::OFFICIAL_REGISTRY_URL;
    let icon_url = "https://cdn.agentclientprotocol.com/registry/v1/latest/vendor-agent.svg";
    let initial = registry("1.0.0", "1.2.3", icon_url);
    let fetcher = Arc::new(ScriptedFetcher::new([
        (
            registry_url,
            vec![
                response(&initial, "v1"),
                response(r#"{"version":"1.0.0","agents":"invalid"}"#, "bad"),
            ],
        ),
        (
            icon_url,
            vec![response(
                r#"<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>"#,
                "icon-v1",
            )],
        ),
    ]));
    let clock = Arc::new(MutableClock(Mutex::new(
        Utc.with_ymd_and_hms(2026, 7, 29, 0, 0, 0).unwrap(),
    )));
    let client = RegistrySnapshotClient::new(fetcher.clone(), clock.clone());
    let mut cache = RegistryCache::default();

    let first = client.open(&mut cache).await;
    assert!(first.refresh_error.is_none());
    assert_eq!(first.freshness, RegistryCacheFreshness::Fresh);
    assert_eq!(first.entries[0].agent_id.as_str(), "vendor-agent");
    assert!(
        first.entries[0]
            .icon_svg
            .as_deref()
            .unwrap()
            .contains("<path")
    );

    let target = first.entries[0].lock_add_target(first.snapshot_id);
    assert_eq!(target.version, "1.2.3");

    clock.advance(Duration::hours(23));
    let cached = client.open(&mut cache).await;
    assert_eq!(cached.freshness, RegistryCacheFreshness::Fresh);
    assert_eq!(fetcher.request_count(), 2);

    clock.advance(Duration::hours(2));
    let retained = client.open(&mut cache).await;
    assert!(retained.refresh_error.is_some());
    assert_eq!(retained.entries[0].version, "1.2.3");
    assert_eq!(target.version, "1.2.3");

    let unsafe_icon = agents::sanitize_registry_svg(
        r#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#,
    );
    assert!(unsafe_icon.is_none());

    let offline_fetcher = Arc::new(ScriptedFetcher::new([(
        registry_url,
        vec![Err(BoundaryError::new("offline"))],
    )]));
    let offline_client = RegistrySnapshotClient::new(offline_fetcher, clock);
    let mut empty_cache = RegistryCache::default();
    let offline = offline_client.open(&mut empty_cache).await;
    assert!(offline.entries.is_empty());
    assert_eq!(offline.freshness, RegistryCacheFreshness::Empty);
    assert!(offline.refresh_error.is_some());
}

/// Manual contract probe for the live ACP Registry. This is intentionally
/// ignored in deterministic test runs, but catches schema and HTTP adapter
/// drift before a release.
#[tokio::test]
#[ignore = "requires the live official ACP Registry"]
async fn live_official_registry_returns_the_public_catalog() {
    let client = RegistrySnapshotClient::new(
        Arc::new(OfficialRegistryHttpFetcher::default()),
        Arc::new(SystemClock),
    );
    let mut cache = RegistryCache::default();

    let view = client.refresh(&mut cache).await;

    assert_eq!(view.refresh_error, None);
    assert!(
        view.entries.len() >= 30,
        "expected the public catalog, got {} entries",
        view.entries.len()
    );
}

#[tokio::test]
async fn registry_package_integrity_is_preserved_across_parse_and_persist() {
    // ADR-0038 Phase 1:官方 Registry 的 npx 分发若提供 integrity,必须被解析
    // 保留并随 snapshot 持久化;缺失时保持 None 且不破坏现有解析。
    let registry_url = RegistrySnapshotClient::OFFICIAL_REGISTRY_URL;
    let with_integrity = r#"{
      "version": "1.0.0",
      "agents": [{
        "id": "vendor-agent",
        "name": "Vendor Agent",
        "version": "1.2.3",
        "description": "A generic ACP Agent",
        "distribution": {
          "npx": { "package": "vendor-agent@1.2.3", "integrity": "sha512-official" }
        }
      }],
      "extensions": []
    }"#;
    let fetcher = Arc::new(ScriptedFetcher::new([(
        registry_url,
        vec![response(with_integrity, "v1")],
    )]));
    let clock = Arc::new(MutableClock(Mutex::new(
        Utc.with_ymd_and_hms(2026, 7, 29, 0, 0, 0).unwrap(),
    )));
    let client = RegistrySnapshotClient::new(fetcher, clock);
    let mut cache = RegistryCache::default();
    let opened = client.open(&mut cache).await;
    assert!(opened.refresh_error.is_none());
    let npx = opened.entries[0]
        .distributions
        .npx
        .as_ref()
        .expect("npx distribution");
    assert_eq!(npx.integrity.as_deref(), Some("sha512-official"));
}
