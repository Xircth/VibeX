import { describe, expect, it } from 'vitest';
import type { AgentSessionConfigOption } from 'shared/types';
import {
  advertisedOptionForDefault,
  sessionDefaultsWritePayload,
} from './sessionDefaults';

const ANTIGRAVITY_CATALOG: AgentSessionConfigOption[] = [
  {
    key: 'model',
    label: 'Model',
    category: 'model',
    value: 'gemini-3.8-flash',
    choices: [
      {
        value: 'gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        description: null,
      },
      { value: 'gemini-4-argon', label: 'Gemini 4 Argon', description: null },
    ],
  },
  {
    key: 'thinking_level',
    label: 'Thinking',
    category: 'thought_level',
    value: 'medium',
    choices: [
      { value: 'low', label: 'Low', description: null },
      { value: 'medium', label: 'Medium', description: null },
      { value: 'high', label: 'High', description: null },
    ],
  },
];

describe('sessionDefaultsWritePayload', () => {
  it('maps Antigravity live thought-level aliases onto thinking_level', () => {
    expect(
      sessionDefaultsWritePayload(ANTIGRAVITY_CATALOG, {
        model: 'gemini-4-argon',
        effort: 'high',
      })
    ).toEqual({
      model: 'gemini-4-argon',
      thinking_level: 'high',
    });
  });

  it('drops pre-update model ids that the new catalog no longer advertises', () => {
    expect(
      sessionDefaultsWritePayload(ANTIGRAVITY_CATALOG, {
        model: 'gemini-3.8-flash-high',
        thinking_level: 'high',
      })
    ).toEqual({
      thinking_level: 'high',
    });
  });

  it('finds the catalog thought-level option by vendor alias', () => {
    expect(advertisedOptionForDefault(ANTIGRAVITY_CATALOG, 'effort')?.key).toBe(
      'thinking_level'
    );
  });
});
