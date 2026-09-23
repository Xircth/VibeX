import { describe, expect, it } from 'vitest';
import {
  boxContains,
  classifyLeftDockSplit,
  dropZoneToDirection,
  ghostBoxForZone,
  innerSizeAfterOuterResize,
  ratioFromSizes,
  resolveLeftPanelDropZone,
  sizesFromRatio,
  unionBoxes,
} from './leftPanelSplit';

const panel: { x: number; y: number; width: number; height: number } = {
  x: 40,
  y: 80,
  width: 240,
  height: 600,
};

const widePanel = { ...panel, width: 400 };

describe('left panel split geometry', () => {
  it('unions visible dock boxes', () => {
    expect(
      unionBoxes([
        { x: 10, y: 10, width: 100, height: 80 },
        { x: 10, y: 90, width: 100, height: 80 },
      ])
    ).toEqual({ x: 10, y: 10, width: 100, height: 160 });
    expect(unionBoxes([])).toBeNull();
  });

  it('uses the top and bottom thirds for vertical slots', () => {
    expect(resolveLeftPanelDropZone({ x: 50, y: 100 }, panel)).toBe('top');
    expect(resolveLeftPanelDropZone({ x: 50, y: 500 }, panel)).toBe('bottom');
    expect(resolveLeftPanelDropZone({ x: 8, y: 100 }, panel)).toBeNull();
  });

  it('uses the middle band for left and right even on a narrow dock', () => {
    expect(resolveLeftPanelDropZone({ x: 60, y: 380 }, panel)).toBe('left');
    expect(resolveLeftPanelDropZone({ x: 220, y: 380 }, panel)).toBe('right');
    expect(resolveLeftPanelDropZone({ x: 50, y: 100 }, panel)).toBe('top');
    expect(resolveLeftPanelDropZone({ x: 50, y: 640 }, panel)).toBe('bottom');
    expect(
      resolveLeftPanelDropZone({ x: 80, y: 380 }, widePanel)
    ).toBe('left');
    expect(
      resolveLeftPanelDropZone({ x: 360, y: 380 }, widePanel)
    ).toBe('right');
  });

  it('maps drop zones onto dockview directions and ghost boxes', () => {
    expect(dropZoneToDirection('top')).toBe('above');
    expect(dropZoneToDirection('bottom')).toBe('below');
    expect(ghostBoxForZone(panel, 'top')).toEqual({
      x: 40,
      y: 80,
      width: 240,
      height: 300,
    });
    expect(ghostBoxForZone(panel, 'right').x).toBe(160);
  });

  it('keeps the inner split proportional when the outer size changes', () => {
    expect(innerSizeAfterOuterResize(240, 280, 120)).toBe(140);
    expect(innerSizeAfterOuterResize(200, 240, 140)).toBe(168);
    expect(ratioFromSizes(140, 280)).toBe(0.5);
    expect(sizesFromRatio(280, 0.5, 80)).toEqual({ first: 140, second: 140 });
  });

  it('classifies stacked versus row docks', () => {
    expect(
      classifyLeftDockSplit([
        { x: 40, y: 80, width: 240, height: 300 },
        { x: 40, y: 380, width: 240, height: 300 },
      ])
    ).toBe('stack');
    expect(
      classifyLeftDockSplit([
        { x: 40, y: 80, width: 200, height: 600 },
        { x: 240, y: 80, width: 200, height: 600 },
      ])
    ).toBe('row');
    expect(classifyLeftDockSplit([{ x: 40, y: 80, width: 240, height: 600 }])).toBe(
      'single'
    );
  });

  it('tests point-in-box', () => {
    expect(boxContains(panel, { x: 40, y: 80 })).toBe(true);
    expect(boxContains(panel, { x: 39, y: 80 })).toBe(false);
  });
});
