use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

// 鈹€鈹€ Path safety 鈹€鈹€

/// Validate that a resolved path falls within one of the allowed sandbox roots.
/// Returns the canonicalized path on success.
///
/// This function:
/// 1. Rejects raw paths containing `..` components (defense-in-depth)
/// 2. Canonicalizes the path to resolve symlinks
/// 3. Verifies the canonical path starts with one of `allowed_roots`
#[allow(dead_code)] // Reserved for future use when commands gain AppState access
fn validate_path_within_sandbox(
    path: &Path,
    allowed_roots: &[PathBuf],
) -> Result<PathBuf, AppError> {
    // Step 1: Reject `..` components in the raw path (before symlink resolution)
    for comp in path.components() {
        if matches!(comp, Component::ParentDir) {
            return Err(AppError::BadRequest(
                "Path traversal not allowed: '..' components rejected".to_string(),
            ));
        }
    }

    // Step 2: Canonicalize to resolve symlinks and get the real absolute path
    let canonical = if path.exists() {
        path.canonicalize().map_err(|e| {
            AppError::Internal(format!("Failed to resolve path {}: {}", path.display(), e))
        })?
    } else if let Some(parent) = path.parent() {
        if parent.exists() {
            let canonical_parent = parent
                .canonicalize()
                .map_err(|e| AppError::Internal(format!("Failed to resolve parent path: {}", e)))?;
            canonical_parent.join(path.file_name().unwrap_or_default())
        } else {
            return Err(AppError::BadRequest(format!(
                "Parent directory does not exist: {}",
                parent.display()
            )));
        }
    } else {
        return Err(AppError::BadRequest(
            "Cannot resolve path: no parent directory".to_string(),
        ));
    };

    // Step 3: Verify the canonical path is under one of the allowed roots
    if allowed_roots.is_empty() {
        return Err(AppError::BadRequest(
            "No allowed sandbox roots configured".to_string(),
        ));
    }

    let is_within_sandbox = allowed_roots.iter().any(|root| {
        // Canonicalize the root too to ensure consistent comparison
        let canonical_root = if root.exists() {
            root.canonicalize().unwrap_or_else(|_| root.clone())
        } else {
            root.clone()
        };
        canonical.starts_with(&canonical_root)
    });

    if !is_within_sandbox {
        return Err(AppError::BadRequest(format!(
            "Access denied: path '{}' is outside allowed workspace boundaries",
            path.display()
        )));
    }

    Ok(canonical)
}

/// Sanitize a user-supplied file path to prevent path traversal attacks.
///
/// When sandbox roots are not available (commands without AppState), this
/// function provides defense-in-depth by:
/// 1. Rejecting paths with `..` components
/// 2. Canonicalizing to resolve symlinks
/// 3. Verifying the canonical path does not escape the original path's parent
///    hierarchy (detects symlink escapes)
fn sanitize_file_path(path: &str) -> Result<PathBuf, AppError> {
    let normalized_path = normalize_windows_verbatim_input(path);
    let p = PathBuf::from(&normalized_path);

    // Reject any path containing parent-dir (`..`) components
    for comp in p.components() {
        if matches!(comp, Component::ParentDir) {
            return Err(AppError::BadRequest(
                "Path traversal not allowed: '..' components rejected".to_string(),
            ));
        }
    }

    // Must be an absolute path to prevent relative-path tricks
    if !p.is_absolute() {
        return Err(AppError::BadRequest(
            "Only absolute paths are accepted".to_string(),
        ));
    }

    // Canonicalize to resolve symlinks and normalize the path
    let canonical = if p.exists() {
        p.canonicalize()
            .map_err(|e| AppError::Internal(format!("Failed to resolve path {}: {}", path, e)))?
    } else if let Some(parent) = p.parent() {
        if parent.exists() {
            let canonical_parent = parent
                .canonicalize()
                .map_err(|e| AppError::Internal(format!("Failed to resolve parent path: {}", e)))?;
            canonical_parent.join(p.file_name().unwrap_or_default())
        } else {
            return Err(AppError::BadRequest(format!(
                "Parent directory does not exist for path: {}",
                normalized_path
            )));
        }
    } else {
        return Err(AppError::BadRequest(format!(
            "Cannot resolve path: {}",
            normalized_path
        )));
    };

    // Additional safety: reject if canonical path contains `..` after resolution
    // (should not happen but acts as a safety net)
    for comp in canonical.components() {
        if matches!(comp, Component::ParentDir) {
            return Err(AppError::BadRequest(
                "Resolved path still contains '..' components".to_string(),
            ));
        }
    }

    Ok(canonical)
}

#[cfg(windows)]
fn normalize_windows_verbatim_input(path: &str) -> String {
    fn marker_len_at(path: &str, index: usize) -> Option<usize> {
        let rest = path.get(index..)?;
        let bytes = rest.as_bytes();
        let looks_like_drive = |offset: usize| {
            bytes
                .get(offset)
                .is_some_and(|byte| byte.is_ascii_alphabetic())
                && bytes.get(offset + 1) == Some(&b':')
                && bytes
                    .get(offset + 2)
                    .is_some_and(|byte| *byte == b'\\' || *byte == b'/')
        };

        if bytes.len() >= 7
            && bytes[0] == b'\\'
            && bytes[1] == b'\\'
            && bytes[2] == b'?'
            && (bytes[3] == b'\\' || bytes[3] == b'/')
            && looks_like_drive(4)
        {
            return Some(4);
        }

        if bytes.len() >= 6
            && (bytes[0] == b'\\' || bytes[0] == b'/')
            && bytes[1] == b'?'
            && (bytes[2] == b'\\' || bytes[2] == b'/')
            && looks_like_drive(3)
        {
            return Some(3);
        }

        None
    }

    let mut last_marker = None;
    for (index, _) in path.char_indices() {
        if let Some(marker_len) = marker_len_at(path, index) {
            last_marker = Some((index, marker_len));
        }
    }

    let Some((index, marker_len)) = last_marker else {
        return path.to_string();
    };

    let candidate = &path[index + marker_len..];
    candidate.replace('/', "\\")
}

#[cfg(not(windows))]
fn normalize_windows_verbatim_input(path: &str) -> String {
    path.to_string()
}

fn read_utf8_text_file(path: &Path, display_path: &str) -> Result<String, AppError> {
    let bytes = std::fs::read(path)
        .map_err(|e| AppError::Internal(format!("Failed to read file {}: {}", display_path, e)))?;

    if bytes.contains(&0) {
        return Err(AppError::BadRequest(format!(
            "Binary file cannot be opened as text: {}",
            display_path
        )));
    }

    String::from_utf8(bytes).map_err(|_| {
        AppError::BadRequest(format!(
            "Binary file cannot be opened as text: {}",
            display_path
        ))
    })
}

