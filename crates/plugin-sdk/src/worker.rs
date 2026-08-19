use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use futures::future::BoxFuture;
use regex::Regex;
use serde_json::Value;

use crate::{
    error::PluginSdkError,
    host::HostClient,
    protocol::{PLUGIN_API_VERSION, PluginContext},
};

pub type HandlerFuture = Pin<Box<dyn Future<Output = Result<Value, PluginSdkError>> + Send>>;
pub type Handler = Arc<dyn Fn(Value, WorkerEnv) -> HandlerFuture + Send + Sync>;
pub type DisposeHook =
    Arc<dyn Fn() -> BoxFuture<'static, Result<(), PluginSdkError>> + Send + Sync>;
type SetupFn = Arc<dyn Fn(&mut PluginRegistrar, &WorkerEnv) + Send + Sync>;

#[derive(Clone)]
pub struct WorkerLog {
    inner: Arc<dyn WorkerLogger>,
}

impl WorkerLog {
    pub fn new(inner: Arc<dyn WorkerLogger>) -> Self {
        Self { inner }
    }

    pub fn debug(&self, message: impl Into<String>, fields: Option<Value>) {
        self.inner.log("debug", &message.into(), fields.as_ref());
    }

    pub fn info(&self, message: impl Into<String>, fields: Option<Value>) {
        self.inner.log("info", &message.into(), fields.as_ref());
    }

    pub fn warn(&self, message: impl Into<String>, fields: Option<Value>) {
        self.inner.log("warn", &message.into(), fields.as_ref());
    }

    pub fn error(&self, message: impl Into<String>, fields: Option<Value>) {
        self.inner.log("error", &message.into(), fields.as_ref());
    }
}

pub trait WorkerLogger: Send + Sync {
    fn log(&self, level: &str, message: &str, fields: Option<&Value>);
}

pub struct StderrLogger;

impl WorkerLogger for StderrLogger {
    fn log(&self, level: &str, message: &str, fields: Option<&Value>) {
        let payload = serde_json::json!({
            "level": level,
            "message": message,
            "fields": fields.cloned().unwrap_or(Value::Null),
        });
        eprintln!("{payload}");
    }
}

#[derive(Clone)]
pub struct WorkerEnv {
    context: Arc<Mutex<PluginContext>>,
    pub host: HostClient,
    pub log: WorkerLog,
    cancelled: Arc<AtomicBool>,
}

