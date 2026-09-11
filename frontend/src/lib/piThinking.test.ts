import { describe, expect, it } from 'vitest';

import {
  implicitWireValue,
  levelsFromMap,
  reasoningFromModel,
  reasoningToMap,
  toggleThinkingLevel,
} from './piThinking';

describe('piThinking', () => {
  it('offers every level except xhigh when the map is empty', () => {
    expect(levelsFromMap({})).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
    ]);
  });

  it('drops null entries and requires an explicit xhigh mapping', () => {
    expect(
      levelsFromMap({
        low: null,
        xhigh: 'xhigh',
      })
    ).toEqual(['off', 'minimal', 'medium', 'high', 'xhigh']);
  });

  it('round-trips a declared custom model without restating implicit wires', () => {
    const reasoning = reasoningFromModel(true, {
      off: 'none',
      high: 'HIGH',
      xhigh: null,
    });
    expect(reasoning).toEqual({
      enabled: true,
      levels: ['off', 'minimal', 'low', 'medium', 'high'],
      wireValues: { high: 'HIGH' },
    });
    expect(reasoningToMap(reasoning)).toEqual({
      off: 'none',
      high: 'HIGH',
      xhigh: null,
    });
  });

  it('keeps chip order stable when toggling', () => {
    expect(toggleThinkingLevel(['high', 'off'], 'low')).toEqual([
      'off',
      'low',
      'high',
    ]);
  });

  it('maps off to none when the wire value is implicit', () => {
    expect(implicitWireValue('off')).toBe('none');
    expect(implicitWireValue('medium')).toBe('medium');
  });
});
