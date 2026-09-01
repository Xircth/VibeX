# Windows Host CPU / Memory — Optimization Plan

Date: 2026-08-31
Branch: `perf/windows-host-baseline`
Decision basis: ADR-0007, ADR-0061 §8–9, static review vs Codeg.

## Goal

Cut idle CPU/RAM and streaming jank on Windows without dropping product
capability. Preview, conversations, Git, terminals, and toasts must still work
end to end on Desktop and `vibex-server`.

## Root causes (not workarounds)

1. Dual Chromium: WebView2 UI plus CEF initialized at launch and pumped on every
   Tauri event.
2. SQLite writer is the global clock: 8 ms persist, full-timeline open IPC,
   snapshots only at turn end.
3. Git and recursive file listing block the Tokio runtime; every git call also
   spawns `git --version`.
4. Workspace chrome uses WebGL glass and `backdrop-filter` on a compositor that
   already hosts WebView2.
5. Process-wide conversation events, hidden toast WebView, hidden Dockview
   panels, and uncapped terminal/ACP buffers grow RAM under load.

## Batches

| Batch | Change |
|---|---|
| A | Git path cache + real timeout; `spawn_blocking` for git panel and file-tree listing; cap untracked line-count reads |
| B | Persist 50–100 ms; mid-turn snapshots; clamp ACP terminal history; bounded persist channel; SQLite/diff/MsgStore ceilings |
| C | Lazy CEF initialize; pump only when scheduled; Windows/Linux helper subprocess |
| D | Toast window on demand; Windows solid chrome (no WebGL glass / heavy blur) |
| E | Paginated conversation open + older-row scroll-back; in-place row upsert; per-conversation event channel |
| F | Dockview `onlyWhenVisible` for terminal/preview; production sourcemaps off; git status uses file events |

## Non-goals

- Do not disable Preview, Git, or conversation streaming.
- Do not claim plugin/Agent isolation.
- Do not keep a parallel CEF-always-on fallback.
