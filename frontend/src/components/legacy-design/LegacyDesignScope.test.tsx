import { render, waitFor } from '@testing-library/react';
import { ThemeMode } from 'shared/types';
import { describe, expect, it } from 'vitest';
import { ThemeProvider } from '@/components/ThemeProvider';
import { LegacyDesignScope } from './LegacyDesignScope';

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
});
