use std::sync::OnceLock;

static ARTIFACT_ORIGIN: OnceLock<String> = OnceLock::new();

pub fn artifact_origin() -> Option<&'static str> {
    ARTIFACT_ORIGIN.get().map(String::as_str)
}

pub fn set_artifact_origin(origin: String) {
    let _ = ARTIFACT_ORIGIN.set(origin);
}

pub fn rewrite_remote_entry(plugin_id: &str, entry: &str) -> String {
    if entry.starts_with("http://") || entry.starts_with("https://") {
        return entry.to_owned();
    }
    match artifact_origin() {
        Some(origin) => format!("{origin}/{plugin_id}/{}", entry.trim_start_matches('/')),
        None => entry.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_entries_pass_through() {
        assert_eq!(
            rewrite_remote_entry("p", "http://127.0.0.1:9/remoteEntry.js"),
            "http://127.0.0.1:9/remoteEntry.js"
        );
        assert_eq!(
            rewrite_remote_entry("p", "https://example.test/remoteEntry.js"),
            "https://example.test/remoteEntry.js"
        );
    }

    #[test]
    fn relative_entries_gain_the_artifact_origin() {
        if artifact_origin().is_none() {
            assert_eq!(
                rewrite_remote_entry("p", "dist/remoteEntry.js"),
                "dist/remoteEntry.js"
            );
            set_artifact_origin("http://127.0.0.1:1".to_owned());
        }
        let rewritten = rewrite_remote_entry("vibex.host-surface", "dist/remoteEntry.js");
        assert!(
            rewritten.ends_with("/vibex.host-surface/dist/remoteEntry.js"),
            "{rewritten}"
        );
        assert!(
            rewritten.starts_with("http://") || rewritten.starts_with("https://"),
            "{rewritten}"
        );
    }
}
