//! Shell command parsing utilities for categorizing commands

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Category of a shell command, used for display grouping and filtering
#[derive(Debug, Clone, Serialize, Deserialize, TS, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommandCategory {
    /// Commands that read files (cat, head, tail, ls, etc.)
    Read,
    /// Commands that search for content (grep, rg, find, etc.)
    Search,
    /// Commands that modify files or state (sed, awk, cp, mv, etc.)
    Edit,
    /// Commands that fetch remote content (curl, wget, etc.)
    Fetch,
    /// Everything else
    #[default]
    Other,
}

impl CommandCategory {
    /// Classify a shell command string into a category
    pub fn from_command(command: &str) -> Self {
        let first = command.split_whitespace().next().unwrap_or("");
        // Strip path prefix to get just the binary name
        let base = std::path::Path::new(first)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(first);

        match base {
            // Read / inspect
            "cat" | "head" | "tail" | "less" | "more" | "bat" | "file" | "stat" | "wc" | "xxd"
            | "od" | "hexdump" | "strings" => Self::Read,

            // Directory listing / find (read-only traversal)
            "ls" | "ll" | "la" | "dir" | "fd" | "lsd" | "exa" | "eza" => Self::Read,

            // Search
            "grep" | "rg" | "ag" | "ack" | "fzf" | "ripgrep" => Self::Search,

            // Find (can be search)
            "find" => Self::Search,

            // Fetch remote
            "curl" | "wget" | "fetch" | "http" | "httpie" => Self::Fetch,

            // Edit / write / mutate
            "sed" | "awk" | "perl" | "vim" | "vi" | "nano" | "emacs" | "ed" | "micro" | "tee"
            | "tr" | "cut" | "sort" | "uniq" | "cp" | "mv" | "rm" | "mkdir" | "rmdir" | "touch"
            | "chmod" | "chown" | "chgrp" | "ln" | "dd" | "install" | "rsync" | "patch" => {
                Self::Edit
            }

            _ => Self::Other,
        }
    }
}

/// Attempt to unwrap a shell-wrapped command (e.g. `bash -c "..."`) and return
/// the inner command string, or `None` if no unwrapping is needed.
pub fn unwrap_shell_command(command: &str) -> Option<String> {
    let mut parts = command.splitn(3, ' ');
    let shell = parts.next()?;
    let flag = parts.next()?;
    let inner = parts.next()?;

    if matches!(shell, "bash" | "sh" | "zsh" | "fish") && flag == "-c" {
        // Strip surrounding quotes if present
        let trimmed = inner.trim();
        let unquoted = if (trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\''))
        {
            &trimmed[1..trimmed.len() - 1]
        } else {
            trimmed
        };
        Some(unquoted.to_string())
    } else {
        None
    }
}

/// Returns true if the command string contains a file redirect operator
pub fn has_file_redirect(command: &str) -> bool {
    command.contains(" > ") || command.contains(" >> ") || command.contains(" 2> ")
}

/// Returns true if `path` looks like it is a direct file target (not a flag)
pub fn is_file_target(path: &str) -> bool {
    !path.starts_with('-') && !path.is_empty()
}
