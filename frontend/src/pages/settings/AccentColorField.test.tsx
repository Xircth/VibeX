import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

const mocks = vi.hoisted(() => ({
  getAccentColor: vi.fn(() => '#171717'),
  setAccentColor: vi.fn(),
}));

vi.mock('@/lib/uiAccent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/uiAccent')>();
  return {
    ...actual,
    getAccentColor: mocks.getAccentColor,
    setAccentColor: mocks.setAccentColor,
  };
});

import { AccentColorField } from './AccentColorField';

describe('AccentColorField', () => {
  beforeEach(() => {
    mocks.getAccentColor.mockReturnValue('#171717');
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
    expect(hex).toHaveValue('#171717');

    await user.clear(hex);
    await user.type(hex, '#3f6cc4');

    expect(mocks.setAccentColor).toHaveBeenCalledWith('#3f6cc4');
  });

  it('opens a color palette popover from the swatch', async () => {
    const user = userEvent.setup();
    render(<AccentColorField />);

    await user.click(screen.getByRole('button', { name: '选择强调色' }));

    expect(screen.getByRole('slider', { name: '色相' })).toBeInTheDocument();
  });
});
