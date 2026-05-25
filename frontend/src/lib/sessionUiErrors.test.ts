import { describe, expect, it } from 'vitest';
import { getSessionUiErrorMessage } from './sessionUiErrors';

describe('getSessionUiErrorMessage', () => {
  it('strips backend prefixes from local-change checkout errors', () => {
    expect(
      getSessionUiErrorMessage(
        'Bad request: \u5f53\u524d\u5206\u652ffeature-a\u4e2d\u5b58\u5728\u672a\u63d0\u4ea4\u66f4\u6539\uff0c\u65e0\u6cd5\u5207\u6362\u5230main\u5206\u652f\uff0c\u8bf7\u5148\u63d0\u4ea4\u6216\u653e\u5f03\u66f4\u6539\u3002',
        'fallback'
      )
    ).toBe(
      '\u5f53\u524d\u5206\u652ffeature-a\u4e2d\u5b58\u5728\u672a\u63d0\u4ea4\u66f4\u6539\uff0c\u65e0\u6cd5\u5207\u6362\u5230main\u5206\u652f\uff0c\u8bf7\u5148\u63d0\u4ea4\u6216\u653e\u5f03\u66f4\u6539\u3002'
    );
  });

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
