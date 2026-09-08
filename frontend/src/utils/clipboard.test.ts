import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clipboardDataHasTextPayload,
  extractImageFilesFromClipboardData,
  fileNameForImageUpload,
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

describe('fileNameForImageUpload', () => {
  it('keeps a filename that already has an image extension', () => {
    expect(
      fileNameForImageUpload(new File(['x'], 'shot.PNG', { type: 'image/png' }))
    ).toBe('shot.PNG');
  });

  it('adds an extension for unnamed Windows clipboard images', () => {
    expect(
      fileNameForImageUpload(new File(['x'], '', { type: 'image/png' }))
    ).toBe('pasted-image.png');
    expect(
      fileNameForImageUpload(
        new File(['x'], 'clipboard', { type: 'image/jpeg' })
      )
    ).toBe('clipboard.jpg');
  });

  it('keeps video filenames and names unnamed clipboard videos', () => {
    expect(
      fileNameForImageUpload(new File(['x'], 'clip.MP4', { type: 'video/mp4' }))
    ).toBe('clip.MP4');
    expect(
      fileNameForImageUpload(new File(['x'], '', { type: 'video/webm' }))
    ).toBe('pasted-video.webm');
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

    expect(result).toEqual([imageFile, textFile]);
  });

  it('returns document files from clipboard files', () => {
    const markdown = new File(['# hi'], 'readme.md', {
      type: 'text/markdown',
    });
    const pdf = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' });

    const result = extractImageFilesFromClipboardData(
      createClipboardData({
        files: [markdown, pdf],
      })
    );

    expect(result).toEqual([markdown, pdf]);
  });

  it('returns video files from clipboard files', () => {
    const videoFile = new File(['video'], 'clip.mp4', { type: 'video/mp4' });

    const result = extractImageFilesFromClipboardData(
      createClipboardData({
        files: [videoFile],
      })
    );

    expect(result).toEqual([videoFile]);
  });

  it('treats unnamed-type files with video extensions as videos', () => {
    const videoFile = new File(['video'], 'clip.webm', { type: '' });
    expect(
      extractImageFilesFromClipboardData(
        createClipboardData({ files: [videoFile] })
      )
    ).toEqual([videoFile]);
  });

  it('treats unnamed-type files with image extensions as images', () => {
    const imageFile = new File(['image'], 'shot.png', { type: '' });
    expect(
      extractImageFilesFromClipboardData(
        createClipboardData({ files: [imageFile] })
      )
    ).toEqual([imageFile]);
  });

  it('falls back to clipboard video items when files are empty', () => {
    const videoFile = new File(['video'], 'paste.mp4', { type: 'video/mp4' });

    const result = extractImageFilesFromClipboardData(
      createClipboardData({
        items: [
          {
            kind: 'file',
            type: 'video/mp4',
            getAsFile: () => videoFile,
          },
        ],
      })
    );

    expect(result).toEqual([videoFile]);
  });

  it('falls back to clipboard document items when files are empty', () => {
    const pdf = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' });

    const result = extractImageFilesFromClipboardData(
      createClipboardData({
        items: [
          {
            kind: 'file',
            type: 'application/pdf',
            getAsFile: () => pdf,
          },
        ],
      })
    );

    expect(result).toEqual([pdf]);
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

  it('reads video clipboard items from the async clipboard api', async () => {
    const blob = new Blob(['video'], { type: 'video/mp4' });
    const getType = vi.fn().mockResolvedValue(blob);
    const read = vi.fn().mockResolvedValue([
      {
        types: ['video/mp4'],
        getType,
      },
    ]);

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { read },
    });

    const files = await readImageFilesFromNavigatorClipboard();

    expect(getType).toHaveBeenCalledWith('video/mp4');
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toMatch(/^pasted-video-\d+-0\.mp4$/);
    expect(files[0]?.type).toBe('video/mp4');
  });
});
