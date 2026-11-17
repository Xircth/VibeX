use std::{collections::BTreeMap, path::PathBuf};

use serde_json::{Value, json};

use crate::{
    agent,
    error::BrowserHostError,
    import_browsers::{
        ExternalBrowserEngine, detect_external_browsers, import_from_detected_profile,
        parse_netscape_bookmarks_html, parse_passwords_csv,
    },
    service::BrowserService,
    vault::{CredentialSummary, build_autofill_script, credential_matches_url},
};

pub async fn dispatch_userdata(
    service: &BrowserService,
    operation: &str,
    input: Value,
) -> Result<Value, BrowserHostError> {
    match operation {
        "userdata.summary" => {
            let profile_id =
                resolve_profile_id(service, input.get("profileId").and_then(Value::as_str));
            let summary = service.userdata().summary(&profile_id)?;
            serde_json::to_value(summary)
                .map_err(|err| BrowserHostError::new("browser_invalid", err.to_string()))
        }
        "userdata.summaries" => {
            let settings = service.settings();
            let mut map = BTreeMap::new();
            for profile in &settings.profiles {
                map.insert(profile.id.clone(), service.userdata().summary(&profile.id)?);
            }
            Ok(json!({ "summaries": map }))
        }
        "userdata.import.detect" => {
            let browsers = tokio::task::spawn_blocking(detect_external_browsers)
                .await
                .map_err(|err| BrowserHostError::new("browser_read_failed", err.to_string()))?;
            Ok(json!({ "browsers": browsers }))
        }
        "userdata.import.run" => handle_import_run(service, input).await,
        "userdata.bookmarks.list" => {
            let profile_id =
                resolve_profile_id(service, input.get("profileId").and_then(Value::as_str));
            let bookmarks = service.userdata().list_bookmarks(&profile_id)?;
            Ok(json!({ "profileId": profile_id, "bookmarks": bookmarks }))
        }
        "userdata.bookmarks.add" => {
            let profile_id =
                resolve_profile_id(service, input.get("profileId").and_then(Value::as_str));
            let url = input
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| BrowserHostError::new("browser_invalid", "url is required"))?;
            let title = input.get("title").and_then(Value::as_str);
            let folder = input.get("folder").and_then(Value::as_str);
            let favicon = input.get("favicon").and_then(Value::as_str);
            let (bookmark, added) =
                service
                    .userdata()
                    .add_bookmark(&profile_id, url, title, folder, favicon)?;
            Ok(json!({ "bookmark": bookmark, "added": added }))
        }
        "userdata.bookmarks.remove" => {
            let profile_id =
                resolve_profile_id(service, input.get("profileId").and_then(Value::as_str));
            let id = input.get("id").and_then(Value::as_str);
            let url = input.get("url").and_then(Value::as_str);
            let removed = service.userdata().remove_bookmark(&profile_id, id, url)?;
            Ok(json!({ "removed": removed }))
        }
        "userdata.bookmarks.clear" => {
            let profile_id =
                resolve_profile_id(service, input.get("profileId").and_then(Value::as_str));
            service.userdata().clear_bookmarks(&profile_id)?;
            Ok(json!({ "cleared": true }))
        }
        "userdata.history.list" => {
            let profile_id =
                resolve_profile_id(service, input.get("profileId").and_then(Value::as_str));
            let limit = input
                .get("limit")
                .and_then(Value::as_u64)
                .map(|n| n as usize);
            let history = service.userdata().list_history(&profile_id, limit)?;
            Ok(json!({ "profileId": profile_id, "history": history }))
        }
        "userdata.history.record" => {
            let profile_id =
                resolve_profile_id(service, input.get("profileId").and_then(Value::as_str));
            let url = input
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if !url.is_empty() {
                let title = input.get("title").and_then(Value::as_str);
                let favicon = input.get("favicon").and_then(Value::as_str);
                service
                    .userdata()
                    .record_visit(&profile_id, url, title, favicon)?;
            }
            Ok(json!({ "ok": true }))
        }
        "userdata.history.clear" => {
            let profile_id =
                resolve_profile_id(service, input.get("profileId").and_then(Value::as_str));
            service.userdata().clear_history(&profile_id)?;
            Ok(json!({ "cleared": true }))
        }
        "userdata.credentials.list" => {
            let profile_id =
                resolve_profile_id(service, input.get("profileId").and_then(Value::as_str));
            let filter_url = input
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let credentials: Vec<CredentialSummary> = match filter_url {
                Some(url) => {
                    let full = service.userdata().list_credentials_redacted(&profile_id)?;
                    // Re-check origin against stored credentials in Rust without exposing passwords.
                    let mut matched = Vec::new();
                    for summary in full {
                        if let Ok(cred) = service
                            .userdata()
                            .get_credential_for_autofill(&profile_id, &summary.id)
                            && credential_matches_url(&cred, url)
                        {
                            matched.push(summary);
                        }
                    }
                    matched
                }
                None => service.userdata().list_credentials_redacted(&profile_id)?,
            };
            Ok(json!({ "profileId": profile_id, "credentials": credentials }))
        }
        "userdata.credentials.fill" => handle_credential_fill(service, input).await,
        "userdata.credentials.remove" => {
            let profile_id =
                resolve_profile_id(service, input.get("profileId").and_then(Value::as_str));
            let credential_id = input
                .get("credentialId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    BrowserHostError::new("browser_invalid", "credentialId is required")
                })?;
            let removed = service
                .userdata()
                .remove_credential(&profile_id, credential_id)?;
            Ok(json!({ "removed": removed }))
        }
        "userdata.credentials.clear" => {
            let profile_id =
                resolve_profile_id(service, input.get("profileId").and_then(Value::as_str));
            service.userdata().clear_credentials(&profile_id)?;
            Ok(json!({ "cleared": true }))
        }
        other => Err(BrowserHostError::new(
            "capability_unimplemented",
            format!("browser.{other} is not implemented"),
        )),
    }
}

