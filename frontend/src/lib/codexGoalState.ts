import type { PatchType } from 'shared/types';

export type CodexGoalStatus = 'running' | 'paused' | 'completed';

export interface CodexGoalState {
  objective: string;
  status: CodexGoalStatus;
}

export interface CodexGoalTimelineEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

type GoalTransition =
  | { type: 'set'; objective: string; status: CodexGoalStatus }
  | { type: 'status'; status: CodexGoalStatus }
  | { type: 'clear' }
  | { type: 'none' };

const GOAL_COMMAND_RE = /^\/goal(?:\s+([\s\S]+))?$/i;

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

function parseUserGoalCommand(content: string): GoalTransition {
  const normalized = normalizeContent(content);
  const match = GOAL_COMMAND_RE.exec(normalized);

  if (!match) return { type: 'none' };

  const argument = (match[1] ?? '').trim();
  if (!argument) return { type: 'none' };

  const command = argument.toLowerCase();
  if (command === 'pause') {
    return { type: 'status', status: 'paused' };
  }
  if (command === 'resume') {
    return { type: 'status', status: 'running' };
  }
  if (command === 'complete' || command === 'completed' || command === 'done') {
    return { type: 'status', status: 'completed' };
  }
  if (command === 'clear') {
    return { type: 'clear' };
  }

  return {
    type: 'set',
    objective: argument,
    status: 'running',
  };
}

function statusFromContent(content: string): CodexGoalStatus {
  if (
    /\bstatus\s*[:=：]\s*paused\b|paused|\u72b6\u6001\s*[:=：]\s*\u5df2?\u6682\u505c|\u6682\u505c/i.test(
      content
    )
  ) {
    return 'paused';
  }

  if (
    /\bstatus\s*[:=：]\s*(?:complete|completed)\b|complete|completed|\u72b6\u6001\s*[:=：]\s*\u5df2?\u5b8c\u6210|\u5b8c\u6210/i.test(
      content
    )
  ) {
    return 'completed';
  }

  return 'running';
}

function parseAssistantGoalUpdate(content: string): GoalTransition {
  const normalized = normalizeContent(content);
  if (!normalized) return { type: 'none' };

  if (
    /\bno active goal\b/i.test(normalized) ||
    /\u5f53\u524d\u6ca1\u6709\u6d3b\u52a8\u76ee\u6807/.test(normalized) ||
    /\u6ca1\u6709\u6d3b\u52a8\u76ee\u6807/.test(normalized)
  ) {
    return { type: 'clear' };
  }

  const objectiveMatch =
    /(?:current\s+goal|objective|goal)\s*[:=：]\s*(.+)$/im.exec(normalized) ??
    /(?:\u5f53\u524d\u76ee\u6807|\u76ee\u6807|\u76ee\u6807\u5185\u5bb9)\s*[:=：]\s*(.+)$/m.exec(
      normalized
    );

  if (objectiveMatch?.[1]) {
    const objective = objectiveMatch[1].trim();
    if (!objective || /^none$/i.test(objective) || objective === '无') {
      return { type: 'clear' };
    }

    return {
      type: 'set',
      objective,
      status: statusFromContent(normalized),
    };
  }

  if (
    /\bgoal (?:is )?(?:complete|completed|achieved)\b/i.test(normalized) ||
    /\u76ee\u6807\u5df2\u5b8c\u6210/.test(normalized)
  ) {
    return { type: 'status', status: 'completed' };
  }

  if (
    /\bgoal (?:is )?paused\b/i.test(normalized) ||
    /\u76ee\u6807\u5df2\u6682\u505c/.test(normalized)
  ) {
    return { type: 'status', status: 'paused' };
  }

  if (
    /\bgoal (?:is )?(?:running|resumed|active)\b/i.test(normalized) ||
    /\u76ee\u6807(?:\u8fd0\u884c\u4e2d|\u5df2\u6062\u590d)/.test(normalized)
  ) {
    return { type: 'status', status: 'running' };
  }

  return { type: 'none' };
}

function applyTransition(
  current: CodexGoalState | null,
  transition: GoalTransition
): CodexGoalState | null {
  switch (transition.type) {
    case 'set':
      return {
        objective: transition.objective,
        status: transition.status,
      };
    case 'status':
      return current
        ? {
            ...current,
            status: transition.status,
          }
        : current;
    case 'clear':
      return null;
    case 'none':
      return current;
  }
}

export function deriveCodexGoalState(
  timeline: CodexGoalTimelineEntry[]
): CodexGoalState | null {
  return timeline.reduce<CodexGoalState | null>((state, entry) => {
    const transition =
      entry.role === 'user'
        ? parseUserGoalCommand(entry.content)
        : parseAssistantGoalUpdate(entry.content);
    return applyTransition(state, transition);
  }, null);
}

export function codexGoalEntriesFromConversation(
  entries: PatchType[]
): CodexGoalTimelineEntry[] {
  return entries.flatMap((entry) => {
    if (entry.type !== 'NORMALIZED_ENTRY') return [];

    const entryType = entry.content.entry_type.type;
    if (
      entryType !== 'user_message' &&
      entryType !== 'assistant_message' &&
      entryType !== 'system_message'
    ) {
      return [];
    }

    return [
      {
        role:
          entryType === 'user_message'
            ? 'user'
            : entryType === 'assistant_message'
              ? 'assistant'
              : 'system',
        content: entry.content.content,
      } satisfies CodexGoalTimelineEntry,
    ];
  });
}