impl WorkerEnv {
    pub fn new(context: PluginContext, host: HostClient, log: WorkerLog) -> Self {
        Self {
            context: Arc::new(Mutex::new(context)),
            host,
            log,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn context(&self) -> PluginContext {
        self.context.lock().expect("plugin context lock").clone()
    }

    pub fn replace_context(&self, context: PluginContext) {
        *self.context.lock().expect("plugin context lock") = context;
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub async fn call(
        &self,
        capability: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, PluginSdkError> {
        self.host.call(capability, operation, input).await
    }
}

#[derive(Default)]
pub struct PluginRegistrar {
    handlers: BTreeMap<String, Handler>,
    disposables: Vec<DisposeHook>,
    error: Option<PluginSdkError>,
}

impl PluginRegistrar {
    pub fn handle<F, Fut>(&mut self, id: impl Into<String>, handler: F)
    where
        F: Fn(Value, WorkerEnv) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, PluginSdkError>> + Send + 'static,
    {
        if let Err(error) = self.try_handle(id, handler) {
            if self.error.is_none() {
                self.error = Some(error);
            }
        }
    }

    pub fn handle_sync<F>(&mut self, id: impl Into<String>, handler: F)
    where
        F: Fn(Value, WorkerEnv) -> Result<Value, PluginSdkError> + Send + Sync + 'static,
    {
        self.handle(id, move |input, env| {
            let result = handler(input, env);
            async move { result }
        });
    }

    pub fn on_dispose<F, Fut>(&mut self, hook: F)
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<(), PluginSdkError>> + Send + 'static,
    {
        self.disposables.push(Arc::new(move || {
            Box::pin(hook()) as BoxFuture<'static, Result<(), PluginSdkError>>
        }));
    }

    fn try_handle<F, Fut>(
        &mut self,
        id: impl Into<String>,
        handler: F,
    ) -> Result<(), PluginSdkError>
    where
        F: Fn(Value, WorkerEnv) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, PluginSdkError>> + Send + 'static,
    {
        let id = id.into();
        validate_handler_id(&id)?;
        if self.handlers.contains_key(&id) {
            return Err(PluginSdkError::new(
                "handler_duplicate",
                format!("Handler {id} is already registered"),
            ));
        }
        let handler = Arc::new(move |input: Value, env: WorkerEnv| {
            Box::pin(handler(input, env)) as HandlerFuture
        });
        self.handlers.insert(id, handler);
        Ok(())
    }
}

#[derive(Clone)]
pub struct PluginWorkerDefinition {
    pub api_version: &'static str,
    setup: SetupFn,
}

impl PluginWorkerDefinition {
    pub fn setup(&self, registrar: &mut PluginRegistrar, env: &WorkerEnv) {
        (self.setup)(registrar, env);
    }
}

pub fn define_plugin_worker<F>(setup: F) -> PluginWorkerDefinition
where
    F: Fn(&mut PluginRegistrar, &WorkerEnv) + Send + Sync + 'static,
{
    PluginWorkerDefinition {
        api_version: PLUGIN_API_VERSION,
        setup: Arc::new(setup),
    }
}

pub struct ActivatedPluginWorker {
    handlers: BTreeMap<String, Handler>,
    disposables: Vec<DisposeHook>,
    pub env: WorkerEnv,
    disposed: AtomicBool,
    active: AtomicBool,
}

impl ActivatedPluginWorker {
    pub fn handlers(&self) -> Vec<String> {
        self.handlers.keys().cloned().collect()
    }

    pub fn mark_active(&self) {
        self.active.store(true, Ordering::SeqCst);
    }

    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst) && !self.disposed.load(Ordering::SeqCst)
    }

    pub async fn invoke(&self, handler: &str, input: Value) -> Result<Value, PluginSdkError> {
        if self.disposed.load(Ordering::SeqCst) {
            return Err(PluginSdkError::new(
                "worker_disposed",
                "Plugin worker is disposed",
            ));
        }
        let registered = self.handlers.get(handler).ok_or_else(|| {
            PluginSdkError::new(
                "handler_not_found",
                format!("Handler {handler} is not registered"),
            )
        })?;
        registered(input, self.env.clone()).await
    }

    pub async fn dispose(&self) -> Result<(), PluginSdkError> {
        if self
            .disposed
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(());
        }
        self.active.store(false, Ordering::SeqCst);
        self.env.cancel();
        let mut errors = Vec::new();
        for hook in self.disposables.iter().rev() {
            if let Err(error) = hook().await {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(PluginSdkError::with_details(
                "worker_dispose_failed",
                "Plugin worker disposal failed",
                serde_json::json!(
                    errors
                        .iter()
                        .map(|error| serde_json::json!({
                            "code": error.code,
                            "message": error.message,
                        }))
                        .collect::<Vec<_>>()
                ),
            ))
        }
    }
}

pub fn activate_plugin_worker(
    definition: &PluginWorkerDefinition,
    context: PluginContext,
    host: HostClient,
    log: WorkerLog,
) -> Result<ActivatedPluginWorker, PluginSdkError> {
    if definition.api_version != PLUGIN_API_VERSION {
        return Err(PluginSdkError::new(
            "sdk_incompatible",
            format!("Unsupported worker API {}", definition.api_version),
        ));
    }
    let env = WorkerEnv::new(context, host, log);
    let mut registrar = PluginRegistrar::default();
    definition.setup(&mut registrar, &env);
    if let Some(error) = registrar.error {
        return Err(error);
    }
    Ok(ActivatedPluginWorker {
        handlers: registrar.handlers,
        disposables: registrar.disposables,
        env,
        disposed: AtomicBool::new(false),
        active: AtomicBool::new(false),
    })
}

pub fn validate_handler_id(id: &str) -> Result<(), PluginSdkError> {
    let pattern =
        Regex::new(r"^[a-z][A-Za-z0-9]*(?:[.-][a-z][A-Za-z0-9]*)*$").expect("handler id regex");
    if pattern.is_match(id) {
        Ok(())
    } else {
        Err(PluginSdkError::new(
            "handler_id_invalid",
            format!("Handler {id} must be a namespaced lower-camel identifier"),
        ))
    }
}

pub fn hello_plugin_worker() -> PluginWorkerDefinition {
    define_plugin_worker(|registrar, _env| {
        registrar.handle_sync("hello", |input, _env| Ok(input));
    })
}
