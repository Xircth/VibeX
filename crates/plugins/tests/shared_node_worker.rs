use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use plugins::{
    CapabilityBroker, ConflictDecision, DenyCapabilityBroker, InMemoryPluginRegistry,
    PluginControlPlane, PluginPackage, PluginSourceKind, WorkerHostError,
};
use serde_json::{Value, json};

fn node_executable() -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
    })
}

type RecordedBrokerCall = (String, u64, String, String, Value);

#[derive(Default)]
struct RecordingBroker {
    calls: Mutex<Vec<RecordedBrokerCall>>,
}

#[async_trait]
impl CapabilityBroker for RecordingBroker {
    fn supports(&self, _capability: &str) -> bool {
        true
    }

    async fn call(
        &self,
        plugin_id: &str,
        generation: u64,
        capability: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, WorkerHostError> {
        self.calls.lock().unwrap().push((
            plugin_id.to_owned(),
            generation,
            capability.to_owned(),
            operation.to_owned(),
            input.clone(),
        ));
        Ok(json!({
            "callerPluginId": plugin_id,
            "callerGeneration": generation,
            "capability": capability,
            "operation": operation,
            "echo": input,
        }))
    }
}

fn write_shared_worker_package(root: &Path, index: usize, version: &str, exported_style: bool) {
    let plugin_id = format!("dev.vibex.shared-{index}");
    let handler_id = format!("ping.w{index}");
    std::fs::create_dir_all(root.join(".vibex-plugin")).unwrap();
    std::fs::write(
        root.join(".vibex-plugin/plugin.json"),
        serde_json::to_string_pretty(&json!({
            "manifestVersion": 4,
            "apiVersion": "1.0",
            "id": plugin_id,
            "publisher": "dev.vibex",
            "name": format!("Shared Worker {index}"),
            "version": version,
            "engines": { "vibex": ">=0.1.3 <1.0.0", "pluginSdk": "^1.0.0" },
            "entrypoints": {
                "worker": { "path": "worker.mjs", "runtime": "node", "protocol": "1.1" }
            },
            "permissions": [],
            "contributes": {
                "agent.invocations": [{
                    "id": format!("invoke-{index}"),
                    "kindVersion": 1,
                    "label": format!("Invoke {index}"),
                    "entrypoints": ["action"],
                    "handler": handler_id,
                }]
            }
        }))
        .unwrap(),
    )
    .unwrap();

    let worker_source = if exported_style {
        format!(
            r#"export default {{
  apiVersion: "1.0",
  async setup(registrar, env) {{
    registrar.handle("{handler_id}", async (input) => {{
      const brokerEcho = await env.host.call("kv", "get", {{ key: "k-{index}", input }});
      return {{
        index: {index},
        version: "{version}",
        style: "exported-module",
        pid: process.pid,
        cwd: process.cwd(),
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
        slotCount: globalThis.__VIBEX_SHARED_PLUGIN_HOST__?.slots?.size ?? 0,
        brokerEcho,
      }};
    }});
  }}
}};
"#
        )
    } else {
        format!(
            r#"import {{ createInterface }} from "node:readline";
let hostSeq = 0;
const pending = new Map();
const rl = createInterface({{ input: process.stdin, crlfDelay: Infinity }});
for await (const line of rl) {{
  const msg = JSON.parse(line);
  if ("ok" in msg && pending.has(msg.id)) {{
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    p.resolve(msg.result);
    continue;
  }}
  if (msg.method === "initialize") {{
    console.log(JSON.stringify({{
      id: msg.id,
      ok: true,
      result: {{
        protocolVersion: "1.1",
        sdkVersion: "1.0.0",
        registrations: ["{handler_id}"],
        requestedFeatures: []
      }}
    }}));
  }} else if (msg.method === "activate") {{
    console.log(JSON.stringify({{
      id: msg.id,
      ok: true,
      result: {{ handlers: ["{handler_id}"] }}
    }}));
  }} else if (msg.method === "dispose") {{
    console.log(JSON.stringify({{ id: msg.id, ok: true, result: null }}));
  }} else if (msg.method === "invoke") {{
    (async () => {{
      const callId = `host:${{++hostSeq}}`;
      const brokerPromise = new Promise((resolve) => pending.set(callId, {{ resolve }}));
      console.log(JSON.stringify({{
        id: callId,
        method: "host.call",
        params: {{ capability: "kv", operation: "get", input: {{ key: "k-{index}", input: msg.params.input }} }}
      }}));
      const brokerEcho = await brokerPromise;
      console.log(JSON.stringify({{
        id: msg.id,
        ok: true,
        result: {{
          index: {index},
          version: "{version}",
          style: "stdio-loop",
          pid: process.pid,
          cwd: process.cwd(),
          rssBytes: process.memoryUsage().rss,
          heapUsedBytes: process.memoryUsage().heapUsed,
          slotCount: globalThis.__VIBEX_SHARED_PLUGIN_HOST__?.slots?.size ?? 0,
          brokerEcho,
        }}
      }}));
    }})();
  }}
}}
"#
        )
    };
    std::fs::write(root.join("worker.mjs"), worker_source).unwrap();
}

