use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{self, Read},
    path::{Path, PathBuf},
};

use crate::PluginError;

const MAX_PLUGIN_ARCHIVE_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_ENTRY_BYTES: u64 = 100 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_EXTRACTED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_ENTRIES: usize = 5_000;
const MAX_PLUGIN_ARCHIVE_PATH_DEPTH: usize = 20;

pub(crate) struct OpenedPluginSource {
    _staging: Option<tempfile::TempDir>,
    root: PathBuf,
}

impl OpenedPluginSource {
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
}

pub(crate) fn open_plugin_source(path: &Path) -> Result<OpenedPluginSource, PluginError> {
    let metadata = fs::metadata(path).map_err(|error| {
        PluginError::io(
            &format!("resolve plugin source `{}`", path.display()),
            error,
        )
    })?;
    if metadata.is_file() {
        return extract_plugin_archive(path);
    }
    if metadata.is_dir() {
        return Ok(OpenedPluginSource {
            _staging: None,
            root: path.to_path_buf(),
        });
    }
    Err(PluginError::invalid_manifest(format!(
        "plugin source `{}` must be a directory or archive",
        path.display()
    )))
}

fn extract_plugin_archive(path: &Path) -> Result<OpenedPluginSource, PluginError> {
    if is_gzip_archive(path) {
        return extract_plugin_tar_gz(path);
    }
    extract_plugin_zip(path)
}

fn is_gzip_archive(path: &Path) -> bool {
    let mut magic = [0u8; 2];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut magic))
        .is_ok()
        && magic == [0x1f, 0x8b]
}

fn extract_plugin_tar_gz(path: &Path) -> Result<OpenedPluginSource, PluginError> {
    let metadata =
        fs::metadata(path).map_err(|error| PluginError::io("read plugin archive", error))?;
    if metadata.len() > MAX_PLUGIN_ARCHIVE_BYTES {
        return Err(PluginError::invalid_manifest(
            "plugin archive must be 100 MB or smaller",
        ));
    }
    let file = File::open(path).map_err(|error| PluginError::io("open plugin archive", error))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut archive = tar::Archive::new(decoder);
    let staging =
        tempfile::tempdir().map_err(|error| PluginError::io("stage plugin archive", error))?;
    let mut extracted_bytes = 0_u64;
    let mut entries = 0_usize;
    for entry in archive
        .entries()
        .map_err(|error| PluginError::invalid_manifest(format!("invalid plugin tar.gz: {error}")))?
    {
        let mut entry = entry.map_err(|error| {
            PluginError::invalid_manifest(format!("unreadable tar.gz entry: {error}"))
        })?;
        entries += 1;
        if entries > MAX_PLUGIN_ARCHIVE_ENTRIES {
            return Err(PluginError::invalid_manifest(
                "plugin archive contains more than 5,000 entries",
            ));
        }
        let size = entry.header().size().unwrap_or(0);
        if size > MAX_PLUGIN_ARCHIVE_ENTRY_BYTES {
            return Err(PluginError::invalid_manifest(
                "archive entry exceeds 100 MiB",
            ));
        }
        extracted_bytes = extracted_bytes.saturating_add(size);
        if extracted_bytes > MAX_PLUGIN_ARCHIVE_EXTRACTED_BYTES {
            return Err(PluginError::invalid_manifest(
                "plugin archive expands beyond 512 MiB",
            ));
        }
        if !entry.unpack_in(staging.path()).map_err(|error| {
            PluginError::invalid_manifest(format!("cannot extract tar.gz entry: {error}"))
        })? {
            return Err(PluginError::invalid_manifest("unsafe tar.gz entry path"));
        }
    }
    if entries == 0 {
        return Err(PluginError::invalid_manifest("plugin archive is empty"));
    }
    let root = resolve_extracted_plugin_root(staging.path())?;
    Ok(OpenedPluginSource {
        _staging: Some(staging),
        root,
    })
}