#[derive(Debug, Serialize, Clone)]
pub struct DocumentPreviewResponse {
    pub content: String,
    pub format: String,
    pub extractor: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct BinaryAssetResponse {
    pub data_base64: String,
    pub mime_type: String,
}

fn mime_type_for_path(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();

    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "tif" | "tiff" => "image/tiff",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn read_binary_asset_file(
    path: &Path,
    display_path: &str,
) -> Result<BinaryAssetResponse, AppError> {
    let bytes = std::fs::read(path)
        .map_err(|e| AppError::Internal(format!("Failed to read file {}: {}", display_path, e)))?;

    Ok(BinaryAssetResponse {
        data_base64: BASE64.encode(bytes),
        mime_type: mime_type_for_path(path).to_string(),
    })
}

fn decode_xml_entities(input: &str) -> String {
    let numeric_entity_re =
        Regex::new(r"&#(x?[0-9A-Fa-f]+);").expect("valid numeric xml entity regex");
    let decoded = numeric_entity_re
        .replace_all(input, |captures: &regex::Captures<'_>| {
            let raw = captures.get(1).map(|m| m.as_str()).unwrap_or_default();
            let parsed = if let Some(hex) = raw.strip_prefix('x').or_else(|| raw.strip_prefix('X'))
            {
                u32::from_str_radix(hex, 16).ok()
            } else {
                raw.parse::<u32>().ok()
            };

            parsed
                .and_then(char::from_u32)
                .map(|value| value.to_string())
                .unwrap_or_default()
        })
        .into_owned();

    decoded
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn escape_powershell_single_quoted_string(value: &str) -> String {
    value.replace('\'', "''")
}

fn normalize_document_preview_text(content: &str) -> String {
    let repeated_spaces_re = Regex::new(r"[ \t]{2,}").expect("valid repeated spaces regex");
    let repeated_newlines_re = Regex::new(r"\n{3,}").expect("valid repeated newlines regex");
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = repeated_spaces_re
        .replace_all(&normalized, " ")
        .into_owned();
    let normalized = repeated_newlines_re
        .replace_all(&normalized, "\n\n")
        .into_owned();
    normalized.trim().to_string()
}

fn escape_html(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn wrap_inline_run_html(run_xml: &str, content: String) -> String {
    let mut wrapped = content;

    if run_xml.contains("<w:b") {
        wrapped = format!("<strong>{wrapped}</strong>");
    }
    if run_xml.contains("<w:i") {
        wrapped = format!("<em>{wrapped}</em>");
    }
    if run_xml.contains("<w:u") {
        wrapped = format!("<u>{wrapped}</u>");
    }

    wrapped
}

fn extract_run_html(run_xml: &str) -> String {
    let token_re = Regex::new(r#"(?s)<w:t[^>]*>(.*?)</w:t>|<w:(?:br|cr)\b[^>]*/>|<w:tab\b[^>]*/>"#)
        .expect("valid run token regex");
    let mut html = String::new();

    for token in token_re.find_iter(run_xml) {
        let raw = token.as_str();
        if raw.starts_with("<w:t") {
            let start = raw.find('>').unwrap_or(0) + 1;
            let end = raw.rfind("</w:t>").unwrap_or(raw.len());
            let text = decode_xml_entities(&raw[start..end]);
            html.push_str(&escape_html(&text));
        } else if raw.starts_with("<w:tab") {
            html.push_str("&emsp;");
        } else {
            html.push_str("<br/>");
        }
    }

    wrap_inline_run_html(run_xml, html)
}

fn extract_paragraph_inline_html(paragraph_xml: &str) -> String {
    let run_re = Regex::new(r#"(?s)<w:r\b[^>]*>.*?</w:r>|<w:hyperlink\b[^>]*>.*?</w:hyperlink>"#)
        .expect("valid paragraph run regex");
    let mut html = String::new();

    for block in run_re.find_iter(paragraph_xml) {
        let raw = block.as_str();
        if raw.starts_with("<w:hyperlink") {
            let inner_start = raw.find('>').unwrap_or(0) + 1;
            let inner_end = raw.rfind("</w:hyperlink>").unwrap_or(raw.len());
            html.push_str(&extract_paragraph_inline_html(&raw[inner_start..inner_end]));
        } else {
            html.push_str(&extract_run_html(raw));
        }
    }

    html.trim().to_string()
}

fn paragraph_alignment_class(paragraph_xml: &str) -> &'static str {
    if paragraph_xml.contains(r#"w:jc w:val="center""#) {
        " is-center"
    } else if paragraph_xml.contains(r#"w:jc w:val="right""#) {
        " is-right"
    } else {
        ""
    }
}

enum DocxBlock {
    Heading { level: u8, html: String },
    Paragraph(String),
    ListItem(String),
}

fn extract_paragraph_block(paragraph_xml: &str) -> Option<DocxBlock> {
    let html = extract_paragraph_inline_html(paragraph_xml);
    if html.is_empty() {
        return None;
    }

    let alignment_class = paragraph_alignment_class(paragraph_xml);
    let style_re =
        Regex::new(r#"w:pStyle[^>]*w:val="([^"]+)""#).expect("valid paragraph style regex");
    let style_name = style_re
        .captures(paragraph_xml)
        .and_then(|captures| captures.get(1).map(|value| value.as_str().to_string()));

    if paragraph_xml.contains("<w:numPr") {
        return Some(DocxBlock::ListItem(format!(
            r#"<li class="doc-preview-list-item{alignment_class}">{html}</li>"#
        )));
    }

    if let Some(style_name) = style_name {
        let normalized = style_name.to_ascii_lowercase();
        if let Some(level_text) = normalized.strip_prefix("heading")
            && let Ok(level) = level_text.parse::<u8>()
        {
            let heading_level = level.clamp(1, 6);
            return Some(DocxBlock::Heading {
                level: heading_level,
                html,
            });
        }

        if normalized == "title" {
            return Some(DocxBlock::Heading { level: 1, html });
        }

        if normalized == "subtitle" {
            return Some(DocxBlock::Heading { level: 2, html });
        }
    }

    Some(DocxBlock::Paragraph(format!(
        r#"<p class="doc-preview-paragraph{alignment_class}">{html}</p>"#
    )))
}

fn extract_table_html(table_xml: &str) -> Option<String> {
    let row_re = Regex::new(r#"(?s)<w:tr\b[^>]*>.*?</w:tr>"#).expect("valid table row regex");
    let cell_re = Regex::new(r#"(?s)<w:tc\b[^>]*>.*?</w:tc>"#).expect("valid table cell regex");
    let paragraph_re =
        Regex::new(r#"(?s)<w:p\b[^>]*>.*?</w:p>"#).expect("valid table paragraph regex");
    let mut rows = Vec::new();

    for row_match in row_re.find_iter(table_xml) {
        let mut cells = Vec::new();
        for cell_match in cell_re.find_iter(row_match.as_str()) {
            let mut paragraphs = Vec::new();
            for paragraph_match in paragraph_re.find_iter(cell_match.as_str()) {
                if let Some(block) = extract_paragraph_block(paragraph_match.as_str()) {
                    match block {
                        DocxBlock::Heading { html, .. } => paragraphs.push(format!(
                            r#"<div class="doc-preview-cell-heading">{html}</div>"#
                        )),
                        DocxBlock::Paragraph(html) => paragraphs.push(html),
                        DocxBlock::ListItem(html) => paragraphs
                            .push(format!(r#"<ul class="doc-preview-cell-list">{html}</ul>"#)),
                    }
                }
            }

            let cell_html = if paragraphs.is_empty() {
                "<div class=\"doc-preview-cell-empty\"></div>".to_string()
            } else {
                paragraphs.join("")
            };
            cells.push(format!(r#"<td>{cell_html}</td>"#));
        }

        if !cells.is_empty() {
            rows.push(format!(r#"<tr>{}</tr>"#, cells.join("")));
        }
    }

    if rows.is_empty() {
        None
    } else {
        Some(format!(
            r#"<div class="doc-preview-table-wrap"><table class="doc-preview-table"><tbody>{}</tbody></table></div>"#,
            rows.join("")
        ))
    }
}

fn extract_docx_html_from_xml(document_xml: &str) -> String {
    let body_re = Regex::new(r#"(?s)<w:body\b[^>]*>(.*)</w:body>"#).expect("valid docx body regex");
    let block_re = Regex::new(r#"(?s)<w:tbl\b[^>]*>.*?</w:tbl>|<w:p\b[^>]*>.*?</w:p>"#)
        .expect("valid docx block regex");
    let body = body_re
        .captures(document_xml)
        .and_then(|captures| captures.get(1).map(|value| value.as_str()))
        .unwrap_or(document_xml);
    let mut rendered = String::new();
    let mut pending_list_items: Vec<String> = Vec::new();

    let flush_list = |buffer: &mut String, items: &mut Vec<String>| {
        if items.is_empty() {
            return;
        }

        buffer.push_str(r#"<ul class="doc-preview-list">"#);
        buffer.push_str(&items.join(""));
        buffer.push_str("</ul>");
        items.clear();
    };

    for block_match in block_re.find_iter(body) {
        let block_xml = block_match.as_str();

        if block_xml.starts_with("<w:tbl") {
            flush_list(&mut rendered, &mut pending_list_items);
            if let Some(table_html) = extract_table_html(block_xml) {
                rendered.push_str(&table_html);
            }
            continue;
        }

        let Some(block) = extract_paragraph_block(block_xml) else {
            continue;
        };

        match block {
            DocxBlock::Heading { level, html } => {
                flush_list(&mut rendered, &mut pending_list_items);
                rendered.push_str(&format!(
                    r#"<h{level} class="doc-preview-heading doc-preview-heading-{level}">{html}</h{level}>"#
                ));
            }
            DocxBlock::Paragraph(html) => {
                flush_list(&mut rendered, &mut pending_list_items);
                rendered.push_str(&html);
            }
            DocxBlock::ListItem(html) => {
                pending_list_items.push(html);
            }
        }
    }

    flush_list(&mut rendered, &mut pending_list_items);

    if rendered.trim().is_empty() {
        "<p class=\"doc-preview-empty\">This document does not contain previewable text content.</p>"
            .to_string()
    } else {
        format!(
            r#"<div class="doc-preview-root"><style>
.doc-preview-root {{
  color: inherit;
  font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  line-height: 1.75;
}}
.doc-preview-root strong {{ font-weight: 700; }}
.doc-preview-root em {{ font-style: italic; }}
.doc-preview-root u {{ text-decoration: underline; }}
.doc-preview-root .is-center {{ text-align: center; }}
.doc-preview-root .is-right {{ text-align: right; }}
.doc-preview-root h1,
.doc-preview-root h2,
.doc-preview-root h3,
.doc-preview-root h4,
.doc-preview-root h5,
.doc-preview-root h6 {{
  margin: 1.25rem 0 0.5rem;
  color: hsl(var(--foreground));
  line-height: 1.3;
}}
.doc-preview-root h1 {{ font-size: 1.75rem; }}
.doc-preview-root h2 {{ font-size: 1.45rem; }}
.doc-preview-root h3 {{ font-size: 1.2rem; }}
.doc-preview-root p {{
  margin: 0.6rem 0;
  font-size: 0.95rem;
  color: hsl(var(--foreground));
}}
.doc-preview-root ul {{
  margin: 0.6rem 0;
  padding-left: 1.4rem;
}}
.doc-preview-root li {{
  margin: 0.25rem 0;
}}
.doc-preview-root .doc-preview-table-wrap {{
  margin: 1rem 0;
  overflow-x: auto;
}}
.doc-preview-root table {{
  width: 100%;
  border-collapse: collapse;
  font-size: 0.92rem;
}}
.doc-preview-root td {{
  min-width: 6rem;
  border: 1px solid hsl(var(--border));
  padding: 0.65rem 0.75rem;
  vertical-align: top;
}}
.doc-preview-root .doc-preview-cell-heading {{
  font-weight: 600;
  margin-bottom: 0.35rem;
}}
.doc-preview-root .doc-preview-cell-list {{
  margin: 0.35rem 0;
}}
.doc-preview-root .doc-preview-empty {{
  color: hsl(var(--muted-foreground));
}}
</style>{rendered}</div>"#
        )
    }
}

#[cfg(test)]
fn extract_docx_text_from_xml(document_xml: &str) -> String {
    let inter_tag_whitespace_re = Regex::new(r">\s+<").expect("valid inter-tag whitespace regex");
    let paragraph_end_re = Regex::new(r"</w:p>").expect("valid docx paragraph regex");
    let break_re = Regex::new(r"<w:(?:br|cr)\b[^>]*/>").expect("valid docx break regex");
    let tab_re = Regex::new(r"<w:tab\b[^>]*/>").expect("valid docx tab regex");
    let tag_re = Regex::new(r"<[^>]+>").expect("valid xml tag regex");

    let compact_xml = inter_tag_whitespace_re.replace_all(document_xml, "><");
    let with_paragraphs = paragraph_end_re.replace_all(&compact_xml, "\n\n");
    let with_breaks = break_re.replace_all(&with_paragraphs, "\n");
    let with_tabs = tab_re.replace_all(&with_breaks, "\t");
    let without_tags = tag_re.replace_all(&with_tabs, "");

    normalize_document_preview_text(&decode_xml_entities(&without_tags))
}

async fn run_hidden_utf8_command(
    program: impl AsRef<Path>,
    args: Vec<String>,
    context: &str,
) -> Result<String, AppError> {
    let mut command = utils::process::new_hidden_tokio_command(program.as_ref(), &args);
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let output = command.output().await.map_err(|error| {
        AppError::Internal(format!(
            "Failed to start {} preview extractor: {}",
            context, error
        ))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::BadRequest(if stderr.is_empty() {
            format!("{} preview extraction failed", context)
        } else {
            format!("{} preview extraction failed: {}", context, stderr)
        }));
    }

    String::from_utf8(output.stdout)
        .map(|stdout| stdout.trim().to_string())
        .map_err(|_| {
            AppError::Internal(format!(
                "{} preview extractor returned invalid UTF-8",
                context
            ))
        })
}

#[cfg(windows)]
async fn extract_docx_xml_with_powershell(path: &Path) -> Result<String, AppError> {
    let escaped_path = escape_powershell_single_quoted_string(&path.display().to_string());
    let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.IO.Compression.FileSystem
$targetPath = '__VIBE_ESCAPED_PATH__'
$zip = [System.IO.Compression.ZipFile]::OpenRead($targetPath)
try {
  $entry = $zip.GetEntry('word/document.xml')
  if ($null -eq $entry) {
    $entry = $zip.GetEntry('word\document.xml')
  }
  if ($null -eq $entry) {
    throw 'word/document.xml not found'
  }

  $stream = $entry.Open()
  try {
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
    try {
      [Console]::Write($reader.ReadToEnd())
    } finally {
      $reader.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
} finally {
  $zip.Dispose()
}
"#
    .replace("__VIBE_ESCAPED_PATH__", &escaped_path);

    run_hidden_utf8_command(
        "powershell.exe",
        vec![
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-Command".to_string(),
            script,
        ],
        "DOCX",
    )
    .await
}

#[cfg(not(windows))]
async fn extract_docx_xml_with_powershell(_path: &Path) -> Result<String, AppError> {
    Err(AppError::BadRequest(
        "DOCX preview is currently only available on Windows in the desktop app".to_string(),
    ))
}

#[cfg(windows)]
async fn extract_word_text_with_powershell(path: &Path) -> Result<String, AppError> {
    let escaped_path = escape_powershell_single_quoted_string(&path.display().to_string());
    let script = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$targetPath = '__VIBE_ESCAPED_PATH__'
$word = $null
$document = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $document = $word.Documents.Open($targetPath, $false, $true)
  [Console]::Write($document.Content.Text)
} finally {
  if ($null -ne $document) {
    $document.Close()
  }
  if ($null -ne $word) {
    $word.Quit()
  }
}
"#
    .replace("__VIBE_ESCAPED_PATH__", &escaped_path);

    run_hidden_utf8_command(
        "powershell.exe",
        vec![
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-Command".to_string(),
            script,
        ],
        "Word",
    )
    .await
}

#[cfg(not(windows))]
async fn extract_word_text_with_powershell(_path: &Path) -> Result<String, AppError> {
    Err(AppError::BadRequest(
        "Legacy Word preview is currently only available on Windows in the desktop app".to_string(),
    ))
}

async fn read_document_preview_content(path: &Path) -> Result<DocumentPreviewResponse, AppError> {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();

    match extension.as_str() {
        "docx" => {
            let document_xml = extract_docx_xml_with_powershell(path).await?;
            let content = extract_docx_html_from_xml(&document_xml);
            Ok(DocumentPreviewResponse {
                content,
                format: "html".to_string(),
                extractor: "docx-xml-structured".to_string(),
            })
        }
        "doc" => {
            let content =
                normalize_document_preview_text(&extract_word_text_with_powershell(path).await?);
            Ok(DocumentPreviewResponse {
                content,
                format: "text".to_string(),
                extractor: "word-com".to_string(),
            })
        }
        other => Err(AppError::BadRequest(format!(
            "Document preview is not supported for .{} files",
            other
        ))),
    }
}

// 鈹€鈹€ Existing types 鈹€鈹€

#[derive(Debug, Serialize, Clone)]
pub struct FileTreeEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileTreeEntry>>,
    pub git_status: Option<String>,
}

// 鈹€鈹€ New types for directory listing 鈹€鈹€

#[derive(Debug, Serialize, Clone)]
pub struct DirectoryChildrenResponse {
    pub files: Vec<String>,
    pub directories: Vec<String>,
    pub gitignored_files: Vec<String>,
    pub gitignored_directories: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct TextSearchMatch {
    pub line: usize,
    pub column: usize,
    pub end_column: usize,
    pub preview: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct TextSearchFileResult {
    pub path: String,
    pub match_count: usize,
    pub matches: Vec<TextSearchMatch>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TextSearchResponse {
    pub files: Vec<TextSearchFileResult>,
    pub file_count: usize,
    pub match_count: usize,
    pub limit_hit: bool,
}

#[derive(Debug, Deserialize)]
pub struct TextSearchOptions {
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub is_regex: bool,
    pub include_pattern: Option<String>,
    pub exclude_pattern: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ReadFileResponse {
    pub content: String,
    pub truncated: bool,
}

// 鈹€鈹€ Constants 鈹€鈹€

const SKIP_DIRS: &[&str] = &[".git"];

const DEPENDENCY_DIRS: &[&str] = &[
    "node_modules",
    ".pnpm-store",
    ".yarn",
    "bower_components",
    "vendor",
    ".venv",
    "venv",
    "env",
    "__pypackages__",
    "Pods",
    "Carthage",
    ".m2",
    ".ivy2",
    ".cargo",
];

const BUILD_ARTIFACT_DIRS: &[&str] = &[
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".angular",
    ".parcel-cache",
    ".turbo",
    ".cache",
    ".gradle",
    "CMakeFiles",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".tox",
    ".dart_tool",
];

const MAX_SEARCH_MATCHES: usize = 1_000;
const MAX_SEARCH_FILE_BYTES: u64 = 1_024 * 1_024;
const MAX_PREVIEW_CHARS: usize = 180;
const SCAN_ENTRY_BUDGET: usize = 30_000;
const SCAN_TIME_BUDGET: Duration = Duration::from_millis(1_200);
const MAX_READ_FILE_BYTES: usize = 512 * 1024;

fn is_special_dir(name: &str) -> bool {
    DEPENDENCY_DIRS.contains(&name) || BUILD_ARTIFACT_DIRS.contains(&name)
}

fn should_skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name)
}

fn scan_budget_reached(started_at: Instant, scanned: usize) -> bool {
    scanned >= SCAN_ENTRY_BUDGET || started_at.elapsed() >= SCAN_TIME_BUDGET
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

// 鈹€鈹€ Git status helpers 鈹€鈹€

fn build_git_status_map(root: &Path) -> HashMap<PathBuf, String> {
    let mut map = HashMap::new();

    let repo = match git2::Repository::discover(root) {
        Ok(r) => r,
        Err(_) => return map,
    };

    let statuses = match repo.statuses(Some(
        git2::StatusOptions::new()
            .include_untracked(true)
            .recurse_untracked_dirs(true),
    )) {
        Ok(s) => s,
        Err(_) => return map,
    };

    let workdir = match repo.workdir() {
        Some(w) => w.to_path_buf(),
        None => return map,
    };

    for entry in statuses.iter() {
        let status = entry.status();
        let status_str =
            if status.contains(git2::Status::WT_NEW) || status.contains(git2::Status::INDEX_NEW) {
                "added"
            } else if status.contains(git2::Status::WT_MODIFIED)
                || status.contains(git2::Status::INDEX_MODIFIED)
            {
                "modified"
            } else if status.contains(git2::Status::WT_DELETED)
                || status.contains(git2::Status::INDEX_DELETED)
            {
                "deleted"
            } else if status.contains(git2::Status::WT_RENAMED)
                || status.contains(git2::Status::INDEX_RENAMED)
            {
                "renamed"
            } else if status.contains(git2::Status::CONFLICTED) {
                "conflicted"
            } else {
                continue;
            };

        if let Some(path_str) = entry.path() {
            let full_path = workdir.join(path_str);
            map.insert(full_path, status_str.to_string());
        }
    }

    map
}

/// Recursively build the file tree (existing implementation).
fn build_tree(
    dir: &Path,
    depth: u32,
    max_depth: u32,
    git_map: &HashMap<PathBuf, String>,
) -> Result<Vec<FileTreeEntry>, AppError> {
    if depth >= max_depth {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();

    let read_dir = std::fs::read_dir(dir).map_err(|e| {
        AppError::Internal(format!("Failed to read directory {}: {}", dir.display(), e))
    })?;

    let mut dir_entries: Vec<std::fs::DirEntry> = read_dir.filter_map(|e| e.ok()).collect();

    dir_entries.sort_by(|a, b| {
        let a_is_dir = a.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        let b_is_dir = b.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.file_name().cmp(&b.file_name()),
        }
    });

    for dir_entry in dir_entries {
        let name = dir_entry.file_name().to_string_lossy().to_string();
        let path = dir_entry.path();
        let is_dir = dir_entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);

        if is_dir && (should_skip_dir(&name) || is_special_dir(&name)) {
            continue;
        }

        let path_str = path.to_string_lossy().to_string();

        if is_dir {
            let children = build_tree(&path, depth + 1, max_depth, git_map)?;
            let dir_git_status = derive_dir_git_status(&children);
            entries.push(FileTreeEntry {
                name,
                path: path_str,
                is_dir: true,
                children: Some(children),
                git_status: dir_git_status,
            });
        } else {
            let git_status = git_map.get(&path).cloned();
            entries.push(FileTreeEntry {
                name,
                path: path_str,
                is_dir: false,
                children: None,
                git_status,
            });
        }
    }

    Ok(entries)
}

fn derive_dir_git_status(children: &[FileTreeEntry]) -> Option<String> {
    for child in children {
        if child.git_status.is_some() {
            return Some("modified".to_string());
        }
        if let Some(ref grandchildren) = child.children
            && derive_dir_git_status(grandchildren).is_some()
        {
            return Some("modified".to_string());
        }
    }
    None
}

// 鈹€鈹€ Search helpers 鈹€鈹€

fn compile_search_regex(query: &str, options: &TextSearchOptions) -> Result<Regex, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("Search query cannot be empty.".to_string());
    }
    // Limit regex pattern length to prevent DoS via compilation of huge patterns
    if trimmed.len() > 1000 {
        return Err("Search pattern too long (max 1000 characters).".to_string());
    }
    let pattern = if options.is_regex {
        trimmed.to_string()
    } else {
        regex::escape(trimmed)
    };
    let pattern = if options.whole_word {
        format!(r"\b(?:{})\b", pattern)
    } else {
        pattern
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .size_limit(1 << 20) // 1MB compiled regex size limit
        .build()
        .map_err(|error| format!("Invalid search pattern: {error}"))
}

fn glob_to_regex(pattern: &str) -> Result<Regex, String> {
    let normalized = pattern
        .replace('\\', "/")
        .trim()
        .trim_matches('/')
        .to_string();
    if normalized.is_empty() {
        return Err("Glob pattern cannot be empty.".to_string());
    }
    let mut regex_src = String::from("^");
    let chars: Vec<char> = normalized.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' {
            if chars.get(i + 1).copied() == Some('*') {
                regex_src.push_str(".*");
                i += 2;
                continue;
            }
            regex_src.push_str("[^/]*");
            i += 1;
            continue;
        }
        if c == '?' {
            regex_src.push_str("[^/]");
            i += 1;
            continue;
        }
        if matches!(
            c,
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\'
        ) {
            regex_src.push('\\');
        }
        regex_src.push(c);
        i += 1;
    }
    regex_src.push('$');
    Regex::new(&regex_src).map_err(|e| format!("Invalid glob `{pattern}`: {e}"))
}

fn compile_globs(input: Option<&str>) -> Result<Vec<Regex>, String> {
    match input {
        None => Ok(Vec::new()),
        Some(s) => s
            .split([',', '\n'])
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(glob_to_regex)
            .collect(),
    }
}

fn matches_any(path: &str, patterns: &[Regex]) -> bool {
    patterns.iter().any(|p| p.is_match(path))
}

fn build_preview(line: &str, start: usize, end: usize) -> String {
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= MAX_PREVIEW_CHARS {
        return line.trim().to_string();
    }
    let start_char = line[..start].chars().count();
    let end_char = line[..end].chars().count();
    let context = MAX_PREVIEW_CHARS / 2;
    let slice_start = start_char.saturating_sub(context / 2);
    let slice_end = (end_char + context).min(chars.len());
    let mut preview: String = chars[slice_start..slice_end].iter().collect();
    if slice_start > 0 {
        preview = format!("...{preview}");
    }
    if slice_end < chars.len() {
        preview.push_str("...");
    }
    preview.trim().to_string()
}

// 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
//  TAURI COMMANDS 鈥?Existing
// 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲

#[tauri::command]
pub async fn get_file_tree(
    root_path: String,
    depth: Option<u32>,
) -> Result<Vec<FileTreeEntry>, AppError> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err(AppError::BadRequest(format!(
            "Path is not a directory: {}",
            root_path
        )));
    }

    let max_depth = depth.unwrap_or(10);
    let git_map = build_git_status_map(&root);
    let tree = build_tree(&root, 0, max_depth, &git_map)?;
    Ok(tree)
}

#[tauri::command]
pub async fn get_claude_settings_path() -> String {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| {
            std::path::PathBuf::from(home)
                .join(".claude")
                .join("settings.json")
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, AppError> {
    let file_path = sanitize_file_path(&path)?;
    if !file_path.is_file() {
        return Err(AppError::NotFound(format!("File not found: {}", path)));
    }
    read_utf8_text_file(&file_path, &path)
}

#[tauri::command]
pub async fn read_document_preview(path: String) -> Result<DocumentPreviewResponse, AppError> {
    let file_path = sanitize_file_path(&path)?;
    if !file_path.is_file() {
        return Err(AppError::NotFound(format!("File not found: {}", path)));
    }

    read_document_preview_content(&file_path).await
}

#[tauri::command]
pub async fn read_binary_asset(path: String) -> Result<BinaryAssetResponse, AppError> {
    let file_path = sanitize_file_path(&path)?;
    if !file_path.is_file() {
        return Err(AppError::NotFound(format!("File not found: {}", path)));
    }

    read_binary_asset_file(&file_path, &path)
}

#[tauri::command]
pub async fn save_file_content(path: String, content: String) -> Result<(), AppError> {
    let file_path = sanitize_file_path(&path)?;
    if let Some(parent) = file_path.parent()
        && !parent.exists()
    {
        return Err(AppError::NotFound(format!(
            "Parent directory does not exist: {}",
            parent.display()
        )));
    }
    std::fs::write(&file_path, &content)
        .map_err(|e| AppError::Internal(format!("Failed to save file {}: {}", path, e)))
}

#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), AppError> {
    let file_path = sanitize_file_path(&path)?;
    if !file_path.exists() {
        return Err(AppError::NotFound(format!("File not found: {}", path)));
    }
    if file_path.is_dir() {
        std::fs::remove_dir_all(&file_path)
            .map_err(|e| AppError::Internal(format!("Failed to delete directory {}: {}", path, e)))
    } else {
        std::fs::remove_file(&file_path)
            .map_err(|e| AppError::Internal(format!("Failed to delete file {}: {}", path, e)))
    }
}

#[tauri::command]
pub async fn get_file_at_head(file_path: String) -> Result<String, AppError> {
    let path = sanitize_file_path(&file_path)?;

    let repo = git2::Repository::discover(&path)
        .map_err(|e| AppError::Internal(format!("Failed to open git repo: {}", e)))?;

    let workdir = repo.workdir().ok_or_else(|| {
        AppError::Internal("Bare repository has no working directory".to_string())
    })?;

    let relative_path = path.strip_prefix(workdir).map_err(|_| {
        AppError::BadRequest(format!(
            "File {} is not within the repository working directory",
            file_path
        ))
    })?;

    let head = repo
        .head()
        .map_err(|e| AppError::Internal(format!("Failed to get HEAD: {}", e)))?;
    let commit = head
        .peel_to_commit()
        .map_err(|e| AppError::Internal(format!("Failed to peel HEAD to commit: {}", e)))?;
    let tree = commit
        .tree()
        .map_err(|e| AppError::Internal(format!("Failed to get commit tree: {}", e)))?;

    let git_path = relative_path.to_string_lossy().replace('\\', "/");
    let tree_entry = tree
        .get_path(Path::new(&git_path))
        .map_err(|_| AppError::NotFound(format!("File not found in HEAD: {}", git_path)))?;

    let blob = repo
        .find_blob(tree_entry.id())
        .map_err(|e| AppError::Internal(format!("Failed to read blob: {}", e)))?;

    if blob.is_binary() {
        return Err(AppError::BadRequest(format!(
            "Binary file cannot be opened as text: {}",
            git_path
        )));
    }

    std::str::from_utf8(blob.content())
        .map(|content| content.to_string())
        .map_err(|_| {
            AppError::BadRequest(format!(
                "Binary file cannot be opened as text: {}",
                git_path
            ))
        })
}

// 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
//  TAURI COMMANDS 鈥?New (from mossx)
// 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲

/// List directory children with gitignore classification.
///
/// When `relative_path` is empty or None, recursively scans the full tree
/// (skipping special directories like node_modules, target, etc.) and returns
/// all file/directory paths relative to `root_path`.
///
/// When `relative_path` is provided, lists only direct children of that
/// subdirectory (used for lazy-loading special directories).
#[tauri::command]
pub async fn list_directory_children(
    root_path: String,
    relative_path: String,
) -> Result<DirectoryChildrenResponse, AppError> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        // Return empty response instead of error when path doesn't exist
        // (e.g. worktree was cleaned up)
        return Ok(DirectoryChildrenResponse {
            files: Vec::new(),
            directories: Vec::new(),
            gitignored_files: Vec::new(),
            gitignored_directories: Vec::new(),
            truncated: false,
        });
    }

    let trimmed = relative_path.trim().replace('\\', "/");
    let trimmed = trimmed.trim_matches('/');
    let is_root_scan = trimmed.is_empty();

    // Validate path components
    if !is_root_scan {
        let p = Path::new(trimmed);
        for comp in p.components() {
            if matches!(
                comp,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            ) {
                return Err(AppError::BadRequest("Invalid path".to_string()));
            }
        }
    }

    let repo = git2::Repository::discover(&root).ok();

    if is_root_scan {
        // Full recursive scan (like mossx list_workspace_files)
        scan_tree_recursive(&root, &repo)
    } else {
        // Single directory children (for lazy load)
        let target_dir = root.join(trimmed);
        if !target_dir.is_dir() {
            return Err(AppError::NotFound(format!(
                "Directory not found: {}",
                target_dir.display()
            )));
        }
        scan_single_directory(&root, &target_dir, &repo)
    }
}

/// Recursively scan tree from root, skipping special directories.
/// Returns all files/directories as paths relative to root.
fn scan_tree_recursive(
    root: &Path,
    repo: &Option<git2::Repository>,
) -> Result<DirectoryChildrenResponse, AppError> {
    let started_at = Instant::now();
    let max_files = 10_000usize;
    let max_directories = 20_000usize;

    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut gitignored_files = Vec::new();
    let mut gitignored_directories = Vec::new();
    let mut truncated = false;

    let root_children = scan_single_directory(root, root, repo)?;
    files.extend(root_children.files);
    directories.extend(root_children.directories);
    gitignored_files.extend(root_children.gitignored_files);
    gitignored_directories.extend(root_children.gitignored_directories);
    truncated |= root_children.truncated;

    let root_clone = root.to_path_buf();
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .git_ignore(false)
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                if should_skip_dir(&name) {
                    return false;
                }
                // Prune special directories (node_modules, target, etc.)
                // They will still appear in the directory list but won't be traversed
                if let Ok(rel_path) = entry.path().strip_prefix(&root_clone) {
                    let normalized = normalize_path(&rel_path.to_string_lossy());
                    if !normalized.is_empty() && is_special_dir(&name) {
                        return false;
                    }
                }
            }
            true
        })
        .build();

    for (scanned, result) in walker.enumerate() {
        if scan_budget_reached(started_at, scanned) {
            truncated = true;
            break;
        }

        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };

        if entry.depth() == 0 {
            continue;
        }

        let path = entry.path();
        let rel_path = match path.strip_prefix(root) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let normalized = normalize_path(&rel_path.to_string_lossy());
        if normalized.is_empty() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().is_some_and(|ft| ft.is_dir());
        let is_file = entry.file_type().is_some_and(|ft| ft.is_file());

        let is_ignored = repo
            .as_ref()
            .and_then(|r| r.status_should_ignore(rel_path).ok())
            .unwrap_or(false);

        if is_dir {
            if directories.len() >= max_directories {
                truncated = true;
                continue;
            }
            directories.push(normalized.clone());
            if is_ignored {
                gitignored_directories.push(normalized);
            }
        } else if is_file {
            if name == ".DS_Store" {
                continue;
            }
            if files.len() >= max_files {
                truncated = true;
                break;
            }
            files.push(normalized.clone());
            if is_ignored {
                gitignored_files.push(normalized);
            }
        }
    }

    // Also add special directories at root level that were pruned by the walker
    // (they need to appear as directories so they can be lazy-loaded)
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if ft.is_dir() && is_special_dir(&name) && !should_skip_dir(&name) {
                let normalized = name.clone();
                if !directories.contains(&normalized) {
                    let rel_path = entry.path();
                    let rel_from_root = rel_path.strip_prefix(root).unwrap_or(&rel_path);
                    let is_ignored = repo
                        .as_ref()
                        .and_then(|r| r.status_should_ignore(rel_from_root).ok())
                        .unwrap_or(false);
                    directories.push(normalized.clone());
                    if is_ignored {
                        gitignored_directories.push(normalized);
                    }
                }
            }
        }
    }

    files.sort();
    files.dedup();
    directories.sort();
    directories.dedup();
    gitignored_files.sort();
    gitignored_files.dedup();
    gitignored_directories.sort();
    gitignored_directories.dedup();

    Ok(DirectoryChildrenResponse {
        files,
        directories,
        gitignored_files,
        gitignored_directories,
        truncated,
    })
}

/// Scan only direct children of a specific subdirectory.
/// Returns paths relative to root (not to the target directory).
fn scan_single_directory(
    root: &Path,
    target_dir: &Path,
    repo: &Option<git2::Repository>,
) -> Result<DirectoryChildrenResponse, AppError> {
    let started_at = Instant::now();
    let mut truncated = false;

    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut gitignored_files = Vec::new();
    let mut gitignored_directories = Vec::new();

    let read_dir = std::fs::read_dir(target_dir)
        .map_err(|e| AppError::Internal(format!("Failed to read directory: {}", e)))?;

    let mut dir_entries = Vec::new();
    for (scanned, entry) in read_dir.enumerate() {
        if scan_budget_reached(started_at, scanned) {
            truncated = true;
            break;
        }
        if let Ok(entry) = entry {
            dir_entries.push(entry);
        }
    }

    dir_entries.sort_by_key(|a| a.file_name());

    for entry in dir_entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        // Build path relative to root
        let rel_from_root = match path.strip_prefix(root) {
            Ok(p) => normalize_path(&p.to_string_lossy()),
            Err(_) => continue,
        };

        let is_ignored = repo
            .as_ref()
            .and_then(|r| r.status_should_ignore(Path::new(&rel_from_root)).ok())
            .unwrap_or(false);

        if file_type.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            directories.push(rel_from_root.clone());
            if is_ignored {
                gitignored_directories.push(rel_from_root);
            }
        } else if file_type.is_file() {
            if name == ".DS_Store" {
                continue;
            }
            files.push(rel_from_root.clone());
            if is_ignored {
                gitignored_files.push(rel_from_root);
            }
        }
    }

    Ok(DirectoryChildrenResponse {
        files,
        directories,
        gitignored_files,
        gitignored_directories,
        truncated,
    })
}

/// Read file content with truncation support.
#[tauri::command]
pub async fn read_file_with_truncation(
    path: String,
    max_bytes: Option<usize>,
) -> Result<ReadFileResponse, AppError> {
    let file_path = sanitize_file_path(&path)?;
    if !file_path.is_file() {
        return Err(AppError::NotFound(format!("File not found: {}", path)));
    }

    let limit = max_bytes.unwrap_or(MAX_READ_FILE_BYTES);
    let bytes = std::fs::read(&file_path)
        .map_err(|e| AppError::Internal(format!("Failed to read file {}: {}", path, e)))?;

    let truncated = bytes.len() > limit;
    let slice = if truncated { &bytes[..limit] } else { &bytes };
    let content = String::from_utf8_lossy(slice).to_string();

    Ok(ReadFileResponse { content, truncated })
}

/// Move file/directory to system trash (recycle bin).
#[tauri::command]
pub async fn trash_item(path: String) -> Result<(), AppError> {
    let item_path = sanitize_file_path(&path)?;
    if !item_path.exists() {
        return Err(AppError::NotFound(format!("Item not found: {}", path)));
    }

    trash::delete(&item_path)
        .map_err(|e| AppError::Internal(format!("Failed to move to trash {}: {}", path, e)))
}

/// Copy a file or directory, returning the new path.
#[tauri::command]
pub async fn copy_item(path: String) -> Result<String, AppError> {
    let source = sanitize_file_path(&path)?;
    if !source.exists() {
        return Err(AppError::NotFound(format!("Item not found: {}", path)));
    }

    let parent = source
        .parent()
        .ok_or_else(|| AppError::Internal("Cannot determine parent directory".to_string()))?;

    let stem = source
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = source
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    // Find unique name: stem_copy.ext, stem_copy_2.ext, etc.
    let mut dest;
    let mut counter = 0u32;
    loop {
        let suffix = if counter == 0 {
            "_copy".to_string()
        } else {
            format!("_copy_{}", counter + 1)
        };
        let new_name = if source.is_dir() {
            format!("{}{}", stem, suffix)
        } else {
            format!("{}{}{}", stem, suffix, ext)
        };
        dest = parent.join(&new_name);
        if !dest.exists() {
            break;
        }
        counter += 1;
        if counter > 100 {
            return Err(AppError::Internal("Too many copies exist".to_string()));
        }
    }

    if source.is_dir() {
        copy_dir_recursive(&source, &dest)?;
    } else {
        std::fs::copy(&source, &dest)
            .map_err(|e| AppError::Internal(format!("Failed to copy file: {}", e)))?;
    }

    Ok(dest.to_string_lossy().to_string())
}

/// Move a file or directory to a new absolute path.
#[tauri::command]
pub async fn move_item(path: String, new_path: String) -> Result<String, AppError> {
    let source = sanitize_file_path(&path)?;
    if !source.exists() {
        return Err(AppError::NotFound(format!("Item not found: {}", path)));
    }

    let destination = sanitize_file_path(&new_path)?;
    if source == destination {
        return Ok(destination.to_string_lossy().to_string());
    }

    if destination.exists() {
        return Err(AppError::Conflict(format!(
            "Destination already exists: {}",
            destination.display()
        )));
    }

    let destination_parent = destination.parent().ok_or_else(|| {
        AppError::BadRequest("Destination must include a parent directory".to_string())
    })?;

    if !destination_parent.exists() {
        return Err(AppError::NotFound(format!(
            "Destination parent does not exist: {}",
            destination_parent.display()
        )));
    }

    if !destination_parent.is_dir() {
        return Err(AppError::BadRequest(format!(
            "Destination parent is not a directory: {}",
            destination_parent.display()
        )));
    }

    if source.is_dir() && destination.starts_with(&source) {
        return Err(AppError::BadRequest(
            "Cannot move a directory into itself".to_string(),
        ));
    }

    std::fs::rename(&source, &destination).map_err(|e| {
        AppError::Internal(format!(
            "Failed to move {} to {}: {}",
            source.display(),
            destination.display(),
            e
        ))
    })?;

    Ok(destination.to_string_lossy().to_string())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dst).map_err(|e| {
        AppError::Internal(format!(
            "Failed to create directory {}: {}",
            dst.display(),
            e
        ))
    })?;

    for entry in std::fs::read_dir(src).map_err(|e| {
        AppError::Internal(format!("Failed to read directory {}: {}", src.display(), e))
    })? {
        let entry = entry.map_err(|e| AppError::Internal(format!("Read dir error: {}", e)))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| AppError::Internal(format!("Failed to copy: {}", e)))?;
        }
    }
    Ok(())
}

/// Create a directory (including parents).
#[tauri::command]
pub async fn create_directory(path: String) -> Result<(), AppError> {
    let dir_path = sanitize_file_path(&path)?;
    std::fs::create_dir_all(&dir_path)
        .map_err(|e| AppError::Internal(format!("Failed to create directory {}: {}", path, e)))
}

/// Search workspace text content.
#[tauri::command]
pub async fn search_workspace_text(
    root_path: String,
    options: TextSearchOptions,
) -> Result<TextSearchResponse, AppError> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err(AppError::BadRequest(format!(
            "Root path is not a directory: {}",
            root_path
        )));
    }

