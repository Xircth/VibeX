import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleComposerImagePaste } from './SessionComposerInput';
import {
  extractImageFilesFromClipboardData,
  readImageFilesFromNavigatorClipboard,
} from '@/utils/clipboard';

vi.mock('@/utils/clipboard', () => ({
  extractImageFilesFromClipboardData: vi.fn(),
  readImageFilesFromNavigatorClipboard: vi.fn(),
}));

const mockExtract = vi.mocked(extractImageFilesFromClipboardData);
const mockReadImages = vi.mocked(readImageFilesFromNavigatorClipboard);

function imageFile(name = 'shot.png', type = 'image/png'): File {
  return new File(['fake-image-bytes'], name, { type });
}

function pasteEvent(): { clipboardData: DataTransfer | null } {
  return { clipboardData: null };
}

describe('handleComposerImagePaste', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('attaches clipboard image files and reports the paste as handled', () => {
    const onAttachImages = vi.fn();
    const shot = imageFile();
    mockExtract.mockReturnValue([shot]);

    const handled = handleComposerImagePaste(pasteEvent(), onAttachImages);

    expect(handled).toBe(true);
    expect(onAttachImages).toHaveBeenCalledWith([shot]);
    expect(mockReadImages).not.toHaveBeenCalled();
  });

  it('leaves plain-text pastes unhandled and only consults the async fallback', async () => {
    const onAttachImages = vi.fn();
    mockExtract.mockReturnValue([]);
    mockReadImages.mockResolvedValue([]);

    const handled = handleComposerImagePaste(pasteEvent(), onAttachImages);

    expect(handled).toBe(false);
    expect(onAttachImages).not.toHaveBeenCalled();
    expect(mockReadImages).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(onAttachImages).not.toHaveBeenCalled();
    });
  });

  it('attaches images recovered from navigator.clipboard asynchronously', async () => {
    const onAttachImages = vi.fn();
    const shot = imageFile();
    mockExtract.mockReturnValue([]);
    mockReadImages.mockResolvedValue([shot]);

    const handled = handleComposerImagePaste(pasteEvent(), onAttachImages);

    expect(handled).toBe(false);
    await vi.waitFor(() => {
      expect(onAttachImages).toHaveBeenCalledWith([shot]);
    });
  });

  it('is inert while the composer is disabled', () => {
    const onAttachImages = vi.fn();
    mockExtract.mockReturnValue([imageFile()]);

    const handled = handleComposerImagePaste(
      pasteEvent(),
      onAttachImages,
      true
    );

    expect(handled).toBe(false);
    expect(onAttachImages).not.toHaveBeenCalled();
    expect(mockReadImages).not.toHaveBeenCalled();
  });
});
