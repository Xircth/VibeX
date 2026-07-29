use semver::Version;

use crate::{PluginError, ToolDependency, ToolId, ToolKind};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperatingSystem {
    MacOs,
    Linux,
    Windows,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Architecture {
    Arm64,
    X64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Platform {
    os: OperatingSystem,
    architecture: Architecture,
}

impl Platform {
    pub fn new(os: OperatingSystem, architecture: Architecture) -> Self {
        Self { os, architecture }
    }

    pub fn target_triple(self) -> &'static str {
        match (self.os, self.architecture) {
            (OperatingSystem::MacOs, Architecture::Arm64) => "aarch64-apple-darwin",
            (OperatingSystem::MacOs, Architecture::X64) => "x86_64-apple-darwin",
            (OperatingSystem::Linux, Architecture::Arm64) => "aarch64-unknown-linux-gnu",
            (OperatingSystem::Linux, Architecture::X64) => "x86_64-unknown-linux-gnu",
            (OperatingSystem::Windows, Architecture::Arm64) => "aarch64-pc-windows-msvc",
            (OperatingSystem::Windows, Architecture::X64) => "x86_64-pc-windows-msvc",
        }
    }

    pub fn host() -> Self {
        let os = if cfg!(target_os = "macos") {
            OperatingSystem::MacOs
        } else if cfg!(target_os = "windows") {
            OperatingSystem::Windows
        } else {
            OperatingSystem::Linux
        };
        let architecture = if cfg!(target_arch = "aarch64") {
            Architecture::Arm64
        } else {
            Architecture::X64
        };
        Self::new(os, architecture)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedToolDistribution {
    pub id: ToolId,
    pub kind: ToolKind,
    pub version: String,
    pub target: String,
    pub url: String,
    pub sha256: String,
    pub probe: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
pub struct ToolDependencyResolver {
    platform: Platform,
}

impl ToolDependencyResolver {
    pub fn new(platform: Platform) -> Self {
        Self { platform }
    }

    pub fn resolve(
        &self,
        dependency: &ToolDependency,
    ) -> Result<ResolvedToolDistribution, PluginError> {
        Version::parse(&dependency.version).map_err(|_| {
            PluginError::version_not_exact(dependency.id.as_str(), &dependency.version)
        })?;

        let target = self.platform.target_triple();
        let distribution = dependency
            .distributions
            .get(target)
            .ok_or_else(|| PluginError::platform_unsupported(dependency.id.as_str(), target))?;
        if distribution.sha256.len() != 64
            || !distribution
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(PluginError::invalid_distribution(
                dependency.id.as_str(),
                "sha256 must contain exactly 64 hexadecimal characters",
            ));
        }
        if distribution.url.trim().is_empty() {
            return Err(PluginError::invalid_distribution(
                dependency.id.as_str(),
                "download URL is empty",
            ));
        }

        Ok(ResolvedToolDistribution {
            id: dependency.id.clone(),
            kind: dependency.kind.clone(),
            version: dependency.version.clone(),
            target: target.to_owned(),
            url: distribution.url.clone(),
            sha256: distribution.sha256.to_ascii_lowercase(),
            probe: dependency.probe.clone(),
        })
    }
}
