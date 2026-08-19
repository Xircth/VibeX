import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const theme = vi.hoisted(() => ({
  resolvedTheme: 'light' as 'light' | 'dark',
}));

vi.mock('@/components/ThemeProvider', () => ({
  useTheme: () => theme,
}));

import { Logo } from './Logo';

describe('Logo', () => {
  beforeEach(() => {
    localStorage.clear();
    theme.resolvedTheme = 'light';
  });

  it('uses the light standalone mark in light mode', () => {
    render(<Logo showText={false} />);

    expect(screen.getByRole('img')).toHaveAttribute(
      'src',
      expect.stringContaining('app-logo-light-lite.png')
    );
  });

  it('uses the dark standalone mark in dark mode', () => {
    theme.resolvedTheme = 'dark';
    render(<Logo showText={false} />);

    expect(screen.getByRole('img')).toHaveAttribute(
      'src',
      expect.stringContaining('app-logo-dark-lite.png')
    );
  });

  it('uses the reduced homepage and workspace sizes', () => {
    const { rerender } = render(<Logo showText={false} size="hero" />);

    expect(screen.getByRole('img')).toHaveClass('h-[60.75px]', 'w-[60.75px]');

    rerender(<Logo showText={false} size="toolbar" />);

    expect(screen.getByRole('img')).toHaveClass('h-[27px]', 'w-[27px]');
  });
});
