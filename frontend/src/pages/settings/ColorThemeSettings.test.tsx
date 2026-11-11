import { THEME_COLOR_ROLES } from '@vibex/plugin-sdk';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference: vi.fn(),
}));

import { clearLocalStorageCache } from '@/lib/safeStorage';
import {
  COLOR_THEME_KEYS,
  getColorThemeSnapshot,
  previewColorTheme,
  userThemeKey,
} from '@/lib/theme/colorThemeStore';

import { THEME_ROLE_GROUPS } from './ColorThemeEditor';
import { ColorThemeSettings } from './ColorThemeSettings';

function themeStylesheet(): string {
  return (
    document.head.querySelector('style[data-vibex-color-theme]')?.textContent ??
    ''
  );
}

describe('ColorThemeSettings', () => {
  beforeEach(() => {
    localStorage.clear();
    clearLocalStorageCache();
    previewColorTheme(null);
  });

  it('groups every theme role exactly once', () => {
    const grouped = THEME_ROLE_GROUPS.flatMap((group) => group.roles);
    expect([...grouped].sort()).toEqual([...THEME_COLOR_ROLES].sort());
  });

  it('duplicates the active theme, previews edits live, and saves a user theme', async () => {
    const user = userEvent.setup();
    render(<ColorThemeSettings />);

    expect(screen.getByText('浅色配色')).toBeInTheDocument();
    expect(screen.getByText('深色配色')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: '复制并编辑' })[1]);

    const name = screen.getByRole('textbox', { name: '名称' });
    expect(name).toHaveValue('VibeX 副本');

    const background = screen.getByRole('textbox', { name: '背景 色值' });
    fireEvent.change(background, { target: { value: '#0b0e14' } });
    expect(themeStylesheet()).toContain('--surface-shell: #0b0e14;');

    await user.click(screen.getByRole('button', { name: '保存并使用' }));

    const key = userThemeKey('dark-custom');
    expect(localStorage.getItem(COLOR_THEME_KEYS.dark)).toBe(key);
    expect(getColorThemeSnapshot().active.dark.theme.colors.background).toBe(
      '#0b0e14'
    );
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument();
  });

  it('blocks saving while body text fails contrast', async () => {
    const user = userEvent.setup();
    render(<ColorThemeSettings />);

    await user.click(screen.getAllByRole('button', { name: '复制并编辑' })[0]);
    fireEvent.change(screen.getByRole('textbox', { name: '文字 色值' }), {
      target: { value: '#eeeeee' },
    });

    expect(screen.getByText('修正标红项后才能保存')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存并使用' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(themeStylesheet()).toBe('');
  });
});
