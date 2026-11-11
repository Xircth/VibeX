import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

const mocks = vi.hoisted(() => ({
  getAccentColor: vi.fn(() => '#1b1b1b'),
  setAccentColor: vi.fn(),
}));

vi.mock('@/lib/frontendPreferences', () => ({
  persistFrontendPreference: vi.fn(),
}));

vi.mock('@/lib/uiAccent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/uiAccent')>();
  return {
    ...actual,
    getAccentColor: mocks.getAccentColor,
    setAccentColor: mocks.setAccentColor,
  };
});

import { clearLocalStorageCache } from '@/lib/safeStorage';

import { AccentColorField } from './AccentColorField';

describe('AccentColorField', () => {
  beforeEach(() => {
    localStorage.clear();
    clearLocalStorageCache();
    mocks.getAccentColor.mockReturnValue('#1b1b1b');
    mocks.setAccentColor.mockReset();
    mocks.setAccentColor.mockImplementation((hex: string) => {
      mocks.getAccentColor.mockReturnValue(
        hex.startsWith('#') ? hex.toLowerCase() : `#${hex.toLowerCase()}`
      );
    });
  });

  it('shows the current accent hex and applies a typed value', async () => {
    const user = userEvent.setup();
    render(<AccentColorField />);

    const hex = screen.getByRole('textbox', { name: '色值' });
    expect(hex).toHaveValue('#1b1b1b');

    await user.clear(hex);
    await user.type(hex, '#3f6cc4');

    expect(mocks.setAccentColor).toHaveBeenCalledWith('#3f6cc4');
  });

  it('offers to follow the theme only while an override is set', async () => {
    const user = userEvent.setup();
    localStorage.setItem('vibex:accent-color', '#3f6cc4');
    clearLocalStorageCache('vibex:accent-color');
    render(<AccentColorField />);

    expect(screen.getByRole('textbox', { name: '色值' })).toHaveValue(
      '#3f6cc4'
    );
    await user.click(screen.getByRole('button', { name: '跟随主题' }));

    expect(localStorage.getItem('vibex:accent-color')).toBe('');
    expect(
      screen.queryByRole('button', { name: '跟随主题' })
    ).not.toBeInTheDocument();
  });

  it('opens a color palette popover from the swatch', async () => {
    const user = userEvent.setup();
    render(<AccentColorField />);

    await user.click(screen.getByRole('button', { name: '选择强调色' }));

    expect(screen.getByRole('slider', { name: '色相' })).toBeInTheDocument();
  });
});
