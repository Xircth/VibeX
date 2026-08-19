//! Tracing layer that feeds the in-memory ring buffer and live-tail event.

use std::{cell::Cell, collections::BTreeMap};

use tracing::{
    Event, Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::layer::{Context, Layer};

use crate::logging::hub::{LogRecord, log_hub};

thread_local! {
    static IN_LAYER: Cell<bool> = const { Cell::new(false) };
}

struct LayerGuard;

impl LayerGuard {
    fn enter() -> Option<Self> {
        if IN_LAYER.with(|f| f.replace(true)) {
            None
        } else {
            Some(LayerGuard)
        }
    }
}

impl Drop for LayerGuard {
    fn drop(&mut self) {
        IN_LAYER.with(|f| f.set(false));
    }
}

#[derive(Default)]
struct FieldVisitor {
    message: Option<String>,
    fields: BTreeMap<String, String>,
}

impl FieldVisitor {
    fn put(&mut self, field: &Field, value: String) {
        if field.name() == "message" {
            self.message = Some(value);
        } else {
            self.fields.insert(field.name().to_string(), value);
        }
    }
}

impl Visit for FieldVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field, value.to_string());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.put(field, format!("{value:?}"));
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field, value.to_string());
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field, value.to_string());
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field, value.to_string());
    }
}

pub struct BufferEmitLayer;

impl<S: Subscriber> Layer<S> for BufferEmitLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let Some(_guard) = LayerGuard::enter() else {
            return;
        };
        let Some(hub) = log_hub() else {
            return;
        };

        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        let meta = event.metadata();
        hub.record(LogRecord {
            seq: hub.next_seq(),
            timestamp_ms: now_ms(),
            level: meta.level().as_str(),
            target: meta.target().to_string(),
            message: visitor.message.unwrap_or_default(),
            fields: visitor.fields,
        });
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
