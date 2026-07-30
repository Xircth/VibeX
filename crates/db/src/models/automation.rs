//! Automations (P0-3): saved headless "start a turn" configurations plus a log
//! of each run. Uses runtime sqlx queries (no offline macro cache).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Automation {
    pub id: Uuid,
    pub name: String,
    pub project_id: Uuid,
    pub executor: Option<String>,
    pub prompt: String,
    pub plugin_action_json: Option<String>,
    /// `in_place` | `new_worktree`.
    pub isolation: String,
    /// `manual` | `cron`.
    pub trigger_kind: String,
    /// 5-field cron expression, evaluated in local time (present when cron-triggered).
    pub cron: Option<String>,
    pub enabled: bool,
    pub next_run_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct AutomationInput {
    pub name: String,
    pub project_id: Uuid,
    pub executor: Option<String>,
    pub prompt: String,
    pub plugin_action_json: Option<String>,
    pub isolation: String,
    pub trigger_kind: String,
    pub cron: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, FromRow, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AutomationRun {
    pub id: Uuid,
    pub automation_id: Uuid,
    /// `running` | `completed` | `failed` | `interrupted`.
    pub status: String,
    pub conversation_id: Option<Uuid>,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub seen: bool,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

const AUTOMATION_COLS: &str = "a.id, a.name, a.project_id, \
    json_extract(a.turn_launch_spec_json, '$.agent.agentId') AS executor, \
    json_extract(a.turn_launch_spec_json, '$.displayText') AS prompt, \
    json_extract(e.evidence_json, '$.plugin_action_json') AS plugin_action_json, \
    a.isolation, \
    CASE a.trigger_kind WHEN 'schedule' THEN 'cron' ELSE 'manual' END AS trigger_kind, \
    a.cron, a.enabled, a.next_run_at, a.created_at, a.updated_at";

impl Automation {
    pub async fn create(
        pool: &SqlitePool,
        id: Uuid,
        input: &AutomationInput,
        next_run_at: Option<DateTime<Utc>>,
    ) -> Result<Self, sqlx::Error> {
        let now = Utc::now();
        let (launch_json, isolation, enabled) = compatibility_launch(input)?;
        sqlx::query(
            "INSERT INTO automations \
             (id,name,enabled,spec_version,trigger_kind,cron,timezone,next_run_at,\
              turn_launch_spec_json,isolation,project_id,root_folder,branch,\
              legacy_migration_status,created_at,updated_at) \
             VALUES (?,?,?,1,?,?, 'UTC',?,?,?,?, '',NULL,'migration_required',?,?)",
        )
        .bind(id)
        .bind(&input.name)
        .bind(enabled)
        .bind(if input.trigger_kind == "cron" {
            "schedule"
        } else {
            "manual"
        })
        .bind(&input.cron)
        .bind(if enabled { next_run_at } else { None })
        .bind(launch_json)
        .bind(isolation)
        .bind(input.project_id)
        .bind(now)
        .bind(now)
        .execute(pool)
        .await?;
        if input.plugin_action_json.is_some() {
            let evidence = serde_json::json!({
                "source": "legacy_compatibility_input",
                "plugin_action_json": input.plugin_action_json,
            });
            sqlx::query(
                "INSERT INTO automation_legacy_evidence
                 (automation_id,evidence_json,captured_at) VALUES (?,?,?)",
            )
            .bind(id)
            .bind(evidence.to_string())
            .bind(now)
            .execute(pool)
            .await?;
        }
        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn list(pool: &SqlitePool) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {AUTOMATION_COLS} FROM automations a
             LEFT JOIN automation_legacy_evidence e ON e.automation_id = a.id
             ORDER BY a.created_at DESC"
        ))
        .fetch_all(pool)
        .await
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {AUTOMATION_COLS} FROM automations a
             LEFT JOIN automation_legacy_evidence e ON e.automation_id = a.id
             WHERE a.id = ?"
        ))
        .bind(id)
        .fetch_optional(pool)
        .await
    }

    /// Enabled cron automations whose next run is due at or before `now`.
    pub async fn due(pool: &SqlitePool, now: DateTime<Utc>) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {AUTOMATION_COLS} FROM automations a
             LEFT JOIN automation_legacy_evidence e ON e.automation_id = a.id
             WHERE a.enabled = 1 AND a.trigger_kind = 'schedule' \
               AND a.next_run_at IS NOT NULL AND a.next_run_at <= ? \
             ORDER BY a.next_run_at ASC"
        ))
        .bind(now)
        .fetch_all(pool)
        .await
    }

    pub async fn update(
        pool: &SqlitePool,
        id: Uuid,
        input: &AutomationInput,
        next_run_at: Option<DateTime<Utc>>,
    ) -> Result<Self, sqlx::Error> {
        let (launch_json, isolation, enabled) = compatibility_launch(input)?;
        sqlx::query(
            "UPDATE automations SET name=?,project_id=?,turn_launch_spec_json=?,isolation=?,\
             trigger_kind=?,cron=?,enabled=?,next_run_at=?,updated_at=? WHERE id=?",
        )
        .bind(&input.name)
        .bind(input.project_id)
        .bind(launch_json)
        .bind(isolation)
        .bind(if input.trigger_kind == "cron" {
            "schedule"
        } else {
            "manual"
        })
        .bind(&input.cron)
        .bind(enabled)
        .bind(if enabled { next_run_at } else { None })
        .bind(Utc::now())
        .bind(id)
        .execute(pool)
        .await?;
        if let Some(plugin_action_json) = &input.plugin_action_json {
            let evidence = serde_json::json!({
                "source": "legacy_compatibility_input",
                "plugin_action_json": plugin_action_json,
            });
            sqlx::query(
                "INSERT INTO automation_legacy_evidence
                 (automation_id,evidence_json,captured_at) VALUES (?,?,?)
                 ON CONFLICT(automation_id) DO UPDATE SET
                    evidence_json=excluded.evidence_json,
                    captured_at=excluded.captured_at",
            )
            .bind(id)
            .bind(evidence.to_string())
            .bind(Utc::now())
            .execute(pool)
            .await?;
        }
        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn set_next_run(
        pool: &SqlitePool,
        id: Uuid,
        next_run_at: Option<DateTime<Utc>>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE automations SET next_run_at = ? WHERE id = ?")
            .bind(next_run_at)
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn set_enabled(
        pool: &SqlitePool,
        id: Uuid,
        enabled: bool,
        next_run_at: Option<DateTime<Utc>>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE automations SET enabled = ?, next_run_at = ?, updated_at = ?
             WHERE id = ? AND legacy_migration_status = 'ready'",
        )
        .bind(enabled)
        .bind(next_run_at)
        .bind(Utc::now())
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn delete(pool: &SqlitePool, id: Uuid) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM automations WHERE id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        sqlx::query("DELETE FROM automation_runs WHERE automation_id = ?")
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }
}

