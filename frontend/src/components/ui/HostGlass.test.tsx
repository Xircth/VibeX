import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HostGlass } from './HostGlass';

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
    document.documentElement.classList.remove('host-windows');
  });
});
