use std::str::FromStr;

use automation::{
    AutomationDraft, AutomationTarget, ClaimStorePort, IsolationSpec, RecoveryStorePort,
    ScheduleSpec, WORKFLOW_AUTOMATION_SPEC_VERSION, WorkflowAutomationDraft, WorkflowLaunchSpec,
    WorkspaceTarget,
};
use chrono::Utc;
use db::models::automation_v2::SqliteAutomationStore;
use sqlx::{
    Executor,
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
};
use uuid::Uuid;

#[tokio::test]
async fn automation_v2_migration_preserves_intent_safely() {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .expect("sqlite options")
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("memory database");

    pool.execute(
        "CREATE TABLE automations (
            id BLOB PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            project_id BLOB NOT NULL,
            executor TEXT,
            prompt TEXT NOT NULL,
            isolation TEXT NOT NULL,
            trigger_kind TEXT NOT NULL,
            cron TEXT,
            enabled INTEGER NOT NULL,
            next_run_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            plugin_action_json TEXT
        );
        CREATE TABLE automation_runs (
            id BLOB PRIMARY KEY NOT NULL,
            automation_id BLOB NOT NULL,
            status TEXT NOT NULL,
            conversation_id BLOB,
            summary TEXT,
            error TEXT,
            seen INTEGER NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT
        );",
    )
    .await
    .expect("legacy schema");

    let automation_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let now = Utc::now();
    sqlx::query(
        "INSERT INTO automations
         (id,name,project_id,executor,prompt,isolation,trigger_kind,cron,enabled,
          next_run_at,created_at,updated_at,plugin_action_json)
         VALUES (?,?,?,?,?,'in_place','cron','30 9 * * 1',1,?,?,?,?)",
    )
    .bind(automation_id)
    .bind("Legacy review")
    .bind(project_id)
    .bind("CODEX")
    .bind("Review this project")
    .bind(now)
    .bind(now)
    .bind(now)
    .bind(r#"{"pluginId":"vibex.office","actionId":"create-presentation"}"#)
    .execute(&pool)
    .await
    .expect("legacy automation");
    sqlx::query(
        "INSERT INTO automation_runs
         (id,automation_id,status,seen,started_at)
         VALUES (?,?,'running',0,?)",
    )
    .bind(run_id)
    .bind(automation_id)
    .bind(now)
    .execute(&pool)
    .await
    .expect("legacy run");

    pool.execute(include_str!(
        "../migrations/20260730110000_automation_v2.sql"
    ))
    .await
    .expect("v2 migration");

    let row: (bool, String, i64, String, String, String) = sqlx::query_as(
        "SELECT enabled, isolation, spec_version, timezone,
                legacy_migration_status, turn_launch_spec_json
         FROM automations WHERE id = ?",
    )
    .bind(automation_id)
    .fetch_one(&pool)
    .await
    .expect("migrated automation");
    assert!(!row.0, "unsafe in-place automations stay disabled");
    assert_eq!(row.1, "shared_in_root");
    assert_eq!(row.2, 1);
    assert!(!row.3.is_empty(), "an explicit IANA timezone is persisted");
    assert_eq!(row.4, "migration_required");
    let spec: serde_json::Value = serde_json::from_str(&row.5).expect("valid launch spec");
    assert_eq!(spec["displayText"], "Review this project");
    assert_eq!(spec["agent"]["agentId"], "codex");
    assert_eq!(spec["workspace"]["isolation"], "shared_in_root");

    let run: (String, Option<String>) =
        sqlx::query_as("SELECT status, finished_at FROM automation_runs WHERE id = ?")
            .bind(run_id)
            .fetch_one(&pool)
            .await
            .expect("migrated run");
    assert_eq!(run.0, "interrupted");
    assert!(run.1.is_some());

    let evidence: String = sqlx::query_scalar(
        "SELECT evidence_json FROM automation_legacy_evidence WHERE automation_id = ?",
    )
    .bind(automation_id)
    .fetch_one(&pool)
    .await
    .expect("legacy evidence");
    assert!(evidence.contains("in_place"));
    assert!(evidence.contains("Review this project"));
    assert!(evidence.contains("legacy_local_pending"));

    let error = SqliteAutomationStore::new(pool)
        .run_now(automation_id, Utc::now())
        .await
        .expect_err("migration-required drafts must never execute");
    assert!(error.to_string().contains("must be reviewed"));
}

