//! Grok occupancy for the composer ring and per-turn token display.
//!
//! Grok Build does not emit ACP `usage_update`. Occupancy rides ordinary
//! `session/update` notifications as `params._meta.totalTokens`. The window
//! comes from Grok's own catalog (`models_cache.json` / `config.toml`), then
//! a model-id fallback. Those two numbers are the same pair CodeG synthesizes
//! into a live `UsageUpdate`.

use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
};

use serde_json::Value;

/// Context-window occupancy from a `session/update` outer `_meta`.
pub fn occupancy_from_meta(meta: Option<&serde_json::Map<String, Value>>) -> Option<u64> {
    meta?
        .get("totalTokens")
        .and_then(Value::as_u64)
        .filter(|used| *used > 0)
}

/// `(used, size)` to emit, or `None` when the pair is unchanged.
///
/// `size` is 0 when the window is unknown so a later catalog hit still
/// re-emits once the denominator appears. Grok repeats `totalTokens` on
/// almost every chunk; callers must drop repeats or the event log floods.
pub fn live_usage_step(
    used: u64,
    window: Option<u64>,
    last: Option<(u64, u64)>,
) -> Option<(u64, u64)> {
    let size = window.filter(|window| *window > 0).unwrap_or(0);
    let next = (used, size);
    (Some(next) != last).then_some(next)
}