async fn handle_import_run(
    service: &BrowserService,
    input: Value,
) -> Result<Value, BrowserHostError> {
    let target_profile = resolve_profile_id(
        service,
        input
            .get("targetProfileId")
            .or_else(|| input.get("profileId"))
            .and_then(Value::as_str),
    );
    let source_path = input
        .get("sourceProfilePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let source_engine = input
        .get("sourceEngine")
        .and_then(Value::as_str)
        .map(|s| s.trim().to_ascii_lowercase());
    let include_bookmarks = input
        .get("includeBookmarks")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let include_history = input
        .get("includeHistory")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let bookmark_html = input
        .get("bookmarkHtml")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let password_csv = input
        .get("passwordCsv")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let password_source = input
        .get("passwordSource")
        .and_then(Value::as_str)
        .unwrap_or("csv")
        .to_owned();

    let mut warnings = Vec::new();
    let mut bookmarks_to_import = Vec::new();
    let mut history_to_import = Vec::new();

    if let Some(dir) = source_path {
        if !dir.is_dir() {
            return Err(BrowserHostError::new(
                "browser_invalid",
                format!("指定的浏览器配置目录不存在: {}", dir.display()),
            ));
        }
        let engine = match source_engine.as_deref() {
            Some("firefox") => ExternalBrowserEngine::Firefox,
            Some("chromium") => ExternalBrowserEngine::Chromium,
            _ => {
                if dir.join("places.sqlite").is_file() {
                    ExternalBrowserEngine::Firefox
                } else {
                    ExternalBrowserEngine::Chromium
                }
            }
        };
        let (bm, hist, mut import_warnings) = tokio::task::spawn_blocking(move || {
            import_from_detected_profile(&dir, engine, include_bookmarks, include_history)
        })
        .await
        .map_err(|err| BrowserHostError::new("browser_read_failed", err.to_string()))?;
        bookmarks_to_import.extend(bm);
        history_to_import.extend(hist);
        warnings.append(&mut import_warnings);
    }

    if let Some(html) = bookmark_html
        && !html.trim().is_empty()
    {
        let parsed = parse_netscape_bookmarks_html(&html);
        if parsed.is_empty() {
            warnings.push("书签 HTML 中未解析到有效的 http(s) 书签条目".to_owned());
        } else {
            bookmarks_to_import.extend(parsed);
        }
    }

    let bookmarks_added = if !bookmarks_to_import.is_empty() {
        service
            .userdata()
            .import_bookmarks(&target_profile, bookmarks_to_import)?
    } else {
        0
    };
    let history_added = if !history_to_import.is_empty() {
        service
            .userdata()
            .import_history(&target_profile, history_to_import)?
    } else {
        0
    };

    let mut cred_added = 0usize;
    let mut cred_updated = 0usize;
    let mut cred_skipped = 0usize;
    if let Some(csv) = password_csv
        && !csv.trim().is_empty()
    {
        let parsed = parse_passwords_csv(&csv, &password_source)?;
        let stats = service
            .userdata()
            .import_credentials(&target_profile, parsed)?;
        cred_added = stats.added;
        cred_updated = stats.updated;
        cred_skipped = stats.skipped;
    }

    let summary = service.userdata().summary(&target_profile)?;
    Ok(json!({
        "profileId": target_profile,
        "bookmarksAdded": bookmarks_added,
        "historyAdded": history_added,
        "credentialsAdded": cred_added,
        "credentialsUpdated": cred_updated,
        "credentialsSkipped": cred_skipped,
        "warnings": warnings,
        "summary": summary,
    }))
}

async fn handle_credential_fill(
    service: &BrowserService,
    input: Value,
) -> Result<Value, BrowserHostError> {
    let tab_id = input
        .get("tabId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| BrowserHostError::new("browser_invalid", "tabId is required"))?
        .to_owned();
    let credential_id = input
        .get("credentialId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| BrowserHostError::new("browser_invalid", "credentialId is required"))?
        .to_owned();

    let tab = service.get_tab(&tab_id)?;
    let profile_id = input
        .get("profileId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&tab.profile_id)
        .to_owned();

    let cred = service
        .userdata()
        .get_credential_for_autofill(&profile_id, &credential_id)?;
    let live_url = service
        .native_handle()
        .current_url(&tab_id)
        .await
        .ok()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or(tab.url);

    if !credential_matches_url(&cred, &live_url) {
        return Err(BrowserHostError::new(
            "browser_origin_mismatch",
            "当前页面域名与所选保存的密码域名不匹配，已拒绝填充",
        ));
    }

    let script = build_autofill_script(&cred.username, &cred.password)?;
    let raw = service.native_handle().eval(&tab_id, &script).await?;
    let decoded = agent::decode_eval_result(&raw);
    let outcome: Value = serde_json::from_str(&decoded).unwrap_or_else(|_| {
        json!({
            "ok": false,
            "filledUsername": false,
            "filledPassword": false,
            "reason": "unexpected_eval_response"
        })
    });
    Ok(outcome)
}

fn resolve_profile_id(service: &BrowserService, explicit: Option<&str>) -> String {
    if let Some(id) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        return id.to_owned();
    }
    service.settings().new_tab_profile
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use rusqlite::Connection;
    use serde_json::json;

    use crate::{BrowserBounds, BrowserHostError, BrowserService, NativeTabs, dispatch};

    struct SpyNative {
        current_url: Mutex<String>,
        evals: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl NativeTabs for SpyNative {
        async fn open(
            &self,
            _tab_id: &str,
            url: &str,
            _bounds: &BrowserBounds,
            _profile_id: &str,
        ) -> Result<(), BrowserHostError> {
            *self.current_url.lock().unwrap() = url.to_owned();
            Ok(())
        }
        async fn navigate(&self, _tab_id: &str, url: &str) -> Result<(), BrowserHostError> {
            *self.current_url.lock().unwrap() = url.to_owned();
            Ok(())
        }
        async fn close(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn set_bounds(
            &self,
            _tab_id: &str,
            _bounds: &BrowserBounds,
        ) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn eval(&self, _tab_id: &str, expression: &str) -> Result<String, BrowserHostError> {
            self.evals.lock().unwrap().push(expression.to_owned());
            Ok(r#"{"ok":true,"filledUsername":true,"filledPassword":true,"reason":null}"#.into())
        }
        async fn current_url(&self, _tab_id: &str) -> Result<String, BrowserHostError> {
            Ok(self.current_url.lock().unwrap().clone())
        }
        async fn go_back(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn go_forward(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn reload(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn set_zoom(&self, _tab_id: &str, _factor: f64) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn open_devtools(&self, _tab_id: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn set_device(&self, _tab_id: &str, _device: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
        async fn inject(&self, _tab_id: &str, _script: &str) -> Result<(), BrowserHostError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn dispatch_userdata_imports_bookmarks_history_and_autofills_without_exposing_passwords()
    {
        let data_root = tempfile::tempdir().expect("data root");
        let source_browser = tempfile::tempdir().expect("source browser");

        // Seed Chromium Bookmarks + History SQLite in source_browser
        std::fs::write(
            source_browser.path().join("Bookmarks"),
            r#"{"roots":{"bookmark_bar":{"type":"folder","name":"Bookmarks bar","children":[{"type":"url","name":"GitHub","url":"https://github.com/"}]}}}"#,
        )
        .expect("write bookmarks");
        let conn = Connection::open(source_browser.path().join("History")).expect("sqlite");
        conn.execute_batch(
            "CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER, hidden INTEGER DEFAULT 0);
             INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES ('https://github.com/DimoADE/Dimo', 'Dimo', 25, 13360000000000000, 0);",
        )
        .expect("seed history");
        drop(conn);

        let native = Arc::new(SpyNative {
            current_url: Mutex::new("https://github.com/login".into()),
            evals: Mutex::new(Vec::new()),
        });
        let service = BrowserService::with_data_dir(
            native.clone(),
            true,
            Some(data_root.path().to_path_buf()),
        );

        let import_res = dispatch(
            &service,
            "dimo.browser",
            "userdata.import.run",
            json!({
                "targetProfileId": "default",
                "sourceProfilePath": source_browser.path(),
                "includeBookmarks": true,
                "includeHistory": true,
                "passwordCsv": "name,url,username,password,note\nGitHub,https://github.com/login,octo,top-secret-999,work\n"
            }),
        )
        .await
        .expect("import run");
        assert_eq!(import_res["bookmarksAdded"], 1);
        assert_eq!(import_res["historyAdded"], 1);
        assert_eq!(import_res["credentialsAdded"], 1);

        let creds_list = dispatch(
            &service,
            "dimo.browser",
            "userdata.credentials.list",
            json!({ "profileId": "default", "url": "https://github.com/login" }),
        )
        .await
        .expect("list creds");
        let serialized_list = creds_list.to_string();
        assert!(!serialized_list.contains("top-secret-999"));
        let cred_id = creds_list["credentials"][0]["id"]
            .as_str()
            .expect("cred id")
            .to_owned();

        let tab = dispatch(
            &service,
            "dimo.browser",
            "tab.create",
            json!({ "url": "https://github.com/login" }),
        )
        .await
        .expect("open tab");
        let tab_id = tab["tabId"].as_str().expect("tab id").to_owned();

        let fill_ok = dispatch(
            &service,
            "dimo.browser",
            "userdata.credentials.fill",
            json!({ "tabId": tab_id, "credentialId": cred_id }),
        )
        .await
        .expect("autofill");
        assert_eq!(fill_ok["ok"], true);
        {
            let eval_calls = native.evals.lock().unwrap();
            assert!(eval_calls.iter().any(|s| s.contains("top-secret-999")));
        }

        // Origin mismatch is refused
        *native.current_url.lock().unwrap() = "https://evil.example/login".into();
        let err = dispatch(
            &service,
            "dimo.browser",
            "userdata.credentials.fill",
            json!({ "tabId": tab_id, "credentialId": cred_id }),
        )
        .await
        .expect_err("origin mismatch must fail");
        assert_eq!(err.code(), "browser_origin_mismatch");
    }
}
