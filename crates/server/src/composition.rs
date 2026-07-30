use std::path::{Path, PathBuf};

use application::{ApplicationCore, SqliteConversationRepository};
use db::DBService;
use sqlx::SqlitePool;

use crate::{ServerConfig, ServerRuntime, ServerToken, SqliteTokenHashStore};

pub struct ServerBootstrapConfig {
    pub data_dir: PathBuf,
    pub server: ServerConfig,
    pub token: Option<ServerToken>,
}

impl ServerBootstrapConfig {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        Self {
            data_dir: data_dir.as_ref().to_path_buf(),
            server: ServerConfig::default(),
            token: None,
        }
    }

    pub fn with_token(mut self, token: ServerToken) -> Self {
        self.token = Some(token);
        self
    }
}

pub struct HeadlessServer {
    pool: SqlitePool,
    runtime: ServerRuntime<SqliteConversationRepository>,
    issued_token: Option<ServerToken>,
}

impl HeadlessServer {
    pub async fn bootstrap(config: ServerBootstrapConfig) -> Result<Self, sqlx::Error> {
        let database = DBService::new_at(&config.data_dir).await?;
        let provisioned = SqliteTokenHashStore::new(database.pool.clone())
            .provision(config.token)
            .await?;
        let core = ApplicationCore::new(SqliteConversationRepository::new(database.pool.clone()));
        let runtime = ServerRuntime::from_credentials(config.server, provisioned.credentials, core);
        Ok(Self {
            pool: database.pool,
            runtime,
            issued_token: provisioned.issued_token,
        })
    }

    pub const fn runtime(&self) -> &ServerRuntime<SqliteConversationRepository> {
        &self.runtime
    }

    pub const fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub fn take_issued_token(&mut self) -> Option<ServerToken> {
        self.issued_token.take()
    }

    pub async fn serve(self) -> std::io::Result<()> {
        let listen_addr = self.runtime.config().listen_addr;
        let listener = tokio::net::TcpListener::bind(listen_addr).await?;
        tracing::info!(%listen_addr, "vibex-server listening");
        axum::serve(listener, self.runtime.router()).await
    }
}
