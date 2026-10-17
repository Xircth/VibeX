import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ComposerPrimaryActionButton } from './ComposerPrimaryActionButton';

describe('ComposerPrimaryActionButton', () => {
  it('keeps a filled send target that is not a ghost button', () => {
    const onClick = vi.fn();
    render(
      <ComposerPrimaryActionButton
        action="send"
        label="发送"
        onClick={onClick}
      />
    );

    const button = screen.getByRole('button', { name: '发送' });
    expect(button).toHaveClass('composer-primary-action');
    expect(button).toHaveAttribute('data-variant', 'primary');
    expect(button.querySelector('svg')).not.toBeNull();

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('shows the stop mark and blocks clicks while disabled', () => {
    const onClick = vi.fn();
    render(
      <ComposerPrimaryActionButton
        action="stop"
        label="停止"
        disabled
        onClick={onClick}
      />
    );

    const button = screen.getByRole('button', { name: '停止' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('shows a spinner while the action is pending', () => {
    render(
      <ComposerPrimaryActionButton
        action="send"
        label="发送"
        pending
        onClick={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: '发送' })).toHaveAttribute(
      'aria-busy',
      'true'
    );
    expect(
      document.querySelector('.composer-primary-action .animate-spin')
    ).not.toBeNull();
  });
});
