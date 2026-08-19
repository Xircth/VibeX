export type PlanStatus = 'completed' | 'in_progress' | 'pending';

export type ConversationPlanItem = {
  status: PlanStatus;
  content: string;
  children: string[];
};

const CHILD_LINE_PATTERN = /^(?:[-*]|\d+[.)])\s+(.*)$/;

export function normalizePlanStatus(status: string): PlanStatus {
  const normalized = status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  if (normalized === 'completed' || normalized === 'done') {
    return 'completed';
  }

  if (
    normalized === 'in_progress' ||
    normalized === 'inprogress' ||
    normalized === 'running' ||
    normalized === 'active'
  ) {
    return 'in_progress';
  }

  return 'pending';
}

export function splitPlanContent(content: string): {
  title: string;
  children: string[];
} {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return { title: '', children: [] };
  }

  if (lines.length === 1) {
    return { title: lines[0], children: [] };
  }

  return {
    title: stripPlanMarker(lines[0]),
    children: lines.slice(1).map(stripPlanMarker).filter(Boolean),
  };
}

export function toConversationPlanItem(entry: {
  status: string;
  content: string;
}): ConversationPlanItem {
  const { title, children } = splitPlanContent(entry.content);
  return {
    status: normalizePlanStatus(entry.status),
    content: title,
    children,
  };
}

export function planProgress(items: Array<{ status: string }>): {
  completed: number;
  inProgress: number;
  pending: number;
  total: number;
} {
  let completed = 0;
  let inProgress = 0;

  for (const item of items) {
    const status = normalizePlanStatus(item.status);
    if (status === 'completed') completed += 1;
    else if (status === 'in_progress') inProgress += 1;
  }

  return {
    completed,
    inProgress,
    pending: items.length - completed - inProgress,
    total: items.length,
  };
}

export function formatPlanStepIndex(index: number): string {
  return String(index + 1).padStart(2, '0');
}

function stripPlanMarker(line: string): string {
  const match = line.match(CHILD_LINE_PATTERN);
  return (match?.[1] ?? line).trim();
}
