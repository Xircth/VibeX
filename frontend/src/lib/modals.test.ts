import { describe, expect, it } from 'vitest';

import { getErrorMessage } from './modals';

describe('getErrorMessage', () => {
  it('uses a Host error envelope message', () => {
    expect(
      getErrorMessage({
        code: 'bad_request',
        message: 'pluginId and handler are required',
      })
    ).toBe('pluginId and handler are required');
  });

  it('falls back when the payload has no message', () => {
    expect(getErrorMessage({ code: 'internal' })).toBe(
      'An unknown error occurred'
    );
  });

  it('returns the reason a Host command rejected with', () => {
    expect(getErrorMessage('Conflict: Failed to bind 0.0.0.0:17891')).toBe(
      'Conflict: Failed to bind 0.0.0.0:17891'
    );
  });

  it('uses the caller fallback when no reason can be read', () => {
    expect(getErrorMessage({ code: 'internal' }, '保存失败')).toBe('保存失败');
    expect(getErrorMessage(undefined, '保存失败')).toBe('保存失败');
  });

  it('keeps a readable reason ahead of the caller fallback', () => {
    expect(getErrorMessage(new Error('port in use'), '保存失败')).toBe(
      'port in use'
    );
  });
});
