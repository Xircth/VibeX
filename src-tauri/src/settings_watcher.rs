use notify::{EventKind, RecursiveMode, Watcher};
use tauri::AppHandle;

pub const SETTINGS_CHANGED_EVENT: &str = "vibex://settings-file-changed";

pub fn start(_app: AppHandle) {
    if let Err(error) = std::thread::Builder::new()
        .name("vibex-settings-watcher".to_string())
        .spawn(move || {
            let settings_path = utils::assets::settings_path();
            let Some(parent) = settings_path.parent() else {
                return;
            };
            if let Err(error) = std::fs::create_dir_all(parent) {
                tracing::warn!(%error, "Failed to create settings directory for watcher");
                return;
            }

            let (sender, receiver) = std::sync::mpsc::channel();
            let mut watcher = match notify::recommended_watcher(sender) {
                Ok(watcher) => watcher,
                Err(error) => {
                    tracing::warn!(%error, "Failed to create settings file watcher");
                    return;
                }
            };
            if let Err(error) = watcher.watch(parent, RecursiveMode::NonRecursive) {
                tracing::warn!(%error, "Failed to watch settings directory");
                return;
            }

            for event in receiver {
                let Ok(event) = event else {
                    continue;
                };
                if !matches!(
                    event.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                ) || !event.paths.iter().any(|path| path == &settings_path)
                {
                    continue;
                }
                server::global_host_events().emit(SETTINGS_CHANGED_EVENT, ());
            }
        })
    {
        tracing::warn!(%error, "Failed to start settings file watcher");
    }
}
