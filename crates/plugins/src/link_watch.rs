use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;

use super::control_plane::PluginControlPlane;
use crate::PluginSourceKind;

const DEBOUNCE: Duration = Duration::from_millis(200);
const RESYNC: Duration = Duration::from_secs(5);
const POLL_FALLBACK: Duration = Duration::from_secs(2);

pub(super) async fn run_developer_link_watch(plane: Arc<PluginControlPlane>) {
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<Event>>();
    match RecommendedWatcher::new(tx, notify::Config::default()) {
        Ok(watcher) => watch_with_notify(plane, watcher, rx).await,
        Err(error) => {
            tracing::warn!(
                %error,
                "linked Plugin file watching is unavailable; refreshing on a 2s interval"
            );
            poll_loop(plane).await;
        }
    }
}

async fn watch_with_notify(
    plane: Arc<PluginControlPlane>,
    mut watcher: RecommendedWatcher,
    rx: std::sync::mpsc::Receiver<notify::Result<Event>>,
) {
    let mut watched = HashSet::<PathBuf>::new();
    resync_watches(&plane, &mut watcher, &mut watched).await;
    let (event_tx, mut event_rx) = mpsc::unbounded_channel();
    std::thread::Builder::new()
        .name("plugin-link-watch".into())
        .spawn(move || {
            while let Ok(event) = rx.recv() {
                if event_tx.send(event).is_err() {
                    break;
                }
            }
        })
        .ok();

    let mut deadline: Option<tokio::time::Instant> = None;
    loop {
        tokio::select! {
            event = event_rx.recv() => {
                match event {
                    Some(Ok(_)) => {
                        deadline = Some(tokio::time::Instant::now() + DEBOUNCE);
                    }
                    Some(Err(error)) => tracing::debug!(%error, "linked Plugin watch event failed"),
                    None => {
                        poll_loop(plane).await;
                        return;
                    }
                }
            }
            _ = sleep_until(deadline), if deadline.is_some() => {
                deadline = None;
                reload(&plane).await;
                resync_watches(&plane, &mut watcher, &mut watched).await;
            }
            _ = tokio::time::sleep(RESYNC) => {
                resync_watches(&plane, &mut watcher, &mut watched).await;
            }
        }
    }
}

async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(when) => tokio::time::sleep_until(when).await,
        None => std::future::pending::<()>().await,
    }
}

async fn poll_loop(plane: Arc<PluginControlPlane>) {
    let mut interval = tokio::time::interval(POLL_FALLBACK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        reload(&plane).await;
    }
}

async fn reload(plane: &PluginControlPlane) {
    match plane.refresh_developer_links().await {
        Ok(changed) if !changed.is_empty() => {
            tracing::info!(
                plugins = ?changed,
                "reloaded linked Plugin packages from their development directories"
            );
        }
        Ok(_) => {}
        Err(error) => tracing::debug!(%error, "linked Plugin refresh failed"),
    }
}

async fn resync_watches(
    plane: &PluginControlPlane,
    watcher: &mut RecommendedWatcher,
    watched: &mut HashSet<PathBuf>,
) {
    let Ok(plugins) = plane.catalog().await else {
        return;
    };
    let desired: HashSet<PathBuf> = plugins
        .into_iter()
        .filter(|plugin| plugin.source.kind == PluginSourceKind::DeveloperLink)
        .filter(|plugin| plugin.source.path.is_dir())
        .map(|plugin| plugin.source.path.clone())
        .collect();
    for stale in watched.difference(&desired).cloned().collect::<Vec<_>>() {
        let _ = watcher.unwatch(Path::new(&stale));
        watched.remove(&stale);
    }
    for path in desired.difference(watched).cloned().collect::<Vec<_>>() {
        if watcher.watch(&path, RecursiveMode::Recursive).is_ok() {
            watched.insert(path);
        }
    }
}
