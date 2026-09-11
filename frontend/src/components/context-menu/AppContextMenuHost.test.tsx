import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppContextMenuHost, useAppContextMenu } from './AppContextMenuHost';

vi.mock('@/vscode/bridge', () => ({
  writeClipboardViaBridge: vi.fn(async () => true),
  readClipboardViaBridge: vi.fn(async () => 'pasted'),
}));

vi.mock('@/contexts/WorkspaceOverlayContext', () => ({
  NativeSurfaceOcclusionHold: () => null,
}));

function SurfaceButton() {
  const { openSurfaceMenu } = useAppContextMenu();
  return (
    <button
      type="button"
      onContextMenu={(event) => {
        openSurfaceMenu(event, [
          {
            id: 'create-session',
            label: 'Do thing',
            onSelect: () => undefined,
          },
        ]);
      }}
    >
      surface
    </button>
  );
}

describe('AppContextMenuHost', () => {
  it('prevents the native browser menu', () => {
    render(
      <AppContextMenuHost>
        <div>hello</div>
      </AppContextMenuHost>
    );
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('shows cut/copy/paste on an input', async () => {
    render(
      <AppContextMenuHost>
        <input aria-label="name" defaultValue="abc" />
      </AppContextMenuHost>
    );
    const input = screen.getByLabelText('name') as HTMLInputElement;
    input.setSelectionRange(0, 2);
    fireEvent.contextMenu(input);
    expect(await screen.findByRole('menuitem', { name: '复制' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '剪切' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '粘贴' })).toBeTruthy();
  });

  it('does not show a product menu on a forbidden terminal zone', () => {
    render(
      <AppContextMenuHost>
        <div data-context-menu-zone="forbidden">
          <span>term</span>
        </div>
      </AppContextMenuHost>
    );
    fireEvent.contextMenu(screen.getByText('term'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a surface menu from openSurfaceMenu', async () => {
    render(
      <AppContextMenuHost>
        <SurfaceButton />
      </AppContextMenuHost>
    );
    fireEvent.contextMenu(screen.getByText('surface'));
    const item = await screen.findByRole('menuitem', { name: 'Do thing' });
    expect(item.querySelector('svg')).toBeTruthy();
  });
});
