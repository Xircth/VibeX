import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImagePreviewPresentationProvider } from '@/contexts/ImagePreviewPresentationContext';
import { useOpenImagePreview } from './useOpenImagePreview';

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

describe('useOpenImagePreview', () => {
  beforeEach(() => {
    mocks.openImagePreview.mockReset();
    mocks.showDialog.mockReset();
  });

  it('opens a dialog by default, even when panel actions are available', () => {
    const { result } = renderHook(() => useOpenImagePreview());
    const args = {
      imageUrl: 'https://example.test/image.png',
      altText: 'Example',
    };

    act(() => result.current(args));

    expect(mocks.showDialog).toHaveBeenCalledWith(args);
    expect(mocks.openImagePreview).not.toHaveBeenCalled();
  });

  it('opens ephemeral images in a workspace tab when explicitly requested', () => {
    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <ImagePreviewPresentationProvider value="workspace-tab">
          {children}
        </ImagePreviewPresentationProvider>
      );
    }
    const { result } = renderHook(() => useOpenImagePreview(), {
      wrapper: Wrapper,
    });

    act(() =>
      result.current({
        imageUrl: 'data:image/png;base64,AAAA',
        altText: 'Generated image',
        fileName: 'generated.png',
      })
    );

    expect(mocks.openImagePreview).toHaveBeenCalledWith(
      'data:image/png;base64,AAAA',
      { title: 'generated.png' }
    );
    expect(mocks.showDialog).not.toHaveBeenCalled();
  });
});
