use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{command, plugin::Builder, plugin::TauriPlugin, Runtime};

fn project_root() -> Result<PathBuf, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .and_then(|path| path.parent())
        .map(PathBuf::from)
        .ok_or_else(|| "VibeX inspector project root is unavailable".to_string())
}

#[command]
fn submit_capture(json: String) -> Result<(), String> {
    if json.len() > 12 * 1024 * 1024 {
        return Err("Redline capture exceeds the 12 MB limit".to_string());
    }
    serde_json::from_str::<serde_json::Value>(&json)
        .map_err(|error| format!("Invalid Redline capture: {error}"))?;
    let inbox = project_root()?.join(".vibex/inspector/inbox");
    fs::create_dir_all(&inbox).map_err(|error| error.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    fs::write(inbox.join(format!("{stamp}.json")), json).map_err(|error| error.to_string())
}

#[command]
fn take_control() -> Result<Option<String>, String> {
    let path = project_root()?.join(".vibex/inspector/control");
    if !path.is_file() {
        return Ok(None);
    }
    let command = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    fs::remove_file(path).map_err(|error| error.to_string())?;
    Ok(Some(command.trim().to_string()))
}

const BRIDGE_SCRIPT: &str = r#"
(function () {
  if (window.__vibexInspectorBridge) return;
  window.__vibexInspectorBridge = true;
  var invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (!invoke) return;

  var blobs = new Map();
  var createObjectURL = URL.createObjectURL.bind(URL);
  var revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    var url = createObjectURL(blob);
    blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    window.setTimeout(function () { blobs.delete(url); }, 2000);
    return revokeObjectURL(url);
  };

  var anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    var blob = blobs.get(this.href);
    if (
      blob &&
      blob.type === 'application/json' &&
      typeof this.download === 'string' &&
      this.download.endsWith('.json')
    ) {
      blob.text().then(function (text) {
        try {
          var value = JSON.parse(text);
          if (Array.isArray(value.annotations)) {
            invoke('plugin:vibex-inspector|submit_capture', { json: text });
          }
        } catch (_) {}
      });
    }
    return anchorClick.call(this);
  };

  window.setInterval(function () {
    invoke('plugin:vibex-inspector|take_control').then(function (command) {
      if (command === 'activate' && window.__redline_activate) {
        window.__redline_activate();
      } else if (command === 'deactivate' && window.__redline_deactivate) {
        window.__redline_deactivate();
      }
    }).catch(function () {});
  }, 400);
})();
"#;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("vibex-inspector")
        .js_init_script(BRIDGE_SCRIPT.to_string())
        .invoke_handler(tauri::generate_handler![submit_capture, take_control])
        .build()
}
