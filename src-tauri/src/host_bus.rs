use std::sync::{Arc, OnceLock};

use server::HostEventBus;

static DESKTOP_BUS: OnceLock<Arc<HostEventBus>> = OnceLock::new();

pub fn install(bus: Arc<HostEventBus>) {
    let _ = DESKTOP_BUS.set(bus);
}

pub fn bus() -> Arc<HostEventBus> {
    DESKTOP_BUS
        .get()
        .cloned()
        .expect("desktop Host Event Bus is installed during AppState construction")
}
