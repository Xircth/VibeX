import { describe, expect, it } from 'vitest';

import { isSettingsSurfacePath } from './settingsPreload';

describe('isSettingsSurfacePath', () => {
  it.each(['/settings', '/settings/agents', '/plugins', '/plugins/office'])(
    'treats %s as the settings surface',
    (pathname) => {
      expect(isSettingsSurfacePath(pathname)).toBe(true);
    }
  );

  it.each(['/', '/local-projects', '/local-projects/p1/sessions'])(
    'does not treat %s as the settings surface',
    (pathname) => {
      expect(isSettingsSurfacePath(pathname)).toBe(false);
    }
  );
});

describe('preloadSettingsPath', () => {
  it('ignores unknown paths', async () => {
    const { preloadSettingsPath } = await import('./settingsPreload');
    expect(() => preloadSettingsPath('/not-a-settings-page')).not.toThrow();
  });
});
