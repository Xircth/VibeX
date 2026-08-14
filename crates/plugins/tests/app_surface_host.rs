use std::{path::PathBuf, sync::Arc, time::Duration};

use plugins::{
    AppSurfaceIdentity, AppSurfaceInvocation, AppSurfaceOpenRequest, ConflictDecision,
    DenyCapabilityBroker, InMemoryPluginRegistry, PluginAppSurfaceHost, PluginControlPlane,
    PluginPackage, PluginSourceKind,
};
use serde_json::json;

fn node_executable() -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|directory| directory.join(if cfg!(windows) { "node.exe" } else { "node" }))
            .find(|candidate| candidate.is_file())
    })
}

fn write_editor_package(root: &std::path::Path) {
    write_package(root);
    let manifest_path = root.join(".vibex-plugin/plugin.json");
    let mut manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
    manifest["contributes"]["app.fileOpeners"] = json!([{
        "id":"drawio-files",
        "kindVersion":1,
        "label":"Drawio diagram",
        "extensions":["drawio"],
        "priority":100,
        "editorSurface":"dashboard"
    }]);
    manifest["contributes"]["app.surfaces"][0]["slot"] = json!("artifact.editor");
    std::fs::write(manifest_path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
}

fn write_package(root: &std::path::Path) {
    std::fs::create_dir_all(root.join(".vibex-plugin")).unwrap();
    std::fs::create_dir_all(root.join("dist/app")).unwrap();
    std::fs::write(
        root.join(".vibex-plugin/plugin.json"),
        r#"{
          "manifestVersion":4,
          "apiVersion":"1.0",
          "id":"tests.surface",
          "publisher":"tests",
          "name":"Surface fixture",
          "version":"1.0.0",
          "engines":{"vibex":">=0.1.3 <1.0.0","pluginSdk":"^1.0.0"},
          "entrypoints":{
            "worker":{"path":"worker.mjs","format":"javascript-esm","protocol":"1.0"},
            "app":{"root":"dist/app","document":"index.html","protocol":"1.0"}
          },
          "permissions":[],
          "contributes":{"app.surfaces":[{
            "id":"dashboard",
            "kindVersion":1,
            "label":"Dashboard",
            "slot":"plugin.detail.panel",
            "appEntrypoint":"app",
            "handler":"surface.createSession",
            "allowedMethods":["hello"]
          }]}
        }"#,
    )
    .unwrap();
    std::fs::write(
        root.join("worker.mjs"),
        r#"import { createInterface } from 'node:readline';
const handlers = ['surface.createSession', 'hello'];
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (request.method === 'activate') {
    console.log(JSON.stringify({ id: request.id, ok: true, result: { handlers } }));
  } else if (request.method === 'dispose') {
    console.log(JSON.stringify({ id: request.id, ok: true, result: null }));
  } else {
    console.log(JSON.stringify({
      id: request.id,
      ok: true,
      result: { handler: request.params.handler, input: request.params.input }
    }));
  }
}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("dist/app/index.html"),
        "<!doctype html><html><body><main>isolated surface</main></body></html>",
    )
    .unwrap();
}

#[tokio::test]
async fn published_surface_opens_invokes_and_revokes_through_the_shared_host() {
    let Some(node) = node_executable() else {
        return;
    };
    let root = tempfile::tempdir().unwrap();
    write_package(root.path());
    let package = PluginPackage::inspect(root.path(), PluginSourceKind::DeveloperLink).unwrap();
    let control = Arc::new(PluginControlPlane::new(Arc::new(
        InMemoryPluginRegistry::default(),
    )));
    control
        .import(package, ConflictDecision::Reject)
        .await
        .unwrap();
    control
        .activate_and_enable(&node, "tests.surface", &[], Arc::new(DenyCapabilityBroker))
        .await
        .unwrap();

    let catalog = control.contributions().await.unwrap();
    let surface = catalog
        .items
        .iter()
        .find(|item| item.id == "dashboard")
        .unwrap();
    let identity = AppSurfaceIdentity {
        plugin_id: "tests.surface".to_owned(),
        surface_id: "dashboard".to_owned(),
        generation: surface.generation,
        token: "0123456789abcdef0123456789abcdef".to_owned(),
    };
    let host = PluginAppSurfaceHost::new(control);
    let document = host
        .open(AppSurfaceOpenRequest {
            identity: identity.clone(),
            artifact_path: None,
        })
        .await
        .unwrap();
    assert!(document.html.contains("isolated surface"));
    assert_ne!(document.token, identity.token);
    let issued_identity = AppSurfaceIdentity {
        token: document.token,
        ..identity.clone()
    };

    let result = host
        .invoke(AppSurfaceInvocation {
            identity: issued_identity.clone(),
            request_id: "request-1".to_owned(),
            sequence: 1,
            method: "hello".to_owned(),
            params: json!({ "name": "VibeX" }),
        })
        .await
        .unwrap();
    assert_eq!(result["handler"], "hello");
    assert_eq!(result["input"]["params"]["name"], "VibeX");

    host.revoke(&issued_identity).await.unwrap();
    let error = host
        .invoke(AppSurfaceInvocation {
            identity: issued_identity,
            request_id: "request-2".to_owned(),
            sequence: 2,
            method: "hello".to_owned(),
            params: json!(null),
        })
        .await
        .expect_err("revoked surface cannot invoke its Worker");
    assert_eq!(error.kind(), plugins::AppSurfaceErrorKind::Conflict);
}

