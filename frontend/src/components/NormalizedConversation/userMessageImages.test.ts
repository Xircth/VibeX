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
        },
      ],
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
        },
      ],
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
        },
      ],
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
          sourceUrl: 'data:image/png;base64,AAAA',
        },
      ],
    });
  });
});
