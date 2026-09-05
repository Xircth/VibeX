import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionListHeaderTitle } from './SessionListHeaderTitle';

type ObserverBox = {
  slotWidth: number;
  titleWidth: number;
};

function stubTitleBoxes({ slotWidth, titleWidth }: ObserverBox) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute('data-session-list-title-slot') ? slotWidth : 0;
    }
  );
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute('data-session-list-title-text') ? titleWidth : 0;
    }
  );
}

describe('SessionListHeaderTitle', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class ResizeObserver {
        observe() {}
        disconnect() {}
      }
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the full title when the header still has room', () => {
    stubTitleBoxes({ slotWidth: 80, titleWidth: 56 });
    render(<SessionListHeaderTitle>会话列表</SessionListHeaderTitle>);

    expect(screen.getByText('会话列表')).not.toHaveClass('invisible');
  });

  it('hides the whole title when the header is too narrow', () => {
    stubTitleBoxes({ slotWidth: 24, titleWidth: 56 });
    render(<SessionListHeaderTitle>会话列表</SessionListHeaderTitle>);

    expect(screen.getByText('会话列表')).toHaveClass('invisible');
  });
});
