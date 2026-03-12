import { describe, expect, it } from "vitest";
import { resolvePendingThreadIdForSession } from "./useThreads";

describe("resolvePendingThreadIdForSession", () => {
  const workspaceId = "ws-1";

  it("prefers active pending thread when only active thread can disambiguate", () => {
    const resolved = resolvePendingThreadIdForSession({
      workspaceId,
      engine: "opencode",
      threadsByWorkspace: {
        "ws-1": [{ id: "opencode-pending-a" }, { id: "opencode-pending-b" }],
      },
      activeThreadIdByWorkspace: { "ws-1": "opencode-pending-b" },
      threadStatusById: {
        "opencode-pending-b": { isProcessing: true },
      },
      activeTurnIdByThread: {},
      itemsByThread: {
        "opencode-pending-b": [{ id: "local-1" }],
      },
    });

    expect(resolved).toBe("opencode-pending-b");
  });

  it("does not resolve by processing state alone without turn/content anchor", () => {
    const resolved = resolvePendingThreadIdForSession({
      workspaceId,
      engine: "opencode",
      threadsByWorkspace: {
        "ws-1": [{ id: "opencode-pending-a" }, { id: "opencode-pending-b" }],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-neutral" },
      threadStatusById: {
        "opencode-pending-b": { isProcessing: true },
      },
      activeTurnIdByThread: {},
      itemsByThread: {},
    });

    expect(resolved).toBeNull();
  });

  it("prefers active pending thread with activity over another processing pending thread", () => {
    const resolved = resolvePendingThreadIdForSession({
      workspaceId,
      engine: "claude",
      threadsByWorkspace: {
        "ws-1": [{ id: "claude-pending-old" }, { id: "claude-pending-new" }],
      },
      activeThreadIdByWorkspace: { "ws-1": "claude-pending-new" },
      threadStatusById: {
        "claude-pending-old": { isProcessing: true },
        "claude-pending-new": { isProcessing: true },
      },
      activeTurnIdByThread: {},
      itemsByThread: {
        "claude-pending-new": [{ id: "user-1" }],
      },
    });

    expect(resolved).toBe("claude-pending-new");
  });

  it("falls back to single turn-bound pending thread", () => {
    const resolved = resolvePendingThreadIdForSession({
      workspaceId,
      engine: "opencode",
      threadsByWorkspace: {
        "ws-1": [{ id: "opencode-pending-a" }, { id: "opencode-pending-b" }],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-neutral" },
      threadStatusById: {},
      activeTurnIdByThread: {
        "opencode-pending-a": "turn-1",
      },
      itemsByThread: {},
    });

    expect(resolved).toBe("opencode-pending-a");
  });

  it("returns single pending thread with observed content", () => {
    const resolved = resolvePendingThreadIdForSession({
      workspaceId,
      engine: "claude",
      threadsByWorkspace: {
        "ws-1": [{ id: "claude-pending-a" }],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-neutral" },
      threadStatusById: {
        "claude-pending-a": { isProcessing: true },
      },
      activeTurnIdByThread: {},
      itemsByThread: {
        "claude-pending-a": [{ id: "assistant-1" }],
      },
    });

    expect(resolved).toBe("claude-pending-a");
  });

  it("does not resolve stale pending thread from historical reasoning-only content", () => {
    const resolved = resolvePendingThreadIdForSession({
      workspaceId,
      engine: "claude",
      threadsByWorkspace: {
        "ws-1": [{ id: "claude-pending-stale" }],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-neutral" },
      threadStatusById: {
        "claude-pending-stale": { isProcessing: false },
      },
      activeTurnIdByThread: {},
      itemsByThread: {
        "claude-pending-stale": [
          { id: "reasoning-1", kind: "reasoning", summary: "old", content: "old" },
        ],
      },
    });

    expect(resolved).toBeNull();
  });

  it("does not resolve single idle pending thread without any activity", () => {
    const resolved = resolvePendingThreadIdForSession({
      workspaceId,
      engine: "claude",
      threadsByWorkspace: {
        "ws-1": [{ id: "claude-pending-a" }],
      },
      activeThreadIdByWorkspace: { "ws-1": "claude-pending-a" },
      threadStatusById: {},
      activeTurnIdByThread: {},
      itemsByThread: {},
    });

    expect(resolved).toBeNull();
  });

  it("returns null for ambiguous pending candidates without active/timestamp hints", () => {
    const resolved = resolvePendingThreadIdForSession({
      workspaceId,
      engine: "opencode",
      threadsByWorkspace: {
        "ws-1": [{ id: "opencode-pending-a" }, { id: "opencode-pending-b" }],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-neutral" },
      threadStatusById: {},
      activeTurnIdByThread: {},
      itemsByThread: {},
    });

    expect(resolved).toBeNull();
  });

  it("does not guess latest pending timestamp when ambiguous and idle", () => {
    const resolved = resolvePendingThreadIdForSession({
      workspaceId,
      engine: "opencode",
      threadsByWorkspace: {
        "ws-1": [
          { id: "opencode-pending-1700000000001-aaaaaa" },
          { id: "opencode-pending-1700000000002-bbbbbb" },
        ],
      },
      activeThreadIdByWorkspace: { "ws-1": "thread-neutral" },
      threadStatusById: {},
      activeTurnIdByThread: {},
      itemsByThread: {},
    });

    expect(resolved).toBeNull();
  });
});
