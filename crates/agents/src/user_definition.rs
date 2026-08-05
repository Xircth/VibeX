//! Persisted, user-declared ACP Agent installation identity.

use api_types::{AgentId, UserAgentDistributionKind};
use regex::Regex;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{RegistryDistributions, parse_registry_distributions_json};

const MAX_DISTRIBUTION_JSON_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserAgentDefinition {
    pub agent_id: AgentId,
    pub display_name: String,
    pub description: String,
    pub version: String,
    pub distribution_kind: UserAgentDistributionKind,
    pub distributions: RegistryDistributions,
    pub distributions_json: String,
    pub definition_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserAgentInstallTarget {
    pub agent_id: AgentId,
    pub version: String,
    pub distribution_kind: UserAgentDistributionKind,
    pub distributions: RegistryDistributions,
    pub definition_sha256: String,
}

impl UserAgentDefinition {
    pub fn parse(
        agent_id: AgentId,
        display_name: String,
        description: String,
        version: String,
        distribution_kind: UserAgentDistributionKind,
        distribution_json: &str,
    ) -> Result<Self, String> {
        let display_name = display_name.trim().to_string();
        if display_name.is_empty() || display_name.chars().count() > 128 {
            return Err("Agent display name must contain 1 to 128 characters".to_string());
        }
        let description = description.trim().to_string();
        if description.chars().count() > 1_024 {
            return Err("Agent description must not exceed 1024 characters".to_string());
        }
        let version = version.trim().to_string();
        let version_pattern = Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$")
            .expect("static semantic version regex");
        if !version_pattern.is_match(&version) {
            return Err(format!("Agent version `{version}` is invalid"));
        }
        if distribution_json.len() > MAX_DISTRIBUTION_JSON_BYTES {
            return Err("Agent distribution JSON exceeds the size limit".to_string());
        }
        let distributions = parse_registry_distributions_json(distribution_json)?;
        let selected_present = match distribution_kind {
            UserAgentDistributionKind::Binary => distributions.binary.is_some(),
            UserAgentDistributionKind::Npx => distributions.npx.is_some(),
            UserAgentDistributionKind::Uvx => distributions.uvx.is_some(),
        };
        if !selected_present {
            let selected = match distribution_kind {
                UserAgentDistributionKind::Binary => "binary",
                UserAgentDistributionKind::Npx => "npx",
                UserAgentDistributionKind::Uvx => "uvx",
            };
            return Err(format!(
                "Agent definition does not contain the selected {selected} distribution"
            ));
        }
        match distribution_kind {
            UserAgentDistributionKind::Npx => {
                let package = distributions.npx.as_ref().expect("selected npx is present");
                if !has_exact_package_version(&package.package, &version, false) {
                    return Err(format!(
                        "npx package `{}` must pin Agent version {version}",
                        package.package
                    ));
                }
            }
            UserAgentDistributionKind::Uvx => {
                let package = distributions.uvx.as_ref().expect("selected uvx is present");
                if !has_exact_package_version(&package.package, &version, true) {
                    return Err(format!(
                        "uvx package `{}` must pin Agent version {version}",
                        package.package
                    ));
                }
            }
            UserAgentDistributionKind::Binary => {}
        }
        let distributions_json = serde_json::to_string(&distributions)
            .map_err(|error| format!("Agent distribution serialization failed: {error}"))?;
        #[derive(Serialize)]
        struct DigestDocument<'a> {
            agent_id: &'a str,
            display_name: &'a str,
            description: &'a str,
            version: &'a str,
            distribution_kind: UserAgentDistributionKind,
            distributions: &'a RegistryDistributions,
        }
        let digest_document = serde_json::to_vec(&DigestDocument {
            agent_id: agent_id.as_str(),
            display_name: &display_name,
            description: &description,
            version: &version,
            distribution_kind,
            distributions: &distributions,
        })
        .map_err(|error| format!("Agent definition serialization failed: {error}"))?;
        let definition_sha256 = format!("{:x}", Sha256::digest(digest_document));
        Ok(Self {
            agent_id,
            display_name,
            description,
            version,
            distribution_kind,
            distributions,
            distributions_json,
            definition_sha256,
        })
    }

    pub fn install_target(&self) -> UserAgentInstallTarget {
        UserAgentInstallTarget {
            agent_id: self.agent_id.clone(),
            version: self.version.clone(),
            distribution_kind: self.distribution_kind,
            distributions: self.distributions.clone(),
            definition_sha256: self.definition_sha256.clone(),
        }
    }
}

fn has_exact_package_version(package: &str, version: &str, allow_equals: bool) -> bool {
    let at_suffix = format!("@{version}");
    let equals_suffix = format!("=={version}");
    (package.ends_with(&at_suffix) && package.len() > at_suffix.len())
        || (allow_equals
            && package.ends_with(&equals_suffix)
            && package.len() > equals_suffix.len())
}