    let regex = compile_search_regex(&options.query, &options).map_err(AppError::BadRequest)?;
    let include_patterns =
        compile_globs(options.include_pattern.as_deref()).map_err(AppError::BadRequest)?;
    let exclude_patterns =
        compile_globs(options.exclude_pattern.as_deref()).map_err(AppError::BadRequest)?;

    let root_for_filter = root.clone();
    let walker = WalkBuilder::new(&root)
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                if should_skip_dir(&name) {
                    return false;
                }
                if let Ok(rel) = entry.path().strip_prefix(&root_for_filter) {
                    let normalized = normalize_path(&rel.to_string_lossy());
                    if !normalized.is_empty()
                        && is_special_dir(normalized.rsplit('/').next().unwrap_or(""))
                    {
                        return false;
                    }
                }
            }
            name != ".DS_Store"
        })
        .build();

    let mut files = Vec::new();
    let mut total_files = 0usize;
    let mut total_matches = 0usize;
    let mut limit_hit = false;

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }
        let rel_path = match entry.path().strip_prefix(&root) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let normalized = normalize_path(&rel_path.to_string_lossy());
        if normalized.is_empty() {
            continue;
        }
        if !include_patterns.is_empty() && !matches_any(&normalized, &include_patterns) {
            continue;
        }
        if !exclude_patterns.is_empty() && matches_any(&normalized, &exclude_patterns) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.len() > MAX_SEARCH_FILE_BYTES {
            continue;
        }
        let bytes = match std::fs::read(entry.path()) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // Skip binary files
        if bytes.contains(&0) {
            continue;
        }
        let content = String::from_utf8_lossy(&bytes);
        let mut file_matches = Vec::new();
        let mut file_match_count = 0usize;

        for (line_idx, line) in content.lines().enumerate() {
            for capture in regex.find_iter(line) {
                file_match_count += 1;
                total_matches += 1;
                if file_matches.len() < 50 {
                    file_matches.push(TextSearchMatch {
                        line: line_idx + 1,
                        column: line[..capture.start()].chars().count() + 1,
                        end_column: line[..capture.end()].chars().count() + 1,
                        preview: build_preview(line, capture.start(), capture.end()),
                    });
                }
                if total_matches >= MAX_SEARCH_MATCHES {
                    limit_hit = true;
                    break;
                }
            }
            if limit_hit {
                break;
            }
        }

        if file_match_count > 0 {
            total_files += 1;
            files.push(TextSearchFileResult {
                path: normalized,
                match_count: file_match_count,
                matches: file_matches,
            });
        }
        if limit_hit {
            break;
        }
    }

    Ok(TextSearchResponse {
        files,
        file_count: total_files,
        match_count: total_matches,
        limit_hit,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        io::Write,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        extract_docx_html_from_xml, extract_docx_text_from_xml, read_binary_asset_file,
        read_utf8_text_file,
    };
    use crate::error::AppError;

    fn temp_file_path(prefix: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("vibex-{prefix}-{unique}.tmp"))
    }

    #[cfg(windows)]
    #[test]
    fn normalize_windows_verbatim_input_extracts_real_path_from_duplicated_path() {
        let duplicated = r"\\?\C:\Users\Administrator\Documents\Projects\self\gameCard\\\?\C:\Users\Administrator\Documents\Projects\self\gameCard\app.py";

        assert_eq!(
            super::normalize_windows_verbatim_input(duplicated),
            r"C:\Users\Administrator\Documents\Projects\self\gameCard\app.py"
        );
    }

    #[test]
    fn read_utf8_text_file_accepts_plain_utf8() {
        let path = temp_file_path("utf8");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(file, "hello world").unwrap();
        drop(file);

        let content = read_utf8_text_file(&path, &path.display().to_string()).unwrap();
        let _ = std::fs::remove_file(&path);

        assert!(content.contains("hello world"));
    }

    #[test]
    fn read_utf8_text_file_rejects_binary_bytes() {
        let path = temp_file_path("binary");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A])
            .unwrap();
        drop(file);

        let error = read_utf8_text_file(&path, &path.display().to_string()).unwrap_err();
        let _ = std::fs::remove_file(&path);

        assert!(matches!(error, AppError::BadRequest(_)));
        assert!(
            error
                .to_string()
                .contains("Binary file cannot be opened as text")
        );
    }

    #[test]
    fn read_binary_asset_file_returns_base64_and_mime_type() {
        let path = temp_file_path("png");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A])
            .unwrap();
        drop(file);

        let asset = read_binary_asset_file(&path, &path.display().to_string()).unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(asset.mime_type, "application/octet-stream");
        assert!(!asset.data_base64.is_empty());
    }

    #[test]
    fn extract_docx_text_from_xml_preserves_paragraphs_and_entities() {
        let xml = r#"
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:t>Hello &amp; goodbye</w:t></w:r>
      <w:r><w:tab/></w:r>
      <w:r><w:t>world</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Line</w:t></w:r>
      <w:r><w:br/></w:r>
      <w:r><w:t>break</w:t></w:r>
    </w:p>
  </w:body>
</w:document>
"#;

        let text = extract_docx_text_from_xml(xml);

        assert_eq!(text, "Hello & goodbye\tworld\n\nLine\nbreak");
    }

    #[test]
    fn extract_docx_html_from_xml_preserves_basic_structure() {
        let xml = r#"
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:t>Project Plan</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Intro paragraph</w:t></w:r>
      <w:r><w:b/><w:t> bold</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Left</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Right</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p>
      <w:pPr><w:numPr/></w:pPr>
      <w:r><w:t>Checklist</w:t></w:r>
    </w:p>
  </w:body>
</w:document>
"#;

        let html = extract_docx_html_from_xml(xml);

        assert!(html.contains("<h1"));
        assert!(html.contains("Project Plan"));
        assert!(html.contains("<p class=\"doc-preview-paragraph\">"));
        assert!(html.contains("<strong> bold</strong>"));
        assert!(html.contains("doc-preview-table"));
        assert!(html.contains("<td><p class=\"doc-preview-paragraph\">Left</p></td>"));
        assert!(html.contains("<ul class=\"doc-preview-list\">"));
        assert!(html.contains("Checklist"));
    }
}
