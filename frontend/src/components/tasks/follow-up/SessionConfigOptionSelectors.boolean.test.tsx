import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SessionConfigOptionSelectors } from './SessionConfigOptionSelectors';

describe('SessionConfigOptionSelectors boolean controls', () => {
  it('renders Fast as a switch and reports a boolean-shaped choice value', async () => {
    const onSelect = vi.fn();
    render(
      <SessionConfigOptionSelectors
        options={[
          {
            key: 'fast',
            label: 'Fast',
            value: false,
            choices: [
              { value: false, label: 'Off' },
              { value: true, label: 'On' },
            ],
          },
        ]}
        pending={{}}
        onSelect={onSelect}
      />
    );

    await userEvent.click(screen.getByRole('switch', { name: 'Fast' }));
    expect(onSelect).toHaveBeenCalledWith('fast', 'true');
  });
});
