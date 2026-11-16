import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerStashMenu } from './ComposerStashMenu';
import { loadComposerDraftStash } from './composerDraftStash';

vi.mock('@/contexts/WorkspaceOverlayContext', () => ({
  NativeSurfaceOcclusionHold: () => null,
  useRevealAfterOverlayReady: () => true,
}));

function StashHarness({
  scopeId = 'ws-menu-test',
  initialImages = [],
}: {
  scopeId?: string;
  initialImages?: string[];
}) {
  const [draft, setDraft] = useState('');
  const [images, setImages] = useState<string[]>(initialImages);
  return (
    <div>
      <textarea
        aria-label="composer-draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div data-testid="active-images">{images.join(',')}</div>
      <button
        type="button"
        data-testid="attach-mock-image"
        onClick={() => setImages((prev) => [...prev, '.vibe-images/pic.png'])}
      >
        Attach
      </button>
      <ComposerStashMenu
        scopeId={scopeId}
        draftValue={draft}
        attachmentCount={images.length}
        attachmentPaths={images}
        isEditable={true}
        onStashDraft={() => {
          setDraft('');
          setImages([]);
        }}
        onRestoreDraft={(next, restoredImages) => {
          setDraft(next);
          setImages(restoredImages ?? []);
        }}
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

  it('stashes image-only drafts, clears active attachments, and restores them on pop', () => {
    render(
      <StashHarness
        scopeId="ws-images-only"
        initialImages={['.vibe-images/a.png', '.vibe-images/b.png']}
      />
    );

    expect(screen.getByTestId('active-images')).toHaveTextContent(
      '.vibe-images/a.png,.vibe-images/b.png'
    );

    // Can stash image-only draft even when text is empty
    fireEvent.click(screen.getByTestId('composer-stash-push-button'));
    expect(screen.getByTestId('active-images')).toHaveTextContent('');
    expect(loadComposerDraftStash('ws-images-only')[0]).toMatchObject({
      text: '',
      attachmentCount: 2,
      images: ['.vibe-images/a.png', '.vibe-images/b.png'],
    });

    // Pop via Ctrl+Alt+S when composer is completely empty restores both images
    fireEvent.keyDown(window, { key: 's', ctrlKey: true, altKey: true });
    expect(screen.getByTestId('active-images')).toHaveTextContent(
      '.vibe-images/a.png,.vibe-images/b.png'
    );
    expect(loadComposerDraftStash('ws-images-only')).toEqual([]);
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

  it('supports lazy getDraftValue + hasDraft without passing draftValue string', () => {
    let latestDraft = 'Lazy stashed draft';
    const onStashDraft = vi.fn(() => {
      latestDraft = '';
    });
    const onRestoreDraft = vi.fn((restored: string) => {
      latestDraft = restored;
    });

    const { rerender } = render(
      <ComposerStashMenu
        scopeId="ws-lazy"
        hasDraft={true}
        getDraftValue={() => latestDraft}
        isEditable={true}
        onStashDraft={onStashDraft}
        onRestoreDraft={onRestoreDraft}
      />
    );

    fireEvent.click(screen.getByTestId('composer-stash-push-button'));
    expect(onStashDraft).toHaveBeenCalledTimes(1);
    expect(loadComposerDraftStash('ws-lazy').map((e) => e.text)).toEqual([
      'Lazy stashed draft',
    ]);

    rerender(
      <ComposerStashMenu
        scopeId="ws-lazy"
        hasDraft={false}
        getDraftValue={() => latestDraft}
        isEditable={true}
        onStashDraft={onStashDraft}
        onRestoreDraft={onRestoreDraft}
      />
    );

    fireEvent.keyDown(window, { key: 's', ctrlKey: true, altKey: true });
    expect(onRestoreDraft).toHaveBeenCalledWith('Lazy stashed draft');
  });
});
