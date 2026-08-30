//! User-environment Agent install layout and adopt/upgrade policy (ADR-0060).
//!
//! Installation truth is PATH, the user npm prefix, uv tools, and `~/.local/bin`.
//! A leftover CLI is only auto-bound when every required component is present
//! and at least as new as the frozen plan / Built-in Profile pin.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use crate::{
    PlannedInstallComponent, ResolvedInstallPlan,
    local_detection::version_at_least,
    profiles::{BuiltInProfile, ProfileInstallSource},
};

/// Writable user-environment locations used to install Agent CLIs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserEnvironmentLayout {
    pub home: PathBuf,
    pub npm_prefix: PathBuf,
    pub npm_bin: PathBuf,
    pub user_bin: PathBuf,
    pub uv_tool_dir: PathBuf,
    pub uv_tool_bin: PathBuf,
    pub uv_python_dir: PathBuf,
    pub uv_cache_dir: PathBuf,
}

impl UserEnvironmentLayout {
    /// Isolated layout rooted at `home`. Tests use this so installs do not
    /// touch the real user profile.
    pub fn for_home(home: impl Into<PathBuf>) -> Self {
        let home = home.into();
        Self::from_home_and_npm_prefix(home.clone(), default_npm_prefix(&home, None))
    }

    /// Production layout: follow APPDATA on Windows when present.
    pub fn for_current_user(home: impl Into<PathBuf>) -> Self {
        let home = home.into();
        let app_data = std::env::var_os("APPDATA").map(PathBuf::from);
        Self::from_home_and_npm_prefix(home.clone(), default_npm_prefix(&home, app_data.as_deref()))
    }

    fn from_home_and_npm_prefix(home: PathBuf, npm_prefix: PathBuf) -> Self {
        let user_bin = home.join(".local").join("bin");
        let npm_bin = if cfg!(windows) {
            npm_prefix.clone()
        } else {
            npm_prefix.join("bin")
        };
        let local_share = home.join(".local").join("share").join("uv");
        Self {
            uv_tool_dir: local_share.join("tools"),
            uv_tool_bin: user_bin.clone(),
            uv_python_dir: local_share.join("python"),
            uv_cache_dir: home.join(".cache").join("uv"),
            home,
            npm_prefix,
            npm_bin,
            user_bin,
        }
    }

    pub fn path_entries(&self) -> Vec<PathBuf> {
        let mut entries = vec![self.user_bin.clone(), self.npm_bin.clone()];
        entries.dedup();
        entries
    }

    /// Parent of `node_modules` for a global `npm install -g --prefix`.
    pub fn npm_global_root(&self) -> PathBuf {
        if cfg!(windows) {
            self.npm_prefix.clone()
        } else {
            self.npm_prefix.join("lib")
        }
    }
}

/// Arguments for writing an Agent CLI into the user npm prefix.
///
/// `--force` is required: leftover shims in `~/.local/bin` (or `%APPDATA%\npm`)
/// make a plain `npm install -g` fail with `EEXIST` even when VibeX is
/// installing the locked version into the same prefix.
pub fn npm_global_install_args(prefix: &Path, package: &str) -> Vec<String> {
    vec![
        "install".to_string(),
        "-g".to_string(),
        "--force".to_string(),
        "--prefix".to_string(),
        prefix.display().to_string(),
        "--no-audit".to_string(),
        "--no-fund".to_string(),
        "--save=false".to_string(),
        "--include=optional".to_string(),
        "--registry=https://registry.npmjs.org".to_string(),
        package.to_string(),
    ]
}

