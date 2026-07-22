# VibeX launch-site prototype

Question: which information architecture best explains VibeX to developers evaluating a local-first AI coding workspace?

Run `pnpm --filter @vibex/launch-site dev`, then compare:

- `/?variant=A` — Flight deck: product UI and controllable workflow lead the story.
- `/?variant=B` — Evidence chain: the lifecycle of one task leads the story.
- `/?variant=C` — Agent formation: multi-agent orchestration leads the story.

Current default: A. It makes the product tangible fastest and keeps the differentiation—inspectable state, local worktrees, and human review—above the fold.

Verdict: pending visual review. Once confirmed, promote the winner and delete the prototype switcher and losing variants.
