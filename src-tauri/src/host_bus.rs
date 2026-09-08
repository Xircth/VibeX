use std::sync::{Arc, OnceLock};

use server::HostEventBus;

static DESKTOP_BUS: OnceLock<Arc<HostEventBus>> = OnceLock::new();

pub fn install(bus: Arc<HostEventBus>) {
    let _ = DESKTOP_BUS.set(bus);
}

pub fn try_bus() -> Option<Arc<HostEventBus>> {
    DESKTOP_BUS.get().cloned()
}

pub fn bus() -> Arc<HostEventBus> {
    try_bus().expect("desktop Host Event Bus is installed during AppState construction")
}