#[tokio::test]
async fn tier0_and_tier1_plugins_enable_with_zero_worker_processes() {
    let control = PluginControlPlane::new(Arc::new(InMemoryPluginRegistry::default()));
    let catalog = control.bootstrap_monorepo_plugins(true).await.unwrap();
    let enabled_count = catalog
        .iter()
        .filter(|plugin| plugin.activation == plugins::PluginActivation::Enabled)
        .count();
    assert!(
        enabled_count >= 10,
        "at least 10 built-in Tier-0/Tier-1 plugins must be enabled"
    );
    assert_eq!(
        control.active_worker_process_count().await,
        0,
        "Tier-0 and Tier-1 plugins must spawn 0 backend worker OS processes"
    );
    assert_eq!(control.shared_node_worker_pid().await, None);
}

#[tokio::test]
async fn ten_tier2_node_plugins_share_one_process_and_stay_under_40mb_delta() {
    let Some(node) = node_executable() else {
        return;
    };
    let control = PluginControlPlane::new(Arc::new(InMemoryPluginRegistry::default()));
    let broker = Arc::new(RecordingBroker::default());
    let mut temp_dirs = Vec::new();

    for index in 0..10 {
        let dir = tempfile::tempdir().unwrap();
        let exported_style = index % 2 == 1;
        write_shared_worker_package(dir.path(), index, "1.0.0", exported_style);
        let package = PluginPackage::inspect(dir.path(), PluginSourceKind::DeveloperLink).unwrap();
        control
            .import(package, ConflictDecision::Reject)
            .await
            .unwrap();
        temp_dirs.push(dir);
    }

    assert_eq!(control.active_worker_process_count().await, 0);

    // Activate plugin 0 first and record baseline RSS of the single shared Node process
    control
        .activate_and_enable(&node, "dev.vibex.shared-0", &[], broker.clone())
        .await
        .unwrap();
    assert_eq!(control.active_worker_process_count().await, 1);
    let shared_pid = control
        .shared_node_worker_pid()
        .await
        .expect("shared Node process PID");

    let lease_0 = control
        .activation_lease("dev.vibex.shared-0")
        .await
        .unwrap();
    let first_probe = lease_0
        .invoke("ping.w0", json!({ "step": "baseline" }))
        .await
        .unwrap();
    let baseline_rss = first_probe["rssBytes"].as_u64().unwrap();
    assert_eq!(first_probe["pid"].as_u64(), Some(u64::from(shared_pid)));

    // Activate the remaining 9 Tier-2 Node plugins (total 10 active simultaneously)
    for index in 1..10 {
        let plugin_id = format!("dev.vibex.shared-{index}");
        control
            .activate_and_enable(&node, &plugin_id, &[], broker.clone())
            .await
            .unwrap();
    }

    // Verify at most 1 OS Worker process is running for all 10 plugins!
    assert_eq!(
        control.active_worker_process_count().await,
        1,
        "10 active Tier-2 Node plugins must share a single OS worker process"
    );
    assert_eq!(control.shared_node_worker_pid().await, Some(shared_pid));

    // Invoke all 10 plugins and verify PID sharing, cwd isolation, broker scoping, and memory delta < 40 MB
    let mut max_rss = baseline_rss;
    for (index, dir) in temp_dirs.iter().enumerate() {
        let plugin_id = format!("dev.vibex.shared-{index}");
        let handler_id = format!("ping.w{index}");
        let lease = control
            .activation_lease(&plugin_id)
            .await
            .expect("active lease");
        assert!(lease.is_shared_node_process());
        assert_eq!(lease.pid().await, Some(shared_pid));

        let response = lease
            .invoke(&handler_id, json!({ "seq": index }))
            .await
            .unwrap();
        assert_eq!(response["index"], json!(index));
        assert_eq!(response["version"], json!("1.0.0"));
        assert_eq!(response["pid"], json!(shared_pid));
        assert_eq!(response["slotCount"], json!(10));
        assert_eq!(
            response["brokerEcho"]["callerPluginId"],
            json!(plugin_id),
            "host.call must be scoped to the exact calling plugin slot"
        );
        let expected_cwd =
            utils::path::normalize_windows_extended_path_prefix(dir.path().canonicalize().unwrap());
        assert_eq!(
            PathBuf::from(response["cwd"].as_str().unwrap()),
            expected_cwd,
            "each plugin slot must observe its own package root via process.cwd()"
        );
        let rss = response["rssBytes"].as_u64().unwrap();
        if rss > max_rss {
            max_rss = rss;
        }
    }

    let rss_delta_bytes = max_rss.saturating_sub(baseline_rss);
    let forty_mib = 40 * 1024 * 1024;
    assert!(
        rss_delta_bytes < forty_mib,
        "10 shared plugins memory delta ({rss_delta_bytes} bytes) must stay well below 40 MiB"
    );

    // Hot-reload plugin 3 to version 2.0.0 while holding its v1.0.0 lease
    let old_lease_3 = control
        .activation_lease("dev.vibex.shared-3")
        .await
        .unwrap();
    let v2_dir = tempfile::tempdir().unwrap();
    write_shared_worker_package(v2_dir.path(), 3, "2.0.0", true);
    let v2_package =
        PluginPackage::inspect(v2_dir.path(), PluginSourceKind::DeveloperLink).unwrap();
    control
        .update_and_activate(&node, v2_package, &[], broker.clone())
        .await
        .unwrap();
    assert_eq!(control.active_worker_process_count().await, 1);

    let new_lease_3 = control
        .activation_lease("dev.vibex.shared-3")
        .await
        .unwrap();
    let v2_res = new_lease_3
        .invoke("ping.w3", json!({ "check": "v2" }))
        .await
        .unwrap();
    assert_eq!(v2_res["version"], json!("2.0.0"));
    drop(old_lease_3);
    drop(new_lease_3);
    drop(lease_0);

    // Disable 9 plugins and verify the 10th still works on the same shared Node process
    for index in 0..9 {
        let plugin_id = format!("dev.vibex.shared-{index}");
        control.set_enabled(&plugin_id, false).await.unwrap();
    }
    assert_eq!(control.active_worker_process_count().await, 1);
    let lease_9 = control
        .activation_lease("dev.vibex.shared-9")
        .await
        .unwrap();
    let res_9 = lease_9
        .invoke("ping.w9", json!({ "remaining": 1 }))
        .await
        .unwrap();
    assert_eq!(res_9["index"], json!(9));
    assert_eq!(res_9["pid"], json!(shared_pid));
    drop(lease_9);

    // Disable the last plugin and verify the shared Node OS process terminates (0 processes left)
    control
        .set_enabled("dev.vibex.shared-9", false)
        .await
        .unwrap();
    assert_eq!(
        control.active_worker_process_count().await,
        0,
        "when the last Tier-2 plugin is disabled, the shared Node process must exit"
    );
    assert_eq!(control.shared_node_worker_pid().await, None);
}

