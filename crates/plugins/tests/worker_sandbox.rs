use std::{path::PathBuf, sync::Arc, time::Duration};

use plugins::{DenyCapabilityBroker, PluginPackage, PluginSourceKind, WorkerHost};
use serde_json::json;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::timeout,
};

fn node_executable() -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
    })
}

fn write_sandbox_probe(root: &std::path::Path) {
    std::fs::create_dir_all(root.join(".vibex-plugin")).unwrap();
    std::fs::write(
        root.join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"security.sandbox-probe","publisher":"security",
          "name":"Sandbox Probe","version":"1.0.0",
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "entrypoints":{"worker":{"path":"worker.mjs","runtime":"node","protocol":"1.1"}},
          "permissions":[],
          "contributes":{"agent.invocations":[
            {"id":"probe-fs","kindVersion":1,"label":"Probe FS","entrypoints":["action"],"handler":"probe-fs"},
            {"id":"probe-child","kindVersion":1,"label":"Probe child","entrypoints":["action"],"handler":"probe-child"},
            {"id":"probe-network","kindVersion":1,"label":"Probe network","entrypoints":["action"],"handler":"probe-network"}
          ]}
        }"#,
    )
    .unwrap();
    std::fs::write(
        root.join("worker.mjs"),
        r#"import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const handlers = ['probe-fs', 'probe-child', 'probe-network'];
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    console.log(JSON.stringify({ id: request.id, ok: true, result: { protocolVersion: '1.1', sdkVersion: '1.0.0', registrations: handlers, requestedFeatures: [] } }));
    continue;
  }
  if (request.method === 'activate') {
    console.log(JSON.stringify({ id: request.id, ok: true, result: { handlers } }));
    continue;
  }
  if (request.method === 'dispose') {
    console.log(JSON.stringify({ id: request.id, ok: true, result: null }));
    continue;
  }
  try {
    let escaped = false;
    if (request.params.handler === 'probe-fs') {
      try { readFileSync(request.params.input.path, 'utf8'); escaped = true; } catch {}
    } else if (request.params.handler === 'probe-child') {
      try { spawnSync('/usr/bin/true'); escaped = true; } catch {}
    } else if (request.params.handler === 'probe-network') {
      try { await fetch(request.params.input.url); escaped = true; } catch {}
    }
    console.log(JSON.stringify({ id: request.id, ok: true, result: { escaped } }));
  } catch (error) {
    console.log(JSON.stringify({ id: request.id, ok: false, error: { code: 'probe_failed', message: String(error) } }));
  }
}"#,
    )
    .unwrap();
}

fn write_busy_worker(root: &std::path::Path) {
    std::fs::create_dir_all(root.join(".vibex-plugin")).unwrap();
    std::fs::write(
        root.join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,"apiVersion":"1.0",
          "id":"security.busy-worker","publisher":"security",
          "name":"Busy Worker","version":"1.0.0",
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "entrypoints":{"worker":{"path":"worker.mjs","runtime":"node","protocol":"1.1"}},
          "permissions":[],
          "contributes":{"agent.invocations":[
            {"id":"busy","kindVersion":1,"label":"Busy","entrypoints":["action"],"handler":"busy"}
          ]}
        }"#,
    )
    .unwrap();
    std::fs::write(
        root.join("worker.mjs"),
        r#"import { createInterface } from 'node:readline';
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    console.log(JSON.stringify({ id: request.id, ok: true, result: { protocolVersion: '1.1', sdkVersion: '1.0.0', registrations: ['busy'], requestedFeatures: [] } }));
  } else if (request.method === 'activate') {
    console.log(JSON.stringify({ id: request.id, ok: true, result: { handlers: ['busy'] } }));
  } else if (request.method === 'invoke') {
    while (true) {}
  }
}"#,
    )
    .unwrap();
}

#[tokio::test]
async fn trusted_worker_can_read_host_files_spawn_children_and_reach_loopback() {
    let Some(node) = node_executable() else {
        return;
    };
    let package_root = tempfile::tempdir().unwrap();
    let outside_root = tempfile::tempdir().unwrap();
    let secret_path = outside_root.path().join("secret.txt");
    std::fs::write(&secret_path, "must stay outside the Worker").unwrap();
    write_sandbox_probe(package_root.path());
    let package = PluginPackage::inspect(package_root.path(), PluginSourceKind::Snapshot).unwrap();
    let worker = WorkerHost::spawn(&node, &package, 1, &[], Arc::new(DenyCapabilityBroker))
        .await
        .unwrap();

    let fs_result = worker
        .invoke("probe-fs", json!({ "path": secret_path }))
        .await
        .unwrap();
    assert_eq!(fs_result["escaped"], true);

    let child_result = worker.invoke("probe-child", json!(null)).await.unwrap();
    assert_eq!(child_result["escaped"], true);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let response = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        // Drain the request first. Closing a socket that still holds unread
        // inbound data makes Windows send an RST, which aborts the response
        // before the client can read it and fails the probe.
        let mut request = [0_u8; 1024];
        let _ = stream.read(&mut request).await;
        stream
            .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
            .await
            .unwrap();
        stream.flush().await.unwrap();
    });
    let network_result = worker
        .invoke(
            "probe-network",
            json!({ "url": format!("http://{address}") }),
        )
        .await
        .unwrap();
    assert_eq!(network_result["escaped"], true);
    timeout(Duration::from_secs(1), response)
        .await
        .expect("trusted Worker reaches the Host loopback listener")
        .unwrap();

    worker.dispose("full-trust test complete").await.unwrap();
}

#[tokio::test]
async fn timed_out_worker_is_killed_and_remains_terminal() {
    let Some(node) = node_executable() else {
        return;
    };
    let package_root = tempfile::tempdir().unwrap();
    write_busy_worker(package_root.path());
    let package = PluginPackage::inspect(package_root.path(), PluginSourceKind::Snapshot).unwrap();
    let worker = WorkerHost::spawn_with_request_timeout(
        &node,
        &package,
        1,
        &[],
        Arc::new(DenyCapabilityBroker),
        Duration::from_millis(100),
    )
    .await
    .unwrap();

    let first = worker.invoke("busy", json!(null)).await.unwrap_err();
    assert_eq!(first.code(), "worker_timeout");
    let second = timeout(
        Duration::from_millis(100),
        worker.invoke("busy", json!(null)),
    )
    .await
    .expect("terminal workers fail immediately")
    .unwrap_err();
    assert_eq!(second.code(), "worker_terminal");
}
