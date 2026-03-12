import type { ConversationItem } from "../../../types";
import type { HistoryLoader } from "../contracts/conversationCurtainContracts";
import { normalizeHistorySnapshot } from "../contracts/conversationCurtainContracts";
import { asString } from "./historyLoaderUtils";

type ClaudeHistoryLoaderOptions = {
  workspaceId: string;
  workspacePath: string | null;
  loadClaudeSession: (
    workspacePath: string,
    sessionId: string,
  ) => Promise<unknown>;
};

function compactComparableReasoningText(value: string) {
  return value
    .replace(/\s+/g, "")
    .replace(/[！!]/g, "!")
    .replace(/[？?]/g, "?")
    .replace(/[，,]/g, ",")
    .replace(/[。．.]/g, ".");
}

function isReasoningSnapshotDuplicate(previous: string, incoming: string) {
  const previousCompact = compactComparableReasoningText(previous);
  const incomingCompact = compactComparableReasoningText(incoming);
  if (!previousCompact || !incomingCompact) {
    return false;
  }
  if (previousCompact === incomingCompact) {
    return true;
  }
  if (previousCompact.length >= 16 && incomingCompact.includes(previousCompact)) {
    return true;
  }
  if (incomingCompact.length >= 16 && previousCompact.includes(incomingCompact)) {
    return true;
  }
  return false;
}

function preferLongerReasoningText(previous: string, incoming: string) {
  const previousCompactLength = compactComparableReasoningText(previous).length;
  const incomingCompactLength = compactComparableReasoningText(incoming).length;
  return incomingCompactLength >= previousCompactLength ? incoming : previous;
}

function mergeReasoningSnapshot(
  items: ConversationItem[],
  id: string,
  text: string,
) {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return;
  }
  const byIdIndex = items.findIndex(
    (item) => item.kind === "reasoning" && item.id === id,
  );
  if (byIdIndex >= 0) {
    const existing = items[byIdIndex];
    if (existing.kind === "reasoning") {
      const nextText = preferLongerReasoningText(existing.content, normalizedText);
      items[byIdIndex] = {
        ...existing,
        summary: nextText.slice(0, 100),
        content: nextText,
      };
    }
    return;
  }
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const candidate = items[index];
    if (candidate.kind === "message" && candidate.role === "user") {
      break;
    }
    if (candidate.kind !== "reasoning") {
      continue;
    }
    if (!isReasoningSnapshotDuplicate(candidate.content, normalizedText)) {
      continue;
    }
    const nextText = preferLongerReasoningText(candidate.content, normalizedText);
    items[index] = {
      ...candidate,
      summary: nextText.slice(0, 100),
      content: nextText,
    };
    return;
  }
  items.push({
    id,
    kind: "reasoning",
    summary: normalizedText.slice(0, 100),
    content: normalizedText,
  });
}

export function parseClaudeHistoryMessages(messagesData: unknown): ConversationItem[] {
  const items: ConversationItem[] = [];
  const toolIndexById = new Map<string, number>();
  const messages = Array.isArray(messagesData)
    ? (messagesData as Array<Record<string, unknown>>)
    : [];
  for (const message of messages) {
    const kind = asString(message.kind ?? "");
    if (kind === "message") {
      items.push({
        id: asString(message.id ?? `claude-message-${items.length + 1}`),
        kind: "message",
        role: asString(message.role) === "user" ? "user" : "assistant",
        text: asString(message.text ?? ""),
      });
      continue;
    }
    if (kind === "reasoning") {
      const text = asString(message.text ?? "");
      mergeReasoningSnapshot(
        items,
        asString(message.id ?? `claude-reasoning-${items.length + 1}`),
        text,
      );
      continue;
    }
    if (kind !== "tool") {
      continue;
    }

    const toolId = asString(message.id ?? "");
    const toolType = asString(message.toolType ?? "unknown");
    const isToolResult = toolType === "result" || toolType === "error";
    const status = toolType === "error" ? "failed" : "completed";
    if (isToolResult) {
      const sourceToolId = toolId.endsWith("-result")
        ? toolId.slice(0, -"-result".length)
        : "";
      const sourceIndex = sourceToolId ? toolIndexById.get(sourceToolId) : undefined;
      if (sourceIndex !== undefined) {
        const existing = items[sourceIndex];
        if (existing?.kind === "tool") {
          items[sourceIndex] = {
            ...existing,
            status,
            output: asString(message.text ?? existing.output ?? ""),
          };
        }
        continue;
      }
      const fallbackId = sourceToolId || toolId || `claude-tool-${items.length + 1}`;
      items.push({
        id: fallbackId,
        kind: "tool",
        toolType,
        title: asString(message.title ?? "Tool"),
        detail: "",
        status,
        output: asString(message.text ?? ""),
      });
      continue;
    }

    items.push({
      id: toolId || `claude-tool-${items.length + 1}`,
      kind: "tool",
      toolType,
      title: asString(message.title ?? "Tool"),
      detail: asString(message.text ?? ""),
      status: "started",
    });
    if (toolId) {
      toolIndexById.set(toolId, items.length - 1);
    }
  }
  return items;
}

export function createClaudeHistoryLoader({
  workspaceId,
  workspacePath,
  loadClaudeSession,
}: ClaudeHistoryLoaderOptions): HistoryLoader {
  return {
    engine: "claude",
    async load(threadId: string) {
      const sessionId = threadId.startsWith("claude:")
        ? threadId.slice("claude:".length)
        : threadId;
      if (!workspacePath) {
        return normalizeHistorySnapshot({
          engine: "claude",
          workspaceId,
          threadId,
          meta: {
            workspaceId,
            threadId,
            engine: "claude",
            activeTurnId: null,
            isThinking: false,
            heartbeatPulse: null,
            historyRestoredAtMs: Date.now(),
          },
        });
      }
      const result = await loadClaudeSession(workspacePath, sessionId);
      const record = result as { messages?: unknown };
      const messagesData = record.messages ?? result;
      return normalizeHistorySnapshot({
        engine: "claude",
        workspaceId,
        threadId,
        items: parseClaudeHistoryMessages(messagesData),
        plan: null,
        userInputQueue: [],
        meta: {
          workspaceId,
          threadId,
          engine: "claude",
          activeTurnId: null,
          isThinking: false,
          heartbeatPulse: null,
          historyRestoredAtMs: Date.now(),
        },
      });
    },
  };
}
