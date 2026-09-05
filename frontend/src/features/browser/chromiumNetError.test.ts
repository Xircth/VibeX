import { describe, expect, it } from 'vitest';
import { browserUrlsEquivalent } from './browserUrl';
import {
  browserErrorCode,
  browserLoadErrorKind,
  isCancelledBrowserError,
} from './chromiumNetError';

describe('chromiumNetError', () => {
  it('treats trailing slashes as the same address', () => {
    expect(
      browserUrlsEquivalent('https://gmail.com', 'https://gmail.com/')
    ).toBe(true);
    expect(browserUrlsEquivalent('gmail.com', 'https://gmail.com')).toBe(true);
  });

  it('ignores aborted navigations that Chromium reports as load errors', () => {
    expect(isCancelledBrowserError('ERR_ABORTED', 'net::ERR_ABORTED')).toBe(
      true
    );
    expect(
      isCancelledBrowserError('ErrAborted', 'The navigation was aborted.')
    ).toBe(true);
    expect(
      isCancelledBrowserError(
        'ERR_SOCKET_NOT_CONNECTED',
        'ERR_SOCKET_NOT_CONNECTED'
      )
    ).toBe(false);
  });

  it('classifies Chromium net errors for the load-error surface', () => {
    expect(
      browserLoadErrorKind({
        code: 'ERR_NAME_NOT_RESOLVED',
        message: 'The host could not be resolved.',
      })
    ).toBe('notFound');
    expect(
      browserLoadErrorKind({
        code: 'Failed',
        message: 'ERR_SOCKET_NOT_CONNECTED',
      })
    ).toBe('connection');
    expect(
      browserErrorCode({
        code: 'Failed',
        message: 'net::ERR_SOCKET_NOT_CONNECTED',
      })
    ).toBe('ERR_SOCKET_NOT_CONNECTED');
  });
});
