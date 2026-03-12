// Sentry module - all third-party error tracking has been removed.

/// No-op: previously initialized Sentry error tracking.
pub fn init_once(_source: SentrySource) {}

/// No-op: previously configured Sentry user scope.
pub fn configure_user_scope(_user_id: &str, _username: Option<&str>, _email: Option<&str>) {}

/// No-op: previously returned a Sentry tracing layer.
pub fn sentry_layer() -> tracing_subscriber::filter::Targets {
    // Return a no-op layer that filters out everything
    tracing_subscriber::filter::Targets::new()
}

#[derive(Clone, Copy, Debug)]
pub enum SentrySource {
    Backend,
    Mcp,
    Remote,
}
