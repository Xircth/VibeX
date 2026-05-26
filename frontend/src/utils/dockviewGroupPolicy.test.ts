import { describe, expect, it } from 'vitest';
import {
  compareEditorGroups,
  getNextEditorGroupId,
  isBottomGroup,
  isEditorGroup,
  isLeftGroup,
  isPlaceholderPanelId,
  isSplittableEditorPanel,
} from './dockviewGroupPolicy';
import { GROUP_IDS, PANEL_IDS } from '@/stores/useLayoutStore';

function group(
  id: string,
  panelIds: string[] = [],
  rect?: Pick<DOMRect, 'left' | 'top'>
) {
  const element = rect ? document.createElement('div') : undefined;

  if (element && rect) {
    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({
        ...rect,
        bottom: rect.top,
        height: 0,
        right: rect.left,
        toJSON: () => ({}),
        width: 0,
        x: rect.left,
        y: rect.top,
      }),
    });
  }

  return {
    id,
    panels: panelIds.map((panelId) => ({ id: panelId })),
    element,
  };
}

describe('dockview group policy', () => {
  it('classifies groups by canonical group id or owned panel id', () => {
    expect(isLeftGroup(group(GROUP_IDS.LEFT))).toBe(true);
    expect(isLeftGroup(group('restored-left', [PANEL_IDS.FILE_TREE]))).toBe(
      true
    );
    expect(isBottomGroup(group(GROUP_IDS.BOTTOM))).toBe(true);
    expect(isBottomGroup(group('restored-bottom', [PANEL_IDS.TERMINAL]))).toBe(
      true
    );
    expect(isEditorGroup(group('group-editor-1', [PANEL_IDS.WELCOME]))).toBe(
      true
    );
  });

  it('keeps welcome placeholder panels out of editor split targets', () => {
    const editorGroup = group('group-editor-1');

    expect(
      isSplittableEditorPanel({ id: PANEL_IDS.WELCOME, group: editorGroup })
    ).toBe(false);
    expect(
      isSplittableEditorPanel({ id: 'file:C:/repo/a.ts', group: editorGroup })
    ).toBe(true);
    expect(isPlaceholderPanelId(PANEL_IDS.WELCOME)).toBe(true);
  });

  it('orders editor groups by screen position before id fallback', () => {
    expect(
      compareEditorGroups(
        group('group-editor-b', [], { left: 200, top: 10 }),
        group('group-editor-a', [], { left: 100, top: 10 })
      )
    ).toBeGreaterThan(0);
    expect(compareEditorGroups(group('b'), group('a'))).toBeGreaterThan(0);
  });

  it('returns the first unused editor group id', () => {
    expect(
      getNextEditorGroupId({
        groups: [group('group-editor-1'), group('group-editor-3')],
      })
    ).toBe('group-editor-2');
  });
});
