use std::path::PathBuf;

use application::ApplicationError;
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use db::models::{
    image::{Image, TaskImage},
    task::Task,
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::unwrap_named;
use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

const PASTED_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];
const MAX_PASTED_IMAGE_BYTES: usize = 15 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadImageRequest {
    file_name: String,
    data_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadArgs {
    payload: UploadImageRequest,
    task_id: Option<Uuid>,
    workspace_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImageIdArgs {
    image_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskIdArgs {
    task_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskPathArgs {
    task_id: Uuid,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspacePathArgs {
    workspace_id: Uuid,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PastedArgs {
    directory: String,
    base64_content: String,
    extension: String,
}

#[derive(Serialize)]
struct ImageMetadataResponse {
    exists: bool,
    file_name: Option<String>,
    path: Option<String>,
    size_bytes: Option<i64>,
    format: Option<String>,
    proxy_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WritePastedImageAssetResponse {
    absolute_path: String,
    file_name: String,
    markdown_path: String,
}

fn decode_image(payload: &UploadImageRequest) -> Result<Vec<u8>, ApplicationError> {
    BASE64
        .decode(payload.data_base64.as_bytes())
        .map_err(|error| ApplicationError::bad_request(format!("Invalid image payload: {error}")))
}

fn metadata_for(
    image_service: &services::services::image::ImageService,
    image: Option<Image>,
) -> ImageMetadataResponse {
    if let Some(image) = image {
        let absolute_path = image_service.get_absolute_path(&image);
        ImageMetadataResponse {
            exists: absolute_path.exists(),
            file_name: Some(image.original_name),
            path: Some(absolute_path.to_string_lossy().to_string()),
            size_bytes: Some(image.size_bytes),
            format: image
                .mime_type
                .as_deref()
                .and_then(|mime| mime.split('/').nth(1))
                .map(ToOwned::to_owned),
            proxy_url: Some(absolute_path.to_string_lossy().to_string()),
        }
    } else {
        ImageMetadataResponse {
            exists: false,
            file_name: None,
            path: None,
            size_bytes: None,
            format: None,
            proxy_url: None,
        }
    }
}

pub(super) async fn upload(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let payload: UploadImageRequest = unwrap_named(args, &["payload"])?;
    let bytes = decode_image(&payload)?;
    serialize(
        domains
            .deployment
            .image()
            .store_image(&bytes, &payload.file_name)
            .await
            .map_err(internal_error)?,
    )
}

pub(super) async fn upload_for_task(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: UploadArgs = parse(args)?;
    let task_id = args
        .task_id
        .ok_or_else(|| ApplicationError::bad_request("taskId required"))?;
    let task = Task::find_by_id(&domains.pool, task_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApplicationError::not_found(format!("Task {task_id} not found")))?;
    let bytes = decode_image(&args.payload)?;
    let image = domains
        .deployment
        .image()
        .store_image(&bytes, &args.payload.file_name)
        .await
        .map_err(internal_error)?;
    TaskImage::associate_many_dedup(&domains.pool, task.id, &[image.id])
        .await
        .map_err(internal_error)?;
    serialize(image)
}

pub(super) async fn upload_for_workspace(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: UploadArgs = parse(args)?;
    let workspace_id = args
        .workspace_id
        .ok_or_else(|| ApplicationError::bad_request("workspaceId required"))?;
    let workspace = Workspace::find_by_id(&domains.pool, workspace_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| {
            ApplicationError::not_found(format!("Workspace {workspace_id} not found"))
        })?;
    let bytes = decode_image(&args.payload)?;
    let image = domains
        .deployment
        .image()
        .store_image(&bytes, &args.payload.file_name)
        .await
        .map_err(internal_error)?;
    TaskImage::associate_many_dedup(&domains.pool, workspace.task_id, &[image.id])
        .await
        .map_err(internal_error)?;
    if let Some(container_ref) = &workspace.container_ref {
        let workspace_path = PathBuf::from(container_ref);
        if workspace_path.exists() {
            domains
                .deployment
                .image()
                .copy_images_by_task_to_worktree(&workspace_path, workspace.task_id, None)
                .await
                .map_err(internal_error)?;
        }
    }
    serialize(image)
}

pub(super) async fn delete(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: ImageIdArgs = parse(args)?;
    domains
        .deployment
        .image()
        .delete_image(args.image_id)
        .await
        .map_err(internal_error)?;
    Ok(Value::Null)
}

pub(super) async fn task_images(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: TaskIdArgs = parse(args)?;
    let _task = Task::find_by_id(&domains.pool, args.task_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApplicationError::not_found(format!("Task {} not found", args.task_id)))?;
    serialize(
        Image::find_by_task_id(&domains.pool, args.task_id)
            .await
            .map_err(internal_error)?,
    )
}

pub(super) async fn task_metadata(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: TaskPathArgs = parse(args)?;
    let _task = Task::find_by_id(&domains.pool, args.task_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApplicationError::not_found(format!("Task {} not found", args.task_id)))?;
    let file_name = args
        .path
        .strip_prefix(".vibe-images/")
        .unwrap_or(args.path.as_str())
        .to_string();
    let image = Image::find_by_file_path(&domains.pool, &file_name)
        .await
        .map_err(internal_error)?;
    serialize(metadata_for(domains.deployment.image(), image))
}

pub(super) async fn workspace_metadata(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: WorkspacePathArgs = parse(args)?;
    let workspace = Workspace::find_by_id(&domains.pool, args.workspace_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| {
            ApplicationError::not_found(format!("Workspace {} not found", args.workspace_id))
        })?;
    let file_name = args
        .path
        .strip_prefix(".vibe-images/")
        .unwrap_or(args.path.as_str())
        .to_string();
    let image = Image::find_by_file_path(&domains.pool, &file_name)
        .await
        .map_err(internal_error)?;
    let metadata = metadata_for(domains.deployment.image(), image);
    if !metadata.exists {
        return serialize(metadata);
    }
    if let Some(container_ref) = &workspace.container_ref {
        let candidate = PathBuf::from(container_ref)
            .join(".vibe-images")
            .join(&file_name);
        if !candidate.exists() {
            let _ = WorkspaceRepo::find_repos_for_workspace(&domains.pool, workspace.id).await;
            domains
                .deployment
                .image()
                .copy_images_by_task_to_worktree(
                    &PathBuf::from(container_ref),
                    workspace.task_id,
                    None,
                )
                .await
                .map_err(internal_error)?;
        }
    }
    serialize(metadata)
}

pub(super) async fn write_pasted(args: Value) -> Result<Value, ApplicationError> {
    let args: PastedArgs = parse(args)?;
    let ext = args.extension.trim().to_ascii_lowercase();
    if !PASTED_IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(ApplicationError::bad_request(format!(
            "Unsupported image extension: {}",
            args.extension
        )));
    }
    let payload = args
        .base64_content
        .trim()
        .rsplit_once(',')
        .map_or(args.base64_content.trim(), |(_, body)| body.trim());
    if payload.is_empty() {
        return Err(ApplicationError::bad_request(
            "Pasted image content is empty",
        ));
    }
    let bytes = BASE64
        .decode(payload)
        .map_err(|_| ApplicationError::bad_request("Invalid base64 image payload"))?;
    if bytes.is_empty() {
        return Err(ApplicationError::bad_request(
            "Pasted image content is empty",
        ));
    }
    if bytes.len() > MAX_PASTED_IMAGE_BYTES {
        return Err(ApplicationError::bad_request(
            "Pasted image exceeds the 15 MB limit",
        ));
    }
    let directory = PathBuf::from(&args.directory);
    let assets = directory.join("assets");
    tokio::fs::create_dir_all(&assets)
        .await
        .map_err(internal_error)?;
    let file_name = format!("pasted-image-{}.{}", uuid::Uuid::new_v4().simple(), ext);
    let absolute_path = assets.join(&file_name);
    tokio::fs::write(&absolute_path, bytes)
        .await
        .map_err(internal_error)?;
    serialize(WritePastedImageAssetResponse {
        absolute_path: absolute_path.to_string_lossy().into_owned(),
        markdown_path: format!("assets/{file_name}"),
        file_name,
    })
}
