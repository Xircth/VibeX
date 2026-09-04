import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsActionBar } from './SettingsUi';

vi.mock('@/hooks/useMediaQuery', () => ({
  useMediaQuery: () => false,
}));

afterEach(() => {
  document.documentElement.classList.remove('host-windows');
});

describe('SettingsActionBar', () => {
  it('fills the Windows stage so Cancel and Save stay in the pane', () => {
    document.documentElement.classList.add('host-windows');
    const { container } = render(
      <div className="settings-page">
        <SettingsActionBar
          dirty
          saving={false}
          onDiscard={vi.fn()}
          onSave={vi.fn()}
        />
      </div>
    );

    const glass = container.querySelector('.settings-action-bar__glass');
    expect(glass).toBeTruthy();
    expect(glass).toHaveStyle({
      position: 'absolute',
      top: '0px',
      left: '0px',
      width: '100%',
      height: '100%',
    });
    expect(glass).not.toHaveStyle({ left: '50%' });
  });

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
