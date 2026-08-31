import { describe, expect, it } from 'vitest';

import {
  collapsedEditorColumnWidths,
  editorColumnShouldDismiss,
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
