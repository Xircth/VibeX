import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SessionComposerFrame } from './SessionComposerFrame';

describe('SessionComposerFrame', () => {
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
