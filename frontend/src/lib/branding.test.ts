import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_DEV_SITE_URL,
  DEFAULT_SITE_URL,
  getSiteHost,
  getSiteUrl,
} from './branding';

describe('getSiteUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses DEFAULT_SITE_URL in non-dev or test mode by default', () => {
    expect(getSiteUrl('/api/auth/desktop/start')).toBe(
      `${DEFAULT_SITE_URL}/api/auth/desktop/start`
    );
  });

  it('connects to DEFAULT_DEV_SITE_URL when running in dev mode without override', () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('MODE', 'development');
    expect(getSiteUrl()).toBe(DEFAULT_DEV_SITE_URL);
    expect(getSiteUrl('/api/auth/desktop/start')).toBe(
      `${DEFAULT_DEV_SITE_URL}/api/auth/desktop/start`
    );
    expect(getSiteHost()).toBe('localhost');
  });

  it('prefers explicit VIBEX_SITE_URL even in dev mode', () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('MODE', 'development');
    vi.stubEnv('VIBEX_SITE_URL', 'http://127.0.0.1:4100/');
    expect(getSiteUrl('/desktop/authorize')).toBe(
      'http://127.0.0.1:4100/desktop/authorize'
    );
  });
});
