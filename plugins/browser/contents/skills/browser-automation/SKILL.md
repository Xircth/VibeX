---
name: browser-automation
description: Inspect web pages, capture DOM snapshots, and interact with browser tabs inside VibeX.
---
# Browser Automation Skill

Use the built-in browser tools to open tabs, inspect accessibility trees, and verify live web UI behavior.

## Deterministic Snapshots & Contact-Sheet Capture

- **Deterministic State (`browser_prefer` / `reducedMotion`)**: Before asserting layout or capturing static UI states, call `browser_prefer` with `{ "reducedMotion": true, "colorScheme": "dark" | "light", "settle": true }` (or pass `reducedMotion: true` / `colorScheme` directly to `browser_screenshot`) to skip CSS transitions/animations, finish active Web Animations, and settle for two animation frames.
- **Contact-Sheet Burst (`overMs` + `everyMs`)**: When inspecting animations, loading skeletons, or transient UI transitions, call `browser_screenshot` with `{ "overMs": 500, "everyMs": 100 }` to sample frames across the time window and composite a single multi-frame contact sheet with frame timestamps.

