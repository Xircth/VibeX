import type { AsyncTaskRecord } from 'shared/types';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(
  record: Record<string, unknown> | null,
  ...keys: string[]
): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function isLiveAsyncTaskState(
  state: string | null | undefined
): boolean {
  return state === 'running' || state === 'paused';
}

export function isTerminalAsyncTaskState(
  state: string | null | undefined
): boolean {
  return state === 'completed' || state === 'failed' || state === 'stopped';
}

export function liveAsyncTasks(
  tasks: readonly AsyncTaskRecord[] | null | undefined
): AsyncTaskRecord[] {
  if (!tasks || tasks.length === 0) return [];
  return tasks.filter((task) => isLiveAsyncTaskState(task.state));
}

function extractAirAsyncTasksMeta(
  meta: unknown
): Record<string, unknown> | null {
  const root = asRecord(meta);
  if (!root) return null;
  const direct = asRecord(asRecord(asRecord(root.jetbrains)?.air)?.asyncTasks);
  if (direct) return direct;
  const nested = asRecord(
    asRecord(asRecord(asRecord(root._meta)?.jetbrains)?.air)?.asyncTasks
  );
  if (nested) return nested;
  return (
    asRecord(root.asyncTasks) ?? asRecord(asRecord(root._meta)?.asyncTasks)
  );
}

/**
 * Strictly checks `_meta.jetbrains.air.asyncTasks.backgrounded === true`
 * (or neutral `_meta.asyncTasks.backgrounded === true`).
 */
export function isToolCallBackgrounded(meta: unknown): boolean {
  const asyncTasksMeta = extractAirAsyncTasksMeta(meta);
  return asyncTasksMeta?.backgrounded === true;
}

export function extractBackgroundedTaskId(
  meta: unknown,
  fallbackPayload?: unknown
): string | null {
  const asyncTasksMeta = extractAirAsyncTasksMeta(meta);
  const fromMeta = readString(
    asyncTasksMeta,
    'taskId',
    'task_id',
    'asyncTaskId',
    'id'
  );
  if (fromMeta) return fromMeta;
  const fallback = asRecord(fallbackPayload);
  return readString(fallback, 'taskId', 'task_id', 'asyncTaskId');
}

export function findAsyncTaskForToolCall(
  tasks: readonly AsyncTaskRecord[] | null | undefined,
  toolUseId?: string | null,
  meta?: unknown,
  fallbackPayload?: unknown
): AsyncTaskRecord | null {
  if (!tasks || tasks.length === 0) return null;
  if (toolUseId) {
    const byToolCallId = tasks.find((task) => task.tool_call_id === toolUseId);
    if (byToolCallId) return byToolCallId;
  }
  const taskId = extractBackgroundedTaskId(meta, fallbackPayload);
  if (taskId) {
    const byId = tasks.find((task) => task.id === taskId);
    if (byId) return byId;
  }
  return null;
}

const BACKGROUND_POLL_TOOL_NAMES = new Set([
  'taskoutput',
  'readasynctask',
  'waitasynctask',
  'checkasynctask',
  'getasynctask',
  'bashoutput',
  'commandstatus',
]);

function normalizePollToolName(name: string): string {
  return name
    .replace(/^(?:mcp|call|tool)[_:-]+/i, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

export function parseBackgroundPollTaskId(use: {
  tool_name: string;
  meta?: unknown;
  input_preview?: string | null;
}): string | null {
  const canonical = normalizePollToolName(use.tool_name);
  if (!BACKGROUND_POLL_TOOL_NAMES.has(canonical)) {
    return null;
  }
  let parsedInput: Record<string, unknown> | null = null;
  if (use.input_preview) {
    try {
      parsedInput = asRecord(JSON.parse(use.input_preview));
    } catch {
      parsedInput = null;
    }
  }
  return (
    extractBackgroundedTaskId(use.meta, parsedInput) ??
    readString(parsedInput, 'shell_id', 'shellId', 'process_id', 'processId')
  );
}

export type GroupedBackgroundTaskItem<T> =
  | { kind: 'single'; item: T }
  | { kind: 'poll_group'; taskId: string; items: T[] };

export function groupConsecutiveBackgroundTasks<T>(
  items: readonly T[],
  getPollTaskId: (item: T) => string | null
): GroupedBackgroundTaskItem<T>[] {
  const result: GroupedBackgroundTaskItem<T>[] = [];
  for (const item of items) {
    const taskId = getPollTaskId(item);
    if (!taskId) {
      result.push({ kind: 'single', item });
      continue;
    }
    const previous = result.at(-1);
    if (previous?.kind === 'poll_group' && previous.taskId === taskId) {
      previous.items.push(item);
    } else if (
      previous?.kind === 'single' &&
      getPollTaskId(previous.item) === taskId
    ) {
      result[result.length - 1] = {
        kind: 'poll_group',
        taskId,
        items: [previous.item, item],
      };
    } else {
      result.push({ kind: 'single', item });
    }
  }
  return result;
}
