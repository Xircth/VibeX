import { describe, expect, it } from 'vitest';
import {
  beginCollaborationComposerSend,
  buildCollaborationSendContent,
  restoreCollaborationComposerAfterSendFailure,
} from './collaborationComposerSend';

const image = {
  id: 'image-1',
  name: 'shot.png',
  path: '.vibe-images/shot.png',
  previewUrl: 'blob:shot',
};

describe('collaborationComposerSend', () => {
  it('builds send content from text and attachment markdown', () => {
    expect(buildCollaborationSendContent('看这张图', [image])).toBe(
      '看这张图\n\n![shot.png](.vibe-images/shot.png)'
    );
    expect(buildCollaborationSendContent('   ', [image])).toBe(
      '![shot.png](.vibe-images/shot.png)'
    );
  });

  it('clears composer attachments immediately while keeping the sent snapshot', () => {
    expect(beginCollaborationComposerSend([image])).toEqual({
      message: '',
      attachments: [],
      sentAttachments: [image],
    });
  });

  it('restores the sent attachments when send fails and the composer is still empty', () => {
    expect(
      restoreCollaborationComposerAfterSendFailure({
        currentAttachments: [],
        sentAttachments: [image],
      })
    ).toEqual([image]);
  });
});