const RUN_COLS: &str =
    "id, automation_id, status, conversation_id, summary, error, seen, started_at, finished_at";

impl AutomationRun {
    pub async fn start(
        pool: &SqlitePool,
        id: Uuid,
        automation_id: Uuid,
        conversation_id: Option<Uuid>,
    ) -> Result<Self, sqlx::Error> {
        sqlx::query(
            "INSERT INTO automation_runs \
             (id, automation_id, trigger, status, conversation_id, seen, started_at) \
             VALUES (?,?,'manual','running',?,0,?)",
        )
        .bind(id)
        .bind(automation_id)
        .bind(conversation_id)
        .bind(Utc::now())
        .execute(pool)
        .await?;
        Self::find_by_id(pool, id)
            .await?
            .ok_or(sqlx::Error::RowNotFound)
    }

    pub async fn find_by_id(pool: &SqlitePool, id: Uuid) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {RUN_COLS} FROM automation_runs WHERE id = ?"
        ))
        .bind(id)
        .fetch_optional(pool)
        .await
    }

    pub async fn finish(
        pool: &SqlitePool,
        id: Uuid,
        status: &str,
        conversation_id: Option<Uuid>,
        summary: Option<&str>,
        error: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        // COALESCE keeps an existing conversation_id when None is passed.
        sqlx::query(
            "UPDATE automation_runs \
             SET status=?, conversation_id=COALESCE(?, conversation_id), \
                 summary=?, error=?, finished_at=? WHERE id=?",
        )
        .bind(status)
        .bind(conversation_id)
        .bind(summary)
        .bind(error)
        .bind(Utc::now())
        .bind(id)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn list_for_automation(
        pool: &SqlitePool,
        automation_id: Uuid,
        limit: i64,
    ) -> Result<Vec<Self>, sqlx::Error> {
        sqlx::query_as::<_, Self>(&format!(
            "SELECT {RUN_COLS} FROM automation_runs WHERE automation_id = ? \
             ORDER BY started_at DESC LIMIT ?"
        ))
        .bind(automation_id)
        .bind(limit)
        .fetch_all(pool)
        .await
    }

    /// Drive any still-`running` runs to `interrupted` (host restart recovery).
    pub async fn interrupt_orphans(pool: &SqlitePool) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            "UPDATE automation_runs SET status='interrupted', finished_at=? WHERE status='running'",
        )
        .bind(Utc::now())
        .execute(pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn unseen_failure_count(pool: &SqlitePool) -> Result<i64, sqlx::Error> {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM automation_runs WHERE status IN ('failed','interrupted') AND seen = 0",
        )
        .fetch_one(pool)
        .await
    }

    pub async fn mark_all_seen(pool: &SqlitePool) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE automation_runs SET seen = 1 WHERE seen = 0")
            .execute(pool)
            .await?;
        Ok(())
    }
}

