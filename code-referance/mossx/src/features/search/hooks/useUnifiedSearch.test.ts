import { describe, expect, it } from "vitest";
import type { ConversationItem, CustomCommandOption, SkillOption, ThreadSummary } from "../../../types";
import { SEARCH_PERF_BASELINE_GLOBAL } from "../perf/baseline.config";
import type { SearchContentFilter } from "../types";
import { computeUnifiedSearchResults } from "./useUnifiedSearch";

function makeThread(id: string, name: string, updatedAt: number): ThreadSummary {
  return { id, name, updatedAt };
}

function makeMessage(id: string, text: string): ConversationItem {
  return { id, kind: "message", role: "assistant", text };
}

describe("computeUnifiedSearchResults", () => {
  it("supports scope switching by source set", () => {
    const workspaceA = {
      workspaceId: "w-a",
      workspaceName: "A",
      files: ["src/hello-a.ts"],
      threads: [makeThread("t-a", "hello thread a", 10)],
    };
    const workspaceB = {
      workspaceId: "w-b",
      workspaceName: "B",
      files: ["src/hello-b.ts"],
      threads: [makeThread("t-b", "hello thread b", 10)],
    };

    const base = {
      query: "hello",
      contentFilters: ["all"] as SearchContentFilter[],
      kanbanTasks: [],
      threadItemsByThread: {} as Record<string, ConversationItem[]>,
      historyItems: [],
      skills: [] as SkillOption[],
      commands: [] as CustomCommandOption[],
      activeWorkspaceId: "w-a",
      recencyMap: {},
      reportMetrics: false,
    };

    const activeResults = computeUnifiedSearchResults({
      ...base,
      workspaceSources: [workspaceA],
    });
    expect(activeResults.some((item) => item.workspaceId === "w-a")).toBe(true);
    expect(activeResults.some((item) => item.workspaceId === "w-b")).toBe(false);

    const globalResults = computeUnifiedSearchResults({
      ...base,
      workspaceSources: [workspaceA, workspaceB],
    });
    expect(globalResults.some((item) => item.workspaceId === "w-a")).toBe(true);
    expect(globalResults.some((item) => item.workspaceId === "w-b")).toBe(true);
  });

  it("includes skills and commands when selected", () => {
    const results = computeUnifiedSearchResults({
      query: "plan",
      contentFilters: ["skills", "commands"],
      workspaceSources: [],
      kanbanTasks: [],
      threadItemsByThread: {},
      historyItems: [],
      skills: [{ name: "plan-writer", path: "/skill/plan", description: "Plan helper" }],
      commands: [{ name: "plan", path: "/command/plan", description: "Command plan", content: "" }],
      activeWorkspaceId: "w-1",
      recencyMap: {},
      reportMetrics: false,
    });

    expect(results.some((item) => item.kind === "skill" && item.skillName === "plan-writer")).toBe(true);
    expect(results.some((item) => item.kind === "command" && item.commandName === "plan")).toBe(true);
  });

  it("keeps global search latency under baseline for large data", () => {
    const {
      workspaceCount,
      filesPerWorkspace,
      threadsPerWorkspace,
      messagesPerThread,
      maxElapsedMs,
    } = SEARCH_PERF_BASELINE_GLOBAL;
    const query = "alpha";

    const workspaceSources = Array.from({ length: workspaceCount }, (_, workspaceIndex) => {
      const workspaceId = `w-${workspaceIndex}`;
      const files = Array.from({ length: filesPerWorkspace }, (_, fileIndex) =>
        fileIndex % 15 === 0
          ? `src/alpha-${workspaceIndex}-${fileIndex}.ts`
          : `src/feature-${workspaceIndex}-${fileIndex}.ts`,
      );
      const threads = Array.from({ length: threadsPerWorkspace }, (_, threadIndex) =>
        makeThread(
          `${workspaceId}-t-${threadIndex}`,
          threadIndex % 8 === 0
            ? `alpha-thread-${workspaceId}-${threadIndex}`
            : `thread-${workspaceId}-${threadIndex}`,
          1_700_000_000 + threadIndex,
        ),
      );
      return {
        workspaceId,
        workspaceName: `Workspace ${workspaceIndex}`,
        files,
        threads,
      };
    });

    const threadItemsByThread: Record<string, ConversationItem[]> = {};
    for (const source of workspaceSources) {
      for (const thread of source.threads) {
        threadItemsByThread[thread.id] = Array.from({ length: messagesPerThread }, (_, msgIndex) =>
          makeMessage(
            `${thread.id}-m-${msgIndex}`,
            msgIndex % 6 === 0
              ? `alpha message ${msgIndex} in ${thread.id}`
              : `regular message ${msgIndex} in ${thread.id}`,
          ),
        );
      }
    }

    const startedAt = performance.now();
    const results = computeUnifiedSearchResults({
      query,
      contentFilters: ["all"],
      workspaceSources,
      kanbanTasks: [],
      threadItemsByThread,
      historyItems: [],
      skills: [],
      commands: [],
      activeWorkspaceId: "w-0",
      recencyMap: {},
      reportMetrics: false,
    });
    const elapsedMs = performance.now() - startedAt;

    expect(results.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(maxElapsedMs);
  });
});