#[tokio::test]
async fn failed_candidate_in_shared_runner_does_not_disrupt_healthy_plugins() {
    let Some(node) = node_executable() else {
        return;
    };
    let control = PluginControlPlane::new(Arc::new(InMemoryPluginRegistry::default()));
    let healthy_dir = tempfile::tempdir().unwrap();
    write_shared_worker_package(healthy_dir.path(), 1, "1.0.0", false);
    control
        .import(
            PluginPackage::inspect(healthy_dir.path(), PluginSourceKind::DeveloperLink).unwrap(),
            ConflictDecision::Reject,
        )
        .await
        .unwrap();
    control
        .activate_and_enable(
            &node,
            "dev.vibex.shared-1",
            &[],
            Arc::new(DenyCapabilityBroker),
        )
        .await
        .unwrap();
    let shared_pid = control.shared_node_worker_pid().await.unwrap();

    // Create a broken candidate whose worker throws on import
    let broken_dir = tempfile::tempdir().unwrap();
    write_shared_worker_package(broken_dir.path(), 2, "1.0.0", false);
    std::fs::write(
        broken_dir.path().join("worker.mjs"),
        "throw new Error('boom during module top-level evaluation');\n",
    )
    .unwrap();
    control
        .import(
            PluginPackage::inspect(broken_dir.path(), PluginSourceKind::DeveloperLink).unwrap(),
            ConflictDecision::Reject,
        )
        .await
        .unwrap();
    let err = control
        .activate_and_enable(
            &node,
            "dev.vibex.shared-2",
            &[],
            Arc::new(DenyCapabilityBroker),
        )
        .await
        .expect_err("broken worker must fail activation");
    assert_eq!(err.code(), "worker_spawn_failed");

    // Healthy plugin 1 must still be alive on the exact same shared Node PID
    assert_eq!(control.active_worker_process_count().await, 1);
    assert_eq!(control.shared_node_worker_pid().await, Some(shared_pid));
    let lease_1 = control
        .activation_lease("dev.vibex.shared-1")
        .await
        .unwrap();
    let res = lease_1
        .invoke("ping.w1", json!({ "alive": true }))
        .await
        .unwrap();
    assert_eq!(res["pid"], json!(shared_pid));
}

