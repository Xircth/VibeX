import { describe, expect, it } from 'vitest';
import { resolveTerminalFitBox, terminalGridForBox } from './terminalFitBox';

describe('terminal fit box', () => {
  it('uses the panel width when the xterm host is still the narrow first grid', () => {
    const box = resolveTerminalFitBox({
      containerWidth: 80,
      containerHeight: 200,
      panelWidth: 480,
      panelHeight: 400,
      contentWidth: 480,
      contentHeight: 400,
      groupWidth: 480,
    });

    expect(box).toEqual({ width: 464, height: 396 });
    expect(terminalGridForBox(box, { width: 8, height: 16 })).toEqual({
      cols: 58,
      rows: 24,
    });
  });

  it('keeps the host box when it already tracks the panel', () => {
    const box = resolveTerminalFitBox({
      containerWidth: 464,
      containerHeight: 396,
      panelWidth: 480,
      panelHeight: 400,
      contentWidth: 480,
      contentHeight: 400,
      groupWidth: 480,
    });

    expect(box).toEqual({ width: 464, height: 396 });
  });

  it('follows a later narrower panel instead of a stuck wide host', () => {
    const box = resolveTerminalFitBox({
      containerWidth: 464,
      containerHeight: 396,
      panelWidth: 200,
      panelHeight: 400,
      contentWidth: 200,
      contentHeight: 400,
      groupWidth: 200,
    });

    expect(box.width).toBe(184);
    expect(box.height).toBe(396);
  });
});
