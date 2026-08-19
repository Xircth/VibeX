//! VibeX plugin worker SDK.
//!
//! MSRV 1.85. stdio uses a tokio current-thread runtime. Isolated builds should
//! use `--no-default-features --features isolated` so filesystem and network
//! helpers are not compiled.

pub mod error;
pub mod host;
pub mod protocol;
pub mod protocol_fixtures;
pub mod stdio;
pub mod testing;
pub mod worker;

pub use error::PluginSdkError;
pub use host::{HostClient, HostTransport};
pub use protocol::{
    PLUGIN_API_VERSION, PLUGIN_PROTOCOL_VERSION, PLUGIN_SDK_VERSION, PackageClass, PluginContext,
};
pub use stdio::{WorkerSession, run_stdio_plugin_worker, run_stdio_plugin_worker_blocking};
pub use testing::{
    GenerationHarness, MemoryHost, WorkerHarness, create_generation_harness, create_worker_harness,
};
pub use worker::{
    ActivatedPluginWorker, PluginRegistrar, PluginWorkerDefinition, WorkerEnv,
    activate_plugin_worker, define_plugin_worker, hello_plugin_worker,
};

#[cfg(test)]
mod api_tests {
    use serde_json::{Value, json};

    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn registers_handlers_and_disposes_in_reverse() {
        let order = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let first = order.clone();
        let second = order.clone();
        let definition = define_plugin_worker(move |registrar, _env| {
            registrar.handle_sync("document.preview", |input, _env| {
                Ok(json!({ "received": input }))
            });
            registrar.handle_sync("surface.createSession", |_input, _env| {
                Ok(json!({ "ready": true }))
            });
            let first = first.clone();
            registrar.on_dispose(move || {
                let first = first.clone();
                async move {
                    first.lock().expect("order").push("first");
                    Ok(())
                }
            });
            let second = second.clone();
            registrar.on_dispose(move || {
                let second = second.clone();
                async move {
                    second.lock().expect("order").push("second");
                    Ok(())
                }
            });
        });
        let harness = create_worker_harness(&definition, None, None).expect("harness");
        let result = harness
            .invoke("document.preview", json!({ "path": "example.docx" }))
            .await
            .expect("invoke");
        assert_eq!(result, json!({ "received": { "path": "example.docx" } }));
        assert_eq!(
            harness.handlers(),
            vec![
                "document.preview".to_owned(),
                "surface.createSession".to_owned()
            ]
        );
        harness.dispose().await.expect("dispose");
        assert_eq!(order.lock().expect("order").as_slice(), ["second", "first"]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn harness_implements_memory_catalog_and_rejects_the_rest() {
        let definition = define_plugin_worker(|registrar, _env| {
            registrar.handle("run", |_, env| async move {
                env.host
                    .call("storage.settings", "put", json!({ "theme": "dark" }))
                    .await?;
                let settings = env
                    .host
                    .call("storage.settings", "get", json!({}))
                    .await?;
                env.host
                    .call("storage.kv", "put", json!({ "key": "n", "value": 1 }))
                    .await?;
                env.host
                    .call(
                        "storage.database",
                        "execute",
                        json!({ "sql": "CREATE TABLE items (id INTEGER, name TEXT)", "params": [] }),
                    )
                    .await?;
                env.host
                    .call(
                        "storage.database",
                        "execute",
                        json!({ "sql": "INSERT INTO items (id, name) VALUES (?, ?)", "params": [1, "a"] }),
                    )
                    .await?;
                let rows = env
                    .host
                    .call(
                        "storage.database",
                        "query",
                        json!({ "sql": "SELECT id, name FROM items", "params": [] }),
                    )
                    .await?;
                env.host
                    .call(
                        "artifact",
                        "writeText",
                        json!({ "content": "hello", "expectedRevision": "sha256:test-0" }),
                    )
                    .await?;
                let doctor = env.host.call("plugin.self", "doctor", json!({})).await?;
                let denied = env
                    .host
                    .call("network", "fetch", json!({ "url": "https://example.com" }))
                    .await
                    .expect_err("network is unimplemented");
                assert_eq!(denied.code, "capability_unimplemented");
                Ok(json!({ "settings": settings, "rows": rows, "doctor": doctor }))
            });
        });
        let harness = create_worker_harness(&definition, None, None).expect("harness");
        let result = harness.invoke("run", Value::Null).await.expect("invoke");
        assert_eq!(result["settings"]["theme"], "dark");
        assert_eq!(result["rows"]["rows"][0]["name"], "a");
        assert!(result["doctor"].get("grants").is_none());
        harness.dispose().await.expect("dispose");
    }
}
