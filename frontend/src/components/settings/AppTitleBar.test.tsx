import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AppTitleBar } from './AppTitleBar';

describe('AppTitleBar', () => {
  it('is a drag region without embedding window controls', () => {
    render(<AppTitleBar left={<span>Settings</span>} />);

    const bar = screen.getByText('Settings').closest('.settings-titlebar');
    expect(bar).toHaveClass('window-chrome');
    expect(bar?.querySelector('[data-tauri-drag-region]')).not.toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Minimize' })
    ).not.toBeInTheDocument();
  });
});
