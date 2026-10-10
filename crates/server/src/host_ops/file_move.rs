use std::path::Path;

use application::ApplicationError;

use crate::domains::internal_error;

pub(super) async fn move_item_at_paths(source: &Path, dest: &Path) -> Result<(), ApplicationError> {
    if source == dest {
        return Ok(());
    }
    match tokio::fs::symlink_metadata(dest).await {
        Ok(metadata) => {
            let same_item = !metadata.file_type().is_symlink()
                && tokio::fs::canonicalize(dest)
                    .await
                    .map_err(internal_error)?
                    == tokio::fs::canonicalize(source)
                        .await
                        .map_err(internal_error)?;
            if !same_item {
                return Err(ApplicationError::conflict(format!(
                    "Destination already exists: {}",
                    dest.display()
                )));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(internal_error(error)),
    }
    let dest_parent = dest.parent().ok_or_else(|| {
        ApplicationError::bad_request("Destination must include a parent directory")
    })?;
    if !dest_parent.exists() {
        return Err(ApplicationError::not_found(format!(
            "Destination parent does not exist: {}",
            dest_parent.display()
        )));
    }
    if source.is_dir() && dest.starts_with(source) {
        return Err(ApplicationError::bad_request(
            "Cannot move a directory into itself",
        ));
    }
    tokio::fs::rename(source, dest)
        .await
        .map_err(internal_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn case_only_file_rename_keeps_content_and_updates_name() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("README.md");
        let dest = temp.path().join("readme.md");
        tokio::fs::write(&source, "# Saved content").await.unwrap();
        let source = tokio::fs::canonicalize(&source).await.unwrap();

        move_item_at_paths(&source, &dest).await.unwrap();

        assert_eq!(
            tokio::fs::read_to_string(&dest).await.unwrap(),
            "# Saved content"
        );
        let mut entries = tokio::fs::read_dir(temp.path()).await.unwrap();
        assert_eq!(
            entries.next_entry().await.unwrap().unwrap().file_name(),
            "readme.md"
        );
    }

    #[tokio::test]
    async fn case_only_directory_rename_keeps_children() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("Docs");
        let dest = temp.path().join("docs");
        tokio::fs::create_dir(&source).await.unwrap();
        tokio::fs::write(source.join("guide.md"), "# Guide")
            .await
            .unwrap();
        let source = tokio::fs::canonicalize(&source).await.unwrap();

        move_item_at_paths(&source, &dest).await.unwrap();

        assert_eq!(
            tokio::fs::read_to_string(dest.join("guide.md"))
                .await
                .unwrap(),
            "# Guide"
        );
        let mut entries = tokio::fs::read_dir(temp.path()).await.unwrap();
        assert_eq!(
            entries.next_entry().await.unwrap().unwrap().file_name(),
            "docs"
        );
    }

    #[tokio::test]
    async fn rename_rejects_another_existing_item_without_overwriting_it() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source.md");
        let dest = temp.path().join("existing.md");
        tokio::fs::write(&source, "source").await.unwrap();
        tokio::fs::write(&dest, "destination").await.unwrap();
        let source = tokio::fs::canonicalize(&source).await.unwrap();

        assert!(move_item_at_paths(&source, &dest).await.is_err());

        assert_eq!(tokio::fs::read_to_string(&source).await.unwrap(), "source");
        assert_eq!(
            tokio::fs::read_to_string(&dest).await.unwrap(),
            "destination"
        );
    }
}