#[tokio::test]
async fn shared_node_plugins_collaborate_via_service_container_and_revoke_on_dispose() {
    let Some(node) = node_executable() else {
        return;
    };
    let control = PluginControlPlane::new(Arc::new(InMemoryPluginRegistry::default()));

    // Plugin A: Service Provider + Waterfall Interceptor
    let provider_dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(provider_dir.path().join(".vibex-plugin")).unwrap();
    std::fs::write(
        provider_dir.path().join(".vibex-plugin/plugin.json"),
        serde_json::to_string_pretty(&json!({
            "manifestVersion": 4,
            "apiVersion": "1.0",
            "id": "dev.vibex.service-provider",
            "publisher": "dev.vibex",
            "name": "Service Provider",
            "version": "1.0.0",
            "engines": { "vibex": ">=0.1.3 <1.0.0", "pluginSdk": "^1.0.0" },
            "entrypoints": {
                "worker": { "path": "worker.mjs", "runtime": "node", "protocol": "1.1" }
            },
            "permissions": [],
            "contributes": {
                "agent.invocations": [{
                    "id": "provider-noop",
                    "kindVersion": 1,
                    "label": "Provider Noop",
                    "entrypoints": ["action"],
                    "handler": "provider.ping",
                }]
            }
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        provider_dir.path().join("worker.mjs"),
        r#"export default {
  apiVersion: "1.0",
  async setup(registrar, env) {
    env.services.provide("math.double", {
      compute(x) {
        return x * 2;
      }
    });
    env.services.intercept("prompt.enrich", (value) => `${value} [enriched-by-provider]`, 10);
    registrar.handle("provider.ping", async () => ({ ok: true }));
  }
};
"#,
    )
    .unwrap();

    // Plugin B: Service Consumer
    let consumer_dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(consumer_dir.path().join(".vibex-plugin")).unwrap();
    std::fs::write(
        consumer_dir.path().join(".vibex-plugin/plugin.json"),
        serde_json::to_string_pretty(&json!({
            "manifestVersion": 4,
            "apiVersion": "1.0",
            "id": "dev.vibex.service-consumer",
            "publisher": "dev.vibex",
            "name": "Service Consumer",
            "version": "1.0.0",
            "engines": { "vibex": ">=0.1.3 <1.0.0", "pluginSdk": "^1.0.0" },
            "entrypoints": {
                "worker": { "path": "worker.mjs", "runtime": "node", "protocol": "1.1" }
            },
            "permissions": [],
            "contributes": {
                "agent.invocations": [{
                    "id": "consumer-call",
                    "kindVersion": 1,
                    "label": "Consumer Call",
                    "entrypoints": ["action"],
                    "handler": "consumer.call",
                }]
            }
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        consumer_dir.path().join("worker.mjs"),
        r#"export default {
  apiVersion: "1.0",
  async setup(registrar, env) {
    registrar.handle("consumer.call", async (input) => {
      const hasService = env.services.has("math.double");
      const svc = env.services.inject("math.double");
      const doubled = svc ? svc.compute(input.value) : null;
      const prompt = await env.services.runWaterfall("prompt.enrich", input.prompt);
      return { hasService, doubled, prompt, pid: process.pid };
    });
  }
};
"#,
    )
    .unwrap();

    control
        .import(
            PluginPackage::inspect(provider_dir.path(), PluginSourceKind::DeveloperLink).unwrap(),
            ConflictDecision::Reject,
        )
        .await
        .unwrap();
    control
        .import(
            PluginPackage::inspect(consumer_dir.path(), PluginSourceKind::DeveloperLink).unwrap(),
            ConflictDecision::Reject,
        )
        .await
        .unwrap();

    control
        .activate_and_enable(
            &node,
            "dev.vibex.service-provider",
            &[],
            Arc::new(DenyCapabilityBroker),
        )
        .await
        .unwrap();
    control
        .activate_and_enable(
            &node,
            "dev.vibex.service-consumer",
            &[],
            Arc::new(DenyCapabilityBroker),
        )
        .await
        .unwrap();

    let consumer_lease = control
        .activation_lease("dev.vibex.service-consumer")
        .await
        .unwrap();
    let active_res = consumer_lease
        .invoke("consumer.call", json!({ "value": 21, "prompt": "hello" }))
        .await
        .unwrap();
    assert_eq!(active_res["hasService"], json!(true));
    assert_eq!(active_res["doubled"], json!(42));
    assert_eq!(
        active_res["prompt"],
        json!("hello [enriched-by-provider]")
    );

    // Disable provider plugin -> its services and waterfall interceptors must be automatically revoked
    control
        .set_enabled("dev.vibex.service-provider", false)
        .await
        .unwrap();

    let after_dispose = consumer_lease
        .invoke("consumer.call", json!({ "value": 21, "prompt": "hello" }))
        .await
        .unwrap();
    assert_eq!(
        after_dispose["hasService"],
        json!(false),
        "disabling provider plugin must automatically revoke its provided services"
    );
    assert_eq!(after_dispose["doubled"], Value::Null);
    assert_eq!(
        after_dispose["prompt"],
        json!("hello"),
        "disabling provider plugin must automatically revoke its waterfall interceptors"
    );
}

#[tokio::test]
async fn shared_node_async_timeout_isolates_faulty_slot_and_hard_crash_recovers_survivor_slots() {
    use std::time::Duration;

    let Some(node) = node_executable() else {
        return;
    };
    let control = PluginControlPlane::new(Arc::new(InMemoryPluginRegistry::default()));

    // Healthy plugin 1
    let healthy_dir = tempfile::tempdir().unwrap();
    write_shared_worker_package(healthy_dir.path(), 1, "1.0.0", true);
    control
        .import(
            PluginPackage::inspect(healthy_dir.path(), PluginSourceKind::DeveloperLink).unwrap(),
            ConflictDecision::Reject,
        )
        .await
        .unwrap();

    // Faulty plugin 2 with both an async hang handler and a hard crash handler
    let faulty_dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(faulty_dir.path().join(".vibex-plugin")).unwrap();
    std::fs::write(
        faulty_dir.path().join(".vibex-plugin/plugin.json"),
        serde_json::to_string_pretty(&json!({
            "manifestVersion": 4,
            "apiVersion": "1.0",
            "id": "dev.vibex.faulty",
            "publisher": "dev.vibex",
            "name": "Faulty Worker",
            "version": "1.0.0",
            "engines": { "vibex": ">=0.1.3 <1.0.0", "pluginSdk": "^1.0.0" },
            "entrypoints": {
                "worker": { "path": "worker.mjs", "runtime": "node", "protocol": "1.1" }
            },
            "permissions": [],
            "contributes": {
                "agent.invocations": [
                    {
                        "id": "faulty-hang",
                        "kindVersion": 1,
                        "label": "Faulty Hang",
                        "entrypoints": ["action"],
                        "handler": "faulty.hang",
                    },
                    {
                        "id": "faulty-crash",
                        "kindVersion": 1,
                        "label": "Faulty Crash",
                        "entrypoints": ["action"],
                        "handler": "faulty.crash",
                    }
                ]
            }
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        faulty_dir.path().join("worker.mjs"),
        r#"export default {
  apiVersion: "1.0",
  async setup(registrar) {
    registrar.handle("faulty.hang", () => new Promise(() => {}));
    registrar.handle("faulty.crash", async () => {
      process.exit(1);
    });
  }
};
"#,
    )
    .unwrap();

    control
        .import(
            PluginPackage::inspect(faulty_dir.path(), PluginSourceKind::DeveloperLink).unwrap(),
            ConflictDecision::Reject,
        )
        .await
        .unwrap();

    let broker = Arc::new(RecordingBroker::default());
    control
        .activate_and_enable(&node, "dev.vibex.shared-1", &[], broker.clone())
        .await
        .unwrap();
    control
        .activate_and_enable(&node, "dev.vibex.faulty", &[], broker.clone())
        .await
        .unwrap();

    let initial_pid = control.shared_node_worker_pid().await.unwrap();
    let healthy_lease = control
        .activation_lease("dev.vibex.shared-1")
        .await
        .unwrap();
    let faulty_lease = control
        .activation_lease("dev.vibex.faulty")
        .await
        .unwrap();

    // 1. Trigger async timeout on faulty plugin -> must isolate only faulty slot and keep initial_pid alive!
    let timeout_err = faulty_lease
        .invoke_with_timeout("faulty.hang", json!({}), Duration::from_millis(150))
        .await
        .expect_err("hanging handler must time out");
    assert_eq!(timeout_err.code(), "worker_timeout");

    assert_eq!(
        control.shared_node_worker_pid().await,
        Some(initial_pid),
        "async timeout in one plugin slot must not kill the shared Node process"
    );
    let healthy_probe = healthy_lease
        .invoke("ping.w1", json!({ "after": "timeout" }))
        .await
        .unwrap();
    assert_eq!(healthy_probe["pid"], json!(initial_pid));

    // 2. Re-activate faulty plugin and trigger hard process crash (process.exit(1))
    drop(faulty_lease);
    control
        .activate_and_enable(&node, "dev.vibex.faulty", &[], broker.clone())
        .await
        .unwrap();
    let faulty_lease_2 = control
        .activation_lease("dev.vibex.faulty")
        .await
        .unwrap();
    let _crash_err = faulty_lease_2
        .invoke("faulty.crash", json!({}))
        .await
        .expect_err("process.exit(1) must fail the crashing invocation");

    // Survivor plugin (dev.vibex.shared-1) must have been automatically remounted onto a fresh shared Node process!
    let recovered_pid = control
        .shared_node_worker_pid()
        .await
        .expect("shared Node process must automatically respawn for survivor slots");
    assert_ne!(
        recovered_pid, initial_pid,
        "hard process exit must spawn a new shared Node process"
    );
    let survivor_probe = healthy_lease
        .invoke("ping.w1", json!({ "after": "hard_crash" }))
        .await
        .unwrap();
    assert_eq!(survivor_probe["pid"], json!(recovered_pid));
    assert_eq!(survivor_probe["index"], json!(1));
}

