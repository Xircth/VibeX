import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { WorkspaceOverlayContext } from '@/contexts/WorkspaceOverlayContext';
import { SessionSelector } from './SessionSelector';

const overlayValue = {
  setTabCreationMenuOpen: vi.fn(),
  setHtmlOverlayOpen: vi.fn(),
  setHtmlOverlayRect: vi.fn(),
  subscribeNativeSurfaceOcclusion: () => () => {},
  registerNativeSurfaceHost: () => () => {},
  ackOverlayReady: () => {},
  waitForOverlayReady: () => Promise.resolve(),
  isOverlayReady: () => true,
};

function sessionItem(
  id: string,
  displayName: string,
  statusLabel = '\u5df2\u5b8c\u6210'
) {
  return { id, displayName, statusLabel };
}

function renderSelector(
  props: Partial<Parameters<typeof SessionSelector>[0]> = {}
) {
  const onSelectSession = vi.fn();
  const onStartNewSession = vi.fn();
  const onRenameSession = vi.fn();
  const view = render(
    <WorkspaceOverlayContext.Provider value={overlayValue}>
      <SessionSelector
        sessions={[
          sessionItem('session-1', 'Alpha'),
          sessionItem('session-2', 'Beta'),
        ]}
        selectedSessionId="session-1"
        compactSessionLabel="Alpha"
        selectedSessionLabel="Alpha"
        onSelectSession={onSelectSession}
        onStartNewSession={onStartNewSession}
        onRenameSession={onRenameSession}
        dropdownSide="top"
        {...props}
      />
    </WorkspaceOverlayContext.Provider>
  );
  return { ...view, onSelectSession, onStartNewSession, onRenameSession };
}

function openSelector() {
  fireEvent.pointerDown(screen.getByTitle('Alpha'), { button: 0 });
}

describe('SessionSelector', () => {
  it('caps the panel, scrolls sessions, and pins new session outside the list', () => {
    const sessions = Array.from({ length: 24 }, (_, index) =>
      sessionItem(`session-${index + 1}`, `\u4f1a\u8bdd ${index + 1}`)
    );
    renderSelector({ sessions, selectedSessionId: 'session-1' });

    openSelector();

    const popover = document.querySelector('.composer-session-popover');
    const list = screen.getByTestId('session-selector-list');
    const create = screen.getByTestId('session-selector-new');

    expect(popover).toHaveClass('composer-session-popover');
    expect(popover).toHaveAttribute('data-side', 'top');
    expect(list).toHaveClass('composer-session-list');
    expect(list.contains(create)).toBe(false);
    expect(create).toHaveClass('composer-session-new');
    expect(create).toHaveTextContent('+ \u65b0\u5efa\u4f1a\u8bdd');
    expect(
      screen.queryByText('\u5168\u65b0\u4e0a\u4e0b\u6587')
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Fresh context')).not.toBeInTheDocument();
  });

  it('starts a new session from the pinned action', () => {
    const { onStartNewSession, onSelectSession } = renderSelector();

    openSelector();
    fireEvent.click(screen.getByTestId('session-selector-new'));

    expect(onStartNewSession).toHaveBeenCalledTimes(1);
    expect(onSelectSession).not.toHaveBeenCalled();
  });
});
