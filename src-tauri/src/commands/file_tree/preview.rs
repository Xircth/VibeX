#[cfg(any(windows, test))]
use std::process::Output;
#[cfg(windows)]
use std::process::Stdio;
use std::{io::Read, path::Path};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use regex::Regex;
use serde::Serialize;

use crate::error::AppError;

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

pub(super) fn read_binary_asset_file(
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

#[cfg(windows)]
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

#[cfg(windows)]
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
        return Err(AppError::BadRequest(preview_extraction_failure_message(
            context, &output,
        )));
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

#[cfg(any(windows, test))]
fn preview_extraction_failure_message(context: &str, output: &Output) -> String {
    utils::process::command_output_detail(output).map_or_else(
        || format!("{} preview extraction failed", context),
        |detail| format!("{} preview extraction failed: {}", context, detail),
    )
}

fn extract_docx_xml(path: &Path) -> Result<String, AppError> {
    let file = std::fs::File::open(path)
        .map_err(|error| AppError::Internal(format!("Failed to open DOCX file: {error}")))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| AppError::BadRequest(format!("Invalid DOCX file: {error}")))?;
    let mut document = archive.by_name("word/document.xml").map_err(|_| {
        AppError::BadRequest("DOCX file does not contain word/document.xml".to_string())
    })?;
    let mut xml = String::new();
    document.read_to_string(&mut xml).map_err(|error| {
        AppError::Internal(format!("Failed to read DOCX document XML: {error}"))
    })?;
    Ok(xml)
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

pub(super) async fn read_document_preview_content(
    path: &Path,
) -> Result<DocumentPreviewResponse, AppError> {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();

    match extension.as_str() {
        "docx" => {
            let document_xml = extract_docx_xml(path)?;
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

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    #[cfg(windows)]
    use std::os::windows::process::ExitStatusExt;
    use std::{
        io::Write,
        process::{ExitStatus, Output},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        extract_docx_html_from_xml, extract_docx_text_from_xml, preview_extraction_failure_message,
        read_binary_asset_file,
    };

    fn temp_file_path(prefix: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("vibex-preview-{prefix}-{unique}.tmp"))
    }

    #[cfg(unix)]
    fn failed_exit_status() -> ExitStatus {
        ExitStatus::from_raw(1 << 8)
    }

    #[cfg(windows)]
    fn failed_exit_status() -> ExitStatus {
        ExitStatus::from_raw(1)
    }

    fn command_output(stdout: &[u8], stderr: &[u8]) -> Output {
        Output {
            status: failed_exit_status(),
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
        }
    }

    #[test]
    fn preview_extraction_failure_message_prefers_stderr() {
        let output = command_output(b"stdout detail\n", b" stderr detail \n");

        assert_eq!(
            preview_extraction_failure_message("Word", &output),
            "Word preview extraction failed: stderr detail"
        );
    }

    #[test]
    fn preview_extraction_failure_message_uses_stdout_when_stderr_is_empty() {
        let output = command_output(b" stdout detail \n", b" \n");

        assert_eq!(
            preview_extraction_failure_message("Word", &output),
            "Word preview extraction failed: stdout detail"
        );
    }

    #[test]
    fn preview_extraction_failure_message_keeps_generic_fallback_without_output() {
        let output = command_output(b" \n", b"\t\n");

        assert_eq!(
            preview_extraction_failure_message("Word", &output),
            "Word preview extraction failed"
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
