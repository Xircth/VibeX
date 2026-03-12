//! Tokio-based utilities for SACP
//!
//! This crate provides higher-level functionality for working with SACP
//! that requires the Tokio async runtime, such as spawning agent processes
//! and creating connections.

mod acp_agent;

pub use acp_agent::{AcpAgent, LineDirection};
use sacp::{ByteStreams, Role, ConnectTo};
use std::sync::Arc;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

pub struct Stdio {
    debug_callback: Option<Arc<dyn Fn(&str, LineDirection) + Send + Sync + 'static>>,
}

impl Stdio {
    pub fn new() -> Self {
        Self {
            debug_callback: None,
        }
    }

    pub fn with_debug<F>(mut self, callback: F) -> Self
    where
        F: Fn(&str, LineDirection) + Send + Sync + 'static,
    {
        self.debug_callback = Some(Arc::new(callback));
        self
    }
}

impl Default for Stdio {
    fn default() -> Self {
        Self::new()
    }
}

impl<Counterpart: Role> ConnectTo<Counterpart> for Stdio {
    async fn connect_to(self, client: impl ConnectTo<Counterpart::Counterpart>) -> Result<(), sacp::Error> {
        if let Some(callback) = self.debug_callback {
            use futures::AsyncBufReadExt;
            use futures::AsyncWriteExt;
            use futures::StreamExt;
            use futures::io::BufReader;

            // With debug: use Lines with interception
            let stdin = tokio::io::stdin();
            let stdout = tokio::io::stdout();

            // Convert stdio to line streams with debug inspection
            let incoming_callback = callback.clone();
            let incoming_lines = Box::pin(BufReader::new(stdin.compat()).lines().inspect(
                move |result| {
                    if let Ok(line) = result {
                        incoming_callback(line, LineDirection::Stdin);
                    }
                },
            ))
                as std::pin::Pin<Box<dyn futures::Stream<Item = std::io::Result<String>> + Send>>;

            // Create a sink that writes lines with debug logging
            let outgoing_sink = Box::pin(futures::sink::unfold(
                (stdout.compat_write(), callback),
                async move |(mut writer, callback), line: String| {
                    callback(&line, LineDirection::Stdout);
                    let mut bytes = line.into_bytes();
                    bytes.push(b'\n');
                    writer.write_all(&bytes).await?;
                    Ok::<_, std::io::Error>((writer, callback))
                },
            ))
                as std::pin::Pin<Box<dyn futures::Sink<String, Error = std::io::Error> + Send>>;

            ConnectTo::<Counterpart>::connect_to(sacp::Lines::new(outgoing_sink, incoming_lines), client)
                .await
        } else {
            // Without debug: use simple ByteStreams
            ConnectTo::<Counterpart>::connect_to(
                ByteStreams::new(
                    tokio::io::stdout().compat_write(),
                    tokio::io::stdin().compat(),
                ),
                client,
            )
            .await
        }
    }
}
