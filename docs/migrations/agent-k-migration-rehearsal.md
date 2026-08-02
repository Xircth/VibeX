# Agent K Migration Rehearsal

- Base SHA: `650164ebf7afd1ec8ae0b258fc422e28e9d31c47`
- Fixtures: `crates/db/tests/fixtures/agent_k_sanitized_legacy.sql` and
  `agent_k_sanitized_legacy_token.sql`
- Harness: `crates/db/tests/agent_k_migration_rehearsal.rs`
- Production entry point: `DBService::new_at`

The fixture uses synthetic UUIDs, names, prompt, paths and timestamps while
preserving the table/column shape of a pre-Automation-v2 data directory. It
contains an external Plugin with a marker-bearing `install_command`, an
enabled in-place scheduled Automation, and a running legacy Run.
The second fixture contains only a synthetic 32-byte token digest plus legacy
scope JSON; it contains no recoverable credential.

## Observed upgrade

| Legacy evidence | Migrated result |
|---|---|
| External Plugin v1 | Full original manifest retained in `plugin_legacy_evidence`; status `migration_required`; command marker absent. |
| In-place Automation | Disabled `shared_in_root` draft, versioned launch spec, local timezone resolved once, `next_run_at` cleared. |
| Running Automation Run | `interrupted`, `stop_reason=host_restarted`, terminal timestamp present. |
| Restart after migration | One Plugin evidence row and one Interrupted Run; no duplicate/relaunch and no permanently running row. |
| Server master token | Exact digest preserved; canonical admin scopes (including pairing, notification and offline read) upgraded; no plaintext introduced. |

The rehearsal runs the historical SQLx migrations only to the sanitized
fixture cutoff, loads the fixture, then opens it through the current production
initializer twice. No one-off repair SQL is used.

## Operator migration procedure

Stop all hosts, take a consistent data-directory snapshot, upgrade, then start
exactly one host. Review all `migration_required` Plugin and Automation drafts.
Do not translate or run an old `install_command`. If startup is interrupted,
restart the same version; SQLx migrations and evidence capture are idempotent.

Forward migrations are not down migrations. Rollback requires stopping all
hosts and restoring the complete pre-upgrade snapshot, not selectively copying
the SQLite main file.
