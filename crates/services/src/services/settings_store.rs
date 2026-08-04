use std::{io::Write, path::Path, sync::LazyLock};

use serde::{Serialize, de::DeserializeOwned};
use thiserror::Error;

static SETTINGS_WRITE_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

#[derive(Debug, Error)]
pub enum SettingsStoreError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("Settings document must be a JSON object")]
    InvalidDocument,
}

pub async fn read_section<T>(path: &Path, section: &str) -> Result<Option<T>, SettingsStoreError>
where
    T: DeserializeOwned,
{
    let document = read_document(path).await?;
    document
        .get(section)
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(SettingsStoreError::from)
}

pub async fn write_section<T>(
    path: &Path,
    section: &str,
    value: &T,
) -> Result<(), SettingsStoreError>
where
    T: Serialize,
{
    let _guard = SETTINGS_WRITE_LOCK.lock().await;
    let mut document = read_document(path).await?;
    let object = document
        .as_object_mut()
        .ok_or(SettingsStoreError::InvalidDocument)?;
    object.insert(section.to_string(), serde_json::to_value(value)?);

    persist_document(path.to_path_buf(), document).await
}

pub async fn merge_object_section(
    path: &Path,
    section: &str,
    updates: serde_json::Map<String, serde_json::Value>,
) -> Result<serde_json::Map<String, serde_json::Value>, SettingsStoreError> {
    let _guard = SETTINGS_WRITE_LOCK.lock().await;
    let mut document = read_document(path).await?;
    let document_object = document
        .as_object_mut()
        .ok_or(SettingsStoreError::InvalidDocument)?;
    let section_value = document_object
        .entry(section.to_string())
        .or_insert_with(|| serde_json::json!({}));
    let section_object = section_value
        .as_object_mut()
        .ok_or(SettingsStoreError::InvalidDocument)?;
    section_object.extend(updates);
    let merged = section_object.clone();

    persist_document(path.to_path_buf(), document).await?;
    Ok(merged)
}

async fn persist_document(
    path: std::path::PathBuf,
    document: serde_json::Value,
) -> Result<(), SettingsStoreError> {
    tokio::task::spawn_blocking(move || -> Result<(), SettingsStoreError> {
        let parent = path.parent().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "settings path has no parent directory",
            )
        })?;
        std::fs::create_dir_all(parent)?;

        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer_pretty(&mut temporary, &document)?;
        temporary.write_all(b"\n")?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(&path)
            .map_err(|error| SettingsStoreError::Io(error.error))?;
        Ok(())
    })
    .await
    .map_err(|error| {
        SettingsStoreError::Io(std::io::Error::other(format!(
            "settings writer task failed: {error}"
        )))
    })?
}

async fn read_document(path: &Path) -> Result<serde_json::Value, SettingsStoreError> {
    let raw = match tokio::fs::read_to_string(path).await {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::json!({}));
        }
        Err(error) => return Err(SettingsStoreError::Io(error)),
    };
    let document: serde_json::Value = serde_json::from_str(&raw)?;
    if !document.is_object() {
        return Err(SettingsStoreError::InvalidDocument);
    }
    Ok(document)
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};

    use super::{merge_object_section, read_section, write_section};

    #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct ExampleSettings {
        enabled: bool,
    }

    #[tokio::test]
    async fn updating_one_section_preserves_other_json_settings() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("settings.json");
        tokio::fs::write(
            &path,
            r#"{
  "application": { "theme": "system" },
  "worktrees": { "project-a": { "cleanup_prompt_enabled": true } }
}"#,
        )
        .await
        .expect("seed settings");

        write_section(&path, "example", &ExampleSettings { enabled: true })
            .await
            .expect("write section");

        let document: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&path)
                .await
                .expect("read settings"),
        )
        .expect("valid JSON");
        assert_eq!(document["application"]["theme"], "system");
        assert_eq!(
            document["worktrees"]["project-a"]["cleanup_prompt_enabled"],
            true
        );
        assert_eq!(document["example"]["enabled"], true);
    }

    #[tokio::test]
    async fn each_read_observes_external_file_edits() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("settings.json");
        write_section(&path, "example", &ExampleSettings { enabled: false })
            .await
            .expect("initial write");

        tokio::fs::write(&path, r#"{"example":{"enabled":true}}"#)
            .await
            .expect("external edit");

        assert_eq!(
            read_section::<ExampleSettings>(&path, "example")
                .await
                .expect("read section"),
            Some(ExampleSettings { enabled: true })
        );
    }

    #[tokio::test]
    async fn concurrent_object_updates_do_not_overwrite_sibling_keys() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("settings.json");
        let first = merge_object_section(
            &path,
            "frontend",
            serde_json::Map::from_iter([("zoom".to_string(), serde_json::json!(1.25))]),
        );
        let second = merge_object_section(
            &path,
            "frontend",
            serde_json::Map::from_iter([("font".to_string(), serde_json::json!("menlo"))]),
        );

        let (first_result, second_result) = tokio::join!(first, second);
        first_result.expect("first merge");
        second_result.expect("second merge");

        let frontend: serde_json::Value = read_section(&path, "frontend")
            .await
            .expect("read frontend")
            .expect("frontend section");
        assert_eq!(frontend["zoom"], 1.25);
        assert_eq!(frontend["font"], "menlo");
    }
}
