import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ENABLED_PI_THINKING_LEVELS,
  implicitWireValue,
  levelsFromMap,
  NO_PI_REASONING,
  piReasoningIssue,
  reasoningFromModel,
  reasoningToMap,
  thinkingLevelMapFromUnknown,
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

  it('does not flag a provider that never declared reasoning', () => {
    expect(piReasoningIssue(NO_PI_REASONING, 'high')).toBeNull();
  });

  it('requires at least one thinking level once reasoning is declared', () => {
    expect(
      piReasoningIssue({ enabled: true, levels: [], wireValues: {} }, 'off')
    ).toBe('empty-levels');
  });

  it('rejects a default thinking level the model does not advertise', () => {
    expect(
      piReasoningIssue(
        { enabled: true, levels: ['off', 'high'], wireValues: {} },
        'xhigh'
      )
    ).toBe('default-unlisted');
  });

  it('defaults new reasoning declarations to every level except xhigh', () => {
    expect(DEFAULT_ENABLED_PI_THINKING_LEVELS).toEqual([
      'off',
      'minimal',
      'low',
      'medium',
      'high',
    ]);
  });

  it('reads camelCase and snake_case thinking maps', () => {
    expect(
      thinkingLevelMapFromUnknown({
        off: 'none',
        xhigh: null,
        ignored: 'nope',
      })
    ).toEqual({ off: 'none', xhigh: null });
    expect(thinkingLevelMapFromUnknown(null)).toBeUndefined();
  });
});
