import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { HostGlass } from './host-glass';

const LIQUID_GLASS_STAGE_CONTRACT = {
  position: 'absolute' as const,
  top: '50%',
  left: '50%',
  width: '100%',
  height: '100%',
};

afterEach(() => {
  document.documentElement.classList.remove('host-windows');
});

describe('HostGlass', () => {
  it('renders children without a WebGL surface on Windows', () => {
    document.documentElement.classList.add('host-windows');
    render(
      <HostGlass className="chrome">
        <span>toolbar</span>
      </HostGlass>
    );
    expect(screen.getByText('toolbar')).toBeInTheDocument();
    expect(screen.queryByTestId('liquid-glass')).not.toBeInTheDocument();
  });

  it('fills the stage on Windows instead of keeping the LiquidGlass 50% contract', () => {
    document.documentElement.classList.add('host-windows');
    render(
      <HostGlass className="chrome" style={LIQUID_GLASS_STAGE_CONTRACT}>
        <span>toolbar</span>
      </HostGlass>
    );

    const glass = document.querySelector('.chrome');
    expect(glass).toHaveStyle({
      position: 'absolute',
      top: '0px',
      left: '0px',
      width: '100%',
      height: '100%',
    });
    expect(glass).not.toHaveStyle({ left: '50%' });
    expect(glass).not.toHaveStyle({ top: '50%' });
  });
});
