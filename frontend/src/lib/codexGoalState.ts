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
    if (entry.role !== 'user') return state;
    return applyTransition(state, parseUserGoalCommand(entry.content));
  }, null);
}

export function codexGoalEntriesFromConversation(
  entries: PatchType[]
): CodexGoalTimelineEntry[] {
  return entries.flatMap((entry) => {
    if (entry.type !== 'NORMALIZED_ENTRY') return [];

    const entryType = entry.content.entry_type.type;
    if (entryType !== 'user_message') {
      return [];
    }

    return [
      {
        role: 'user',
        content: entry.content.content,
      } satisfies CodexGoalTimelineEntry,
    ];
  });
}
