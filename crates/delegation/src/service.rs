//! Lifecycle handle for the companion broker socket.
//!
//! Bootstrap binds once. The status bar can ping and rebind without restarting
//! the Host. A ping is a real `BrokerMessage::Ping` round-trip, not "the accept
//! task handle still exists".

use std::{
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};

use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::listener::DelegationListener;

const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

static CURRENT: OnceLock<Arc<DelegationService>> = OnceLock::new();

#[derive(Default)]
struct ServiceState {
    task: Option<JoinHandle<()>>,
    last_error: Option<String>,
}

pub struct DelegationService {
    listener: Arc<DelegationListener>,
    socket_path: PathBuf,
    state: Mutex<ServiceState>,
}

impl DelegationService {
    pub fn new(listener: Arc<DelegationListener>, socket_path: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            listener,
            socket_path,
            state: Mutex::new(ServiceState::default()),
        })
    }

    pub fn install(service: Arc<Self>) {
        let _ = CURRENT.set(service);
    }

    pub fn current() -> Option<Arc<Self>> {
        CURRENT.get().cloned()
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    pub async fn start(&self) -> Result<(), String> {
        let mut state = self.state.lock().await;
        self.start_locked(&mut state).await
    }

    pub async fn ensure_running(&self) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if probe_socket(&self.socket_path).await {
            return Ok(());
        }
        self.start_locked(&mut state).await
    }

    async fn start_locked(&self, state: &mut ServiceState) -> Result<(), String> {
        #[cfg(windows)]
        if state.task.as_ref().is_some_and(|task| !task.is_finished()) {
            tracing::info!(
                "delegation accept loop still running on {}; not rebinding",
                self.socket_path.display()
            );
            return Ok(());
        }

        if let Some(task) = state.task.take() {
            task.abort();
        }
        let listener = Arc::clone(&self.listener);
        let socket_path = self.socket_path.clone();
        state.task = Some(tokio::spawn(async move {
            if let Err(error) = listener.run(socket_path).await {
                tracing::warn!("delegation listener stopped: {error}");
            }
        }));
        for _ in 0..40 {
            if probe_socket(&self.socket_path).await {
                state.last_error = None;
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let message = format!(
            "delegation socket did not answer after bind: {}",
            self.socket_path.display()
        );
        state.last_error = Some(message.clone());
        Err(message)
    }

    pub async fn is_listening(&self) -> bool {
        probe_socket(&self.socket_path).await
    }

    pub async fn last_error(&self) -> Option<String> {
        self.state.lock().await.last_error.clone()
    }

    pub fn abort(&self) {
        if let Ok(mut state) = self.state.try_lock() {
            if let Some(task) = state.task.take() {
                task.abort();
            }
        }
    }
}

pub async fn probe_socket(socket_path: &Path) -> bool {
    let path = socket_path.to_string_lossy().to_string();
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, ping_once(&path)).await,
        Ok(Ok(true))
    )
}

async fn ping_once(socket_path: &str) -> std::io::Result<bool> {
    use delegation_proto::{BrokerMessage, BrokerResponse, read_frame, write_frame};

    #[cfg(unix)]
    {
        let mut stream = tokio::net::UnixStream::connect(socket_path).await?;
        write_frame(&mut stream, &BrokerMessage::Ping).await?;
        Ok(matches!(
            read_frame::<_, BrokerResponse>(&mut stream).await?,
            BrokerResponse::Payload(value) if value.get("ok") == Some(&serde_json::json!(true))
        ))
    }

    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        let mut stream = ClientOptions::new().open(socket_path)?;
        write_frame(&mut stream, &BrokerMessage::Ping).await?;
        Ok(matches!(
            read_frame::<_, BrokerResponse>(&mut stream).await?,
            BrokerResponse::Payload(value) if value.get("ok") == Some(&serde_json::json!(true))
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ping_fails_when_nothing_is_bound() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        let path = dir.path().join("vibex-delegation-missing.sock");
        #[cfg(windows)]
        let path = PathBuf::from(format!(
            r"\\.\pipe\vibex-delegation-missing-{}",
            uuid::Uuid::new_v4()
        ));
        assert!(!probe_socket(&path).await);
        drop(dir);
    }
}
