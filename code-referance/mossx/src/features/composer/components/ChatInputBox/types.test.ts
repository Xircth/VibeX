import { describe, expect, it } from 'vitest';

import { CODEX_MODELS } from './types';

describe('CODEX_MODELS', () => {
  it('uses gpt-5.4 and removes gpt-5.2 from the built-in model list', () => {
    expect(CODEX_MODELS.some(model => model.id === 'gpt-5.4')).toBe(true);
    expect(CODEX_MODELS.some(model => model.id === 'gpt-5.3')).toBe(false);
    expect(CODEX_MODELS.some(model => model.id === 'gpt-5.2')).toBe(false);
  });
});
