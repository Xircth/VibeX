use std::{
    sync::{Arc, LazyLock},
    time::Duration,
};

use futures::StreamExt;
use regex::Regex;
use workspace_utils::msg_store::MsgStore;

use crate::logs::{NormalizedEntry, NormalizedEntryType, utils::EntryIndexProvider};

pub struct PlainTextLogProcessor {
    time_gap: Duration,
}

impl PlainTextLogProcessor {
    pub fn with_time_gap(time_gap: Duration) -> Self {
        Self { time_gap }
    }

    pub fn process_stderr(
        self,
        msg_store: Arc<MsgStore>,
        entry_index_provider: EntryIndexProvider,
    ) {
        let time_gap = self.time_gap;
        tokio::spawn(async move {
            let mut stderr_lines = msg_store.stderr_lines_stream();
            let mut buffered = String::new();
            let mut last_flush = tokio::time::Instant::now();

            while let Some(Ok(line)) = stderr_lines.next().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let cleaned = clean_stderr_line(trimmed);
                if cleaned.is_empty() || should_suppress_internal_stderr_line(&cleaned) {
                    continue;
                }

                if !buffered.is_empty() {
                    buffered.push('\n');
                }
                buffered.push_str(&cleaned);

                let now = tokio::time::Instant::now();
                if now.duration_since(last_flush) >= time_gap {
                    flush_buffer(&msg_store, &entry_index_provider, &mut buffered);
                    last_flush = now;
                }
            }

            flush_buffer(&msg_store, &entry_index_provider, &mut buffered);
        });
    }
}

fn flush_buffer(
    msg_store: &Arc<MsgStore>,
    entry_index_provider: &EntryIndexProvider,
    buffered: &mut String,
) {
    if buffered.is_empty() {
        return;
    }

    let index = entry_index_provider.next();
    msg_store.push_patch(
        crate::logs::utils::patch::ConversationPatch::add_normalized_entry(
            index,
            NormalizedEntry {
                timestamp: None,
                entry_type: NormalizedEntryType::SystemMessage,
                content: buffered.clone(),
                metadata: None,
            },
        ),
    );
    buffered.clear();
}

fn clean_stderr_line(line: &str) -> String {
    static ANSI_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\[(?:[0-9]{1,2};?)*m").expect("valid ansi regex")
    });

    ANSI_RE.replace_all(line, "").trim().to_string()
}

fn should_suppress_internal_stderr_line(line: &str) -> bool {
    static TRACING_LOG_RE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"^(?:\d{4}-\d{2}-\d{2}T[0-9:.]+Z\s+)?(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+[a-zA-Z0-9_]+(?:::[a-zA-Z0-9_]+)+(?:\s*:|:|\s)",
        )
        .expect("valid tracing log regex")
    });

    TRACING_LOG_RE.is_match(line) || line.contains(" codex_acp::") || line.contains(" codex_core::")
}

#[cfg(test)]
mod tests {
    use super::{clean_stderr_line, should_suppress_internal_stderr_line};

    #[test]
    fn strips_ansi_escape_and_visible_sgr_fragments() {
        assert_eq!(
            clean_stderr_line("\u{1b}[31mERROR\u{1b}[0m [2mcodex_acp::thread[0m"),
            "ERROR codex_acp::thread"
        );
    }

    #[test]
    fn suppresses_codex_tracing_stderr_lines() {
        let line = clean_stderr_line(
            "[2m2026-04-29T08:22:34.695492Z[0m [31mERROR[0m [2mcodex_acp::thread[0m[2m:[0m Handled error during turn",
        );

        assert!(should_suppress_internal_stderr_line(&line));
    }

    #[test]
    fn keeps_plain_user_facing_stderr() {
        assert!(!should_suppress_internal_stderr_line(
            "Cannot find module 'express'"
        ));
    }
}