fn extract_plugin_zip(path: &Path) -> Result<OpenedPluginSource, PluginError> {
    let metadata =
        fs::metadata(path).map_err(|error| PluginError::io("read plugin archive", error))?;
    if metadata.len() > MAX_PLUGIN_ARCHIVE_BYTES {
        return Err(PluginError::invalid_manifest(
            "plugin archive must be 100 MB or smaller",
        ));
    }
    let file = File::open(path).map_err(|error| PluginError::io("open plugin archive", error))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| {
        PluginError::invalid_manifest(format!("invalid plugin archive: {error}"))
    })?;
    if archive.is_empty() {
        return Err(PluginError::invalid_manifest("plugin archive is empty"));
    }
    if archive.len() > MAX_PLUGIN_ARCHIVE_ENTRIES {
        return Err(PluginError::invalid_manifest(
            "plugin archive contains more than 5,000 entries",
        ));
    }

    let staging =
        tempfile::tempdir().map_err(|error| PluginError::io("stage plugin archive", error))?;
    let mut extracted_bytes = 0_u64;
    let mut normalized_paths = BTreeSet::new();

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| {
            PluginError::invalid_manifest(format!("unreadable archive entry: {error}"))
        })?;
        let raw_name = entry.name().to_owned();
        let path_name = raw_name.strip_suffix('/').unwrap_or(&raw_name);
        if raw_name.is_empty()
            || path_name.trim() != path_name
            || raw_name.contains('\\')
            || path_name
                .split('/')
                .any(|segment| segment.is_empty() || segment == "..")
        {
            return Err(PluginError::invalid_manifest(format!(
                "unsafe archive entry path `{raw_name}`"
            )));
        }
        let relative = entry.enclosed_name().ok_or_else(|| {
            PluginError::invalid_manifest(format!("unsafe archive entry path `{raw_name}`"))
        })?;
        if relative.components().count() > MAX_PLUGIN_ARCHIVE_PATH_DEPTH {
            return Err(PluginError::invalid_manifest(format!(
                "archive entry path is too deep `{raw_name}`"
            )));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(PluginError::invalid_manifest(format!(
                "archive symlinks are not supported `{raw_name}`"
            )));
        }
        let normalized = raw_name.to_lowercase();
        if !normalized_paths.insert(normalized) {
            return Err(PluginError::invalid_manifest(format!(
                "duplicate archive entry path `{raw_name}`"
            )));
        }

        let output = staging.path().join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|error| PluginError::io("create archive directory", error))?;
            continue;
        }
        if !entry.is_file() {
            return Err(PluginError::invalid_manifest(format!(
                "unsupported archive entry type `{raw_name}`"
            )));
        }
        if entry.size() > MAX_PLUGIN_ARCHIVE_ENTRY_BYTES {
            return Err(PluginError::invalid_manifest(format!(
                "archive entry exceeds 100 MiB `{raw_name}`"
            )));
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| PluginError::io("create archive parent directory", error))?;
        }
        let mut destination = File::create(&output)
            .map_err(|error| PluginError::io("extract archive entry", error))?;
        let remaining_archive_bytes = MAX_PLUGIN_ARCHIVE_EXTRACTED_BYTES
            .checked_sub(extracted_bytes)
            .ok_or_else(|| {
                PluginError::invalid_manifest("plugin archive expands beyond 512 MiB")
            })?;
        let entry_limit = MAX_PLUGIN_ARCHIVE_ENTRY_BYTES.min(remaining_archive_bytes);
        let copied = io::copy(&mut entry.by_ref().take(entry_limit + 1), &mut destination)
            .map_err(|error| {
                PluginError::invalid_manifest(format!("cannot read archive entry: {error}"))
            })?;
        if copied > remaining_archive_bytes {
            return Err(PluginError::invalid_manifest(
                "plugin archive expands beyond 512 MiB",
            ));
        }
        if copied > entry_limit {
            return Err(PluginError::invalid_manifest(format!(
                "archive entry exceeds 100 MiB `{raw_name}`"
            )));
        }
        extracted_bytes = extracted_bytes.checked_add(copied).ok_or_else(|| {
            PluginError::invalid_manifest("plugin archive extracted size overflow")
        })?;
    }

    let root = resolve_extracted_plugin_root(staging.path())?;
    Ok(OpenedPluginSource {
        _staging: Some(staging),
        root,
    })
}

fn resolve_extracted_plugin_root(staging: &Path) -> Result<PathBuf, PluginError> {
    if has_supported_plugin_manifest(staging) {
        return Ok(staging.to_path_buf());
    }
    let entries = fs::read_dir(staging)
        .map_err(|error| PluginError::io("inspect plugin archive", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| PluginError::io("inspect plugin archive", error))?;
    if entries.len() != 1 || !entries[0].path().is_dir() {
        return Err(PluginError::invalid_manifest(
            "plugin archive must contain exactly one plugin root",
        ));
    }
    let root = entries[0].path();
    if !has_supported_plugin_manifest(&root) {
        return Err(PluginError::invalid_manifest(
            "plugin archive does not contain a supported plugin manifest",
        ));
    }
    Ok(root)
}

fn has_supported_plugin_manifest(root: &Path) -> bool {
    root.join(".vibex-plugin/plugin.json").is_file()
        || root.join(".codex-plugin/plugin.json").is_file()
        || root.join(".claude-plugin/plugin.json").is_file()
}
