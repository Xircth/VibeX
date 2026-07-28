import { describe, expect, it } from 'vitest';
import type { AgentSessionConfigOption } from 'shared/types';
import {
  configOptionDisplayState,
  presentableSessionConfigOptions,
  resolvedConfigOptionChoices,
  sanitizeDependentConfigValues,
  selectConfigOptionValue,
  visibleSessionConfigOptions,
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
  it('deduplicates only a config mode whose choices match the session modes', () => {
    const modeOption: AgentSessionConfigOption = {
      key: 'mode',
      label: 'Mode',
      category: 'mode',
      value: 'agent',
      choices: [
        { value: 'read-only', label: 'Read-only' },
        { value: 'agent', label: 'Agent' },
      ],
    };
    const matchingModes = [
      { id: 'read-only', label: 'Read-only' },
      { id: 'agent', label: 'Agent' },
    ];

    expect(
      presentableSessionConfigOptions([modeOption], matchingModes)
    ).toEqual([]);
    expect(
      presentableSessionConfigOptions(
        [modeOption],
        [
          ...matchingModes,
          { id: 'agent-full-access', label: 'Agent (full access)' },
        ]
      )
    ).toEqual([modeOption]);
  });

  it('shortens the Codex Agent full access choice without changing its value', () => {
    const option: AgentSessionConfigOption = {
      key: 'mode',
      label: 'Mode',
      value: 'agent-full-access',
      choices: [
        { value: 'agent', label: 'Agent' },
        { value: 'agent-full-access', label: 'Agent (full access)' },
      ],
    };

    expect(configOptionDisplayState(option, null)).toMatchObject({
      displayChoices: [
        { value: 'agent', name: 'Agent' },
        { value: 'agent-full-access', name: '完全访问' },
      ],
      presentedActiveValue: 'agent-full-access',
    });
  });

  it('hides Codex collaboration mode while preserving the runtime snapshot', () => {
    const collaborationMode: AgentSessionConfigOption = {
      key: 'collaboration_mode',
      label: 'Collaboration mode',
      value: 'default',
      choices: [
        { value: 'default', label: 'Default' },
        { value: 'plan', label: 'Plan' },
      ],
    };
    const options = [MODEL_DEPENDENT_OPTIONS[0], collaborationMode];

    expect(visibleSessionConfigOptions(options)).toEqual([
      MODEL_DEPENDENT_OPTIONS[0],
    ]);
    expect(
      sanitizeDependentConfigValues(visibleSessionConfigOptions(options), {
        model: 'large',
        collaboration_mode: 'plan',
      })
    ).toEqual({ model: 'large' });
    expect(collaborationMode.value).toBe('default');
  });

  it("hides Claude Code's redundant Default model sentinel", () => {
    const option: AgentSessionConfigOption = {
      key: 'model',
      label: 'Model',
      category: 'model',
      value: 'gpt-5.6-sol',
      choices: [
        { value: 'default', label: 'Default (recommended)' },
        { value: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
      ],
    };

    expect(configOptionDisplayState(option, null)).toEqual({
      displayChoices: [
        {
          value: 'gpt-5.6-sol',
          name: 'GPT 5.6 Sol',
          description: undefined,
        },
      ],
      presentedActiveValue: 'gpt-5.6-sol',
    });
  });
});
