use reqwest::Client;
use serde::Deserialize;

const MAINLAND_GITHUB_PROXIES: &[&str] = &["https://ghfast.top/", "https://ghproxy.net/"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DownloadSource {
    Official,
    Mainland,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GithubRelease {
    #[allow(dead_code)]
    pub tag_name: String,
    pub assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct GithubReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
    pub digest: Option<String>,
}

impl GithubReleaseAsset {
    pub(crate) fn sha256_digest(&self) -> Option<&str> {
        self.digest
            .as_deref()
            .and_then(|digest| digest.strip_prefix("sha256:"))
    }
}

pub(crate) fn candidate_urls(official: &str) -> Vec<(DownloadSource, String)> {
    let mut urls = vec![(DownloadSource::Official, official.to_string())];
    if is_github_hosted(official) {
        for proxy in MAINLAND_GITHUB_PROXIES {
            urls.push((DownloadSource::Mainland, format!("{proxy}{official}")));
        }
    }
    urls
}

fn is_github_hosted(url: &str) -> bool {
    url.starts_with("https://github.com/") || url.starts_with("https://api.github.com/")
}

pub(crate) async fn get_with_fallback(
    client: &Client,
    official_url: &str,
) -> Result<(reqwest::Response, DownloadSource), String> {
    let mut last_error = None;
    for (source, url) in candidate_urls(official_url) {
        match client.get(&url).send().await {
            Ok(response) => match response.error_for_status() {
                Ok(response) => return Ok((response, source)),
                Err(error) => last_error = Some(format!("Failed to fetch {url}: {error}")),
            },
            Err(error) => last_error = Some(format!("Failed to fetch {url}: {error}")),
        }
    }
    Err(last_error.unwrap_or_else(|| format!("Failed to fetch {official_url}")))
}

pub(crate) async fn download_with_fallback(
    client: &Client,
    official_url: &str,
    limit: usize,
) -> Result<(Vec<u8>, DownloadSource), String> {
    let (response, source) = get_with_fallback(client, official_url).await?;
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(format!(
            "Download exceeds the {limit}-byte safety limit: {official_url}"
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read {official_url}: {error}"))?;
    if bytes.len() > limit {
        return Err(format!(
            "Download exceeds the {limit}-byte safety limit: {official_url}"
        ));
    }
    Ok((bytes.to_vec(), source))
}

pub(crate) async fn github_latest_release(
    client: &Client,
    owner: &str,
    repo: &str,
) -> Result<(GithubRelease, DownloadSource), String> {
    let official = format!("https://api.github.com/repos/{owner}/{repo}/releases/latest");
    let (response, source) = get_with_fallback(client, &official).await?;
    response
        .json()
        .await
        .map(|release| (release, source))
        .map_err(|error| format!("Failed to parse the latest {owner}/{repo} release: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_urls_try_official_source_before_mainland_proxies() {
        let urls = candidate_urls("https://github.com/cli/cli/releases/latest");
        assert_eq!(urls[0].0, DownloadSource::Official);
        assert_eq!(urls[0].1, "https://github.com/cli/cli/releases/latest");
        assert!(urls.iter().any(|(source, url)| {
            *source == DownloadSource::Mainland
                && url == "https://ghfast.top/https://github.com/cli/cli/releases/latest"
        }));
        assert!(urls.iter().any(|(source, url)| {
            *source == DownloadSource::Mainland
                && url == "https://ghproxy.net/https://github.com/cli/cli/releases/latest"
        }));
    }

    #[test]
    fn non_github_urls_do_not_gain_mainland_proxies() {
        let urls = candidate_urls("https://example.com/git.zip");
        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0].0, DownloadSource::Official);
    }

    #[test]
    fn asset_digest_strips_sha256_prefix() {
        let asset = GithubReleaseAsset {
            name: "git.tar.gz".to_string(),
            browser_download_url: "https://github.com/example".to_string(),
            digest: Some(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_string(),
            ),
        };
        assert_eq!(
            asset.sha256_digest(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
    }
}
