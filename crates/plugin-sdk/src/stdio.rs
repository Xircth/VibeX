use std::{
    collections::HashMap,
    io::{self, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot},
};

use crate::{
    error::PluginSdkError,
    host::{HostClient, HostTransport},
    protocol::{
        InitializeParams, MAX_FRAME_BYTES, PLUGIN_API_VERSION, PLUGIN_PROTOCOL_VERSION,
        PLUGIN_SDK_VERSION, PluginContext, WireInbound, error_response, ok_response,
    },
    worker::{
        ActivatedPluginWorker, PluginWorkerDefinition, StderrLogger, WorkerLog,
        activate_plugin_worker,
    },
};

struct PendingHost {
    tx: oneshot::Sender<Result<Value, PluginSdkError>>,
}

struct SessionState {
    pending: Mutex<HashMap<String, PendingHost>>,
    host_sequence: AtomicU64,
    current_request: Mutex<String>,
    outbound: mpsc::UnboundedSender<Value>,
}

impl SessionState {
    fn current_request_id(&self) -> String {
        self.current_request
            .lock()
            .expect("current request lock")
            .clone()
    }
}

struct SessionHost {
    state: Arc<SessionState>,
}

#[async_trait]
impl HostTransport for SessionHost {
    async fn call(
        &self,
        capability: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, PluginSdkError> {
        let id = format!(
            "host:{}",
            self.state.host_sequence.fetch_add(1, Ordering::SeqCst) + 1
        );
        let (tx, rx) = oneshot::channel();
        self.state
            .pending
            .lock()
            .expect("host pending lock")
            .insert(id.clone(), PendingHost { tx });
        self.state
            .outbound
            .send(json!({
                "id": id,
                "method": "host.call",
                "params": {
                    "capability": capability,
                    "operation": operation,
                    "input": input,
                }
            }))
            .map_err(|_| PluginSdkError::new("host_closed", "Host connection closed"))?;
        rx.await
            .map_err(|_| PluginSdkError::new("host_closed", "Host connection closed"))?
    }
}

pub struct WorkerSession {
    definition: PluginWorkerDefinition,
    state: Arc<SessionState>,
    worker: Mutex<Option<Arc<ActivatedPluginWorker>>>,
    outbound_rx: Mutex<Option<mpsc::UnboundedReceiver<Value>>>,
}

impl WorkerSession {
    pub fn new(definition: PluginWorkerDefinition) -> Self {
        let (outbound, outbound_rx) = mpsc::unbounded_channel();
        Self {
            definition,
            state: Arc::new(SessionState {
                pending: Mutex::new(HashMap::new()),
                host_sequence: AtomicU64::new(0),
                current_request: Mutex::new("unknown".to_owned()),
                outbound,
            }),
            worker: Mutex::new(None),
            outbound_rx: Mutex::new(Some(outbound_rx)),
        }
    }

    pub fn take_outbound(&self) -> mpsc::UnboundedReceiver<Value> {
        self.outbound_rx
            .lock()
            .expect("outbound lock")
            .take()
            .expect("outbound already taken")
    }

    pub fn emit(&self, message: Value) {
        let _ = self.state.outbound.send(message);
    }

