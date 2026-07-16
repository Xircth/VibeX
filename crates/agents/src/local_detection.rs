//! Cheap, local-only agent install/runtime detection.
//!
//! `agent_availability` (metadata.rs) answers "is there a login/config marker";
//! this module answers "is the agent actually present on this machine" and "can
//! its distribution even run here" — WITHOUT spawning the agent, downloading a
//! package, or touching the network. The expensive on-demand probe (which may
//! `npx -y` a package) stays in the preflight command.
//!
//! Split so the decision logic is pure and unit-testable: the caller gathers a
//! [`LocalRuntimeProbe`] (one `npm root -g` / `node --version` / `uv --version`
//! pass) plus a per-agent [`AgentLocalProbe`], and [`agent_local_state`] folds
//! them into the [`AgentLocalState`] the settings DTO carries.

use std::path::{Path, PathBuf};

use crate::distribution::AgentDistribution;

/// Machine-wide runtime facts gathered once per detection pass.
#[derive(Debug, Clone, Default)]
pub struct LocalRuntimeProbe {
    /// Output of `npm root -g`, if npm resolved.
    pub npm_global_root: Option<String>,
    /// Output of `node --version` (any surrounding text tolerated).
    pub node_version: Option<String>,
    /// Output of `uv --version` (any surrounding text tolerated).
    pub uv_version: Option<String>,
}

/// Per-agent local facts gathered by the caller (filesystem / PATH only).
#[derive(Debug, Clone, Copy, Default)]
pub struct AgentLocalProbe {
    /// A login/config marker was found (`agent_availability(..).is_available()`).
    pub marker_available: bool,
    /// The agent's own command resolved on PATH (system command or dist cmd).
    pub program_on_path: bool,
    /// For Npx distributions: the package directory exists under `npm root -g`.
    pub npm_package_dir_exists: bool,
}

/// The verified local state exposed to the frontend picker/settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentLocalState {
    /// Evidence the agent is present: marker, PATH binary, or global package.
    /// Never inferred from the distribution kind ("npx could download it" is
    /// NOT installed — that inference is the bug this module replaces).
    pub installed: bool,
    /// The distribution's runtime prerequisites are satisfied, so installing
    /// (or on-demand fetching) is possible on this machine.
    pub runtime_ok: bool,
}

/// Fold distribution + probes into the local state.
pub fn agent_local_state(
    distribution: &AgentDistribution,
    probe: AgentLocalProbe,
    runtime: &LocalRuntimeProbe,
) -> AgentLocalState {
    let runtime_ok = match distribution {
        AgentDistribution::Npx { node_required, .. } => {
            version_gate_ok(runtime.node_version.as_deref(), node_required.as_deref())
        }
        // uv provisions Python itself, so only uv is gated here.
        AgentDistribution::Uvx { uv_required, .. } => {
            version_gate_ok(runtime.uv_version.as_deref(), uv_required.as_deref())
        }
        // Binaries are downloaded by VibeX; nothing local is required up front.
        AgentDistribution::Binary { .. } => true,
        AgentDistribution::System { .. } => probe.program_on_path,
    };

    let installed = probe.marker_available
        || probe.program_on_path
        || matches!(distribution, AgentDistribution::Npx { .. }) && probe.npm_package_dir_exists;

    AgentLocalState {
        installed,
        runtime_ok,
    }
}

fn version_gate_ok(found: Option<&str>, required: Option<&str>) -> bool {
    match (found, required) {
        (None, _) => false,
        (Some(_), None) => true,
        (Some(found), Some(required)) => version_at_least(found, required),
    }
}

/// Compare dotted numeric versions segment-wise ("v24.16.0", "uv 0.11.28
/// (ebf0f43d7 2026-07-07)" and similar decorated outputs are tolerated).
/// Missing segments count as 0. Non-numeric tails are ignored.
pub fn version_at_least(found: &str, required: &str) -> bool {
    let found = extract_version_segments(found);
    let required = extract_version_segments(required);
    if found.is_empty() {
        return false;
    }
    for i in 0..found.len().max(required.len()) {
        let f = found.get(i).copied().unwrap_or(0);
        let r = required.get(i).copied().unwrap_or(0);
        if f != r {
            return f > r;
        }
    }
    true
}

/// Pull the first dotted-number run out of arbitrary version output.
fn extract_version_segments(raw: &str) -> Vec<u64> {
    let start = match raw.find(|c: char| c.is_ascii_digit()) {
        Some(index) => index,
        None => return Vec::new(),
    };
    raw[start..]
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .next()
        .unwrap_or("")
        .split('.')
        .map_while(|segment| segment.parse::<u64>().ok())
        .collect()
}

/// The npm package name of a versioned spec (`@scope/name@1.2.3` → `@scope/name`).
pub fn npm_package_name(package_spec: &str) -> String {
    if let Some(stripped) = package_spec.strip_prefix('@') {
        return stripped
            .rfind('@')
            .map(|index| format!("@{}", &stripped[..index]))
            .unwrap_or_else(|| package_spec.to_string());
    }
    package_spec
        .split_once('@')
        .map(|(name, _)| name.to_string())
        .unwrap_or_else(|| package_spec.to_string())
}

