# Product

## Register

product

## Users

VibeX serves developers who use AI coding agents as part of real project work. They manage projects, isolated worktrees, sessions, terminals, previews, diffs, review comments, and follow-up prompts from one local desktop workspace.

The primary user is already technical and task-focused. They are often comparing agent output, watching execution state, verifying code changes, and deciding whether to continue, retry, review, or merge. The interface should support repeated use under high information density without feeling chaotic.

## Product Purpose

VibeX is a local-first orchestration workspace for AI coding agents. It brings Claude Code, OpenAI Codex, OpenCode, Gemini, Cursor Agent CLI, Amp, and related agent workflows into one desktop product with project isolation, visible execution, preview, review, and follow-up loops.

Success means the user can keep multiple AI-assisted coding tasks moving without losing control of source state, session context, terminal output, or review evidence. The product should reduce switching between terminal, browser, editor, and agent CLI, while preserving the developer's final judgment.

## Brand Personality

Calm, inspectable, and precise.

VibeX should feel like a serious engineering cockpit rather than a promotional AI dashboard. It can be polished, but the polish must serve scanability, state clarity, and confidence. The tone should be direct, technical enough for developers, and restrained enough for long daily sessions.

## Anti-references

- Generic AI SaaS dashboards with oversized cards, decorative gradients, glass panels, and vague productivity claims.
- Terminal-only complexity copied directly into the UI without grouping, progressive disclosure, or visual hierarchy.
- Dark-mode-by-default tool aesthetics that rely on neon, purple-blue glow, or dramatic contrast instead of usable structure.
- Inconsistent component vocabulary where settings, workspace, dialogs, file tree, conversation, and Kanban each feel designed by a different product.
- Heavy side-stripe accents, pure black or pure white surfaces, and large rounded cards used as decoration.

## Design Principles

1. Make state visible before making it beautiful. Agent status, queue state, workspace selection, diff state, and execution ownership must be readable at a glance.
2. Keep the tool dense but calm. Density is acceptable because the audience is technical, but every surface needs rhythm, grouping, and consistent component behavior.
3. Use one product vocabulary. Buttons, cards, inputs, chips, dialogs, tabs, and toasts should share radius, border, focus, and hover logic across the app.
4. Treat color as information. Accent color marks selection, primary action, focus, and status. It should not become background decoration.
5. Prefer inspectable structure over theatrical UI. Panels, lists, code views, logs, and previews should feel durable and work-focused.

## Accessibility & Inclusion

Target WCAG AA contrast for text, controls, and state indicators. Do not use color alone to communicate task, git, agent, or queue state. Keyboard navigation matters because the product is built for developers. Motion should be short and state-driven, with reduced-motion fallbacks for nonessential transitions.
