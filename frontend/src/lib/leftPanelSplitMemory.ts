import {
  clampRatio,
  DEFAULT_ROW_RATIO,
  DEFAULT_STACK_RATIO,
} from './leftPanelSplit';

export const LEFT_PANEL_SPLIT_MEMORY_KEY = 'vibex:left-panel-split';

export interface LeftPanelSplitMemory {
  stackRatio: number;
  rowRatio: number;
}

const DEFAULT_MEMORY: LeftPanelSplitMemory = {
  stackRatio: DEFAULT_STACK_RATIO,
  rowRatio: DEFAULT_ROW_RATIO,
};

function parseMemory(raw: string | null): LeftPanelSplitMemory {
  if (!raw) return { ...DEFAULT_MEMORY };
  try {
    const parsed = JSON.parse(raw) as Partial<LeftPanelSplitMemory>;
    return {
      stackRatio: clampRatio(
        typeof parsed.stackRatio === 'number'
          ? parsed.stackRatio
          : DEFAULT_STACK_RATIO
      ),
      rowRatio: clampRatio(
        typeof parsed.rowRatio === 'number'
          ? parsed.rowRatio
          : DEFAULT_ROW_RATIO
      ),
    };
  } catch {
    return { ...DEFAULT_MEMORY };
  }
}

export function readLeftPanelSplitMemory(): LeftPanelSplitMemory {
  try {
    return parseMemory(localStorage.getItem(LEFT_PANEL_SPLIT_MEMORY_KEY));
  } catch {
    return { ...DEFAULT_MEMORY };
  }
}

export function writeLeftPanelSplitMemory(
  patch: Partial<LeftPanelSplitMemory>
): LeftPanelSplitMemory {
  const next = {
    ...readLeftPanelSplitMemory(),
    ...patch,
  };
  next.stackRatio = clampRatio(next.stackRatio);
  next.rowRatio = clampRatio(next.rowRatio);
  try {
    localStorage.setItem(LEFT_PANEL_SPLIT_MEMORY_KEY, JSON.stringify(next));
  } catch {
    // Keep going when storage is unavailable.
  }
  return next;
}
