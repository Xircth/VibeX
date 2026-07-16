import { describe, expect, it } from 'vitest';
import type { AgentSessionConfigOption } from 'shared/types';
import {
  configOptionDisplayState,
  resolvedConfigOptionChoices,
  sanitizeDependentConfigValues,
  selectConfigOptionValue,
} from './SessionConfigOptionSelectors';

const MODEL_DEPENDENT_OPTIONS: AgentSessionConfigOption[] = [
  {
    key: 'model',
    label: 'Model',
    category: 'model',
    value: null,
    choices: [
      { value: 'large', label: 'Large' },
      { value: 'small', label: 'Small' },
    ],
  },
  {
    key: 'effort',
    label: 'Work intensity',
    category: 'thought_level',
    value: null,
    choices: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ],
    dependency: {
      parent_key: 'model',
      choices_by_parent_value: {
        large: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' },
        ],
        small: [{ value: 'low', label: 'Low' }],
      },
    },
  },
];

describe('model-dependent session config options', () => {
  it('does not resolve or retain effort before a model is actually known', () => {
    const effort = MODEL_DEPENDENT_OPTIONS[1];
    expect(
      resolvedConfigOptionChoices(effort, MODEL_DEPENDENT_OPTIONS, {})
    ).toEqual([]);
    expect(
      sanitizeDependentConfigValues(MODEL_DEPENDENT_OPTIONS, { effort: 'high' })
    ).toEqual({});
  });

  it('uses only the selected model choices and clears an invalid old effort', () => {
    const withLarge = selectConfigOptionValue(
      MODEL_DEPENDENT_OPTIONS,
      {},
      'model',
      'large'
    );
    const withHighEffort = selectConfigOptionValue(
      MODEL_DEPENDENT_OPTIONS,
      withLarge,
      'effort',
      'high'
    );
    expect(withHighEffort).toEqual({ model: 'large', effort: 'high' });
    expect(
      resolvedConfigOptionChoices(
        MODEL_DEPENDENT_OPTIONS[1],
        MODEL_DEPENDENT_OPTIONS,
        withHighEffort
      ).map((choice) => choice.value)
    ).toEqual(['low', 'high']);

    expect(
      selectConfigOptionValue(
        MODEL_DEPENDENT_OPTIONS,
        withHighEffort,
        'model',
        'small'
      )
    ).toEqual({ model: 'small' });
  });
});

describe('Agent-advertised choice presentation', () => {
  it('keeps Default and the exact active value instead of substituting choices', () => {
    const option: AgentSessionConfigOption = {
      key: 'model',
      label: 'Model',
      category: 'model',
      value: 'default',
      choices: [
        { value: 'default', label: 'Default' },
        { value: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
      ],
    };

    expect(configOptionDisplayState(option, null)).toEqual({
      displayChoices: [
        { value: 'default', name: 'Default', description: undefined },
        {
          value: 'gpt-5.6-sol',
          name: 'GPT 5.6 Sol',
          description: undefined,
        },
      ],
      presentedActiveValue: 'default',
    });
  });
});
