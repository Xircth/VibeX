import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clipboardDataHasTextPayload,
  extractImageFilesFromClipboardData,
  readImageFilesFromNavigatorClipboard,
} from './clipboard';

function createClipboardData({
  files = [],
  items = [],
  types = [],
}: {
  files?: File[];
  items?: Array<{
    kind: string;
    type: string;
    getAsFile: () => File | null;
  }>;
  types?: string[];
}) {
  return {
    files,
    items,
    types,
  } as unknown as DataTransfer;
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  });
});

describe('extractImageFilesFromClipboardData', () => {
  it('returns image files from clipboard files', () => {
    const imageFile = new File(['image'], 'paste.png', { type: 'image/png' });
    const textFile = new File(['text'], 'note.txt', { type: 'text/plain' });

    const result = extractImageFilesFromClipboardData(
      createClipboardData({
        files: [imageFile, textFile],
      })
    );

    expect(result).toEqual([imageFile]);
  });

  it('falls back to clipboard items when files are empty', () => {
    const imageFile = new File(['image'], 'paste.webp', { type: 'image/webp' });

    const result = extractImageFilesFromClipboardData(
      createClipboardData({
        items: [
          {
            kind: 'string',
            type: 'text/plain',
            getAsFile: () => null,
          },
          {
            kind: 'file',
            type: 'image/webp',
            getAsFile: () => imageFile,
          },
        ],
      })
    );

    expect(result).toEqual([imageFile]);
  });
});

describe('clipboardDataHasTextPayload', () => {
  it('detects plain text and html clipboard payloads', () => {
    expect(
      clipboardDataHasTextPayload(
        createClipboardData({ types: ['Files', 'text/plain'] })
      )
    ).toBe(true);
    expect(
      clipboardDataHasTextPayload(createClipboardData({ types: ['text/html'] }))
    ).toBe(true);
  });

  it('does not treat file-only clipboard payloads as text', () => {
    expect(
      clipboardDataHasTextPayload(createClipboardData({ types: ['Files'] }))
    ).toBe(false);
  });
});

describe('readImageFilesFromNavigatorClipboard', () => {
  it('reads image clipboard items from the async clipboard api', async () => {
    const blob = new Blob(['image'], { type: 'image/png' });
    const getType = vi.fn().mockResolvedValue(blob);
    const read = vi.fn().mockResolvedValue([
      {
        types: ['text/plain', 'image/png'],
        getType,
      },
    ]);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { read },
    });

    const files = await readImageFilesFromNavigatorClipboard();

    expect(read).toHaveBeenCalledTimes(1);
    expect(getType).toHaveBeenCalledWith('image/png');
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toMatch(/^pasted-image-\d+-0\.png$/);
    expect(files[0]?.type).toBe('image/png');
  });
});
