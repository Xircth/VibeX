//! Process-global ring buffer, reload handle, and live-tail emitter.

use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        Arc, Mutex, OnceLock, RwLock,
        atomic::{AtomicU64, Ordering},
    },
};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::logging::{
    LOG_APPENDED_EVENT, LogSettings,
    init::{ReloadHandle, build_env_filter},
};

pub const LOG_BUFFER_MAX_COUNT: usize = 5_000;
pub const LOG_BUFFER_MAX_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct LogRecord {
    pub seq: u64,
    pub timestamp_ms: u64,
    pub level: &'static str,
    pub target: String,
    pub message: String,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
}

fn estimate_size(rec: &LogRecord) -> usize {
    rec.target.len()
        + rec.message.len()
        + 48
        + rec
            .fields
            .iter()
            .map(|(k, v)| k.len() + v.len() + 16)
            .sum::<usize>()
}

struct RingBuffer {
    records: VecDeque<(usize, LogRecord)>,
    byte_total: usize,
}

impl RingBuffer {
    fn new() -> Self {
        Self {
            records: VecDeque::with_capacity(256),
            byte_total: 0,
        }
    }

    fn push(&mut self, rec: LogRecord) {
        let size = estimate_size(&rec);
        self.records.push_back((size, rec));
        self.byte_total = self.byte_total.saturating_add(size);
        while self.records.len() > LOG_BUFFER_MAX_COUNT || self.byte_total > LOG_BUFFER_MAX_BYTES {
            match self.records.pop_front() {
                Some((s, _)) => self.byte_total = self.byte_total.saturating_sub(s),
                None => break,
            }
        }
    }

    fn snapshot(&self) -> Vec<LogRecord> {
        self.records.iter().map(|(_, r)| r.clone()).collect()
    }
}

pub struct LogHub {
    seq: AtomicU64,
    buffer: Mutex<RingBuffer>,
    emitter: RwLock<Option<AppHandle>>,
    reload: ReloadHandle,
}

static LOG_HUB: OnceLock<Arc<LogHub>> = OnceLock::new();

pub fn log_hub() -> Option<&'static Arc<LogHub>> {
    LOG_HUB.get()
}

pub fn attach_emitter(app: AppHandle) {
    if let Some(hub) = log_hub() {
        *hub.emitter.write().unwrap_or_else(|e| e.into_inner()) = Some(app);
    }
}

impl LogHub {
    pub(crate) fn install(reload: ReloadHandle) {
        let _ = LOG_HUB.set(Arc::new(Self {
            seq: AtomicU64::new(0),
            buffer: Mutex::new(RingBuffer::new()),
            emitter: RwLock::new(None),
            reload,
        }));
    }

    pub fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::Relaxed)
    }

    pub fn record(&self, rec: LogRecord) {
        self.buffer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(rec.clone());
        let emitter = self
            .emitter
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(app) = emitter {
            let _ = app.emit(LOG_APPENDED_EVENT, &rec);
        }
    }

    pub fn snapshot(&self) -> Vec<LogRecord> {
        self.buffer
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot()
    }

    pub fn apply_settings(&self, settings: &LogSettings) {
        let _ = self.reload.modify(|filter| {
            *filter = build_env_filter(settings);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(seq: u64, message: &str) -> LogRecord {
        LogRecord {
            seq,
            timestamp_ms: 0,
            level: "INFO",
            target: "t".into(),
            message: message.into(),
            fields: BTreeMap::new(),
        }
    }

    #[test]
    fn ring_buffer_count_cap_evicts_oldest() {
        let mut buf = RingBuffer::new();
        let n = (LOG_BUFFER_MAX_COUNT + 10) as u64;
        for i in 0..n {
            buf.push(rec(i, "m"));
        }
        let snap = buf.snapshot();
        assert_eq!(snap.len(), LOG_BUFFER_MAX_COUNT);
        assert_eq!(snap.first().unwrap().seq, 10);
        assert_eq!(snap.last().unwrap().seq, n - 1);
    }

    #[test]
    fn ring_buffer_byte_cap_evicts_to_stay_under_limit() {
        let mut buf = RingBuffer::new();
        let big = "x".repeat(64 * 1024);
        let n = (LOG_BUFFER_MAX_BYTES / (64 * 1024)) as u64 + 10;
        for i in 0..n {
            buf.push(rec(i, &big));
        }
        assert!(buf.byte_total <= LOG_BUFFER_MAX_BYTES);
        assert!(buf.snapshot().len() <= LOG_BUFFER_MAX_COUNT);
    }
}
