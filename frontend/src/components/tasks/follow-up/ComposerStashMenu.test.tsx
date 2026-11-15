import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerStashMenu } from './ComposerStashMenu';
import { loadComposerDraftStash } from './composerDraftStash';

vi.mock('@/contexts/WorkspaceOverlayContext', () => ({
  NativeSurfaceOcclusionHold: () => null,
  useRevealAfterOverlayReady: () => true,
}));

function StashHarness({ scopeId = 'ws-menu-test' }: { scopeId?: string }) {
  const [draft, setDraft] = useState('');
  return (
    <div>
      <textarea
        aria-label="composer-draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <ComposerStashMenu
        scopeId={scopeId}
        draftValue={draft}
        attachmentCount={2}
        isEditable={true}
        onStashDraft={() => setDraft('')}
        onRestoreDraft={(next) => setDraft(next)}
      />
    </div>
  );
}

describe('ComposerStashMenu', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('stashes drafts, opens LIFO popover, swaps unsaved draft safely, reorders, and deletes', () => {
    render(<StashHarness scopeId="ws-ui-1" />);

    // Hidden when empty and no stashed items
    expect(screen.queryByTestId('composer-stash-push-button')).toBeNull();
    expect(screen.queryByTestId('composer-stash-menu-trigger')).toBeNull();

    const input = screen.getByLabelText('composer-draft') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'First stashed prompt' } });

    // 1-click stash when stack is empty
    fireEvent.click(screen.getByTestId('composer-stash-push-button'));
    expect(input.value).toBe('');
    expect(screen.getByTestId('composer-stash-menu-trigger')).toHaveTextContent(
      '1'
    );

    // Push second draft via Ctrl+Alt+S shortcut
    fireEvent.change(input, { target: { value: 'Second stashed prompt' } });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true, altKey: true });
    expect(input.value).toBe('');
    expect(screen.getByTestId('composer-stash-menu-trigger')).toHaveTextContent(
      '2'
    );

    // Open menu, inspect LIFO order, reorder, and restore
    fireEvent.click(screen.getByTestId('composer-stash-menu-trigger'));
    const items = screen.getAllByTestId('composer-stash-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Second stashed prompt');
    expect(items[1]).toHaveTextContent('First stashed prompt');

    // Move bottom item up
    const moveUpButtons = screen.getAllByTestId('composer-stash-move-up');
    fireEvent.click(moveUpButtons[1]!);
    expect(screen.getAllByTestId('composer-stash-item')[0]).toHaveTextContent(
      'First stashed prompt'
    );

    // Type an active draft, then restore top item -> swaps active draft into stash!
    fireEvent.change(input, { target: { value: 'Unsaved active draft' } });
    fireEvent.click(screen.getAllByTestId('composer-stash-restore')[0]!);
    expect(input.value).toBe('First stashed prompt');
    expect(
      loadComposerDraftStash('ws-ui-1').map((entry) => entry.text)
    ).toEqual(['Unsaved active draft', 'Second stashed prompt']);

    // Clear all
    fireEvent.click(screen.getByTestId('composer-stash-clear-all'));
    expect(loadComposerDraftStash('ws-ui-1')).toEqual([]);
  });

  it('pops latest stashed draft via Ctrl+Alt+S when composer is empty', () => {
    render(<StashHarness scopeId="ws-shortcut" />);
    const input = screen.getByLabelText('composer-draft') as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: 'Shortcut draft [:quote](abc)' } });
    fireEvent.keyDown(window, { key: 's', ctrlKey: true, altKey: true });
    expect(input.value).toBe('');

    fireEvent.keyDown(window, { key: 's', ctrlKey: true, altKey: true });
    expect(input.value).toBe('Shortcut draft [:quote](abc)');
    expect(loadComposerDraftStash('ws-shortcut')).toEqual([]);
  });
});