pub fn grok_home_dir() -> Option<PathBuf> {
    env::var_os("GROK_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".grok")))
}

/// Window for `model`: wire spec, then on-disk catalog, then id heuristic.
pub fn context_window_for_model(
    model: Option<&str>,
    grok_home: Option<&Path>,
    wire_window: Option<u64>,
) -> Option<u64> {
    if let Some(window) = wire_window.filter(|window| *window > 0) {
        return Some(window);
    }
    let model = model?.trim();
    if model.is_empty() {
        return None;
    }
    grok_home
        .and_then(|home| catalog_context_window(home, model))
        .or_else(|| infer_grok_context_window(model))
}

pub fn catalog_context_window(home: &Path, model: &str) -> Option<u64> {
    read_to_string(home.join("models_cache.json"))
        .and_then(|raw| window_from_models_cache(&raw, model))
        .or_else(|| {
            read_to_string(home.join("config.toml"))
                .and_then(|raw| window_from_config_toml(&raw, model))
        })
}

/// `availableModels[]._meta.totalContextTokens` from a session-establishment
/// `_meta` (or `_meta.models`).
pub fn windows_from_session_meta(
    meta: Option<&serde_json::Map<String, Value>>,
) -> HashMap<String, u64> {
    let Some(meta) = meta else {
        return HashMap::new();
    };
    let list = meta.get("availableModels").or_else(|| {
        meta.get("models")
            .and_then(|models| models.get("availableModels"))
    });
    windows_from_available_models(list)
}

fn windows_from_available_models(list: Option<&Value>) -> HashMap<String, u64> {
    let mut out = HashMap::new();
    let Some(list) = list.and_then(Value::as_array) else {
        return out;
    };
    for model in list {
        let Some(model_id) = model.get("modelId").and_then(Value::as_str) else {
            continue;
        };
        let Some(window) = model
            .get("_meta")
            .and_then(|meta| meta.get("totalContextTokens"))
            .and_then(Value::as_u64)
            .filter(|window| *window > 0)
        else {
            continue;
        };
        out.insert(model_id.to_string(), window);
    }
    out
}

fn window_from_models_cache(raw: &str, model: &str) -> Option<u64> {
    serde_json::from_str::<Value>(raw)
        .ok()?
        .get("models")?
        .get(model)?
        .get("info")?
        .get("context_window")?
        .as_u64()
        .filter(|window| *window > 0)
}

fn window_from_config_toml(raw: &str, model: &str) -> Option<u64> {
    raw.parse::<toml::Table>()
        .ok()?
        .get("model")?
        .as_table()?
        .get(model)?
        .as_table()?
        .get("context_window")?
        .as_integer()
        .filter(|window| *window > 0)
        .map(|window| window as u64)
}

/// Last resort when Grok has not published a window for this id on this machine.
pub fn infer_grok_context_window(model: &str) -> Option<u64> {
    let normalized = model
        .rsplit('/')
        .next()
        .unwrap_or(model)
        .split(':')
        .next()
        .unwrap_or(model)
        .trim()
        .to_ascii_lowercase();
    if !normalized.contains("grok") {
        return None;
    }
    if normalized.contains("4.6") || normalized.contains("4.5") {
        return Some(500_000);
    }
    if normalized.contains("4.3") || normalized.contains("4.20") {
        return Some(1_000_000);
    }
    if normalized.contains("code") || normalized.contains("build") {
        return Some(256_000);
    }
    if normalized.contains("fast") && !normalized.contains("composer") {
        return Some(2_000_000);
    }
    Some(256_000)
}

fn read_to_string(path: PathBuf) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn occupancy_ignores_missing_and_zero() {
        assert_eq!(occupancy_from_meta(None), None);
        let empty = serde_json::Map::new();
        assert_eq!(occupancy_from_meta(Some(&empty)), None);
        let zero = json!({"totalTokens": 0}).as_object().cloned().unwrap();
        assert_eq!(occupancy_from_meta(Some(&zero)), None);
        let used = json!({"totalTokens": 18658}).as_object().cloned().unwrap();
        assert_eq!(occupancy_from_meta(Some(&used)), Some(18_658));
    }

    #[test]
    fn live_usage_step_drops_repeats_and_reemits_on_window() {
        assert_eq!(live_usage_step(100, None, None), Some((100, 0)));
        assert_eq!(live_usage_step(100, None, Some((100, 0))), None);
        assert_eq!(
            live_usage_step(100, Some(500_000), Some((100, 0))),
            Some((100, 500_000))
        );
        assert_eq!(
            live_usage_step(120, Some(500_000), Some((100, 500_000))),
            Some((120, 500_000))
        );
        assert_eq!(
            live_usage_step(120, Some(500_000), Some((120, 500_000))),
            None
        );
    }

    #[test]
    fn catalog_reads_models_cache_then_config_toml() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("models_cache.json"),
            r#"{"models":{"grok-4.6":{"info":{"context_window":500000}}}}"#,
        )
        .unwrap();
        std::fs::write(
            home.path().join("config.toml"),
            "[model.\"my-byo\"]\nmodel = \"my-byo\"\ncontext_window = 64000\n",
        )
        .unwrap();

        assert_eq!(
            catalog_context_window(home.path(), "grok-4.6"),
            Some(500_000)
        );
        assert_eq!(catalog_context_window(home.path(), "my-byo"), Some(64_000));
        assert_eq!(catalog_context_window(home.path(), "missing"), None);
    }

    #[test]
    fn wire_window_wins_over_catalog() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(
            home.path().join("models_cache.json"),
            r#"{"models":{"grok-4.6":{"info":{"context_window":500000}}}}"#,
        )
        .unwrap();
        assert_eq!(
            context_window_for_model(Some("grok-4.6"), Some(home.path()), Some(123)),
            Some(123)
        );
        assert_eq!(
            context_window_for_model(Some("grok-4.6"), Some(home.path()), None),
            Some(500_000)
        );
    }

    #[test]
    fn infer_known_grok_families() {
        assert_eq!(infer_grok_context_window("grok-4.6"), Some(500_000));
        assert_eq!(infer_grok_context_window("grok-4.5"), Some(500_000));
        assert_eq!(infer_grok_context_window("grok-code-fast-1"), Some(256_000));
        assert_eq!(infer_grok_context_window("deepseek-chat"), None);
    }

    #[test]
    fn windows_from_available_models_meta() {
        let meta = json!({
            "availableModels": [
                {"modelId": "grok-4.6", "_meta": {"totalContextTokens": 500000}},
                {"modelId": "z", "_meta": {"totalContextTokens": 0}},
                {"modelId": "bare"}
            ]
        })
        .as_object()
        .cloned()
        .unwrap();
        let windows = windows_from_session_meta(Some(&meta));
        assert_eq!(windows.get("grok-4.6"), Some(&500_000));
        assert!(!windows.contains_key("z"));
        assert!(!windows.contains_key("bare"));
    }
}
