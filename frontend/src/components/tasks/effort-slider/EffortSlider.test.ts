import { describe, expect, it } from 'vitest';
import { orderChoicesByEffort, type EffortSliderChoice } from './EffortSlider';

function choice(value: string, label = value): EffortSliderChoice {
  return { value, label };
}

describe('orderChoicesByEffort', () => {
  it('moves a leading Default next to High instead of leftmost', () => {
    const ordered = orderChoicesByEffort([
      choice('default', 'Default'),
      choice('low', 'Low'),
      choice('medium', 'Medium'),
      choice('high', 'High'),
      choice('xhigh', 'Extra High'),
      choice('max', 'Max'),
    ]);

    expect(ordered.map((c) => c.value)).toEqual([
      'low',
      'medium',
      'high',
      'default',
      'xhigh',
      'max',
    ]);
  });

  it('keeps an already ascending list stable', () => {
    const ordered = orderChoicesByEffort([
      choice('low', 'Low'),
      choice('medium', 'Medium'),
      choice('high', 'High'),
      choice('xhigh', 'Extra High'),
    ]);

    expect(ordered.map((c) => c.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('ranks by label when the value is opaque', () => {
    const ordered = orderChoicesByEffort([
      choice('opt-c', 'High'),
      choice('opt-a', 'Low'),
      choice('opt-b', 'Medium'),
    ]);

    expect(ordered.map((c) => c.label)).toEqual(['Low', 'Medium', 'High']);
  });

  it('falls back to the advertised order when any choice is unknown', () => {
    const advertised = [
      choice('galaxy-brain', 'Galaxy Brain'),
      choice('low', 'Low'),
      choice('high', 'High'),
    ];

    expect(orderChoicesByEffort(advertised)).toEqual(advertised);
  });
});
