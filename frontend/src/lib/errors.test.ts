import { describe, expect, it } from 'vitest';

import { getInvokeErrorMessage, isCanceledError } from './errors';

describe('getInvokeErrorMessage', () => {
  it('reads the message from a Host ErrorEnvelope object', () => {
    expect(
      getInvokeErrorMessage({
        code: 'bad_request',
        message: 'missing field conversationId',
        retryable: false,
        operation_id: 'op-1',
        details: null,
      })
    ).toBe('missing field conversationId');
  });

  it('does not stringify a plain object as [object Object]', () => {
    expect(String({ message: 'hidden' })).toBe('[object Object]');
    expect(getInvokeErrorMessage({ message: 'hidden' })).toBe('hidden');
  });

  it('keeps Error and string values', () => {
    expect(getInvokeErrorMessage(new Error('boom'))).toBe('boom');
    expect(getInvokeErrorMessage('already a string')).toBe('already a string');
  });
});

describe('isCanceledError', () => {
  it('treats a Host envelope cancel as canceled', () => {
    expect(
      isCanceledError({
        code: 'bad_request',
        message: 'Request cancelled',
      })
    ).toBe(true);
  });
});
