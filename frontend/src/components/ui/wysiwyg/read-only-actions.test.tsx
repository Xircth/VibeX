import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WysiwygReadOnlyActions } from './read-only-actions';

describe('WysiwygReadOnlyActions', () => {
  it('renders the copy action with the current copied state label', () => {
    const onCopy = vi.fn();
    const { rerender } = render(
      <WysiwygReadOnlyActions copied={false} onCopy={onCopy} />
    );

    expect(
      screen.getByRole('button', { name: 'Copy as Markdown' })
    ).toBeInTheDocument();

    rerender(<WysiwygReadOnlyActions copied onCopy={onCopy} />);

    expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();
  });

  it('calls the copy handler when copy is clicked', () => {
    const onCopy = vi.fn();

    render(<WysiwygReadOnlyActions copied={false} onCopy={onCopy} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }));

    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it('renders edit and delete actions only when callbacks are provided', () => {
    const { rerender } = render(
      <WysiwygReadOnlyActions copied={false} onCopy={vi.fn()} />
    );

    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();

    rerender(
      <WysiwygReadOnlyActions
        copied={false}
        onCopy={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('calls edit and delete handlers when their buttons are clicked', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();

    render(
      <WysiwygReadOnlyActions
        copied={false}
        onCopy={vi.fn()}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
