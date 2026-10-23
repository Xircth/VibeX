use std::{
    fs,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use crate::{
    error::PluginError,
    package::{PluginPackage, checked_package_path},
};

impl PluginPackage {
    pub fn freeze_execution_root(
        &mut self,
        storage_root: &Path,
        expected_digest: &str,
    ) -> Result<(), PluginError> {
        if expected_digest.len() != 64
            || !expected_digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(PluginError::invalid_manifest(
                "candidate digest must be lowercase SHA-256 hex",
            ));
        }
        validate_storage_segment(self.id.as_str())?;
        let publisher = self.publisher.as_deref().unwrap_or("local");
        validate_storage_segment(publisher)?;
        fs::create_dir_all(storage_root)
            .map_err(|error| PluginError::io("create candidate storage", error))?;
        let storage_root = storage_root
            .canonicalize()
            .map_err(|error| PluginError::io("resolve candidate storage", error))?;
        let parent = storage_root.join(publisher).join(self.id.as_str());
        fs::create_dir_all(&parent)
            .map_err(|error| PluginError::io("create candidate identity storage", error))?;
        let target = parent.join(expected_digest);
        if !target.exists() {
            let staging = parent.join(format!(".{expected_digest}.incoming"));
            if staging.exists() {
                remove_snapshot_path(&staging)?;
            }
            copy_digest_files(&self.source.path, &staging)?;
            if self.source.path.join("config.json").is_file() {
                let config_source = checked_package_path(&self.source.path, "config.json")?;
                fs::copy(config_source, staging.join("config.json"))
                    .map_err(|error| PluginError::io("copy Plugin config into candidate", error))?;
            }
            Self::inspect(&staging, self.source.kind)?;
            let staged_digest = package_content_digest(&staging)?;
            if staged_digest != expected_digest {
                remove_snapshot_path(&staging)?;
                return Err(PluginError::invalid_manifest(
                    "linked source changed while the candidate was being frozen",
                ));
            }
            fs::rename(&staging, &target)
                .map_err(|error| PluginError::io("publish frozen candidate", error))?;
        }
        if package_content_digest(&target)? != expected_digest {
            return Err(PluginError::invalid_manifest(
                "frozen candidate digest does not match its content address",
            ));
        }
        self.execution_root = Some(
            target
                .canonicalize()
                .map_err(|error| PluginError::io("resolve frozen candidate", error))?,
        );
        Ok(())
    }
}

pub fn package_content_digest(root: &Path) -> Result<String, PluginError> {
    let root = root
        .canonicalize()
        .map_err(|error| PluginError::io("canonicalize Plugin package", error))?;
    let mut files = Vec::new();
    collect_digest_files(&root, &root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut rows = Vec::with_capacity(files.len());
    for (relative, absolute) in files {
        let contents = fs::read(&absolute)
            .map_err(|error| PluginError::io("read Plugin package file", error))?;
        rows.push(format!(
            "{}\0{}\0{:x}",
            relative,
            contents.len(),
            Sha256::digest(&contents)
        ));
    }
    Ok(format!("{:x}", Sha256::digest(rows.join("\n").as_bytes())))
}

fn collect_digest_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(String, PathBuf)>,
) -> Result<(), PluginError> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| PluginError::io("read Plugin package directory", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| PluginError::io("read Plugin package entry", error))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let file_type = entry
            .file_type()
            .map_err(|error| PluginError::io("inspect Plugin package entry", error))?;
        if file_type.is_symlink() {
            return Err(PluginError::invalid_manifest(format!(
                "package symlink is not allowed: {}",
                entry.path().display()
            )));
        }
        let name = entry.file_name();
        if file_type.is_dir() && matches!(name.to_str(), Some(".git" | "node_modules")) {
            continue;
        }
        if file_type.is_dir() {
            collect_digest_files(root, &entry.path(), files)?;
            continue;
        }
        if !file_type.is_file() {
            return Err(PluginError::invalid_manifest(format!(
                "unsupported package entry: {}",
                entry.path().display()
            )));
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|error| PluginError::invalid_manifest(error.to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        if relative.ends_with(".vxp")
            || matches!(
                relative.as_str(),
                "config.json"
                    | ".vibex-plugin/package.lock.json"
                    | ".vibex-plugin/developer-link.json"
            )
        {
            continue;
        }
        files.push((relative, entry.path()));
    }
    Ok(())
}

fn copy_digest_files(source: &Path, target: &Path) -> Result<(), PluginError> {
    let mut files = Vec::new();
    collect_digest_files(source, source, &mut files)?;
    fs::create_dir_all(target)
        .map_err(|error| PluginError::io("create frozen candidate", error))?;
    for (relative, absolute) in files {
        let destination = target.join(&relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| PluginError::io("create candidate directory", error))?;
        }
        fs::copy(&absolute, &destination)
            .map_err(|error| PluginError::io("copy candidate file", error))?;
    }
    Ok(())
}

pub(crate) fn validate_storage_segment(id: &str) -> Result<(), PluginError> {
    if id.is_empty()
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err(PluginError::invalid_manifest(format!(
            "plugin id `{id}` cannot be used as a snapshot directory"
        )));
    }
    Ok(())
}

pub(crate) fn copy_snapshot_directory(source: &Path, target: &Path) -> Result<(), PluginError> {
    fs::create_dir_all(target)
        .map_err(|error| PluginError::io("create plugin snapshot target", error))?;
    let entries = fs::read_dir(source)
        .map_err(|error| PluginError::io("read plugin snapshot source", error))?;
    for entry in entries {
        let entry = entry.map_err(|error| PluginError::io("read plugin snapshot entry", error))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| PluginError::io("inspect plugin snapshot entry", error))?;
        if file_type.is_dir() {
            copy_snapshot_directory(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path)
                .map_err(|error| PluginError::io("copy plugin snapshot file", error))?;
        } else {
            return Err(PluginError::invalid_manifest(format!(
                "snapshot import refuses non-file entry `{}`",
                source_path.display()
            )));
        }
    }
    Ok(())
}

pub(crate) fn remove_snapshot_path(path: &Path) -> Result<(), PluginError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| PluginError::io("inspect plugin snapshot target", error))?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path).map_err(|error| PluginError::io("remove plugin snapshot file", error))
    } else {
        fs::remove_dir_all(path)
            .map_err(|error| PluginError::io("remove plugin snapshot directory", error))
    }
}