#[tokio::test]
async fn host_issued_surface_token_expires() {
    let Some(node) = node_executable() else {
        return;
    };
    let root = tempfile::tempdir().unwrap();
    write_package(root.path());
    let package = PluginPackage::inspect(root.path(), PluginSourceKind::DeveloperLink).unwrap();
    let control = Arc::new(PluginControlPlane::new(Arc::new(
        InMemoryPluginRegistry::default(),
    )));
    control
        .import(package, ConflictDecision::Reject)
        .await
        .unwrap();
    control
        .activate_and_enable(&node, "tests.surface", &[], Arc::new(DenyCapabilityBroker))
        .await
        .unwrap();
    let surface = control.contributions().await.unwrap().items.pop().unwrap();
    let host = PluginAppSurfaceHost::with_token_ttl(control, Duration::from_millis(1));
    let document = host
        .open(AppSurfaceOpenRequest {
            identity: AppSurfaceIdentity {
                plugin_id: "tests.surface".to_owned(),
                surface_id: "dashboard".to_owned(),
                generation: surface.generation,
                token: "0123456789abcdef0123456789abcdef".to_owned(),
            },
            artifact_path: None,
        })
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(5)).await;
    let error = host
        .invoke(AppSurfaceInvocation {
            identity: AppSurfaceIdentity {
                plugin_id: "tests.surface".to_owned(),
                surface_id: "dashboard".to_owned(),
                generation: surface.generation,
                token: document.token,
            },
            request_id: "expired".to_owned(),
            sequence: 1,
            method: "hello".to_owned(),
            params: json!(null),
        })
        .await
        .unwrap_err();
    assert!(error.to_string().contains("expired"));
}

#[tokio::test]
async fn artifact_editor_surface_reads_writes_and_detects_external_changes() {
    let Some(node) = node_executable() else {
        return;
    };
    let root = tempfile::tempdir().unwrap();
    write_editor_package(root.path());
    let diagram = root.path().join("architecture.drawio");
    std::fs::write(&diagram, "<mxfile><diagram>first</diagram></mxfile>").unwrap();
    let package = PluginPackage::inspect(root.path(), PluginSourceKind::DeveloperLink).unwrap();
    let control = Arc::new(PluginControlPlane::new(Arc::new(
        InMemoryPluginRegistry::default(),
    )));
    control
        .import(package, ConflictDecision::Reject)
        .await
        .unwrap();
    control
        .activate_and_enable(&node, "tests.surface", &[], Arc::new(DenyCapabilityBroker))
        .await
        .unwrap();
    let surface = control
        .contributions()
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.id == "dashboard")
        .unwrap();
    let host = PluginAppSurfaceHost::new(control);
    let document = host
        .open(AppSurfaceOpenRequest {
            identity: AppSurfaceIdentity {
                plugin_id: "tests.surface".to_owned(),
                surface_id: "dashboard".to_owned(),
                generation: surface.generation,
                token: "0123456789abcdef0123456789abcdef".to_owned(),
            },
            artifact_path: Some(diagram.clone()),
        })
        .await
        .unwrap();
    assert_eq!(document.context["slot"], "artifact.editor");
    assert_eq!(document.context["artifact"]["name"], "architecture.drawio");
    let identity = AppSurfaceIdentity {
        plugin_id: "tests.surface".to_owned(),
        surface_id: "dashboard".to_owned(),
        generation: surface.generation,
        token: document.token,
    };

    let opened = host
        .invoke(AppSurfaceInvocation {
            identity: identity.clone(),
            request_id: "read-1".to_owned(),
            sequence: 1,
            method: "artifact.readText".to_owned(),
            params: json!(null),
        })
        .await
        .unwrap();
    assert_eq!(
        opened["content"],
        "<mxfile><diagram>first</diagram></mxfile>"
    );
    let revision = opened["revision"].as_str().unwrap().to_owned();
    let saved = host
        .invoke(AppSurfaceInvocation {
            identity: identity.clone(),
            request_id: "write-1".to_owned(),
            sequence: 2,
            method: "artifact.writeText".to_owned(),
            params: json!({
                "content":"<mxfile><diagram>saved</diagram></mxfile>",
                "expectedRevision": revision,
            }),
        })
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(&diagram).unwrap(),
        "<mxfile><diagram>saved</diagram></mxfile>"
    );

    std::fs::write(&diagram, "<mxfile><diagram>external</diagram></mxfile>").unwrap();
    let error = host
        .invoke(AppSurfaceInvocation {
            identity,
            request_id: "write-stale".to_owned(),
            sequence: 3,
            method: "artifact.writeText".to_owned(),
            params: json!({
                "content":"<mxfile><diagram>overwrite</diagram></mxfile>",
                "expectedRevision": saved["revision"],
            }),
        })
        .await
        .expect_err("an external edit must not be overwritten silently");
    assert_eq!(error.kind(), plugins::AppSurfaceErrorKind::Conflict);
}
