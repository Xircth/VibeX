import { describe, expect, it } from 'vitest';
import {
  compareEditorGroups,
  getNextEditorGroupId,
  getNextLeftGroupId,
  getNextRightGroupId,
  isBottomGroup,
  isEditorGroup,
  isLeftGroup,
  isPlaceholderPanelId,
  isSessionGroup,
  isSessionPanelId,
  isSplittableEditorPanel,
  listLeftDockGroups,
  listSessionGroups,
  sessionPanelId,
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
  it('classifies groups by canonical group id or owned panel id across A/B/C zones', () => {
    expect(isLeftGroup(group(GROUP_IDS.LEFT))).toBe(true);
    expect(isLeftGroup(group('group-left-1', [PANEL_IDS.NOTES]))).toBe(true);
    expect(isLeftGroup(group('restored-left', [PANEL_IDS.FILE_TREE]))).toBe(
      true
    );
    expect(
      listLeftDockGroups([
        group(GROUP_IDS.LEFT),
        group('group-left-1', [PANEL_IDS.NOTES]),
        group('restored-left', [PANEL_IDS.SESSION_LIST]),
        group('group-editor-1', [PANEL_IDS.WELCOME]),
        group(GROUP_IDS.RIGHT, [PANEL_IDS.FILE_TREE]),
      ]).map((item) => item.id)
    ).toEqual([GROUP_IDS.LEFT, 'group-left-1', 'restored-left']);

    expect(isSessionGroup(group(GROUP_IDS.RIGHT))).toBe(true);
    expect(isSessionGroup(group('group-right-1', [PANEL_IDS.FILE_TREE]))).toBe(
      true
    );
    expect(
      isSessionGroup(group('restored-session', [sessionPanelId('s-1')]))
    ).toBe(true);
    expect(
      listSessionGroups([
        group(GROUP_IDS.RIGHT),
        group('group-right-1', [PANEL_IDS.NOTES]),
        group('restored-session', [sessionPanelId('s-1')]),
        group('group-editor-1', [sessionPanelId('s-2')]),
        group(GROUP_IDS.LEFT, [sessionPanelId('s-3')]),
      ]).map((item) => item.id)
    ).toEqual([GROUP_IDS.RIGHT, 'group-right-1', 'restored-session']);

    expect(isBottomGroup(group(GROUP_IDS.BOTTOM))).toBe(true);
    expect(isBottomGroup(group('restored-bottom', [PANEL_IDS.TERMINAL]))).toBe(
      false
    );
    expect(isEditorGroup(group('restored-bottom', [PANEL_IDS.TERMINAL]))).toBe(
      true
    );
    expect(isEditorGroup(group('group-editor-1', [PANEL_IDS.WELCOME]))).toBe(
      true
    );
    expect(isLeftGroup(group('group-editor-1', [PANEL_IDS.FILE_TREE]))).toBe(
      false
    );
    expect(isEditorGroup(group('group-editor-1', [PANEL_IDS.FILE_TREE]))).toBe(
      true
    );
    expect(
      isSessionGroup(group('group-editor-1', [sessionPanelId('s-1')]))
    ).toBe(false);
    expect(
      isEditorGroup(group('group-editor-1', [sessionPanelId('s-1')]))
    ).toBe(true);
    expect(isSessionGroup(group(GROUP_IDS.LEFT, [sessionPanelId('s-1')]))).toBe(
      false
    );
    expect(isLeftGroup(group(GROUP_IDS.RIGHT, [PANEL_IDS.FILE_TREE]))).toBe(
      false
    );
    expect(isBottomGroup(group('group-editor-1', ['terminal:term-1']))).toBe(
      false
    );
    expect(isEditorGroup(group('group-editor-1', ['terminal:term-1']))).toBe(
      true
    );
    expect(isSessionPanelId(PANEL_IDS.AI_CHAT)).toBe(true);
    expect(isSessionPanelId(sessionPanelId('abc'))).toBe(true);
    expect(isSessionPanelId(PANEL_IDS.FILE_TREE)).toBe(false);
  });

  it('keeps welcome placeholder panels out of editor split targets while allowing A/B/C zone tabs', () => {
    const editorGroup = group('group-editor-1');
    const leftGroup = group(GROUP_IDS.LEFT);
    const rightGroup = group(GROUP_IDS.RIGHT);

    expect(
      isSplittableEditorPanel({ id: PANEL_IDS.WELCOME, group: editorGroup })
    ).toBe(false);
    expect(
      isSplittableEditorPanel({ id: 'file:C:/repo/a.ts', group: editorGroup })
    ).toBe(true);
    expect(
      isSplittableEditorPanel({
        id: 'terminal:term-1',
        group: editorGroup,
      })
    ).toBe(true);
    expect(
      isSplittableEditorPanel({
        id: PANEL_IDS.GIT,
        group: leftGroup,
      })
    ).toBe(true);
    expect(
      isSplittableEditorPanel({
        id: sessionPanelId('s-1'),
        group: rightGroup,
      })
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

  it('returns the first unused editor, left dock, or right session group id', () => {
    expect(
      getNextEditorGroupId({
        groups: [group('group-editor-1'), group('group-editor-3')],
      })
    ).toBe('group-editor-2');
    expect(
      getNextLeftGroupId({
        groups: [group('group-editor-1')],
      })
    ).toBe(GROUP_IDS.LEFT);
    expect(
      getNextLeftGroupId({
        groups: [group(GROUP_IDS.LEFT), group('group-left-2')],
      })
    ).toBe('group-left-1');
    expect(
      getNextRightGroupId({
        groups: [group('group-editor-1')],
      })
    ).toBe(GROUP_IDS.RIGHT);
    expect(
      getNextRightGroupId({
        groups: [group(GROUP_IDS.RIGHT), group('group-right-2')],
      })
    ).toBe('group-right-1');
  });
});