/// Where a globally-installed npm package would live under `npm root -g`.
pub fn npm_global_package_dir(npm_global_root: &str, package_spec: &str) -> PathBuf {
    npm_package_name(package_spec)
        .split('/')
        .fold(Path::new(npm_global_root).to_path_buf(), |path, segment| {
            path.join(segment)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn npx(node_required: Option<&str>) -> AgentDistribution {
        AgentDistribution::Npx {
            version: "1.0.0".to_string(),
            package: "pkg@1.0.0".to_string(),
            cmd: "pkg".to_string(),
            args: vec![],
            node_required: node_required.map(str::to_string),
        }
    }

    fn uvx(uv_required: Option<&str>) -> AgentDistribution {
        AgentDistribution::Uvx {
            version: "0.16.0".to_string(),
            package: "pkg==0.16.0".to_string(),
            cmd: "pkg".to_string(),
            args: vec![],
            uv_required: uv_required.map(str::to_string),
            python_required: Some("3.13".to_string()),
            system_command: None,
        }
    }

    fn runtime(node: Option<&str>, uv: Option<&str>) -> LocalRuntimeProbe {
        LocalRuntimeProbe {
            npm_global_root: Some("/g/root".to_string()),
            node_version: node.map(str::to_string),
            uv_version: uv.map(str::to_string),
        }
    }

    #[test]
    fn npx_kind_alone_is_not_installed() {
        // The original bug: uninstalled npx agents were reported installed just
        // because npx could download them on demand.
        let state = agent_local_state(
            &npx(None),
            AgentLocalProbe::default(),
            &runtime(Some("v24.16.0"), None),
        );
        assert!(!state.installed);
        assert!(state.runtime_ok, "node present ⇒ install is possible");
    }

    #[test]
    fn uvx_with_uv_ready_is_runtime_ok_even_when_not_installed() {
        // The inverse bug: hermes was reported unavailable on machines where
        // uv (and python) were perfectly ready.
        let state = agent_local_state(
            &uvx(Some("0.5.0")),
            AgentLocalProbe::default(),
            &runtime(None, Some("uv 0.11.28 (ebf0f43d7 2026-07-07)")),
        );
        assert!(!state.installed);
        assert!(state.runtime_ok, "uv 0.11.28 satisfies the 0.5.0 gate");
    }

    #[test]
    fn evidence_marks_installed_for_every_distribution() {
        for (dist, probe) in [
            (
                npx(None),
                AgentLocalProbe {
                    marker_available: true,
                    ..Default::default()
                },
            ),
            (
                npx(None),
                AgentLocalProbe {
                    npm_package_dir_exists: true,
                    ..Default::default()
                },
            ),
            (
                npx(None),
                AgentLocalProbe {
                    program_on_path: true,
                    ..Default::default()
                },
            ),
            (
                uvx(None),
                AgentLocalProbe {
                    program_on_path: true,
                    ..Default::default()
                },
            ),
        ] {
            assert!(
                agent_local_state(&dist, probe, &runtime(Some("v24"), Some("uv 0.6"))).installed,
                "{probe:?} should count as installed"
            );
        }
    }

    #[test]
    fn missing_runtime_blocks_runtime_ok() {
        assert!(
            !agent_local_state(&npx(None), AgentLocalProbe::default(), &runtime(None, None))
                .runtime_ok
        );
        assert!(
            !agent_local_state(&uvx(None), AgentLocalProbe::default(), &runtime(None, None))
                .runtime_ok
        );
        assert!(
            !agent_local_state(
                &npx(Some("22.19.0")),
                AgentLocalProbe::default(),
                &runtime(Some("v20.1.0"), None)
            )
            .runtime_ok,
            "node 20 fails a 22.19 gate"
        );
    }

    #[test]
    fn version_comparison_is_numeric_not_lexical() {
        // "0.11.28" < "0.5.0" lexically — the classic trap.
        assert!(version_at_least("0.11.28", "0.5.0"));
        assert!(version_at_least("v24.16.0", "22.19.0"));
        assert!(version_at_least("1.2", "1.2.0"));
        assert!(!version_at_least("1.2", "1.2.1"));
        assert!(version_at_least(
            "uv 0.11.28 (ebf0f43d7 2026-07-07)",
            "0.5.0"
        ));
        assert!(!version_at_least("garbage", "1.0.0"));
        assert!(version_at_least("10.0.0", "9.99.99"));
    }

    #[test]
    fn npm_package_paths_handle_scopes() {
        assert_eq!(
            npm_package_name("@google/gemini-cli@0.45.2"),
            "@google/gemini-cli"
        );
        assert_eq!(npm_package_name("opencode-ai@1.17.11"), "opencode-ai");
        assert_eq!(npm_package_name("@openai/codex"), "@openai/codex");
        assert_eq!(
            npm_global_package_dir("/g/root", "@google/gemini-cli@0.45.2"),
            Path::new("/g/root").join("@google").join("gemini-cli")
        );
    }
}
