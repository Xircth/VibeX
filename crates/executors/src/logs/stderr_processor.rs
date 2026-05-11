//! Standard stderr log processor for executor output

use std::{sync::Arc, time::Duration};

use workspace_utils::msg_store::MsgStore;

use crate::logs::{plain_text_processor::PlainTextLogProcessor, utils::EntryIndexProvider};

/// Normalize stderr output from an executor into conversation entries.
///
/// Lines are grouped using a 2-second time gap: lines that arrive within 2 seconds
/// of each other are merged into a single `SystemMessage` entry.
pub fn normalize_stderr_logs(msg_store: Arc<MsgStore>, entry_index_provider: EntryIndexProvider) {
    PlainTextLogProcessor::with_time_gap(Duration::from_secs(2))
        .process_stderr(msg_store, entry_index_provider);
}
