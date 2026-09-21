import { describe, expect, it, vi } from 'vitest';
import type { ContentBlock } from 'shared/types';
import {
  isAbsoluteLocalPath,
  loadUserMessageImageSrc,
  resolveUserMessageImageFilesystemPath,
  userMessageImageFilesystemCandidates,
  splitDisplayContentImages,
  splitUserTurnContent,
} from './userMessageImages';

describe('resolveUserMessageImageFilesystemPath', () => {
  it('prefers the workspace copy over the image-cache metadata path', () => {
    expect(
      resolveUserMessageImageFilesystemPath({
        imagePath: '.vibe-images/screen.png',
        metadataPath: 'C:\\Users\\me\\AppData\\VibeX\\images\\screen.png',
        metadataProxyUrl: 'C:\\Users\\me\\AppData\\VibeX\\images\\screen.png',
        workspacePath: 'C:\\Users\\me\\proj',
      })
    ).toBe('C:\\Users\\me\\proj\\.vibe-images\\screen.png');
  });

  it('lists workspace then cache paths so a sandbox miss can fall back', () => {
    expect(
      userMessageImageFilesystemCandidates({
        imagePath: '.vibe-images/screen.png',
        metadataPath: 'C:\\Users\\me\\AppData\\VibeX\\images\\screen.png',
        workspacePath: 'C:\\Users\\me\\proj',
      })
    ).toEqual([
      'C:\\Users\\me\\proj\\.vibe-images\\screen.png',
      'C:\\Users\\me\\AppData\\VibeX\\images\\screen.png',
    ]);
  });

  it('uses an absolute metadata path when no workspace is available', () => {
    expect(
      resolveUserMessageImageFilesystemPath({
        imagePath: '.vibe-images/screen.png',
        metadataPath: 'C:\\Users\\me\\proj\\.vibe-images\\screen.png',
        metadataProxyUrl: 'C:\\Users\\me\\proj\\.vibe-images\\screen.png',
      })
    ).toBe('C:\\Users\\me\\proj\\.vibe-images\\screen.png');
  });

  it('joins a workspace folder with a vibe-images uri when metadata is missing', () => {
    expect(
      resolveUserMessageImageFilesystemPath({
        imagePath: '.vibe-images/screen.png',
        workspacePath: 'C:\\Users\\me\\proj',
      })
    ).toBe('C:\\Users\\me\\proj\\.vibe-images\\screen.png');
  });

  it('joins posix workspace folders with forward slashes', () => {
    expect(
      resolveUserMessageImageFilesystemPath({
        imagePath: '.vibe-images/screen.png',
        workspacePath: '/Users/me/proj',
      })
    ).toBe('/Users/me/proj/.vibe-images/screen.png');
  });

  it('loads the first filesystem path that hostFileSrc can read', async () => {
    const load = vi.fn(async (path: string) => {
      if (path.includes('.vibe-images')) {
        throw new Error('path is outside every registered repository or workspace');
      }
      return 'blob:image/png';
    });

    await expect(
      loadUserMessageImageSrc(
        [
          'C:\\Users\\me\\proj\\.vibe-images\\screen.png',
          'C:\\Users\\me\\AppData\\VibeX\\images\\screen.png',
        ],
        load
      )
    ).resolves.toEqual({
      path: 'C:\\Users\\me\\AppData\\VibeX\\images\\screen.png',
      url: 'blob:image/png',
    });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('ignores asset and data URLs that cannot be read as files', () => {
    expect(
      resolveUserMessageImageFilesystemPath({
        imagePath: '.vibe-images/screen.png',
        metadataProxyUrl: 'asset://screen.png',
      })
    ).toBeUndefined();
    expect(isAbsoluteLocalPath('.vibe-images/screen.png')).toBe(false);
    expect(isAbsoluteLocalPath('C:/Users/me/shot.png')).toBe(true);
  });
});

describe('splitDisplayContentImages', () => {
  it('lifts vibe image markdown out of the user message body', () => {
    expect(
      splitDisplayContentImages(
        'Please inspect this.\n![screen](.vibe-images/screen.png)'
      )
    ).toEqual({
      text: 'Please inspect this.',
      images: [
        {
          id: '.vibe-images/screen.png:0',
          path: '.vibe-images/screen.png',
          altText: 'screen',
          kind: 'image',
        },
      ],
      files: [],
    });
  });

  it('lifts document attachments into file cards instead of images', () => {
    expect(
      splitDisplayContentImages(
        'See the spec.\n![notes](.vibe-images/notes.pdf)\n![icon](.vibe-images/icon.svg)'
      )
    ).toEqual({
      text: 'See the spec.',
      images: [],
      files: [
        {
          id: '.vibe-images/notes.pdf:0',
          path: '.vibe-images/notes.pdf',
          altText: 'notes',
          kind: 'file',
        },
        {
          id: '.vibe-images/icon.svg:1',
          path: '.vibe-images/icon.svg',
          altText: 'icon',
          kind: 'file',
        },
      ],
    });
  });
});

describe('splitUserTurnContent', () => {
  it('keeps first-class image blocks independent from the message text', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Please inspect this.' },
      {
        type: 'image',
        data: '',
        mime_type: 'image/png',
        uri: '.vibe-images/screen.png',
      },
    ];

    expect(splitUserTurnContent(blocks)).toEqual({
      text: 'Please inspect this.',
      images: [
        {
          id: '.vibe-images/screen.png:0',
          path: '.vibe-images/screen.png',
          altText: 'screen.png',
          kind: 'image',
        },
      ],
      files: [],
    });
  });

  it('renders image-only user turns without synthesizing a text body', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'image',
        data: '',
        mime_type: 'image/png',
        uri: '.vibe-images/shot.png',
      },
    ];

    expect(splitUserTurnContent(blocks)).toEqual({
      text: '',
      images: [
        {
          id: '.vibe-images/shot.png:0',
          path: '.vibe-images/shot.png',
          altText: 'shot.png',
          kind: 'image',
        },
      ],
      files: [],
    });
  });

  it('does not duplicate an image that is both a block and markdown', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        text: 'Look\n![screen](.vibe-images/screen.png)',
      },
      {
        type: 'image',
        data: '',
        mime_type: 'image/png',
        uri: '.vibe-images/screen.png',
      },
    ];

    expect(splitUserTurnContent(blocks)).toEqual({
      text: 'Look',
      images: [
        {
          id: '.vibe-images/screen.png:0',
          path: '.vibe-images/screen.png',
          altText: 'screen.png',
          kind: 'image',
        },
      ],
      files: [],
    });
  });

  it('uses inline image data when the persisted block has no workspace path', () => {
    const blocks: ContentBlock[] = [
      {
        type: 'image',
        data: 'AAAA',
        mime_type: 'image/png',
        uri: null,
      },
    ];

    expect(splitUserTurnContent(blocks)).toEqual({
      text: '',
      images: [
        {
          id: 'inline:0',
          path: '',
          altText: 'Image',
          kind: 'image',
          sourceUrl: 'data:image/png;base64,AAAA',
        },
      ],
      files: [],
    });
  });

  it('classifies document image-blocks as file cards even when mime is image/png', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'Attached.' },
      {
        type: 'image',
        data: '',
        mime_type: 'image/png',
        uri: '.vibe-images/notes.pdf',
      },
    ];

    expect(splitUserTurnContent(blocks)).toEqual({
      text: 'Attached.',
      images: [],
      files: [
        {
          id: '.vibe-images/notes.pdf:0',
          path: '.vibe-images/notes.pdf',
          altText: 'notes.pdf',
          kind: 'file',
        },
      ],
    });
  });
});
