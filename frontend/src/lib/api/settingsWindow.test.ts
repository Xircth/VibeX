import { beforeEach, describe, expect, it, vi } from 'vitest';

import i18n from '@/i18n';

const backendCall = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('./base', () => ({
  backendCall,
}));

import { settingsWindowApi } from './settingsWindow';

describe('settingsWindowApi', () => {
  beforeEach(() => {
    backendCall.mockClear();
  });

  it('opens the settings window with the Chinese title', async () => {
    await i18n.changeLanguage('zh-CN');

    await settingsWindowApi.open();

    expect(backendCall).toHaveBeenCalledWith('open_settings_window', {
      title: '设置',
    });
  });

  it('opens the settings window with the English title', async () => {
    await i18n.changeLanguage('en');

    await settingsWindowApi.open();

    expect(backendCall).toHaveBeenCalledWith('open_settings_window', {
      title: 'Settings',
    });
  });
});
