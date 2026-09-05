import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SurfaceLoading } from './SurfaceLoading';

describe('SurfaceLoading', () => {
  it('renders the settings surface skeleton instead of a spinner', () => {
    render(<SurfaceLoading label="Loading usage" />);

    const status = screen.getByRole('status', { name: 'Loading usage' });
    expect(status).toHaveClass('agent-settings-loading');
    expect(status.querySelectorAll('.settings-surface')).toHaveLength(2);
    expect(
      status.querySelectorAll('.agent-settings-loading-rows li')
    ).toHaveLength(5);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