fn compatibility_launch(
    input: &AutomationInput,
) -> Result<(String, &'static str, bool), sqlx::Error> {
    let isolation = if matches!(
        input.isolation.as_str(),
        "new_worktree" | "worktree_per_run"
    ) {
        "worktree_per_run"
    } else {
        "shared_in_root"
    };
    let enabled = input.enabled && isolation == "worktree_per_run";
    let agent_id = input
        .executor
        .as_deref()
        .unwrap_or("codex")
        .to_ascii_lowercase();
    let launch = serde_json::json!({
        "specVersion": 1,
        "promptBlocks": [{"type": "text", "text": input.prompt}],
        "displayText": input.prompt,
        "agent": {"agentId": agent_id, "executorProfileId": null},
        "modeId": null,
        "configValues": [],
        "pluginActions": [],
        "skills": [],
        "workspace": {
            "projectId": input.project_id,
            "rootFolder": "",
            "branch": null,
            "isolation": isolation,
        },
        "labelSnapshot": input.name,
    });
    Ok((launch.to_string(), isolation, enabled))
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use chrono::Duration;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

    use super::*;

    /// In-memory database with the real migrations applied on a single
    /// connection. Foreign keys are irrelevant here (automations reference a
    /// project id but the schema declares no FK on it).
    async fn setup_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect memory db");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        pool
    }

    fn input(name: &str, trigger_kind: &str, cron: Option<&str>, enabled: bool) -> AutomationInput {
        AutomationInput {
            name: name.to_string(),
            project_id: Uuid::new_v4(),
            executor: Some("CLAUDE_CODE".to_string()),
            prompt: "run tests".to_string(),
            plugin_action_json: None,
            isolation: "new_worktree".to_string(),
            trigger_kind: trigger_kind.to_string(),
            cron: cron.map(ToOwned::to_owned),
            enabled,
        }
    }

    /// The due query's `next_run_at <= now` comparison happens on TEXT columns —
    /// verify the stored encoding actually compares correctly and the
    /// enabled/trigger filters hold.
    #[tokio::test]
    async fn due_returns_only_enabled_past_cron_automations() {
        let pool = setup_pool().await;
        let now = Utc::now();
        let past = Some(now - Duration::minutes(5));
        let future = Some(now + Duration::hours(1));

        let due_one = Automation::create(
            &pool,
            Uuid::new_v4(),
            &input("due", "cron", Some("* * * * *"), true),
            past,
        )
        .await
        .expect("create due");
        Automation::create(
            &pool,
            Uuid::new_v4(),
            &input("future", "cron", Some("0 3 * * *"), true),
            future,
        )
        .await
        .expect("create future");
        Automation::create(
            &pool,
            Uuid::new_v4(),
            &input("disabled", "cron", Some("* * * * *"), false),
            past,
        )
        .await
        .expect("create disabled");
        Automation::create(
            &pool,
            Uuid::new_v4(),
            &input("manual", "manual", None, true),
            None,
        )
        .await
        .expect("create manual");

        let due = Automation::due(&pool, now).await.expect("due query");
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, due_one.id);

        // Rolling the schedule forward removes it from the due set.
        Automation::set_next_run(&pool, due_one.id, future)
            .await
            .expect("set next run");
        assert!(Automation::due(&pool, now).await.expect("due").is_empty());
    }

    #[tokio::test]
    async fn structured_plugin_action_round_trips_with_the_automation() {
        let pool = setup_pool().await;
        let mut input = input("office", "manual", None, true);
        input.plugin_action_json =
            Some(r#"{"pluginId":"vibex.office","actionId":"create-presentation"}"#.into());
        let automation = Automation::create(&pool, Uuid::new_v4(), &input, None)
            .await
            .expect("create automation");
        assert_eq!(automation.plugin_action_json, input.plugin_action_json);

        let loaded = Automation::find_by_id(&pool, automation.id)
            .await
            .expect("load automation")
            .expect("automation exists");
        assert_eq!(loaded.plugin_action_json, input.plugin_action_json);
    }

    #[tokio::test]
    async fn run_lifecycle_failure_badge_and_orphan_recovery() {
        let pool = setup_pool().await;
        let automation = Automation::create(
            &pool,
            Uuid::new_v4(),
            &input("a", "manual", None, true),
            None,
        )
        .await
        .expect("create automation");

        // running → completed: no failure badge.
        let ok_run = AutomationRun::start(&pool, Uuid::new_v4(), automation.id, None)
            .await
            .expect("start run");
        AutomationRun::finish(
            &pool,
            ok_run.id,
            "completed",
            Some(Uuid::new_v4()),
            Some("ok"),
            None,
        )
        .await
        .expect("finish run");
        assert_eq!(
            AutomationRun::unseen_failure_count(&pool)
                .await
                .expect("count"),
            0
        );

        // running → failed: one unseen failure until marked seen.
        let failed_run = AutomationRun::start(&pool, Uuid::new_v4(), automation.id, None)
            .await
            .expect("start failed run");
        AutomationRun::finish(&pool, failed_run.id, "failed", None, None, Some("boom"))
            .await
            .expect("finish failed");
        assert_eq!(
            AutomationRun::unseen_failure_count(&pool)
                .await
                .expect("count"),
            1
        );
        AutomationRun::mark_all_seen(&pool)
            .await
            .expect("mark seen");
        assert_eq!(
            AutomationRun::unseen_failure_count(&pool)
                .await
                .expect("count"),
            0
        );

        // An orphaned `running` run is driven to `interrupted` on recovery and
        // counts as an unseen failure again.
        let orphan = AutomationRun::start(&pool, Uuid::new_v4(), automation.id, None)
            .await
            .expect("start orphan");
        let recovered = AutomationRun::interrupt_orphans(&pool)
            .await
            .expect("recover");
        assert_eq!(recovered, 1);
        let orphan = AutomationRun::find_by_id(&pool, orphan.id)
            .await
            .expect("find orphan")
            .expect("orphan exists");
        assert_eq!(orphan.status, "interrupted");
        assert!(orphan.finished_at.is_some());
        assert_eq!(
            AutomationRun::unseen_failure_count(&pool)
                .await
                .expect("count"),
            1
        );

        // Runs list is newest-first and capped by the limit.
        let runs = AutomationRun::list_for_automation(&pool, automation.id, 2)
            .await
            .expect("list runs");
        assert_eq!(runs.len(), 2);

        // Deleting the automation removes its runs.
        Automation::delete(&pool, automation.id)
            .await
            .expect("delete");
        let runs = AutomationRun::list_for_automation(&pool, automation.id, 10)
            .await
            .expect("list after delete");
        assert!(runs.is_empty());
    }
}
