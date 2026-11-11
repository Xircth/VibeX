---
name: orchestrate
description: Supervise long-running or multi-subagent implementation loops autonomously. Use when orchestrating multi-step plans, supervising background subagents or tasks, tracking milestone checklists and ETAs, or deciding whether to proceed autonomously vs escalate to the user.
---

# Autonomous Supervision Protocol (`orchestrate`)

Run multi-step implementation and subagent supervision loops with high autonomy, quantitative progress accounting, post-hoc decision transparency, and hard circuit-breaker redlines.

## 1. Establish Countable Percent & ETA Slip Trajectory

Before launching background tasks or subagents, decompose the work into a fixed, numbered checklist of verifiable deliverables (`N` items total) and state an initial time estimate (`ETA Xm`).

Every status update must report a **Countable Percent** (bound to an explicit denominator, never an unanchored subjective percentage) and carry the full **ETA slip trajectory**:

```markdown
**Progress**: 5 of 8 items = 63% | **ETA**: 40m (was 20m, second slip)
```

- **GOOD**: `5 of 8 items = 63% | ETA 40m (was 20m, second slip)` — binds the percentage to verifiable items and states the exact slip trajectory.
- **BAD**: `Almost done (~75%), should finish soon` — subjective percentage with no denominator and untrackable ETA.

**Completion criterion**: The checklist has `N` numbered items with binary pass/fail verification, and the baseline `0 of N items = 0% | ETA Xm (initial)` is recorded.

## 2. Apply the 80% Confidence Rule & `DECIDED WITHOUT ASKING` Ledger

When an implementation fork, library trade-off, or local boundary decision arises during execution, estimate your confidence in the best option based on repository conventions, spec constraints, and empirical codebase evidence:

- **Confidence ≥ 80%** (reversible decision, grounded in existing codebase patterns or spec requirements): Decide immediately and continue execution without pausing for human input. Append one line per decision (`chosen option + rejected alternative + brief rationale`) to the `DECIDED WITHOUT ASKING` ledger for the next status report:
  ```markdown
  ### DECIDED WITHOUT ASKING
  - Used `status.after-mcp` status-bar slot over top-level `app.tab` — matches v4 non-core plugin placement spec and preserves one-click modal entry.
  - Clamped burst screenshot `overMs` to `5000ms` max over unbounded duration — prevents stdio MCP request timeouts.
  ```
- **Confidence < 80%** (irreversible destructive operation, external billing/credential boundary, product scope change, or genuine tie between incompatible user-facing behaviors): Pause only the blocked track, continue independent tracks if any, and ask the user with concrete options and trade-offs.

**Completion criterion**: Every autonomous decision made during the cycle is logged as a single line (`[Chosen option] over [rejected alternative] — [evidence/rationale]`) in the `DECIDED WITHOUT ASKING` section of the status or completion report, giving the user post-hoc veto power without mid-run blocking.

## 3. Enforce the Three Circuit-Breaker Escalation Redlines

At every supervision tick (when a subagent returns, a test suite finishes, or a check timer fires), evaluate three quantitative circuit breakers. If **any** redline trips, stop automated retries on that track immediately and escalate to the user with the concrete failure state:

| Redline | Trigger Condition | Required Escalation Payload |
| :--- | :--- | :--- |
| **1. Fix-Loop Redline (`3-strike failure`)** | **3 consecutive fix rounds** on the same issue or test failure fail to resolve it. | Exact error output, the 3 attempted hypotheses/diffs, and why each failed. |
| **2. Stall Redline (`2-cycle 0% progress`)** | **2 consecutive supervision check cycles** show `0%` countable progress movement (`k of N` unchanged). | Which checklist item is stalled, what subagent/task is holding it, and the blocker. |
| **3. ETA Slip Redline (`2nd ETA slip`)** | **2 consecutive upward ETA slips** occur on the same milestone (e.g., `ETA 40m (was 20m, second slip)`). | Remaining checklist items, reason for the second slip, and options to descope or repartition. |

**Completion criterion**: Every supervision tick updates `{ fixRound, completedItems, etaSlipCount }` and either advances the checklist or halts and delivers the structured escalation payload when a redline trips.

## 4. Log Tool & Skill Friction Notes

When a tool call fails in a surprising way, a skill instruction leaves an edge case ambiguous, or you have to invent a workaround during orchestration, record a compact friction entry in `docs/friction-diary.md` (or in the final report's `Friction Notes` block when operating outside `docs/`):

```markdown
- **[YYYY-MM-DD] [Skill/Tool Name]**: [1-sentence symptom] → [Workaround used] → [Proposed permanent fix in skill or tool schema].
```

**Completion criterion**: All non-obvious tool or skill workarounds encountered during the session are captured with a concrete upstream fix recommendation.