#[tokio::test]
async fn sqlite_claim_is_transactional_across_concurrent_ticks() {
    let temp = tempfile::tempdir().expect("temp directory");
    let database = temp.path().join("automation.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(&database)
        .create_if_missing(true)
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .expect("temp database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations");
    let store = SqliteAutomationStore::new(pool.clone());
    let mut draft: AutomationDraft = automation::BuiltinTemplateCatalog::all().remove(0).draft;
    draft.enabled = true;
    draft.trigger = ScheduleSpec::Schedule {
        cron: "* * * * *".to_string(),
        timezone: "UTC".to_string(),
    };
    let now = Utc::now();
    let automation = store.create(draft, now).await.expect("create");
    let due_at = now - chrono::Duration::minutes(5);
    sqlx::query("UPDATE automations SET next_run_at = ? WHERE id = ?")
        .bind(due_at)
        .bind(automation.id)
        .execute(&pool)
        .await
        .expect("force due");

    let (first, second) = tokio::join!(store.claim_due(now), store.claim_due(now));
    let claimed = first
        .expect("first claim")
        .into_iter()
        .chain(second.expect("second claim"))
        .collect::<Vec<_>>();

    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].scheduled_for, due_at);
    assert!(claimed[0].next_run_at.is_some_and(|next| next > now));
    let running: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM automation_runs
         WHERE automation_id = ? AND status = 'running'",
    )
    .bind(automation.id)
    .fetch_one(&pool)
    .await
    .expect("running count");
    assert_eq!(running, 1);
}

#[tokio::test]
async fn automation_record_projects_last_status_and_unseen_failures() {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .expect("sqlite options")
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("memory database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations");
    let store = SqliteAutomationStore::new(pool.clone());
    let automation = store
        .create(
            automation::BuiltinTemplateCatalog::all().remove(0).draft,
            Utc::now(),
        )
        .await
        .expect("create");
    sqlx::query(
        "UPDATE automations
         SET last_run_status = 'interrupted', unseen_failure_count = 2
         WHERE id = ?",
    )
    .bind(automation.id)
    .execute(&pool)
    .await
    .expect("record failure projection");

    let loaded = store
        .find(automation.id)
        .await
        .expect("load")
        .expect("automation");
    assert_eq!(loaded.last_run_status.as_deref(), Some("interrupted"));
    assert_eq!(loaded.unseen_failure_count, 2);
}

#[tokio::test]
async fn workflow_automation_round_trips_and_links_its_run() {
    let options = SqliteConnectOptions::from_str("sqlite::memory:")
        .expect("sqlite options")
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("memory database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations");
    let store = SqliteAutomationStore::new(pool);
    let definition_version_id = Uuid::new_v4();
    let workspace_id = Uuid::new_v4();
    let automation = store
        .create_workflow(
            WorkflowAutomationDraft {
                name: "nightly workflow".to_string(),
                enabled: true,
                trigger: ScheduleSpec::Manual,
                launch: WorkflowLaunchSpec {
                    spec_version: WORKFLOW_AUTOMATION_SPEC_VERSION,
                    definition_version_id,
                    input: serde_json::json!({ "scope": "changed" }),
                    policy_override: None,
                    workspace: WorkspaceTarget {
                        project_id: Uuid::new_v4(),
                        root_folder: "/tmp/project".to_string(),
                        branch: Some("main".to_string()),
                        isolation: IsolationSpec::WorktreePerRun,
                    },
                },
            },
            Utc::now(),
        )
        .await
        .expect("create workflow automation");
    assert!(matches!(
        automation.target,
        AutomationTarget::Workflow(ref spec)
            if spec.definition_version_id == definition_version_id
                && spec.input == serde_json::json!({ "scope": "changed" })
    ));

    let run = store
        .run_now(automation.id, Utc::now())
        .await
        .expect("claim manual run");
    let workflow_run_id = Uuid::new_v4();
    store
        .attach_workflow_run(run.snapshot.run_id, workflow_run_id, workspace_id)
        .await
        .expect("link workflow run");
    let loaded = store
        .run(run.snapshot.run_id)
        .await
        .expect("load run")
        .expect("run exists");
    assert_eq!(loaded.workflow_run_id, Some(workflow_run_id));
    assert_eq!(loaded.snapshot.workspace_id, Some(workspace_id));

    let interrupted = store
        .interrupt_running(Utc::now())
        .await
        .expect("startup recovery");
    assert!(interrupted.is_empty());
    assert_eq!(
        store
            .run(run.snapshot.run_id)
            .await
            .expect("reload linked run")
            .expect("linked run exists")
            .snapshot
            .status,
        automation::RunStatus::Running
    );
}

#[tokio::test]
async fn sqlite_shared_root_lease_excludes_other_runs_until_release() {
    let temp = tempfile::tempdir().expect("temp directory");
    let database = temp.path().join("automation-root-lock.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(&database)
        .create_if_missing(true)
        .foreign_keys(false);
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(options)
        .await
        .expect("temp database");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations");
    let store = SqliteAutomationStore::new(pool);
    let first_run = Uuid::new_v4();
    let second_run = Uuid::new_v4();
    let root = "/workspaces/shared-project";

    assert!(
        store
            .try_acquire_shared_root(root, first_run, Utc::now())
            .await
            .expect("first lease")
    );
    assert!(
        !store
            .try_acquire_shared_root(root, second_run, Utc::now())
            .await
            .expect("competing lease")
    );

    store.release_shared_root(first_run).await.expect("release");
    assert!(
        store
            .try_acquire_shared_root(root, second_run, Utc::now())
            .await
            .expect("lease after release")
    );
}
