import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SettingsActionBar } from './SettingsUi';

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

describe('SettingsActionBar', () => {
  it('uses a stronger neutral lens without chromatic edge artifacts', () => {
    render(
      <SettingsActionBar
        dirty
        saving={false}
        onDiscard={vi.fn()}
        onSave={vi.fn()}
      />
    );

    expect(screen.getByTestId('liquid-glass')).toHaveAttribute(
      'data-aberration-intensity',
      '0'
    );
    expect(screen.getByTestId('liquid-glass')).toHaveAttribute(
      'data-blur-amount',
      '0.16'
    );
    expect(screen.getByTestId('liquid-glass')).toHaveAttribute(
      'data-saturation',
      '155'
    );
    expect(screen.getByTestId('liquid-glass')).toHaveAttribute(
      'data-elasticity',
      '0.12'
    );
  });
});
