import { fireEvent, render, screen } from '@testing-library/react';
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
    const anchor = screen.getByTestId('session-composer-anchor');

    expect(status.parentElement).toBe(anchor.parentElement);
    expect(body.parentElement).toBe(anchor);
    expect(body).toHaveClass('rounded-lg');
    expect(status.nextElementSibling).toBe(anchor);
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
    const anchor = screen.getByTestId('session-composer-anchor');

    expect(drawer.parentElement).toBe(anchor.parentElement);
    expect(drawer.nextElementSibling).toBe(anchor);
    expect(body.parentElement).toBe(anchor);
    expect(body).not.toContainElement(drawer);
  });

  it('constrains the composer stack to the message stream reading width by default and supports widthClassName overrides', () => {
    const { rerender } = render(
      <SessionComposerFrame>
        <div data-testid="composer-content" />
      </SessionComposerFrame>
    );

    const stack = screen.getByTestId('session-composer-stack');
    expect(stack).toHaveClass('mx-auto', 'w-full', 'max-w-3xl');
    expect(stack.parentElement).toHaveClass('px-3');

    rerender(
      <SessionComposerFrame widthClassName="max-w-none">
        <div data-testid="composer-content" />
      </SessionComposerFrame>
    );

    expect(screen.getByTestId('session-composer-stack')).toHaveClass(
      'mx-auto',
      'w-full',
      'max-w-none'
    );
  });

  it('forwards non-interactive dead-zone clicks in the composer body to focus the editor without hijacking button clicks', () => {
    render(
      <SessionComposerFrame>
        <div
          data-testid="mock-editor"
          contentEditable
          suppressContentEditableWarning
          tabIndex={0}
        >
          draft
        </div>
        <div data-testid="toolbar-spacer">
          <button type="button" data-testid="toolbar-button">
            Action
          </button>
        </div>
      </SessionComposerFrame>
    );

    const editor = screen.getByTestId('mock-editor');
    const spacer = screen.getByTestId('toolbar-spacer');
    const button = screen.getByTestId('toolbar-button');

    fireEvent.click(spacer);
    expect(document.activeElement).toBe(editor);

    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(document.activeElement).toBe(button);
  });
});
