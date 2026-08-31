# Workspace UX and process surfaces — implementation plan

Source of truth: [ADR-0068](../adr/0068-workspace-default-surfaces-and-activity.md).

## Order

1. Desktop toast native transparency.
2. Conversation overlay + collapse de-duplication.
3. `TurnFileChangesCard` width.
4. Web Preview current-tab navigation.
5. Agent long-running terminals in the workspace terminal list.
6. Workspace activity list (sessions / background / notices) with session span chart.
7. Notes editor clipping.
8. Toolbar toggle i18n.
9. Default workspace = project folder on current branch.
10. Full re-verification.

## Seams under test

- `overlayLiveText` / collapse split: one assistant text block, not two.
- BrowserPanel address submit: navigates current tab; popups still call `onOpenExternalTab`.
- Workspace branch options and fallback resolver: project-root on current branch wins.
- Agent terminal title: `Codex-01` style, unique per workspace.
- Activity model: session spans, background terminals, notices from existing facts.
- Desktop toast window builder: transparent, no decorations, no shadow.

## Out of scope

- Reintroducing agent execution on `ExecutionProcess`.
- Changing ACP terminal protocol.
- Syncing Dockview layout across devices (ADR-0042).
