import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('renders title, description and action', () => {
    render(
      <EmptyState
        icon={<svg data-testid="icon" />}
        title="Nothing here"
        description="Add something"
        action={<button type="button">Add</button>}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Nothing here');
    expect(screen.getByText('Add something')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });
});
