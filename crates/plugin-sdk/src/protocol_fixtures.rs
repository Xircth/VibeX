use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Deserialize;
use serde_json::Value;
use tokio::time::timeout;

use crate::{
    error::PluginSdkError,
    protocol::WireInbound,
    stdio::WorkerSession,
    worker::{PluginWorkerDefinition, hello_plugin_worker},
};

#[derive(Debug, Deserialize)]
struct FixtureRecord {
    dir: String,
    message: Value,
}

#[derive(Debug)]
pub struct ProtocolFixture {
    pub path: PathBuf,
    pub steps: Vec<FixtureStep>,
}

#[derive(Debug)]
pub struct FixtureStep {
    pub direction: String,
    pub message: Value,
}

pub fn default_fixture_directory() -> Result<PathBuf, PluginSdkError> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let candidate = manifest.join("../../packages/plugin-contract/fixtures/protocol");
    if candidate.is_dir() {
        return Ok(candidate);
    }
    let cwd = std::env::current_dir()
        .map_err(|error| PluginSdkError::new("fixture_missing", error.to_string()))?;
    for parent in cwd.ancestors() {
        let nested = parent.join("packages/plugin-contract/fixtures/protocol");
        if nested.is_dir() {
            return Ok(nested);
        }
    }
    Err(PluginSdkError::new(
        "fixture_missing",
        "Could not locate packages/plugin-contract/fixtures/protocol",
    ))
}

pub fn load_protocol_fixtures(directory: &Path) -> Result<Vec<ProtocolFixture>, PluginSdkError> {
    let mut fixtures = Vec::new();
    let mut entries = fs::read_dir(directory)
        .map_err(|error| PluginSdkError::new("fixture_missing", error.to_string()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| PluginSdkError::new("fixture_missing", error.to_string()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        if path.extension().and_then(|item| item.to_str()) != Some("jsonl") {
            continue;
        }
        let mut steps = Vec::new();
        for (index, line) in fs::read_to_string(&path)
            .map_err(|error| PluginSdkError::new("fixture_invalid", error.to_string()))?
            .lines()
            .enumerate()
        {
            if line.trim().is_empty() {
                continue;
            }
            let record: FixtureRecord = serde_json::from_str(line).map_err(|error| {
                PluginSdkError::new(
                    "fixture_invalid",
                    format!("{}:{}: {error}", path.display(), index + 1),
                )
            })?;
            steps.push(FixtureStep {
                direction: record.dir,
                message: record.message,
            });
        }
        fixtures.push(ProtocolFixture { path, steps });
    }
    Ok(fixtures)
}

pub async fn replay_fixture(
    fixture: &ProtocolFixture,
    definition: Option<PluginWorkerDefinition>,
) -> Result<(), PluginSdkError> {
    let session = WorkerSession::new(definition.unwrap_or_else(hello_plugin_worker));
    let mut outbound = session.take_outbound();
    for (index, step) in fixture.steps.iter().enumerate() {
        if step.direction == "in" {
            let inbound: WireInbound = serde_json::from_value(step.message.clone())
                .map_err(|error| PluginSdkError::new("fixture_invalid", error.to_string()))?;
            session.handle_inbound(inbound).await;
            continue;
        }
        if step.direction != "out" {
            return Err(PluginSdkError::new(
                "fixture_invalid",
                format!(
                    "{}: unknown direction {}",
                    fixture.path.display(),
                    step.direction
                ),
            ));
        }
        let actual = timeout(Duration::from_secs(5), outbound.recv())
            .await
            .map_err(|_| {
                PluginSdkError::new(
                    "fixture_timeout",
                    format!("{} step {index}: timed out", fixture.path.display()),
                )
            })?
            .ok_or_else(|| {
                PluginSdkError::new(
                    "fixture_timeout",
                    format!("{} step {index}: session closed", fixture.path.display()),
                )
            })?;
        if actual != step.message {
            return Err(PluginSdkError::new(
                "fixture_mismatch",
                format!(
                    "{} step {index}: expected {}, actual {}",
                    fixture.path.display(),
                    step.message,
                    actual
                ),
            ));
        }
    }
    if let Ok(extra) = outbound.try_recv() {
        return Err(PluginSdkError::new(
            "fixture_mismatch",
            format!(
                "{}: unexpected extra message {extra}",
                fixture.path.display()
            ),
        ));
    }
    session.dispose().await?;
    Ok(())
}

pub async fn replay_protocol_fixtures(directory: &Path) -> Result<(), PluginSdkError> {
    let fixtures = load_protocol_fixtures(directory)?;
    let mut failures = Vec::new();
    for fixture in fixtures {
        if let Err(error) = replay_fixture(&fixture, None).await {
            failures.push(format!("{}: {error}", fixture.path.display()));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(PluginSdkError::new("fixture_failed", failures.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn protocol_fixtures() {
        let directory = default_fixture_directory().expect("fixture directory");
        replay_protocol_fixtures(&directory)
            .await
            .expect("protocol fixtures should replay");
    }
}
