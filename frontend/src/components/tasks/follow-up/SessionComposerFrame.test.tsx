import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SessionComposerFrame } from './SessionComposerFrame';

describe('SessionComposerFrame', () => {
  it('places status notices in the composer stack behind the body', () => {
    render(
      <SessionComposerFrame status={<div data-testid="status-notices" />}>
        <div data-testid="composer-content" />
      </SessionComposerFrame>
    );

    const status = screen.getByTestId('status-notices');
    const body = screen.getByTestId('session-composer-body');

    expect(status.parentElement).toBe(body.parentElement);
    expect(status.nextElementSibling).toBe(body);
    expect(body).not.toContainElement(status);
  });

  it('pins the composer stack when an overlay sits under the status dock', () => {
    const { rerender } = render(
      <SessionComposerFrame
        status={<div data-testid="status-notices" />}
        overlay={<div data-testid="draft-conflict-banner" />}
      >
        <div data-testid="composer-content" />
      </SessionComposerFrame>
    );

    const stack = screen.getByTestId('session-composer-stack');
    expect(stack).toHaveAttribute('data-has-overlay', 'true');
    expect(screen.getByTestId('status-notices').nextElementSibling).toBe(
      screen.getByTestId('draft-conflict-banner')
    );

    rerender(
      <SessionComposerFrame status={<div data-testid="status-notices" />}>
        <div data-testid="composer-content" />
      </SessionComposerFrame>
    );
    expect(screen.getByTestId('session-composer-stack')).not.toHaveAttribute(
      'data-has-overlay'
    );
  });

  it('places the attachment drawer before and outside the composer body', () => {
    render(
      <SessionComposerFrame drawer={<div data-testid="attachment-drawer" />}>
        <div data-testid="composer-content" />
      </SessionComposerFrame>
    );

    const drawer = screen.getByTestId('attachment-drawer');
    const body = screen.getByTestId('session-composer-body');

    expect(drawer.parentElement).toBe(body.parentElement);
    expect(drawer.nextElementSibling).toBe(body);
    expect(body).not.toContainElement(drawer);
  });
});
