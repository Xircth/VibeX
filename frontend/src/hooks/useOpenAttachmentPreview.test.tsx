import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImagePreviewPresentationProvider } from '@/contexts/ImagePreviewPresentationContext';
import { useOpenAttachmentPreview } from './useOpenAttachmentPreview';

const mocks = vi.hoisted(() => ({
  openFilePreview: vi.fn(),
  openImagePreview: vi.fn(),
  openOverlay: vi.fn(),
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  useOptionalPanelActionsContext: () => ({
    openFilePreview: mocks.openFilePreview,
  }),
}));

vi.mock('./useOpenImagePreview', () => ({
  useOpenImagePreview: () => mocks.openImagePreview,
}));

vi.mock(
  '@/components/NormalizedConversation/attachments/AttachmentPreviewOverlay',
  () => ({
    useOptionalAttachmentPreview: () => ({ open: mocks.openOverlay }),
  })
);

describe('useOpenAttachmentPreview', () => {
  beforeEach(() => {
    mocks.openFilePreview.mockReset();
    mocks.openImagePreview.mockReset();
    mocks.openOverlay.mockReset();
    mocks.openFilePreview.mockReturnValue('opened');
  });

  it('opens images through the existing image preview path', () => {
    const { result } = renderHook(() => useOpenAttachmentPreview());

    act(() =>
      result.current({
        kind: 'image',
        fileName: 'shot.png',
        imageUrl: 'blob:shot',
      })
    );

    expect(mocks.openImagePreview).toHaveBeenCalledWith({
      imageUrl: 'blob:shot',
      altText: 'shot.png',
      fileName: 'shot.png',
      format: undefined,
      sizeBytes: undefined,
    });
    expect(mocks.openFilePreview).not.toHaveBeenCalled();
  });

  it('opens files in a workspace tab', () => {
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <ImagePreviewPresentationProvider value="workspace-tab">
          {children}
        </ImagePreviewPresentationProvider>
      );
    }
    const { result } = renderHook(() => useOpenAttachmentPreview(), {
      wrapper: Wrapper,
    });

    act(() =>
      result.current({
        kind: 'file',
        fileName: 'notes.pdf',
        filePath: '/tmp/notes.pdf',
      })
    );

    expect(mocks.openFilePreview).toHaveBeenCalledWith('/tmp/notes.pdf', {
      title: 'notes.pdf',
      displayPath: 'notes.pdf',
    });
    expect(mocks.openOverlay).not.toHaveBeenCalled();
  });

  it('opens files in the kanban session overlay', () => {
    const { result } = renderHook(() => useOpenAttachmentPreview());

    act(() =>
      result.current({
        kind: 'file',
        fileName: 'notes.pdf',
        filePath: '/tmp/notes.pdf',
      })
    );

    expect(mocks.openOverlay).toHaveBeenCalledWith({
      fileName: 'notes.pdf',
      filePath: '/tmp/notes.pdf',
      previewKind: 'pdf',
    });
    expect(mocks.openFilePreview).not.toHaveBeenCalled();
  });
});
