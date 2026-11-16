//! Canonical Dual-Primitive Pulse Workflow orchestrator presets (`direct_reflex`,
//! `superagent_router`, `hybrid_pipeline`, `event_saga`, `window_aggregator`).

use crate::{
    graph_patch::{i64_prop, normalize_step, str_prop},
    json::Json,
};

pub fn build_preset_workflow(preset: &str, params: &Json) -> Result<Json, String> {
    let agent_id = str_prop(params, &["agentId", "agent_id"]).unwrap_or("codex");
    let member_id = str_prop(params, &["memberId", "member_id"]).unwrap_or("bot-lead");
    let reviewer_bot =
        str_prop(params, &["reviewerMemberId", "reviewer_member_id"]).unwrap_or(member_id);
    let max_iters = i64_prop(params, &["maxIterations", "max_iterations"]).unwrap_or(3);
    let timeout_secs = i64_prop(params, &["timeoutSeconds", "timeout_seconds"]).unwrap_or(3600);

    match preset {
        "direct_reflex" => Ok(Json::obj([
            ("schemaVersion", Json::Int(2)),
            (
                "name",
                Json::str(str_prop(params, &["name"]).unwrap_or("Direct Reflex Workflow")),
            ),
            ("orchestrator", Json::str("direct_reflex")),
            (
                "steps",
                Json::arr([
                    normalize_step(&Json::obj([
                        ("id", Json::str("execute_session")),
                        ("kind", Json::str("session")),
                        ("agentId", Json::str(agent_id)),
                        ("workspaceIsolation", Json::str("isolated_worktree")),
                        ("refreshContext", Json::Bool(true)),
                        (
                            "prompt",
                            Json::str(str_prop(params, &["prompt"]).unwrap_or(
                                "Handle incoming Pulse event {{event.type}} on {{threadKey}}.",
                            )),
                        ),
                        ("dependsOn", Json::arr([])),
                    ])),
                    normalize_step(&Json::obj([
                        ("id", Json::str("reply_outbox")),
                        ("kind", Json::str("outbox_action")),
                        ("actionKind", Json::str("reply_channel")),
                        (
                            "payloadTemplate",
                            Json::str("Completed direct reflex for {{threadKey}}."),
                        ),
                        ("dependsOn", Json::arr([Json::str("execute_session")])),
                    ])),
                ]),
            ),
        ])),
        "superagent_router" => Ok(Json::obj([
            ("schemaVersion", Json::Int(2)),
            (
                "name",
                Json::str(
                    str_prop(params, &["name"]).unwrap_or("Superagent Triage & Coding Router"),
                ),
            ),
            ("orchestrator", Json::str("superagent_router")),
            (
                "steps",
                Json::arr([
                    normalize_step(&Json::obj([
                        ("id", Json::str("triage_bot")),
                        ("kind", Json::str("bot")),
                        ("memberId", Json::str(member_id)),
                        ("preserveContext", Json::Bool(true)),
                        ("conversationScope", Json::str("fixed_primary")),
                        ("mailboxPolicy", Json::str("fifo_serial")),
                        (
                            "prompt",
                            Json::str(
                                "Triage incoming ticket {{threadKey}} using rolling project memory and emit implementation brief.",
                            ),
                        ),
                        ("dependsOn", Json::arr([])),
                    ])),
                    normalize_step(&Json::obj([
                        ("id", Json::str("implement_session")),
                        ("kind", Json::str("session")),
                        ("agentId", Json::str(agent_id)),
                        ("workspaceIsolation", Json::str("isolated_worktree")),
                        ("refreshContext", Json::Bool(true)),
                        (
                            "prompt",
                            Json::str(
                                "Implement the triaged fix in a clean isolated worktree and run verification tests.",
                            ),
                        ),
                        ("dependsOn", Json::arr([Json::str("triage_bot")])),
                        (
                            "inputBindings",
                            Json::obj([("triageBrief", Json::str("steps.triage_bot.output"))]),
                        ),
                    ])),
                    normalize_step(&Json::obj([
                        ("id", Json::str("reply_source")),
                        ("kind", Json::str("outbox_action")),
                        ("actionKind", Json::str("reply_channel")),
                        (
                            "payloadTemplate",
                            Json::str("Triage and implementation completed for {{threadKey}}."),
                        ),
                        ("dependsOn", Json::arr([Json::str("implement_session")])),
                    ])),
                ]),
            ),
        ])),
        "hybrid_pipeline" => Ok(Json::obj([
            ("schemaVersion", Json::Int(2)),
            (
                "name",
                Json::str(
                    str_prop(params, &["name"])
                        .unwrap_or("Hybrid Dual-Primitive Delivery Pipeline"),
                ),
            ),
            ("orchestrator", Json::str("hybrid_pipeline")),
            (
                "steps",
                Json::arr([
                    normalize_step(&Json::obj([
                        ("id", Json::str("plan_bot")),
                        ("kind", Json::str("bot")),
                        ("memberId", Json::str(member_id)),
                        ("preserveContext", Json::Bool(true)),
                        ("conversationScope", Json::str("fixed_primary")),
                        ("mailboxPolicy", Json::str("fifo_serial")),
                        (
                            "prompt",
                            Json::str(
                                "Synthesize architecture plan for {{threadKey}} from persistent Bot context.",
                            ),
                        ),
                        ("dependsOn", Json::arr([])),
                    ])),
                    normalize_step(&Json::obj([
                        ("id", Json::str("code_session")),
                        ("kind", Json::str("session")),
                        ("agentId", Json::str(agent_id)),
                        ("workspaceIsolation", Json::str("isolated_worktree")),
                        ("refreshContext", Json::Bool(true)),
                        (
                            "prompt",
                            Json::str(
                                "Execute implementation in fresh session context without prior turn pollution.",
                            ),
                        ),
                        ("dependsOn", Json::arr([Json::str("plan_bot")])),
                    ])),
                    normalize_step(&Json::obj([
                        ("id", Json::str("verify_bot")),
                        ("kind", Json::str("bot")),
                        ("memberId", Json::str(reviewer_bot)),
                        ("preserveContext", Json::Bool(true)),
                        ("conversationScope", Json::str("fixed_primary")),
                        ("mailboxPolicy", Json::str("fifo_serial")),
                        (
                            "prompt",
                            Json::str(
                                "Audit diff and test evidence; set /approved=true when ready.",
                            ),
                        ),
                        ("dependsOn", Json::arr([Json::str("code_session")])),
                    ])),
                    normalize_step(&Json::obj([
                        ("id", Json::str("review_loop")),
                        ("kind", Json::str("bounded_loop")),
                        ("maxIterations", Json::Int(max_iters)),
                        (
                            "bodyStepIds",
                            Json::arr([Json::str("code_session"), Json::str("verify_bot")]),
                        ),
                        ("conditionPointer", Json::str("/approved")),
                        ("onExhaustedStepId", Json::str("release_approval")),
                        ("dependsOn", Json::arr([Json::str("verify_bot")])),
                    ])),
                    normalize_step(&Json::obj([
                        ("id", Json::str("release_approval")),
                        ("kind", Json::str("user_gate")),
                        ("interactionKind", Json::str("approval")),
                        (
                            "title",
                            Json::str("Approve hybrid delivery for {{threadKey}}"),
                        ),
                        ("dependsOn", Json::arr([Json::str("review_loop")])),
                    ])),
                    normalize_step(&Json::obj([
                        ("id", Json::str("publish_outbox")),
                        ("kind", Json::str("outbox_action")),
                        ("actionKind", Json::str("reply_channel")),
                        (
                            "payloadTemplate",
                            Json::str("Hybrid pipeline approved and published for {{threadKey}}."),
                        ),
                        ("dependsOn", Json::arr([Json::str("release_approval")])),
                    ])),
                ]),
            ),
        ])),
        "event_saga" => Ok(Json::obj([
            ("schemaVersion", Json::Int(2)),
            (
                "name",
                Json::str(str_prop(params, &["name"]).unwrap_or("Stateful Event Saga")),
            ),
            ("orchestrator", Json::str("event_saga")),
            (
                "steps",
                Json::arr([
                    normalize_step(&Json::obj([
                        ("id", Json::str("prepare_session")),
                        ("kind", Json::str("session")),
                        ("agentId", Json::str(agent_id)),
                        ("workspaceIsolation", Json::str("isolated_worktree")),
                        ("refreshContext", Json::Bool(true)),
                        (
                            "prompt",
                            Json::str(
                                "Open candidate PR and emit verification checks for {{threadKey}}.",
                            ),
                        ),
                        ("dependsOn", Json::arr([])),
                    ])),
                    normalize_step(&Json::obj([
                        ("id", Json::str("await_ci_signal")),
                        ("kind", Json::str("wait_for_event")),
                        (
                            "eventTypes",
                            Json::arr([
                                Json::str("github.ci.passed"),
                                Json::str("github.pr.approved"),
                            ]),
                        ),
                        ("threadKeyPointer", Json::str("/threadKey")),
                        ("timeoutSeconds", Json::Int(timeout_secs)),
                        ("onTimeoutStepId", Json::str("sla_escalation_gate")),
                        ("dependsOn", Json::arr([Json::str("prepare_session")])),
                    ])),
                    normalize_step(&Json::obj([
                        ("id", Json::str("sla_escalation_gate")),
                        ("kind", Json::str("user_gate")),
                        ("interactionKind", Json::str("notify")),
                        (
                            "title",
                            Json::str("Event Saga timed out awaiting CI/review on {{threadKey}}"),
                        ),
                        ("dependsOn", Json::arr([])),
                    ])),
                    normalize_step(&Json::obj([
                        ("id", Json::str("finalize_bot")),
                        ("kind", Json::str("bot")),
                        ("memberId", Json::str(member_id)),
                        ("preserveContext", Json::Bool(true)),
                        ("conversationScope", Json::str("fixed_primary")),
                        ("mailboxPolicy", Json::str("fifo_serial")),
                        (
                            "prompt",
                            Json::str(
                                "Record release completion in long-lived Bot release ledger.",
                            ),
                        ),
                        ("dependsOn", Json::arr([Json::str("await_ci_signal")])),
                    ])),
                ]),
            ),
        ])),
        "window_aggregator" => Ok(Json::obj([
            ("schemaVersion", Json::Int(2)),
            (
                "name",
                Json::str(
                    str_prop(params, &["name"]).unwrap_or("Sliding Window Digest Aggregator"),
                ),
            ),
            ("orchestrator", Json::str("window_aggregator")),
            (
                "steps",
                Json::arr([
                    normalize_step(&Json::obj([
                        ("id", Json::str("digest_bot")),
                        ("kind", Json::str("bot")),
                        ("memberId", Json::str(member_id)),
                        ("preserveContext", Json::Bool(true)),
                        ("conversationScope", Json::str("fixed_primary")),
                        ("mailboxPolicy", Json::str("coalesce_batch")),
                        (
                            "prompt",
                            Json::str(
                                "Deduplicate and summarize batched alert window into actionable root causes.",
                            ),
                        ),
                        ("dependsOn", Json::arr([])),
                    ])),
                    normalize_step(&Json::obj([
                        ("id", Json::str("notify_digest")),
                        ("kind", Json::str("user_gate")),
                        ("interactionKind", Json::str("notify")),
                        ("title", Json::str("Aggregated Pulse Window Digest")),
                        ("dependsOn", Json::arr([Json::str("digest_bot")])),
                    ])),
                ]),
            ),
        ])),
        other => Err(format!(
            "Unsupported preset '{other}'; expected direct_reflex, superagent_router, hybrid_pipeline, event_saga, or window_aggregator."
        )),
    }
}
