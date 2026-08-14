use std::{path::PathBuf, sync::Mutex};

use async_trait::async_trait;
use plugins::{
    GlobalRuntimeHost, GlobalRuntimeInstaller, RuntimeContribution, RuntimeInstall, RuntimeProcess,
};

#[derive(Default)]
struct FakeHost {
    direct_installs: Mutex<Vec<String>>,
    resolve_to: Mutex<Option<PathBuf>>,
    probe_output: Mutex<Option<String>>,
}

#[async_trait]
impl GlobalRuntimeHost for FakeHost {
    async fn run(&self, _process: RuntimeProcess) -> Result<(), String> {
        Err("global package-manager install is unavailable".to_owned())
    }

    async fn install_binary(
        &self,
        runtime_id: &str,
        command: &str,
        _url: &str,
        _sha256: Option<&str>,
    ) -> Result<(), String> {
        self.direct_installs
            .lock()
            .unwrap()
            .push(format!("binary:{runtime_id}:{command}"));
        Ok(())
    }

    async fn resolve(&self, _command: &str) -> Result<PathBuf, String> {
        self.resolve_to
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "not found in Agent PATH".to_owned())
    }

    async fn probe(
        &self,
        _executable: &std::path::Path,
        _args: &[String],
    ) -> Result<String, String> {
        self.probe_output
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| "probe failed".to_owned())
    }
}

#[tokio::test]
async fn verified_binary_installer_publishes_before_agent_visible_probe() {
    let host = FakeHost {
        resolve_to: Mutex::new(Some(PathBuf::from("/Users/test/.local/bin/example"))),
        probe_output: Mutex::new(Some("example 2.0.0".to_owned())),
        ..Default::default()
    };
    let runtime = RuntimeContribution {
        id: "example-cli".to_owned(),
        command: "example".to_owned(),
        version: Some("2.0.0".to_owned()),
        target: "test-target".to_owned(),
        content_digest: "sha256:abc123".to_owned(),
        probe: vec!["--version".to_owned()],
        install: RuntimeInstall::Binary {
            url: "https://downloads.example.com/example".to_owned(),
            sha256: Some("abc123".to_owned()),
        },
    };

    let lock = GlobalRuntimeInstaller::new(&host)
        .install("dev.vibex.example", &runtime)
        .await
        .unwrap();

    assert_eq!(lock.installer, "binary");
    assert_eq!(
        host.direct_installs.lock().unwrap().as_slice(),
        ["binary:example-cli:example"]
    );
}
