import { describe, expect, it } from 'vitest';
import type { ContentBlock } from 'shared/types';
import {
  splitDisplayContentImages,
  splitUserTurnContent,
} from './userMessageImages';

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
