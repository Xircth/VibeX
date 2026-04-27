import { describe, expect, it } from 'vitest';
import { getSessionUiErrorMessage } from './sessionUiErrors';

describe('getSessionUiErrorMessage', () => {
  it('maps invalid references to a branch-refresh hint', () => {
    expect(
      getSessionUiErrorMessage(
        'Internal error: Invalid repository: git command failed: fatal: invalid reference: vk/0686-new-session-work',
        '创建会话失败，请稍后重试。'
      )
    ).toBe('所选分支不存在，工作区/分支列表可能已过期。请刷新后重新选择。');
  });

  it('falls back to the original message when no specialized mapping exists', () => {
    expect(
      getSessionUiErrorMessage(
        new Error('custom failure'),
        '创建会话失败，请稍后重试。'
      )
    ).toBe('custom failure');
  });
});
