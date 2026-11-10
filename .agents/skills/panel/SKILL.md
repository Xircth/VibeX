---
name: panel
description: Run a mutually blind parallel review panel across distinct subagent seats or model families for architectural decisions, RFCs, complex refactors, or high-stakes code changes. Use when the user asks for a panel review, multi-model critique, blind architectural evaluation, or when a decision has high blast radius.
---

# Heterogeneous Multi-Seat Blind Review Panel (`panel`)

Evaluate high-stakes architectural decisions, RFCs, specs, or large changesets by convening a mutually blind parallel panel of independent reviewer seats and synthesizing their findings by signal strength.

## Step 1: Frame a Neutral Brief & Launch the Blind Panel

Prepare a self-contained review brief that includes:
1. **Artifact paths or diff range** to inspect.
2. **Context and constraints** (target behavior, invariants, non-goals).
3. **Neutral evaluation question** (state the options or design under review without telegraphing a preferred verdict).

Launch **2 to 3 reviewer subagents in parallel** within a single `invoke_subagent` (or `delegate_to_agent`) call.
- When the environment supports distinct model families or explicitly requested model tiers, assign heterogeneous families across seats to decorrelate model blind spots.
- When running on a single inherited model tier, assign orthogonal architectural lenses to each seat:
  - **Seat 1 — Systems & Failure Modes**: Concurrency, state lifecycles, error recovery, resource leaks, and security boundaries.
  - **Seat 2 — Module Depth & Interfaces**: Interface simplicity vs implementation depth (see `codebase-design`), boundary seams, and coupling.
  - **Seat 3 — Spec & Domain Invariants**: Fidelity to product requirements, edge-case completeness, and backward compatibility.

Include these rules in every seat's prompt:
- **Mutually blind execution**: Inspect only the repository and the brief. Do not read other subagents' transcripts or artifacts.
- **Hard cap of 5 fundamental directional issues**: Report at most 5 high-impact architectural, correctness, security, or spec flaws, ordered by severity. Omit formatting or naming nitpicks.
- **Concrete citations**: Anchor every issue to `file:line` or a specific spec section, and state what breaks if left unaddressed.

**Completion criterion**: All parallel reviewer seats are launched in a single turn with neutral briefs and return independent reports of at most 5 cited findings each.

## Step 2: Classify & Verify Findings by Signal Strength

Wait for all seats to return. Default to **1 round** of panel review (hard maximum: **2 rounds** only when a factual contradiction requires a targeted follow-up check). Classify every unique finding into one of three buckets:

| Signal Class | Condition | Moderator Action |
| :--- | :--- | :--- |
| **1. Consensus (Strong Signal — Adopt)** | **2+ independent blind seats / model families** identify the same underlying flaw or architectural risk. | Accept directly into the required action plan without re-litigating. |
| **2. Lone-Voice (Hypothesis — Verify in Source)** | **Only 1 seat** raises the concern. | Read the cited `file:line` and call path yourself. If confirmed by code evidence, promote to **Confirmed Finding**; if disproven by actual code, mark **Discarded (False Positive)** with the disproving citation. |
| **3. Split Decision (Escalate to User)** | Seats recommend **mutually exclusive directions** backed by valid trade-offs. | Distill the strongest evidence for each side into a compact decision matrix and escalate to the user to choose. |

**Completion criterion**: Every finding from all seats is assigned to one of the three signal classes, and every single-seat hypothesis has been verified against the actual source files.

## Step 3: Publish the Synthesis Report

Present the consolidated panel outcome in three sections:

```markdown
## Panel Synthesis (<target / branch / RFC>)

### 1. Strong Signals (Cross-Seat Agreement — Adopted)
- **[Issue title]** (`Seat 1, Seat 2` — `path/to/file.ts:L42`): [Impact and required fix].

### 2. Single-Seat Hypotheses (Moderator Verified)
- **[Confirmed]** `[Issue title]` (`Seat 3` — `path/to/file.ts:L108`): Verified in source; [evidence and fix].
- **[Discarded]** `[Claim]` (`Seat 1` — `path/to/file.ts:L19`): Disproven; line 24 already guards against null via `normalizeConfig()`.

### 3. Split Decisions for User Resolution (if any)
- **[Decision topic]**:
  - **Option A (`Seat 1`)**: [Strongest argument + trade-off].
  - **Option B (`Seat 2`)**: [Strongest argument + trade-off].
```

**Completion criterion**: The synthesis report separates cross-seat agreements, source-verified single-seat hypotheses, and any unresolved splits requiring human judgment.
