use std::{
    io::{BufRead, BufReader},
    path::Path,
};

use super::AgentHistoryError;

pub const MAX_HISTORY_LINE_BYTES: usize = 1024 * 1024;
pub const MAX_HISTORY_MESSAGE_CHARS: usize = 32 * 1024;
pub const MAX_HISTORY_MESSAGES: usize = 8_000;

pub fn cap_history_text(text: String) -> String {
    if text.chars().count() <= MAX_HISTORY_MESSAGE_CHARS {
        return text;
    }
    let mut truncated: String = text.chars().take(MAX_HISTORY_MESSAGE_CHARS).collect();
    truncated.push('…');
    truncated
}

pub fn for_each_jsonl_value(
    path: &Path,
    mut on_value: impl FnMut(serde_json::Value) -> Result<(), AgentHistoryError>,
) -> Result<(), AgentHistoryError> {
    let file = std::fs::File::open(path).map_err(|error| AgentHistoryError::Read {
        path: path.to_path_buf(),
        error: error.to_string(),
    })?;
    let mut reader = BufReader::new(file);
    let mut line_number = 0usize;
    loop {
        line_number += 1;
        match read_bounded_line(path, &mut reader)? {
            BoundedLine::Eof => return Ok(()),
            BoundedLine::Skipped => continue,
            BoundedLine::Line(line) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let value =
                    serde_json::from_str(trimmed).map_err(|error| AgentHistoryError::Parse {
                        path: path.to_path_buf(),
                        error: format!("line {line_number}: {error}"),
                    })?;
                on_value(value)?;
            }
        }
    }
}

enum BoundedLine {
    Line(String),
    Skipped,
    Eof,
}

fn read_bounded_line(
    path: &Path,
    reader: &mut impl BufRead,
) -> Result<BoundedLine, AgentHistoryError> {
    let mut buf = Vec::new();
    let mut skipped = false;
    loop {
        let available = reader.fill_buf().map_err(|error| AgentHistoryError::Read {
            path: path.to_path_buf(),
            error: error.to_string(),
        })?;
        if available.is_empty() {
            if buf.is_empty() && !skipped {
                return Ok(BoundedLine::Eof);
            }
            break;
        }
        if let Some(newline_at) = available.iter().position(|&byte| byte == b'\n') {
            if !skipped && buf.len() + newline_at <= MAX_HISTORY_LINE_BYTES {
                buf.extend_from_slice(&available[..newline_at]);
            } else {
                skipped = true;
                buf.clear();
            }
            reader.consume(newline_at + 1);
            break;
        }
        if !skipped && buf.len() + available.len() > MAX_HISTORY_LINE_BYTES {
            skipped = true;
            buf.clear();
        } else if !skipped {
            buf.extend_from_slice(available);
        }
        let consumed = available.len();
        reader.consume(consumed);
    }
    if skipped {
        return Ok(BoundedLine::Skipped);
    }
    if buf.ends_with(&[b'\r']) {
        buf.pop();
    }
    Ok(BoundedLine::Line(
        String::from_utf8_lossy(&buf).into_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_oversized_jsonl_lines_and_keeps_neighbors() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("bounded.jsonl");
        let huge = "x".repeat(MAX_HISTORY_LINE_BYTES + 32);
        std::fs::write(&path, format!("{{\"ok\":1}}\n{huge}\n{{\"ok\":2}}\n")).unwrap();
        let mut seen = Vec::new();
        for_each_jsonl_value(&path, |value| {
            seen.push(value["ok"].as_u64().unwrap());
            Ok(())
        })
        .unwrap();
        assert_eq!(seen, [1, 2]);
    }

    #[test]
    fn caps_history_text_without_panicking_on_multibyte_chars() {
        let text = "你".repeat(MAX_HISTORY_MESSAGE_CHARS + 8);
        let capped = cap_history_text(text);
        assert_eq!(capped.chars().count(), MAX_HISTORY_MESSAGE_CHARS + 1);
        assert!(capped.ends_with('…'));
    }
}
