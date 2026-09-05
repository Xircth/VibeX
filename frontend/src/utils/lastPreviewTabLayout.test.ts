import { describe, expect, it } from 'vitest';

import { GROUP_IDS, PANEL_IDS } from '@/stores/useLayoutStore';

import {
  collapsedEditorColumnWidths,
  editorColumnShouldDismiss,
  shouldDismissEditorColumnAfterPanelRemoval,
} from './lastPreviewTabLayout';

describe('last preview tab layout', () => {
  it('dismisses an empty or welcome-only editor column', () => {
    expect(editorColumnShouldDismiss([])).toBe(true);
    expect(editorColumnShouldDismiss([{ panels: [] }])).toBe(true);
    expect(editorColumnShouldDismiss([{ panels: [{ id: 'welcome' }] }])).toBe(
      true
    );
    expect(editorColumnShouldDismiss([{ panels: [{ id: 'file:a' }] }])).toBe(
      false
    );
  });

  it('does not hide a welcome-only editor when a left dock panel is removed', () => {
    const welcomeOnly = [{ panels: [{ id: PANEL_IDS.WELCOME }] }];

    expect(
      shouldDismissEditorColumnAfterPanelRemoval(
        {
          id: PANEL_IDS.FILE_TREE,
          group: { id: GROUP_IDS.LEFT, panels: [{ id: PANEL_IDS.GIT }] },
        },
        welcomeOnly
      )
    ).toBe(false);
    expect(
      shouldDismissEditorColumnAfterPanelRemoval(
        { id: PANEL_IDS.SEARCH },
        welcomeOnly
      )
    ).toBe(false);
    expect(
      shouldDismissEditorColumnAfterPanelRemoval(
        { id: PANEL_IDS.SESSION_LIST },
        welcomeOnly
      )
    ).toBe(false);
  });

  it('hides the editor after the last real editor tab is closed', () => {
    expect(
      shouldDismissEditorColumnAfterPanelRemoval(
        {
          id: 'file:a',
          group: {
            id: 'group-editor-1',
            panels: [{ id: PANEL_IDS.WELCOME }],
          },
        },
        [{ panels: [{ id: PANEL_IDS.WELCOME }] }]
      )
    ).toBe(true);
  });

  it('keeps the file tree pinned and gives the rest to the session', () => {
    expect(
      collapsedEditorColumnWidths({
        gridWidth: 1600,
        dockWidth: 200,
        minDockWidth: 200,
        minSessionWidth: 400,
      })
    ).toEqual({
      dock: 200,
      session: 1400,
    });
  });

  it('does not let a ballooned tree width become the restored dock size', () => {
    const widths = collapsedEditorColumnWidths({
      gridWidth: 1600,
      dockWidth: 200,
      minDockWidth: 200,
      minSessionWidth: 400,
    });
    expect(widths.dock).toBe(200);
    expect(widths.session).toBeGreaterThan(widths.dock);
  });
});
