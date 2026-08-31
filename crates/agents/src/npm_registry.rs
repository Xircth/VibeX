//! npm 官方指纹验证:外部 npx 组件内容变化时,用 npm registry 的
//! `dist.integrity` 校验 tarball,再比对 tarball 内容与磁盘文件。

use std::collections::HashSet;

use async_trait::async_trait;
use base64::Engine;
use serde::Deserialize;
use sha2::{Digest, Sha256, Sha512};

use crate::{BoundaryError, RegistryFetchResponse, RegistryFetcher};

/// npm registry 的 HTTP fetcher。与 ACP Registry 的 fetcher 分离:后者对
/// 官方目录 URL 有白名单,而 npm 验证需要请求任意 npm 包元数据与 tarball。
#[derive(Default)]
pub struct NpmRegistryHttpFetcher {
    client: reqwest::Client,
}

impl NpmRegistryHttpFetcher {
    pub fn new() -> Self {
        Self::new_with_client(reqwest::Client::new())
    }

    pub fn new_with_client(client: reqwest::Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl RegistryFetcher for NpmRegistryHttpFetcher {
    async fn fetch(
        &self,
        url: &str,
        _etag: Option<&str>,
    ) -> Result<RegistryFetchResponse, BoundaryError> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| BoundaryError::new(format!("npm fetch failed: {error}")))?;
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .await
            .map_err(|error| BoundaryError::new(format!("npm response read failed: {error}")))?
            .to_vec();
        Ok(RegistryFetchResponse {
            status,
            body,
            etag: None,
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
struct NpmMetadata {
    versions: std::collections::BTreeMap<String, NpmVersion>,
}

#[derive(Debug, Clone, Deserialize)]
struct NpmVersion {
    dist: NpmDist,
    #[serde(default, rename = "optionalDependencies")]
    optional_dependencies: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    os: Vec<String>,
    #[serde(default)]
    cpu: Vec<String>,
    #[serde(default)]
    libc: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NpmDist {
    pub integrity: String,
    pub tarball: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NpmVerificationOutcome {
    /// 磁盘文件与官方 tarball 中的某个文件一致,且 tarball 通过官方
    /// `dist.integrity`(sha512)校验。
    Verified,
    /// 官方来源可验证,但磁盘文件不属于该版本包(损坏或供应链污染)。
    NotVerified,
    /// 无法完成验证(网络失败、元数据缺失、格式异常);调用方保持 fail-closed。
    Unverifiable(String),
}

/// 验证磁盘上某个已安装的 npm 包文件确实来自官方 registry 的指定版本:
/// 1. 拉取 npm metadata,取 `versions[version].dist` 的 tarball 与 integrity;
/// 2. 下载 tarball 并按 integrity(sha512)校验;
/// 3. 解压 tarball,收集所有文件内容的 SHA-256;
/// 4. 若根包未命中,对当前平台、精确锁版的官方 optional dependency 重复校验;
/// 5. 磁盘文件 SHA-256 命中任一已验证 tarball 的文件即视为验证通过。
///
/// 不解析 `bin` 入口:官方 tarball 本身经 integrity 校验后即为可信来源,
/// 磁盘文件是其中任一文件的精确副本即足以证明其官方出处。
pub async fn verify_npm_component_file(
    fetcher: &dyn RegistryFetcher,
    package_name: &str,
    version: &str,
    disk_sha256: &str,
) -> NpmVerificationOutcome {
    let version_info = match fetch_npm_version(fetcher, package_name, version).await {
        Ok(version_info) => version_info,
        Err(message) => return NpmVerificationOutcome::Unverifiable(message),
    };
    match verify_npm_dist_file(
        fetcher,
        package_name,
        version,
        &version_info.dist,
        disk_sha256,
    )
    .await
    {
        NpmVerificationOutcome::Verified => return NpmVerificationOutcome::Verified,
        NpmVerificationOutcome::Unverifiable(message) => {
            return NpmVerificationOutcome::Unverifiable(message);
        }
        NpmVerificationOutcome::NotVerified => {}
    }

    let mut unverifiable_dependencies = Vec::new();
    for (dependency, requirement) in &version_info.optional_dependencies {
        let Some(dependency_version) = exact_npm_dependency_version(requirement) else {
            unverifiable_dependencies.push(format!(
                "optional dependency `{dependency}` is not version-locked"
            ));
            continue;
        };
        let dependency_info = match fetch_npm_version(fetcher, dependency, dependency_version).await
        {
            Ok(version_info) => version_info,
            Err(message) => {
                unverifiable_dependencies.push(message);
                continue;
            }
        };
        if !npm_version_supports_platform(&dependency_info, NpmPlatform::current()) {
            continue;
        }
        match verify_npm_dist_file(
            fetcher,
            dependency,
            dependency_version,
            &dependency_info.dist,
            disk_sha256,
        )
        .await
        {
            NpmVerificationOutcome::Verified => return NpmVerificationOutcome::Verified,
            NpmVerificationOutcome::NotVerified => {}
            NpmVerificationOutcome::Unverifiable(message) => {
                unverifiable_dependencies.push(message);
            }
        }
    }

    if unverifiable_dependencies.is_empty() {
        NpmVerificationOutcome::NotVerified
    } else {
        NpmVerificationOutcome::Unverifiable(unverifiable_dependencies.join("; "))
    }
}

async fn fetch_npm_version(
    fetcher: &dyn RegistryFetcher,
    package_name: &str,
    version: &str,
) -> Result<NpmVersion, String> {
    let metadata_url = format!(
        "https://registry.npmjs.org/{}",
        package_name.replace('/', "%2f")
    );
    let metadata = match fetcher.fetch(&metadata_url, None).await {
        Ok(response) if response.status == 200 => {
            match serde_json::from_slice::<NpmMetadata>(&response.body) {
                Ok(metadata) => metadata,
                Err(error) => {
                    return Err(format!(
                        "npm metadata for `{package_name}` is invalid: {error}"
                    ));
                }
            }
        }
        Ok(response) => {
            return Err(format!(
                "npm metadata for `{package_name}` returned status {}",
                response.status
            ));
        }
        Err(error) => {
            return Err(format!(
                "npm metadata fetch for `{package_name}` failed: {error}"
            ));
        }
    };
    let Some(version_info) = metadata.versions.get(version) else {
        return Err(format!(
            "npm package `{package_name}` has no version `{version}`"
        ));
    };
    Ok(version_info.clone())
}

async fn verify_npm_dist_file(
    fetcher: &dyn RegistryFetcher,
    package_name: &str,
    version: &str,
    dist: &NpmDist,
    disk_sha256: &str,
) -> NpmVerificationOutcome {
    let tarball = match fetcher.fetch(&dist.tarball, None).await {
        Ok(response) if response.status == 200 => response.body,
        Ok(response) => {
            return NpmVerificationOutcome::Unverifiable(format!(
                "npm tarball for `{package_name}@{version}` returned status {}",
                response.status
            ));
        }
        Err(error) => {
            return NpmVerificationOutcome::Unverifiable(format!(
                "npm tarball fetch for `{package_name}@{version}` failed: {error}"
            ));
        }
    };
    let (algorithm, expected) = match dist.integrity.split_once('-') {
        Some((algorithm, digest)) => (algorithm, digest),
        None => {
            return NpmVerificationOutcome::Unverifiable(format!(
                "malformed npm integrity `{}`",
                dist.integrity
            ));
        }
    };
    if algorithm != "sha512" {
        return NpmVerificationOutcome::Unverifiable(format!(
            "unsupported npm integrity algorithm `{algorithm}`"
        ));
    }
    let expected_digest = match base64::engine::general_purpose::STANDARD.decode(expected) {
        Ok(digest) => digest,
        Err(error) => {
            return NpmVerificationOutcome::Unverifiable(format!(
                "npm integrity is not valid base64: {error}"
            ));
        }
    };
    let actual_digest = Sha512::digest(&tarball);
    let actual: &[u8] = actual_digest.as_ref();
    let expected: &[u8] = expected_digest.as_ref();
    if actual != expected {
        return NpmVerificationOutcome::NotVerified;
    }
    let mut file_hashes = HashSet::new();
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(tarball.as_slice()));
    let entries = match archive.entries() {
        Ok(entries) => entries,
        Err(error) => {
            return NpmVerificationOutcome::Unverifiable(format!(
                "npm tarball for `{package_name}@{version}` is not a valid archive: {error}"
            ));
        }
    };
    for entry in entries {
        let mut entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                return NpmVerificationOutcome::Unverifiable(format!(
                    "npm tarball for `{package_name}@{version}` cannot be read: {error}"
                ));
            }
        };
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let mut bytes = Vec::new();
        if std::io::Read::read_to_end(&mut entry, &mut bytes).is_err() {
            continue;
        }
        file_hashes.insert(format!("{:x}", Sha256::digest(&bytes)));
    }
    if file_hashes.contains(disk_sha256) {
        NpmVerificationOutcome::Verified
    } else {
        NpmVerificationOutcome::NotVerified
    }
}

fn exact_npm_dependency_version(requirement: &str) -> Option<&str> {
    let version = requirement.strip_prefix('=').unwrap_or(requirement);
    if version.is_empty()
        || !version.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '+')
        })
    {
        return None;
    }
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let valid_core = (0..3).all(|_| {
        parts.next().is_some_and(|part| {
            !part.is_empty() && part.chars().all(|character| character.is_ascii_digit())
        })
    }) && parts.next().is_none();
    valid_core.then_some(version)
}