    pub async fn handle_line(&self, line: &str) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        if trimmed.len() > MAX_FRAME_BYTES {
            self.emit(error_response(
                "unknown",
                "worker_frame_too_large",
                "Worker protocol frame exceeded the limit",
            ));
            return;
        }
        let inbound: WireInbound = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => {
                self.emit(error_response(
                    "unknown",
                    "protocol_invalid",
                    "Invalid JSON message",
                ));
                return;
            }
        };
        self.handle_inbound(inbound).await;
    }

    pub async fn handle_inbound(&self, inbound: WireInbound) {
        if let Some(ok) = inbound.ok {
            let pending = self
                .state
                .pending
                .lock()
                .expect("host pending lock")
                .remove(&inbound.id);
            if let Some(pending) = pending {
                let result = if ok {
                    Ok(inbound.result.unwrap_or(Value::Null))
                } else {
                    let error = inbound.error.unwrap_or(crate::protocol::ProtocolError {
                        code: "host_failed".to_owned(),
                        message: "Host request failed".to_owned(),
                        details: None,
                    });
                    Err(PluginSdkError::new(error.code, error.message))
                };
                let _ = pending.tx.send(result);
            }
            return;
        }

        *self
            .state
            .current_request
            .lock()
            .expect("current request lock") = inbound.id.clone();
        let Some(method) = inbound.method.as_deref() else {
            self.emit(error_response(
                inbound.id,
                "protocol_invalid",
                "Unknown protocol message",
            ));
            return;
        };
        if let Err(error) = self.dispatch(method, &inbound.id, inbound.params).await {
            self.emit(error_response(inbound.id, &error.code, error.message));
        }
    }

    async fn dispatch(&self, method: &str, id: &str, params: Value) -> Result<(), PluginSdkError> {
        match method {
            "initialize" => self.initialize(id, params).await,
            "activate" => self.activate(id, params).await,
            "invoke" => {
                self.invoke(id.to_owned(), params);
                Ok(())
            }
            "dispose" => {
                self.dispose().await?;
                self.emit(ok_response(id, Value::Null));
                Ok(())
            }
            "ping" => {
                self.emit(ok_response(id, json!({ "apiVersion": PLUGIN_API_VERSION })));
                Ok(())
            }
            other => Err(PluginSdkError::new(
                "protocol_invalid",
                format!("Unknown method {other}"),
            )),
        }
    }

    async fn initialize(&self, id: &str, params: Value) -> Result<(), PluginSdkError> {
        let params: InitializeParams = serde_json::from_value(params)
            .map_err(|error| PluginSdkError::new("protocol_invalid", error.to_string()))?;
        if !params
            .protocol_range
            .iter()
            .any(|item| item == PLUGIN_PROTOCOL_VERSION)
        {
            return Err(PluginSdkError::new(
                "protocol_unsupported",
                "Host protocol range does not include 1.1",
            ));
        }
        let worker = self.ensure_worker(PluginContext::from_initialize(&params))?;
        self.emit(ok_response(
            id,
            json!({
                "protocolVersion": PLUGIN_PROTOCOL_VERSION,
                "sdkVersion": PLUGIN_SDK_VERSION,
                "registrations": worker.handlers(),
                "requestedFeatures": [],
            }),
        ));
        Ok(())
    }

    async fn activate(&self, id: &str, params: Value) -> Result<(), PluginSdkError> {
        if self
            .worker
            .lock()
            .expect("worker lock")
            .as_ref()
            .is_some_and(|worker| worker.is_active())
        {
            return Err(PluginSdkError::new(
                "worker_active",
                "Plugin worker is already active",
            ));
        }
        let context: PluginContext = serde_json::from_value(params)
            .map_err(|error| PluginSdkError::new("protocol_invalid", error.to_string()))?;
        let worker = self.ensure_worker(context.clone())?;
        worker.env.replace_context(context);
        worker.mark_active();
        self.emit(ok_response(id, json!({ "handlers": worker.handlers() })));
        Ok(())
    }

    fn invoke(&self, id: String, params: Value) {
        let worker = self.worker.lock().expect("worker lock").clone();
        let Some(worker) = worker.filter(|item| item.is_active()) else {
            self.emit(error_response(
                id,
                "worker_inactive",
                "Plugin worker is not active",
            ));
            return;
        };
        let handler = params
            .get("handler")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let input = params.get("input").cloned().unwrap_or(Value::Null);
        let outbound = self.state.outbound.clone();
        tokio::spawn(async move {
            let message = match worker.invoke(&handler, input).await {
                Ok(result) => ok_response(id, result),
                Err(error) => error_response(id, &error.code, error.message),
            };
            let _ = outbound.send(message);
        });
    }

    fn ensure_worker(
        &self,
        context: PluginContext,
    ) -> Result<Arc<ActivatedPluginWorker>, PluginSdkError> {
        let mut slot = self.worker.lock().expect("worker lock");
        if let Some(existing) = slot.as_ref()
            && !existing.env.is_cancelled()
        {
            return Ok(existing.clone());
        }
        let host = HostClient::new(Arc::new(SessionHost {
            state: Arc::clone(&self.state),
        }));
        let activated = activate_plugin_worker(
            &self.definition,
            context,
            host,
            WorkerLog::new(Arc::new(StderrLogger)),
        )?;
        let activated = Arc::new(activated);
        *slot = Some(Arc::clone(&activated));
        Ok(activated)
    }

    pub async fn dispose(&self) -> Result<(), PluginSdkError> {
        let worker = self.worker.lock().expect("worker lock").take();
        if let Some(worker) = worker {
            worker.dispose().await?;
        }
        let pending = std::mem::take(&mut *self.state.pending.lock().expect("host pending lock"));
        for (_, item) in pending {
            let _ = item.tx.send(Err(PluginSdkError::new(
                "host_closed",
                "Host connection closed",
            )));
        }
        Ok(())
    }
}

pub async fn run_stdio_plugin_worker(
    definition: PluginWorkerDefinition,
) -> Result<(), PluginSdkError> {
    let session = Arc::new(WorkerSession::new(definition));
    install_panic_hook(Arc::clone(&session.state));
    let mut outbound = session.take_outbound();
    let mut stdout = tokio::io::stdout();
    let writer = tokio::spawn(async move {
        while let Some(message) = outbound.recv().await {
            if write_stdout_line(&mut stdout, &message).await.is_err() {
                break;
            }
        }
    });

    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|error| PluginSdkError::new("worker_transport_failed", error.to_string()))?
    {
        session.handle_line(&line).await;
    }
    session.dispose().await?;
    drop(session);
    let _ = writer.await;
    Ok(())
}

pub fn run_stdio_plugin_worker_blocking(
    definition: PluginWorkerDefinition,
) -> Result<(), PluginSdkError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| PluginSdkError::new("runtime_failed", error.to_string()))?
        .block_on(run_stdio_plugin_worker(definition))
}

async fn write_stdout_line(
    stdout: &mut tokio::io::Stdout,
    message: &Value,
) -> Result<(), io::Error> {
    let mut data = serde_json::to_vec(message).map_err(io::Error::other)?;
    data.push(b'\n');
    stdout.write_all(&data).await?;
    stdout.flush().await
}

fn install_panic_hook(state: Arc<SessionState>) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let id = state.current_request_id();
        let payload = error_response(id, "worker_panic", info.to_string());
        if let Ok(mut data) = serde_json::to_vec(&payload) {
            data.push(b'\n');
            let _ = io::stdout().lock().write_all(&data);
            let _ = io::stdout().lock().flush();
        }
        previous(info);
    }));
}
