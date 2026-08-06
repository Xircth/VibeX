import { afterEach, describe, expect, it } from 'vitest';

import i18n from '@/i18n';

import { agentManagementErrorMessage } from './errorMessage';

describe('agentManagementErrorMessage', () => {
  afterEach(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('never leaks a backend Chinese message into the English UI', async () => {
    await i18n.changeLanguage('en');
    expect(
      agentManagementErrorMessage(
        { message: 'Agent 设置不存在' },
        'Unable to save Agent settings'
      )
    ).toBe('Unable to save Agent settings');
  });

  it('preserves actionable same-language details', async () => {
    await i18n.changeLanguage('en');
    expect(
      agentManagementErrorMessage(
        new Error('OPENAI_API_KEY is required'),
        'Unable to save'
      )
    ).toBe('OPENAI_API_KEY is required');
  });
});