#[derive(Clone, Copy)]
struct NpmPlatform {
    os: &'static str,
    cpu: &'static str,
    libc: Option<&'static str>,
}

impl NpmPlatform {
    fn current() -> Self {
        let os = match std::env::consts::OS {
            "macos" => "darwin",
            os => os,
        };
        let cpu = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "x64",
            cpu => cpu,
        };
        let libc = if cfg!(target_env = "musl") {
            Some("musl")
        } else if cfg!(all(target_os = "linux", target_env = "gnu")) {
            Some("glibc")
        } else {
            None
        };
        Self { os, cpu, libc }
    }
}

fn npm_version_supports_platform(version: &NpmVersion, platform: NpmPlatform) -> bool {
    npm_platform_constraint_matches(&version.os, platform.os)
        && npm_platform_constraint_matches(&version.cpu, platform.cpu)
        && match platform.libc {
            Some(libc) => npm_platform_constraint_matches(&version.libc, libc),
            None => version.libc.is_empty(),
        }
}

fn npm_platform_constraint_matches(constraints: &[String], current: &str) -> bool {
    if constraints
        .iter()
        .any(|constraint| constraint.strip_prefix('!') == Some(current))
    {
        return false;
    }
    let positive = constraints
        .iter()
        .filter(|constraint| !constraint.starts_with('!'))
        .collect::<Vec<_>>();
    positive.is_empty()
        || positive
            .iter()
            .any(|constraint| constraint.as_str() == current)
}

