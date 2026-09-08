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
});
