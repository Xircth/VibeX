# FE-002 ActionBar Content Gate Cleanup Plan

## Scope

- Remove the duplicate queueable-content predicate from `ActionBar`.
- Reuse `hasFollowUpContent` from `sessionComposerSubmit` so send and queue UI eligibility share the same content definition.
- Keep button rendering, labels, and queue/stop/send behavior unchanged.

## Behavior Lock

- Extend `ActionBar.test.tsx` to cover queue button enablement from conflict text, review text, and image attachments when the draft message is blank.
- Also cover the no-content running-attempt state keeping the queue button disabled.

## Cleanup Steps

1. Add the focused `ActionBar` tests before implementation.
2. Replace the inline `localMessage.trim() || conflictResolutionInstructions || reviewMarkdown || attachmentCount > 0` check with `hasFollowUpContent`.
3. Run targeted action-bar tests, follow-up directory tests, typecheck, lint, full checks, and whitespace check.

## Non-Goals

- Do not change `hasFollowUpContent` semantics.
- Do not alter queue mutation payload construction.
- Do not redesign `ActionBar` props in this pass.
