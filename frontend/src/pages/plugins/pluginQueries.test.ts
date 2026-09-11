import { describe, expect, it } from 'vitest';

import { errorMessage } from './pluginQueries';

describe('pluginQueries errorMessage', () => {
  it('reads the Host ErrorEnvelope message instead of [object Object]', () => {
    expect(
      errorMessage({
        code: 'bad_request',
        message: 'missing field `path`',
        retryable: false,
        operation_id: 'op-1',
        details: null,
      })
    ).toBe('missing field `path`');
  });
});
