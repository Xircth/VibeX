use std::{collections::BTreeMap, path::PathBuf, sync::Mutex};

use async_trait::async_trait;
use plugins::{
    GlobalRuntimeHost, GlobalRuntimeInstaller, RuntimeContribution, RuntimeInstall, RuntimeProcess,
};

#[derive(Default)]
struct FakeHost {
    processes: Mutex<Vec<RuntimeProcess>>,
    direct_installs: Mutex<Vec<String>>,
    resolve_to: Mutex<Option<PathBuf>>,
    probe_output: Mutex<Option<String>>,
}

#[async_trait]
impl GlobalRuntimeHost for FakeHost {
    async fn run(&self, process: RuntimeProcess) -> Result<(), String> {
        self.processes.lock().unwrap().push(process);
        Ok(())
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

fn shell_runtime(command: &str) -> RuntimeContribution {
    RuntimeContribution {
        id: "example-cli".to_owned(),
        command: "example".to_owned(),
        version: Some("2.0.0".to_owned()),
        probe: vec!["--version".to_owned()],
        install: RuntimeInstall::Shell {
            command: command.to_owned(),
        },
    }
}

#[tokio::test]
async fn arbitrary_shell_is_blocked_until_the_plugin_id_is_trusted() {
    let host = FakeHost::default();
    let installer = GlobalRuntimeInstaller::new(&host);

    let error = installer
        .install("dev.vibex.example", false, &shell_runtime("install-v2"))
        .await
        .unwrap_err();

    assert_eq!(error.code(), "plugin_shell_trust_required");
    assert!(host.processes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn trusted_shell_runs_with_credentials_removed_and_locks_only_after_probe() {
    let host = FakeHost {
        resolve_to: Mutex::new(Some(PathBuf::from("/Users/test/.local/bin/example"))),
        probe_output: Mutex::new(Some("example 2.0.0".to_owned())),
        ..Default::default()
    };
    let installer = GlobalRuntimeInstaller::new(&host);

    let lock = installer
        .install("dev.vibex.example", true, &shell_runtime("install-v2"))
        .await
        .unwrap();

    assert_eq!(lock.id, "example-cli");
    assert_eq!(lock.version, "2.0.0");
    assert_eq!(
        lock.executable_path,
        PathBuf::from("/Users/test/.local/bin/example")
    );
    let process = &host.processes.lock().unwrap()[0];
    assert!(process.shell);
    assert_eq!(process.args.last().map(String::as_str), Some("install-v2"));
    assert_sanitized(&process.environment);
}

#[tokio::test]
async fn successful_installer_without_agent_visible_probe_never_creates_a_lock() {
    let host = FakeHost::default();
    let installer = GlobalRuntimeInstaller::new(&host);

    let error = installer
        .install("dev.vibex.example", true, &shell_runtime("install-v2"))
        .await
        .unwrap_err();

    assert_eq!(error.code(), "plugin_runtime_not_ready");
    assert_eq!(host.processes.lock().unwrap().len(), 1);
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
        probe: vec!["--version".to_owned()],
        install: RuntimeInstall::Binary {
            url: "https://downloads.example.com/example".to_owned(),
            sha256: Some("abc123".to_owned()),
        },
    };

    let lock = GlobalRuntimeInstaller::new(&host)
        .install("dev.vibex.example", false, &runtime)
        .await
        .unwrap();

    assert_eq!(lock.installer, "binary");
    assert_eq!(
        host.direct_installs.lock().unwrap().as_slice(),
        ["binary:example-cli:example"]
    );
}

fn assert_sanitized(environment: &BTreeMap<String, String>) {
    for key in environment.keys() {
        let upper = key.to_ascii_uppercase();
        assert!(!upper.contains("OPENAI"), "leaked {key}");
        assert!(!upper.contains("ANTHROPIC"), "leaked {key}");
        assert!(!upper.contains("VIBEX"), "leaked {key}");
        assert!(!upper.contains("TOKEN"), "leaked {key}");
        assert!(!upper.contains("SECRET"), "leaked {key}");
    }
}
