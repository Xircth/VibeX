import { afterEach, describe, expect, it } from 'vitest';
import {
  LEFT_PANEL_SPLIT_MEMORY_KEY,
  readLeftPanelSplitMemory,
  writeLeftPanelSplitMemory,
} from './leftPanelSplitMemory';

describe('left panel split memory', () => {
  afterEach(() => {
    localStorage.removeItem(LEFT_PANEL_SPLIT_MEMORY_KEY);
  });

  it('returns defaults when nothing is stored', () => {
    expect(readLeftPanelSplitMemory()).toEqual({
      stackRatio: 0.62,
      rowRatio: 0.5,
    });
  });

  it('persists and clamps ratios', () => {
    writeLeftPanelSplitMemory({ stackRatio: 0.7, rowRatio: 0.05 });
    expect(readLeftPanelSplitMemory()).toEqual({
      stackRatio: 0.7,
      rowRatio: 0.2,
    });
  });
});
