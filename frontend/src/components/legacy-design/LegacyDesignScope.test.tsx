import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, waitFor } from '@testing-library/react';
import { ThemeMode } from 'shared/types';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from '@/components/ThemeProvider';
import { LegacyDesignScope } from './LegacyDesignScope';

const legacyStyles = readFileSync(
  resolve(process.cwd(), 'src/styles/legacy/index.css'),
  'utf8'
);

describe('LegacyDesignScope', () => {
  it('keeps the Astryx color mode synchronized with the VibeX theme', async () => {
    render(
      <ThemeProvider initialTheme={ThemeMode.DARK}>
        <LegacyDesignScope>
          <div>content</div>
        </LegacyDesignScope>
      </ThemeProvider>
    );

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    });
  });

  it('contains the application shell inside the viewport', () => {
    const { container } = render(
      <ThemeProvider initialTheme={ThemeMode.LIGHT}>
        <LegacyDesignScope>content</LegacyDesignScope>
      </ThemeProvider>
    );

    expect(container.firstElementChild).toHaveClass(
      'h-full',
      'min-h-0',
      'overflow-hidden'
    );
    expect(container.firstElementChild).not.toHaveClass('min-h-screen');
    const viewportRule =
      legacyStyles.match(/html,\s*body,\s*#root\s*\{[^}]+\}/u)?.[0] ?? '';
    expect(viewportRule).toContain('height: 100%');
    expect(viewportRule).toContain('overflow: hidden');
    expect(viewportRule).toContain('overscroll-behavior: none');
  });
});