fn default_npm_prefix(home: &Path, app_data: Option<&Path>) -> PathBuf {
    if cfg!(windows) {
        app_data
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"))
            .join("npm")
    } else {
        home.join(".local")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserEnvironmentAdoptDecision {
    Adopt,
    Install {
        missing: Vec<String>,
        outdated: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedUserComponent {
    pub component_id: String,
    pub version: Option<String>,
}

/// Adopt only when every required component exists and is not older than the
/// planned pin. Newer user-upgraded versions are accepted.
pub fn decide_user_environment_adopt(
    required: &[PlannedInstallComponent],
    observed: &[ObservedUserComponent],
) -> UserEnvironmentAdoptDecision {
    let mut missing = Vec::new();
    let mut outdated = Vec::new();
    for component in required {
        if matches!(
            component.component_id.as_str(),
            "base_runtime_node" | "base_runtime_npm" | "base_runtime_uv"
        ) {
            continue;
        }
        let found = observed
            .iter()
            .find(|candidate| candidate.component_id == component.component_id);
        match found.and_then(|candidate| candidate.version.as_deref()) {
            None => missing.push(component.component_id.clone()),
            Some(version) if !version_at_least(version, &component.version) => {
                outdated.push(component.component_id.clone());
            }
            Some(_) => {}
        }
    }
    if missing.is_empty() && outdated.is_empty() {
        UserEnvironmentAdoptDecision::Adopt
    } else {
        UserEnvironmentAdoptDecision::Install { missing, outdated }
    }
}

pub fn profile_required_versions(profile: &BuiltInProfile) -> Vec<(String, &'static str)> {
    profile
        .install_sources
        .iter()
        .map(|source| match source {
            ProfileInstallSource::Npx {
                component, version, ..
            }
            | ProfileInstallSource::Uvx {
                component, version, ..
            }
            | ProfileInstallSource::Binary {
                component, version, ..
            } => (profile_component_id(*component).to_string(), *version),
        })
        .collect()
}

pub fn observed_satisfies_profile(
    profile: &BuiltInProfile,
    observed: &[ObservedUserComponent],
) -> bool {
    profile_required_versions(profile).iter().all(|(id, pin)| {
        observed
            .iter()
            .find(|component| &component.component_id == id)
            .and_then(|component| component.version.as_deref())
            .is_some_and(|version| version_at_least(version, pin))
    })
}

pub fn plan_required_components(plan: &ResolvedInstallPlan) -> Vec<PlannedInstallComponent> {
    plan.components
        .iter()
        .filter(|component| {
            !matches!(
                component.component_id.as_str(),
                "base_runtime_node" | "base_runtime_npm" | "base_runtime_uv"
            )
        })
        .cloned()
        .collect()
}

/// A preflight item that the next install plan would actually change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedPreflightUpdate {
    pub item_id: &'static str,
    pub current_version: String,
    pub available_version: String,
}

fn preflight_item_ids_for_component(component_id: &str) -> &'static [&'static str] {
    match component_id {
        "agent_runtime" => &["runtime"],
        "acp_adapter" => &["acp"],
        "combined_runtime" => &["runtime", "acp"],
        _ => &[],
    }
}

fn is_agent_install_component(component_id: &str) -> bool {
    !matches!(
        component_id,
        "base_runtime_node" | "base_runtime_npm" | "base_runtime_uv"
    )
}

/// Compare the next install plan with the current lock/probe so update
/// badges only appear on components that `apply_update` would actually replace.
///
/// Do not compare [`ResolvedInstallPlan::version`] or a lock identity field
/// with a Registry snapshot version. Adapter-backed Agents keep Runtime at the
/// Profile pin (`plan.version`) and consume Registry versions on ACP only
/// (ADR-0038); those two numbers are different artifacts.
pub fn planned_preflight_updates(
    planned: &[PlannedInstallComponent],
    current: &[ObservedUserComponent],
) -> Vec<PlannedPreflightUpdate> {
    let current_by_id: HashMap<&str, &str> = current
        .iter()
        .filter_map(|component| {
            component
                .version
                .as_deref()
                .filter(|version| !version.is_empty())
                .map(|version| (component.component_id.as_str(), version))
        })
        .collect();
    let mut updates = Vec::new();
    let mut seen = HashSet::new();
    for component in planned {
        if !is_agent_install_component(&component.component_id) {
            continue;
        }
        let Some(current_version) = current_by_id.get(component.component_id.as_str()) else {
            continue;
        };
        if version_at_least(current_version, &component.version) {
            continue;
        }
        for item_id in preflight_item_ids_for_component(&component.component_id) {
            if !seen.insert(*item_id) {
                continue;
            }
            updates.push(PlannedPreflightUpdate {
                item_id,
                current_version: (*current_version).to_string(),
                available_version: component.version.clone(),
            });
        }
    }
    updates
}

fn profile_component_id(component: crate::ProfileComponent) -> &'static str {
    match component {
        crate::ProfileComponent::AgentRuntime => "agent_runtime",
        crate::ProfileComponent::AcpAdapter => "acp_adapter",
        crate::ProfileComponent::CombinedRuntime => "combined_runtime",
    }
}

pub fn uv_distribution_name(package_spec: &str) -> Option<&str> {
    let without_version = package_spec
        .split_once("==")
        .map(|(name, _)| name)
        .or_else(|| package_spec.rsplit_once('@').map(|(name, _)| name))
        .unwrap_or(package_spec);
    let name = without_version
        .split_once('[')
        .map_or(without_version, |(name, _)| name);
    if name.is_empty() { None } else { Some(name) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        ArtifactTrust, BuiltInProfile, BuiltInProfileCatalog, PlannedDistributionKind,
        ProfileTopology,
    };

    fn planned(id: &str, version: &str) -> PlannedInstallComponent {
        PlannedInstallComponent {
            component_id: id.to_string(),
            distribution_kind: PlannedDistributionKind::Npx,
            version: version.to_string(),
            resolved_source: format!("{id}@{version}"),
            command: id.to_string(),
            args: Vec::new(),
            env: Default::default(),
            trust: ArtifactTrust::Tofu,
        }
    }

    fn observed(id: &str, version: Option<&str>) -> ObservedUserComponent {
        ObservedUserComponent {
            component_id: id.to_string(),
            version: version.map(ToString::to_string),
        }
    }

    #[test]
    fn npm_global_install_overwrites_an_existing_user_bin() {
        let args = npm_global_install_args(
            std::path::Path::new("/tmp/home/.local"),
            "deepseek-acp@0.1.0",
        );
        assert_eq!(args[0], "install");
        assert_eq!(args[1], "-g");
        assert_eq!(args[2], "--force");
        assert!(args.contains(&"--prefix".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("deepseek-acp@0.1.0"));
    }

    #[test]
    fn unix_layout_uses_local_prefix() {
        let layout = UserEnvironmentLayout::for_home("/tmp/home");
        if cfg!(windows) {
            assert_eq!(
                layout.npm_prefix,
                PathBuf::from("/tmp/home/AppData/Roaming/npm")
            );
            assert_eq!(layout.npm_bin, layout.npm_prefix);
        } else {
            assert_eq!(layout.npm_prefix, PathBuf::from("/tmp/home/.local"));
            assert_eq!(layout.npm_bin, PathBuf::from("/tmp/home/.local/bin"));
        }
        assert_eq!(layout.user_bin, PathBuf::from("/tmp/home/.local/bin"));
        assert!(
            !layout
                .user_bin
                .starts_with("/tmp/home/Library/Application Support")
        );
        assert!(!layout.user_bin.starts_with("/tmp/home/AppData"));
        if cfg!(windows) {
            assert_eq!(layout.npm_global_root(), layout.npm_prefix);
        } else {
            assert_eq!(
                layout.npm_global_root(),
                PathBuf::from("/tmp/home/.local/lib")
            );
        }
    }

    #[test]
    fn adopts_matching_and_newer_versions() {
        let required = vec![
            planned("agent_runtime", "2.1.222"),
            planned("acp_adapter", "0.64.1"),
        ];
        assert_eq!(
            decide_user_environment_adopt(
                &required,
                &[
                    observed("agent_runtime", Some("2.1.222")),
                    observed("acp_adapter", Some("0.64.1")),
                ]
            ),
            UserEnvironmentAdoptDecision::Adopt
        );
        assert_eq!(
            decide_user_environment_adopt(
                &required,
                &[
                    observed("agent_runtime", Some("2.1.300")),
                    observed("acp_adapter", Some("0.70.0")),
                ]
            ),
            UserEnvironmentAdoptDecision::Adopt
        );
    }

    #[test]
    fn installs_when_a_component_is_missing_or_old() {
        let required = vec![
            planned("agent_runtime", "2.1.222"),
            planned("acp_adapter", "0.64.1"),
        ];
        assert_eq!(
            decide_user_environment_adopt(&required, &[observed("agent_runtime", Some("2.1.222"))]),
            UserEnvironmentAdoptDecision::Install {
                missing: vec!["acp_adapter".to_string()],
                outdated: Vec::new(),
            }
        );
        assert_eq!(
            decide_user_environment_adopt(
                &required,
                &[
                    observed("agent_runtime", Some("1.0.0")),
                    observed("acp_adapter", Some("0.64.1")),
                ]
            ),
            UserEnvironmentAdoptDecision::Install {
                missing: Vec::new(),
                outdated: vec!["agent_runtime".to_string()],
            }
        );
    }

    #[test]
    fn claude_profile_rejects_an_old_runtime_leftover() {
        let profile = crate::BuiltInProfileCatalog::bundled()
            .profile(&crate::AgentId::parse("claude_code").unwrap())
            .cloned()
            .unwrap();
        assert!(!observed_satisfies_profile(
            &profile,
            &[
                observed("agent_runtime", Some("1.0.0")),
                observed("acp_adapter", Some("0.64.1")),
            ]
        ));
        assert!(observed_satisfies_profile(
            &profile,
            &[
                observed("agent_runtime", Some("2.1.222")),
                observed("acp_adapter", Some("0.64.1")),
            ]
        ));
    }

    #[test]
    fn ignores_toolchain_components_in_adopt_decisions() {
        let required = vec![
            planned("combined_runtime", "0.2.118"),
            planned("base_runtime_node", "22.22.3"),
        ];
        assert_eq!(
            decide_user_environment_adopt(
                &required,
                &[observed("combined_runtime", Some("0.2.118"))]
            ),
            UserEnvironmentAdoptDecision::Adopt
        );
    }

    #[test]
    fn planned_updates_mark_only_the_outdated_adapter() {
        let planned = vec![
            planned("agent_runtime", "2.1.222"),
            planned("acp_adapter", "0.70.0"),
        ];
        let current = vec![
            observed("agent_runtime", Some("2.1.222")),
            observed("acp_adapter", Some("0.64.1")),
        ];
        assert_eq!(
            planned_preflight_updates(&planned, &current),
            vec![PlannedPreflightUpdate {
                item_id: "acp",
                current_version: "0.64.1".into(),
                available_version: "0.70.0".into(),
            }]
        );
    }

    #[test]
    fn planned_updates_are_empty_when_the_lock_already_matches() {
        let planned = vec![
            planned("agent_runtime", "2.1.222"),
            planned("acp_adapter", "0.70.0"),
        ];
        let current = vec![
            observed("agent_runtime", Some("2.1.222")),
            observed("acp_adapter", Some("0.70.0")),
        ];
        assert!(planned_preflight_updates(&planned, &current).is_empty());
    }

    #[test]
    fn planned_updates_ignore_a_newer_user_cli() {
        let planned = vec![planned("acp_adapter", "0.70.0")];
        let current = vec![observed("acp_adapter", Some("0.80.0"))];
        assert!(planned_preflight_updates(&planned, &current).is_empty());
    }

    #[test]
    fn planned_updates_mark_combined_runtime_on_both_preflight_items() {
        let planned = vec![planned("combined_runtime", "1.19.0")];
        let current = vec![observed("combined_runtime", Some("1.10.0"))];
        assert_eq!(
            planned_preflight_updates(&planned, &current),
            vec![
                PlannedPreflightUpdate {
                    item_id: "runtime",
                    current_version: "1.10.0".into(),
                    available_version: "1.19.0".into(),
                },
                PlannedPreflightUpdate {
                    item_id: "acp",
                    current_version: "1.10.0".into(),
                    available_version: "1.19.0".into(),
                },
            ]
        );
    }

    fn current_from_profile(profile: &BuiltInProfile) -> Vec<ObservedUserComponent> {
        profile_required_versions(profile)
            .into_iter()
            .map(|(component_id, version)| observed(&component_id, Some(version)))
            .collect()
    }

    fn planned_from_profile(
        profile: &BuiltInProfile,
        bump: Option<(&str, &str)>,
    ) -> Vec<PlannedInstallComponent> {
        profile_required_versions(profile)
            .into_iter()
            .map(|(component_id, version)| {
                let version = bump
                    .filter(|(id, _)| *id == component_id)
                    .map(|(_, version)| version)
                    .unwrap_or(version);
                planned(&component_id, version)
            })
            .collect()
    }

    #[test]
    fn bundled_profiles_report_no_update_when_the_lock_matches_the_pin() {
        for profile in BuiltInProfileCatalog::bundled().profiles() {
            let current = current_from_profile(profile);
            let planned_components = planned_from_profile(profile, None);
            assert!(
                planned_preflight_updates(&planned_components, &current).is_empty(),
                "{}",
                profile.agent_id
            );
        }
    }

    #[test]
    fn bundled_adapter_backed_profiles_only_flag_acp_when_the_adapter_is_newer() {
        let catalog = BuiltInProfileCatalog::bundled();
        let profiles = catalog
            .profiles()
            .iter()
            .filter(|profile| profile.topology == ProfileTopology::AdapterBacked)
            .collect::<Vec<_>>();
        assert_eq!(
            profiles
                .iter()
                .map(|profile| profile.agent_id.as_str())
                .collect::<Vec<_>>(),
            ["claude_code", "codex", "pi"]
        );
        for profile in profiles {
            let current = current_from_profile(profile);
            let planned_components =
                planned_from_profile(profile, Some(("acp_adapter", "99999.0.0")));
            let updates = planned_preflight_updates(&planned_components, &current);
            assert_eq!(
                updates
                    .iter()
                    .map(|update| update.item_id)
                    .collect::<Vec<_>>(),
                ["acp"],
                "{}",
                profile.agent_id
            );
            assert_eq!(updates[0].available_version, "99999.0.0");
        }
    }

    #[test]
    fn bundled_native_acp_profiles_flag_runtime_and_acp_together() {
        for profile in BuiltInProfileCatalog::bundled()
            .profiles()
            .iter()
            .filter(|profile| profile.topology == ProfileTopology::NativeAcp)
        {
            let current = current_from_profile(profile);
            let planned_components =
                planned_from_profile(profile, Some(("combined_runtime", "99999.0.0")));
            let updates = planned_preflight_updates(&planned_components, &current);
            assert_eq!(
                updates
                    .iter()
                    .map(|update| update.item_id)
                    .collect::<Vec<_>>(),
                ["runtime", "acp"],
                "{}",
                profile.agent_id
            );
        }
    }
}
