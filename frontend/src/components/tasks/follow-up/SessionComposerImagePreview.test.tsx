import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ImagePreviewPresentationProvider } from '@/contexts/ImagePreviewPresentationContext';
import { SessionComposerAttachmentDrawer } from './SessionComposerInput';

const mocks = vi.hoisted(() => ({
  openImagePreview: vi.fn(),
  showDialog: vi.fn(),
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  useOptionalPanelActionsContext: () => ({
    openImagePreview: mocks.openImagePreview,
  }),
}));

vi.mock('@/components/dialogs/wysiwyg/ImagePreviewDialog', () => ({
  ImagePreviewDialog: { show: mocks.showDialog },
}));

function renderDrawer(
  presentation: 'dialog' | 'workspace-tab' = 'dialog'
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ImagePreviewPresentationProvider value={presentation}>
        <SessionComposerAttachmentDrawer
          images={[
            {
              id: 'image-1',
              name: 'shot.png',
              path: '.vibe-images/shot.png',
              previewUrl: 'blob:shot',
            },
          ]}
          onRemoveImage={vi.fn()}
        />
      </ImagePreviewPresentationProvider>
    </QueryClientProvider>
  );
}

describe('composer image preview presentation', () => {
  it('opens a dialog on the kanban surface', async () => {
    const user = userEvent.setup();
    mocks.showDialog.mockReset();
    mocks.openImagePreview.mockReset();
    renderDrawer('dialog');
    await user.click(screen.getByRole('button', { name: 'Preview shot.png' }));
    expect(mocks.showDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: 'blob:shot',
        fileName: 'shot.png',
      })
    );
    expect(mocks.openImagePreview).not.toHaveBeenCalled();
  });

  it('opens a workspace tab on the workspace surface', async () => {
    const user = userEvent.setup();
    mocks.showDialog.mockReset();
    mocks.openImagePreview.mockReset();
    renderDrawer('workspace-tab');
    await user.click(screen.getByRole('button', { name: 'Preview shot.png' }));
    expect(mocks.openImagePreview).toHaveBeenCalledWith('blob:shot', {
      title: 'shot.png',
    });
    expect(mocks.showDialog).not.toHaveBeenCalled();
  });
});
