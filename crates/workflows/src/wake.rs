use std::sync::OnceLock;

use tokio::sync::Notify;

static WAKE: OnceLock<Notify> = OnceLock::new();

pub fn workflow_wake() -> &'static Notify {
    WAKE.get_or_init(Notify::new)
}

pub fn notify_workflow_work() {
    workflow_wake().notify_one();
}
