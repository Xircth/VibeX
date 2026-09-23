import { describe, expect, it, vi } from 'vitest';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  isLeftDockSplit,
  unsplitLeftDockKeepLeading,
} from './leftDockPlacement';

function group(
  panelId: string,
  box: { x: number; y: number; width: number; height: number }
) {
  const element = document.createElement('div');
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => ({
      ...box,
      left: box.x,
      top: box.y,
      right: box.x + box.width,
      bottom: box.y + box.height,
      toJSON: () => ({}),
    }),
  });
  const panels = [{ id: panelId }];
  return {
    id: `group-${panelId}`,
    panels,
    element,
    api: { isVisible: true },
  };
}

describe('unsplitLeftDockKeepLeading', () => {
  it('keeps the top pane and removes the rest of a stack', () => {
    const top = group(PANEL_IDS.FILE_TREE, {
      x: 40,
      y: 80,
      width: 240,
      height: 300,
    });
    const bottom = group(PANEL_IDS.SESSION_LIST, {
      x: 40,
      y: 380,
      width: 240,
      height: 300,
    });
    const removePanel = vi.fn();
    const api = {
      groups: [top, bottom],
      removePanel,
    } as never;

    expect(isLeftDockSplit(api)).toBe(true);
    expect(unsplitLeftDockKeepLeading(api)).toBe(true);
    expect(removePanel).toHaveBeenCalledWith(bottom.panels[0]);
    expect(removePanel).not.toHaveBeenCalledWith(top.panels[0]);
  });

  it('keeps the left pane and removes the rest of a row', () => {
    const left = group(PANEL_IDS.FILE_TREE, {
      x: 40,
      y: 80,
      width: 200,
      height: 600,
    });
    const right = group(PANEL_IDS.SESSION_LIST, {
      x: 240,
      y: 80,
      width: 200,
      height: 600,
    });
    const removePanel = vi.fn();
    const api = {
      groups: [right, left],
      removePanel,
    } as never;

    expect(unsplitLeftDockKeepLeading(api)).toBe(true);
    expect(removePanel).toHaveBeenCalledWith(right.panels[0]);
    expect(removePanel).not.toHaveBeenCalledWith(left.panels[0]);
  });
});
