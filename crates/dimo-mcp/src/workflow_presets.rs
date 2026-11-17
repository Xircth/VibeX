//! Canonical Dual-Primitive Pulse Workflow orchestrator presets (`direct_reflex`,
//! `superagent_router`, `hybrid_pipeline`, `event_saga`, `window_aggregator`).

use serde_json::{Value, json};

use crate::workflow_patch::{i64_prop, normalize_step, str_prop};

pub fn build_preset_workflow(preset: &str, params: &Value) -> Result<Value, String> {
    let agent_id = str_prop(params, &["agentId", "agent_id"]).unwrap_or("codex");
    let member_id = str_prop(params, &["memberId", "member_id"]).unwrap_or("bot-lead");
    let reviewer_bot =
        str_prop(params, &["reviewerMemberId", "reviewer_member_id"]).unwrap_or(member_id);
    let max_iters = i64_prop(params, &["maxIterations", "max_iterations"]).unwrap_or(3);
    let timeout_secs = i64_prop(params, &["timeoutSeconds", "timeout_seconds"]).unwrap_or(3600);

    match preset {
        "direct_reflex" => Ok(json!({
            "schemaVersion": 2,
            "name": str_prop(params, &["name"]).unwrap_or("Direct Reflex Workflow"),
            "orchestrator": "direct_reflex",
            "steps": [
                normalize_step(&json!({
                    "id": "execute_session",
                    "kind": "session",
                    "agentId": agent_id,
                    "workspaceIsolation": "isolated_worktree",
                    "refreshContext": true,
                    "prompt": str_prop(params, &["prompt"]).unwrap_or(
                        "Handle incoming Pulse event {{event.type}} on {{threadKey}}."
                    ),
                    "dependsOn": [],
                })),
                normalize_step(&json!({
                    "id": "reply_outbox",
                    "kind": "outbox_action",
                    "actionKind": "reply_channel",
                    "payloadTemplate": "Completed direct reflex for {{threadKey}}.",
                    "dependsOn": ["execute_session"],
                })),
            ],
        })),
        "superagent_router" => Ok(json!({
            "schemaVersion": 2,
            "name": str_prop(params, &["name"]).unwrap_or("Superagent Triage & Coding Router"),
            "orchestrator": "superagent_router",
            "steps": [
                normalize_step(&json!({
                    "id": "triage_bot",
                    "kind": "bot",
                    "memberId": member_id,
                    "preserveContext": true,
                    "conversationScope": "fixed_primary",
                    "mailboxPolicy": "fifo_serial",
                    "prompt": "Triage incoming ticket {{threadKey}} using rolling project memory and emit implementation brief.",
                    "dependsOn": [],
                })),
                normalize_step(&json!({
                    "id": "implement_session",
                    "kind": "session",
                    "agentId": agent_id,
                    "workspaceIsolation": "isolated_worktree",
                    "refreshContext": true,
                    "prompt": "Implement the triaged fix in a clean isolated worktree and run verification tests.",
                    "dependsOn": ["triage_bot"],
                    "inputBindings": {
                        "triageBrief": "steps.triage_bot.output"
                    },
                })),
                normalize_step(&json!({
                    "id": "reply_source",
                    "kind": "outbox_action",
                    "actionKind": "reply_channel",
                    "payloadTemplate": "Triage and implementation completed for {{threadKey}}.",
                    "dependsOn": ["implement_session"],
                })),
            ],
        })),
        "hybrid_pipeline" => Ok(json!({
            "schemaVersion": 2,
            "name": str_prop(params, &["name"]).unwrap_or("Hybrid Dual-Primitive Delivery Pipeline"),
            "orchestrator": "hybrid_pipeline",
            "steps": [
                normalize_step(&json!({
                    "id": "plan_bot",
                    "kind": "bot",
                    "memberId": member_id,
                    "preserveContext": true,
                    "conversationScope": "fixed_primary",
                    "mailboxPolicy": "fifo_serial",
                    "prompt": "Synthesize architecture plan for {{threadKey}} from persistent Bot context.",
                    "dependsOn": [],
                })),
                normalize_step(&json!({
                    "id": "code_session",
                    "kind": "session",
                    "agentId": agent_id,
                    "workspaceIsolation": "isolated_worktree",
                    "refreshContext": true,
                    "prompt": "Execute implementation in fresh session context without prior turn pollution.",
                    "dependsOn": ["plan_bot"],
                })),
                normalize_step(&json!({
                    "id": "verify_bot",
                    "kind": "bot",
                    "memberId": reviewer_bot,
                    "preserveContext": true,
                    "conversationScope": "fixed_primary",
                    "mailboxPolicy": "fifo_serial",
                    "prompt": "Audit diff and test evidence; set /approved=true when ready.",
                    "dependsOn": ["code_session"],
                })),
                normalize_step(&json!({
                    "id": "review_loop",
                    "kind": "bounded_loop",
                    "maxIterations": max_iters,
                    "bodyStepIds": ["code_session", "verify_bot"],
                    "conditionPointer": "/approved",
                    "onExhaustedStepId": "release_approval",
                    "dependsOn": ["verify_bot"],
                })),
                normalize_step(&json!({
                    "id": "release_approval",
                    "kind": "user_gate",
                    "interactionKind": "approval",
                    "title": "Approve hybrid delivery for {{threadKey}}",
                    "dependsOn": ["review_loop"],
                })),
                normalize_step(&json!({
                    "id": "publish_outbox",
                    "kind": "outbox_action",
                    "actionKind": "reply_channel",
                    "payloadTemplate": "Hybrid pipeline approved and published for {{threadKey}}.",
                    "dependsOn": ["release_approval"],
                })),
            ],
        })),
        "event_saga" => Ok(json!({
            "schemaVersion": 2,
            "name": str_prop(params, &["name"]).unwrap_or("Stateful Event Saga"),
            "orchestrator": "event_saga",
            "steps": [
                normalize_step(&json!({
                    "id": "prepare_session",
                    "kind": "session",
                    "agentId": agent_id,
                    "workspaceIsolation": "isolated_worktree",
                    "refreshContext": true,
                    "prompt": "Open candidate PR and emit verification checks for {{threadKey}}.",
                    "dependsOn": [],
                })),
                normalize_step(&json!({
                    "id": "await_ci_signal",
                    "kind": "wait_for_event",
                    "eventTypes": ["github.ci.passed", "github.pr.approved"],
                    "threadKeyPointer": "/threadKey",
                    "timeoutSeconds": timeout_secs,
                    "onTimeoutStepId": "sla_escalation_gate",
                    "dependsOn": ["prepare_session"],
                })),
                normalize_step(&json!({
                    "id": "sla_escalation_gate",
                    "kind": "user_gate",
                    "interactionKind": "notify",
                    "title": "Event Saga timed out awaiting CI/review on {{threadKey}}",
                    "dependsOn": [],
                })),
                normalize_step(&json!({
                    "id": "finalize_bot",
                    "kind": "bot",
                    "memberId": member_id,
                    "preserveContext": true,
                    "conversationScope": "fixed_primary",
                    "mailboxPolicy": "fifo_serial",
                    "prompt": "Record release completion in long-lived Bot release ledger.",
                    "dependsOn": ["await_ci_signal"],
                })),
            ],
        })),
        "window_aggregator" => Ok(json!({
            "schemaVersion": 2,
            "name": str_prop(params, &["name"]).unwrap_or("Sliding Window Digest Aggregator"),
            "orchestrator": "window_aggregator",
            "steps": [
                normalize_step(&json!({
                    "id": "digest_bot",
                    "kind": "bot",
                    "memberId": member_id,
                    "preserveContext": true,
                    "conversationScope": "fixed_primary",
                    "mailboxPolicy": "coalesce_batch",
                    "prompt": "Deduplicate and summarize batched alert window into actionable root causes.",
                    "dependsOn": [],
                })),
                normalize_step(&json!({
                    "id": "notify_digest",
                    "kind": "user_gate",
                    "interactionKind": "notify",
                    "title": "Aggregated Pulse Window Digest",
                    "dependsOn": ["digest_bot"],
                })),
            ],
        })),
        other => Err(format!(
            "Unsupported preset '{other}'; expected direct_reflex, superagent_router, hybrid_pipeline, event_saga, or window_aggregator."
        )),
    }
}
