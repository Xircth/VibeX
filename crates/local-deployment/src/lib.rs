use std::{
    collections::{HashMap, hash_map::DefaultHasher},
    hash::{Hash, Hasher},
    sync::Arc,
};

use async_trait::async_trait;
use db::DBService;
use deployment::{Deployment, DeploymentError};
use executors::profile::ExecutorConfigs;
use git::GitService;
use services::services::{
    approvals::Approvals,
    config::{Config, load_config_from_file, save_config_to_file},
    container::ContainerService,
    events::EventService,
    file_search::FileSearchCache,
    filesystem::FilesystemService,
    image::ImageService,
    pr_monitor::PrMonitorService,
    project::ProjectService,
    repo::RepoService,
    worktree_manager::WorktreeManager,
};
use tokio::sync::RwLock;
use utils::{assets::config_path, msg_store::MsgStore, process::new_hidden_std_command};

use crate::{container::LocalContainerService, pty::PtyService};
mod command;
pub mod container;
mod copy;
mod process_completion;
pub mod pty;

#[derive(Clone)]
pub struct LocalDeployment {
    config: Arc<RwLock<Config>>,
    user_id: String,
    db: DBService,
    container: LocalContainerService,
    git: GitService,
    project: ProjectService,
    repo: RepoService,
    image: ImageService,
    filesystem: FilesystemService,
    events: EventService,
    file_search_cache: Arc<FileSearchCache>,
    approvals: Approvals,
    pty: PtyService,
}

#[async_trait]
impl Deployment for LocalDeployment {
    async fn new() -> Result<Self, DeploymentError> {
        let mut raw_config = load_config_from_file(&config_path()).await;

        let profiles = ExecutorConfigs::get_cached();
        if !raw_config.onboarding_acknowledged
            && let Ok(recommended_executor) = profiles.get_recommended_executor_profile().await
        {
            raw_config.executor_profile = recommended_executor;
        }

        // Check if app version has changed and set release notes flag
        {
            let current_version = utils::version::APP_VERSION;
            let stored_version = raw_config.last_app_version.as_deref();

            if stored_version != Some(current_version) {
                // Show release notes only if this is an upgrade (not first install)
                raw_config.show_release_notes = stored_version.is_some();
                raw_config.last_app_version = Some(current_version.to_string());
            }
        }

        // Always save config (may have been migrated or version updated)
        save_config_to_file(&raw_config, &config_path()).await?;

        let workspace_dir_override = raw_config
            .workspace_dir
            .as_ref()
            .map(|workspace_dir| utils::path::expand_tilde(workspace_dir));
        WorktreeManager::set_workspace_dir_override(workspace_dir_override);

        let config = Arc::new(RwLock::new(raw_config));
        let user_id = generate_user_id();
        let git = GitService::new();
        let project = ProjectService::new();
        let repo = RepoService::new();
        let msg_stores = Arc::new(RwLock::new(HashMap::new()));
        let filesystem = FilesystemService::new();

        // Create shared components for EventService
        let events_msg_store = Arc::new(MsgStore::new());
        let events_entry_count = Arc::new(RwLock::new(0));

        // Create DB with event hooks
        let db = {
            let hook = EventService::create_hook(
                events_msg_store.clone(),
                events_entry_count.clone(),
                DBService::new().await?, // Temporary DB service for the hook
            );
            DBService::new_with_after_connect(hook).await?
        };

        let image = ImageService::new(db.clone().pool)?;
        {
            let image_service = image.clone();
            tokio::spawn(async move {
                tracing::info!("Starting orphaned image cleanup...");
                if let Err(e) = image_service.delete_orphaned_images().await {
                    tracing::error!("Failed to clean up orphaned images: {}", e);
                }
            });
        }

        let approvals = Approvals::new(msg_stores.clone());
        let container = LocalContainerService::new(
            db.clone(),
            msg_stores.clone(),
            config.clone(),
            git.clone(),
            image.clone(),
            approvals.clone(),
        )
        .await;

        let events = EventService::new(db.clone(), events_msg_store);

        let file_search_cache = Arc::new(FileSearchCache::new());

        let pty = PtyService::new();
        {
            let db = db.clone();
            let container = container.clone();
            PrMonitorService::spawn(db, container).await;
        }

        let deployment = Self {
            config,
            user_id,
            db,
            container,
            git,
            project,
            repo,
            image,
            filesystem,
            events,
            file_search_cache,
            approvals,
            pty,
        };

        Ok(deployment)
    }

    fn user_id(&self) -> &str {
        &self.user_id
    }

    fn config(&self) -> &Arc<RwLock<Config>> {
        &self.config
    }

    fn db(&self) -> &DBService {
        &self.db
    }

    fn container(&self) -> &impl ContainerService {
        &self.container
    }

    fn git(&self) -> &GitService {
        &self.git
    }

    fn project(&self) -> &ProjectService {
        &self.project
    }

    fn repo(&self) -> &RepoService {
        &self.repo
    }

    fn image(&self) -> &ImageService {
        &self.image
    }

    fn filesystem(&self) -> &FilesystemService {
        &self.filesystem
    }

    fn events(&self) -> &EventService {
        &self.events
    }

    fn file_search_cache(&self) -> &Arc<FileSearchCache> {
        &self.file_search_cache
    }

    fn approvals(&self) -> &Approvals {
        &self.approvals
    }

}

impl LocalDeployment {
    pub fn pty(&self) -> &PtyService {
        &self.pty
    }
}

/// Generates a consistent, anonymous user ID based on machine identity.
fn generate_user_id() -> String {
    let mut hasher = DefaultHasher::new();

    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
        {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(line) = stdout.lines().find(|l| l.contains("IOPlatformUUID")) {
                line.hash(&mut hasher);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(machine_id) = std::fs::read_to_string("/etc/machine-id") {
            machine_id.trim().hash(&mut hasher);
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = new_hidden_std_command(
            "powershell",
            [
                "-NoProfile",
                "-Command",
                "(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid",
            ],
        )
        .output()
            && output.status.success()
        {
            output.stdout.hash(&mut hasher);
        }
    }

    if let Ok(user) = std::env::var("USER").or_else(|_| std::env::var("USERNAME")) {
        user.hash(&mut hasher);
    }

    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        home.hash(&mut hasher);
    }

    format!("user_{:016x}", hasher.finish())
}