/// 从 `package@version` 形式的 spec 解析包名与版本。
pub fn split_npm_spec(spec: &str) -> Option<(&str, &str)> {
    let separator = if spec.starts_with('@') {
        let slash = spec.find('/')?;
        spec[slash + 1..]
            .rfind('@')
            .map(|offset| slash + 1 + offset)
    } else {
        spec.rfind('@').filter(|separator| *separator > 0)
    }?;
    let (package, version) = spec.split_at(separator);
    if package.is_empty() || version.is_empty() || !version.starts_with('@') {
        return None;
    }
    Some((package, &version[1..]))
}

/// 外部安装组件内容变化的官方验证判定(ADR-0038 方向 B)。
///
/// - npx 分发:经 npm registry 的 `dist.integrity` 验证官方 tarball,再比对
///   tarball 内容与磁盘文件;
/// - binary 分发:与 Registry 官方 `sha256` 直接比对;
/// - 缺少官方指纹时返回 [`ExternalChangeVerdict::Unverifiable`],调用方保持
///   fail-closed(TOFU 语义,ADR-0017)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExternalChangeVerdict {
    Verified,
    NotVerified,
    Unverifiable(String),
}

pub async fn verify_external_component_change(
    fetcher: &dyn RegistryFetcher,
    distribution_kind: &str,
    package_spec: Option<&str>,
    registry_sha256: Option<&str>,
    disk_sha256: &str,
) -> ExternalChangeVerdict {
    match distribution_kind {
        "npx" => {
            let Some(spec) = package_spec else {
                return ExternalChangeVerdict::Unverifiable(
                    "external package component has no package spec".to_string(),
                );
            };
            let Some((package, version)) = split_npm_spec(spec) else {
                return ExternalChangeVerdict::Unverifiable(format!(
                    "external package spec `{spec}` is not version-locked"
                ));
            };
            match verify_npm_component_file(fetcher, package, version, disk_sha256).await {
                NpmVerificationOutcome::Verified => ExternalChangeVerdict::Verified,
                NpmVerificationOutcome::NotVerified => ExternalChangeVerdict::NotVerified,
                NpmVerificationOutcome::Unverifiable(message) => {
                    ExternalChangeVerdict::Unverifiable(message)
                }
            }
        }
        // uvx 包托管在 PyPI,没有 npm `dist.integrity`;当前没有可验证的官方
        // 指纹,保持 fail-closed(TOFU 语义,ADR-0017)。
        "uvx" => ExternalChangeVerdict::Unverifiable(
            "uvx external components have no verifiable official fingerprint".to_string(),
        ),
        "binary" => match registry_sha256 {
            Some(official) if official.to_ascii_lowercase() == disk_sha256 => {
                ExternalChangeVerdict::Verified
            }
            Some(_) => ExternalChangeVerdict::NotVerified,
            // ADR-0017 TOFU + ADR-0060: user-environment binaries without an
            // official digest are not integrity-damaged. Adopt the on-disk
            // fingerprint instead of fail-closing Launch Gate.
            None => ExternalChangeVerdict::Verified,
        },
        other => ExternalChangeVerdict::Unverifiable(format!(
            "unsupported external distribution kind `{other}`"
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, sync::Mutex};

    use async_trait::async_trait;
    use base64::Engine;

    use super::*;
    use crate::{BoundaryError, RegistryFetchResponse, RegistryFetcher};

    struct ScriptedFetcher(Mutex<HashMap<String, Vec<u8>>>);

    #[async_trait]
    impl RegistryFetcher for ScriptedFetcher {
        async fn fetch(
            &self,
            url: &str,
            _etag: Option<&str>,
        ) -> Result<RegistryFetchResponse, BoundaryError> {
            let body = self
                .0
                .lock()
                .unwrap()
                .get(url)
                .cloned()
                .ok_or_else(|| BoundaryError::new(format!("no response for {url}")))?;
            Ok(RegistryFetchResponse {
                status: 200,
                body,
                etag: None,
            })
        }
    }

    fn build_tarball(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        {
            let mut builder = tar::Builder::new(&mut encoder);
            for (path, content) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(content.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder
                    .append_data(&mut header, *path, *content)
                    .expect("append tarball entry");
            }
            builder.finish().expect("finish tarball");
        }
        encoder.finish().expect("finish gzip")
    }

    fn sha512_base64(bytes: &[u8]) -> String {
        format!(
            "sha512-{}",
            base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes))
        )
    }

    #[tokio::test]
    async fn verifies_a_disk_file_that_matches_the_official_tarball() {
        let content = b"trusted adapter entry".as_slice();
        let disk_sha256 = format!("{:x}", Sha256::digest(content));
        let tarball = build_tarball(&[("package/dist/index.js", content)]);
        let metadata = serde_json::json!({
            "versions": {
                "1.1.9": {
                    "dist": {
                        "integrity": sha512_base64(&tarball),
                        "tarball": "https://registry.npmjs.org/@agentclientprotocol/codex-acp/-/codex-acp-1.1.9.tgz",
                    }
                }
            }
        });
        let fetcher = ScriptedFetcher(Mutex::new(HashMap::from([
            (
                "https://registry.npmjs.org/@agentclientprotocol%2fcodex-acp".to_string(),
                serde_json::to_vec(&metadata).unwrap(),
            ),
            (
                "https://registry.npmjs.org/@agentclientprotocol/codex-acp/-/codex-acp-1.1.9.tgz"
                    .to_string(),
                tarball,
            ),
        ])));

        let outcome = verify_npm_component_file(
            &fetcher,
            "@agentclientprotocol/codex-acp",
            "1.1.9",
            &disk_sha256,
        )
        .await;
        assert_eq!(outcome, NpmVerificationOutcome::Verified);
    }

    #[tokio::test]
    async fn rejects_a_disk_file_not_present_in_the_official_tarball() {
        let tarball = build_tarball(&[("package/dist/index.js", b"official content")]);
        let metadata = serde_json::json!({
            "versions": {
                "1.1.9": {
                    "dist": {
                        "integrity": sha512_base64(&tarball),
                        "tarball": "https://registry.npmjs.org/pkg/-/pkg-1.1.9.tgz",
                    }
                }
            }
        });
        let fetcher = ScriptedFetcher(Mutex::new(HashMap::from([
            (
                "https://registry.npmjs.org/pkg".to_string(),
                serde_json::to_vec(&metadata).unwrap(),
            ),
            (
                "https://registry.npmjs.org/pkg/-/pkg-1.1.9.tgz".to_string(),
                tarball,
            ),
        ])));

        let outcome =
            verify_npm_component_file(&fetcher, "pkg", "1.1.9", &"deadbeef".repeat(8)).await;
        assert_eq!(outcome, NpmVerificationOutcome::NotVerified);
    }

    #[tokio::test]
    async fn verifies_a_native_binary_supplied_by_an_official_optional_dependency() {
        let wrapper_tarball = build_tarball(&[("package/bin/claude.exe", b"placeholder")]);
        let native_binary = b"official native binary".as_slice();
        let native_tarball = build_tarball(&[("package/claude", native_binary)]);
        let platform = NpmPlatform::current();
        let wrapper_metadata = serde_json::json!({
            "versions": {
                "2.1.226": {
                    "dist": {
                        "integrity": sha512_base64(&wrapper_tarball),
                        "tarball": "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.226.tgz",
                    },
                    "optionalDependencies": {
                        "@anthropic-ai/claude-code-darwin-arm64": "2.1.226",
                    },
                }
            }
        });
        let native_metadata = serde_json::json!({
            "versions": {
                "2.1.226": {
                    "dist": {
                        "integrity": sha512_base64(&native_tarball),
                        "tarball": "https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.226.tgz",
                    },
                    "os": [platform.os],
                    "cpu": [platform.cpu],
                    "libc": platform.libc.into_iter().collect::<Vec<_>>(),
                }
            }
        });
        let fetcher = ScriptedFetcher(Mutex::new(HashMap::from([
            (
                "https://registry.npmjs.org/@anthropic-ai%2fclaude-code".to_string(),
                serde_json::to_vec(&wrapper_metadata).unwrap(),
            ),
            (
                "https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.226.tgz"
                    .to_string(),
                wrapper_tarball,
            ),
            (
                "https://registry.npmjs.org/@anthropic-ai%2fclaude-code-darwin-arm64"
                    .to_string(),
                serde_json::to_vec(&native_metadata).unwrap(),
            ),
            (
                "https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-2.1.226.tgz"
                    .to_string(),
                native_tarball,
            ),
        ])));

        let outcome = verify_npm_component_file(
            &fetcher,
            "@anthropic-ai/claude-code",
            "2.1.226",
            &format!("{:x}", Sha256::digest(native_binary)),
        )
        .await;

        assert_eq!(outcome, NpmVerificationOutcome::Verified);
    }

    #[tokio::test]
    async fn stays_fail_closed_when_the_tarball_does_not_match_integrity() {
        let tarball = build_tarball(&[("package/dist/index.js", b"official content")]);
        let wrong_integrity = sha512_base64(b"a different payload");
        let metadata = serde_json::json!({
            "versions": {
                "1.1.9": {
                    "dist": {
                        "integrity": wrong_integrity,
                        "tarball": "https://registry.npmjs.org/pkg/-/pkg-1.1.9.tgz",
                    }
                }
            }
        });
        let fetcher = ScriptedFetcher(Mutex::new(HashMap::from([
            (
                "https://registry.npmjs.org/pkg".to_string(),
                serde_json::to_vec(&metadata).unwrap(),
            ),
            (
                "https://registry.npmjs.org/pkg/-/pkg-1.1.9.tgz".to_string(),
                tarball,
            ),
        ])));

        let outcome =
            verify_npm_component_file(&fetcher, "pkg", "1.1.9", &"deadbeef".repeat(8)).await;
        assert_eq!(outcome, NpmVerificationOutcome::NotVerified);
    }

    #[tokio::test]
    async fn reports_unverifiable_when_metadata_is_unreachable() {
        let fetcher = ScriptedFetcher(Mutex::new(HashMap::new()));
        let outcome = verify_npm_component_file(&fetcher, "missing-pkg", "1.0.0", "hash").await;
        assert!(matches!(outcome, NpmVerificationOutcome::Unverifiable(_)));
    }

    #[test]
    fn splits_package_and_version_from_npm_specs() {
        assert_eq!(
            split_npm_spec("@agentclientprotocol/codex-acp@1.1.9"),
            Some(("@agentclientprotocol/codex-acp", "1.1.9"))
        );
        assert_eq!(split_npm_spec("cli@3.0.49"), Some(("cli", "3.0.49")));
        assert_eq!(split_npm_spec("no-version"), None);
        assert_eq!(split_npm_spec("@scoped/no-version"), None);
    }

    #[test]
    fn npm_platform_metadata_selects_only_compatible_optional_dependencies() {
        let version = |os: &[&str], cpu: &[&str], libc: &[&str]| NpmVersion {
            dist: NpmDist {
                integrity: String::new(),
                tarball: String::new(),
            },
            optional_dependencies: std::collections::BTreeMap::new(),
            os: os.iter().map(|value| (*value).to_string()).collect(),
            cpu: cpu.iter().map(|value| (*value).to_string()).collect(),
            libc: libc.iter().map(|value| (*value).to_string()).collect(),
        };
        let mac_arm64 = NpmPlatform {
            os: "darwin",
            cpu: "arm64",
            libc: None,
        };

        assert!(npm_version_supports_platform(
            &version(&["darwin"], &["arm64"], &[]),
            mac_arm64
        ));
        assert!(!npm_version_supports_platform(
            &version(&["linux"], &["arm64"], &[]),
            mac_arm64
        ));
        assert!(!npm_version_supports_platform(
            &version(&["!darwin"], &["arm64"], &[]),
            mac_arm64
        ));
    }

    #[tokio::test]
    async fn uvx_external_components_stay_fail_closed() {
        // uvx 包托管在 PyPI,没有 npm dist.integrity;内容变化时无法用官方
        // 指纹验证,保持 fail-closed(TOFU 语义)。
        let fetcher = ScriptedFetcher(Mutex::new(HashMap::new()));
        let verdict =
            verify_external_component_change(&fetcher, "uvx", Some("some-pkg@1.0.0"), None, "hash")
                .await;
        assert!(matches!(verdict, ExternalChangeVerdict::Unverifiable(_)));
    }

    #[tokio::test]
    async fn tofu_registry_binaries_adopt_the_on_disk_fingerprint() {
        let fetcher = ScriptedFetcher(Mutex::new(HashMap::new()));
        let verdict =
            verify_external_component_change(&fetcher, "binary", None, None, "abc123").await;
        assert_eq!(verdict, ExternalChangeVerdict::Verified);
    }
}
