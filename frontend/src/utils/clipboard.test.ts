import { describe, expect, it } from 'vitest';
import { extractImageFilesFromClipboardData } from './clipboard';

function createClipboardData({
  files = [],
  items = [],
}: {
  files?: File[];
  items?: Array<{
    kind: string;
    type: string;
    getAsFile: () => File | null;
  }>;
}) {
  return {
    files,
    items,
  } as unknown as DataTransfer;
}

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
