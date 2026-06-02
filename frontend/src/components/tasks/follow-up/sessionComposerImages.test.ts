import { describe, expect, it, vi } from 'vitest';
import {
  clearComposerImageAttachments,
  createUploadedImageAttachment,
  getUploadedImageApplication,
  imageAttachmentFromPath,
  mergeComposerImageAttachments,
  removeComposerImageAttachment,
  revokeComposerImagePreviewUrl,
} from './sessionComposerImages';

describe('session composer image helpers', () => {
  it('hydrates stored image paths into composer attachments', () => {
    expect(imageAttachmentFromPath('vibe://uploads/nested/image.png')).toEqual({
      id: 'vibe://uploads/nested/image.png',
      name: 'image.png',
      path: 'vibe://uploads/nested/image.png',
    });
    expect(imageAttachmentFromPath('C:\\tmp\\shot.jpg')).toEqual({
      id: 'C:\\tmp\\shot.jpg',
      name: 'shot.jpg',
      path: 'C:\\tmp\\shot.jpg',
    });
  });

  it('converts uploaded image responses into composer attachments', () => {
    expect(
      createUploadedImageAttachment(
        {
          id: 'image-1',
          original_name: 'screen.png',
          file_path: 'uploads/screen.png',
        },
        'blob:preview-1'
      )
    ).toEqual({
      id: 'image-1',
      name: 'screen.png',
      path: '.vibe-images/uploads/screen.png',
      previewUrl: 'blob:preview-1',
    });

    expect(
      createUploadedImageAttachment(
        {
          id: 'image-2',
          original_name: 'already.png',
          file_path: '.vibe-images/already.png',
        },
        'blob:preview-2'
      ).path
    ).toBe('.vibe-images/already.png');
  });

  it('merges queued attachments before current attachments and appends upload', () => {
    const queued = imageAttachmentFromPath('.vibe-images/queued.png');
    const current = {
      ...imageAttachmentFromPath('.vibe-images/current.png'),
      previewUrl: 'blob:current',
    };
    const uploaded = {
      id: 'upload',
      name: 'upload.png',
      path: '.vibe-images/upload.png',
      previewUrl: 'blob:upload',
    };

    expect(
      mergeComposerImageAttachments({
        queuedAttachments: [queued],
        currentAttachments: [current],
        newAttachment: uploaded,
      })
    ).toEqual({
      attachments: [queued, current, uploaded],
      imageToRevoke: null,
    });
  });

  it('replaces duplicate paths and returns the previous preview for revocation', () => {
    const queued = {
      id: 'queued',
      name: 'old.png',
      path: '.vibe-images/shared.png',
      previewUrl: 'blob:old',
    };
    const current = {
      id: 'current',
      name: 'current.png',
      path: '.vibe-images/other.png',
      previewUrl: 'blob:current',
    };
    const uploaded = {
      id: 'upload',
      name: 'new.png',
      path: '.vibe-images/shared.png',
      previewUrl: 'blob:new',
    };

    expect(
      mergeComposerImageAttachments({
        queuedAttachments: [queued],
        currentAttachments: [current],
        newAttachment: uploaded,
      })
    ).toEqual({
      attachments: [uploaded, current],
      imageToRevoke: queued,
    });
  });

  it('does not request revocation when replacement has the same preview URL', () => {
    const current = {
      id: 'current',
      name: 'old.png',
      path: '.vibe-images/shared.png',
      previewUrl: 'blob:same',
    };
    const uploaded = {
      id: 'upload',
      name: 'new.png',
      path: '.vibe-images/shared.png',
      previewUrl: 'blob:same',
    };

    expect(
      mergeComposerImageAttachments({
        queuedAttachments: [],
        currentAttachments: [current],
        newAttachment: uploaded,
      })
    ).toEqual({
      attachments: [uploaded],
      imageToRevoke: null,
    });
  });

  it('removes matching image ids and returns removed previews for revocation', () => {
    const retained = {
      id: 'keep',
      name: 'keep.png',
      path: '.vibe-images/keep.png',
      previewUrl: 'blob:keep',
    };
    const removedA = {
      id: 'remove',
      name: 'remove-a.png',
      path: '.vibe-images/remove-a.png',
      previewUrl: 'blob:remove-a',
    };
    const removedB = {
      id: 'remove',
      name: 'remove-b.png',
      path: '.vibe-images/remove-b.png',
    };

    expect(
      removeComposerImageAttachment([retained, removedA, removedB], 'remove')
    ).toEqual({
      attachments: [retained],
      imagesToRevoke: [removedA, removedB],
    });
  });

  it('clears image attachments and returns all previews for revocation', () => {
    const current = [
      {
        id: 'image-1',
        name: 'one.png',
        path: '.vibe-images/one.png',
        previewUrl: 'blob:one',
      },
      imageAttachmentFromPath('.vibe-images/two.png'),
    ];

    expect(clearComposerImageAttachments(current)).toEqual({
      attachments: [],
      imagesToRevoke: current,
    });
  });

  it('revokes only attachments with preview URLs', () => {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });

    revokeComposerImagePreviewUrl({
      id: 'preview',
      name: 'preview.png',
      path: '.vibe-images/preview.png',
      previewUrl: 'blob:preview',
    });
    revokeComposerImagePreviewUrl(
      imageAttachmentFromPath('.vibe-images/no-preview.png')
    );

    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('applies uploaded images against the current draft attachments only', () => {
    const current = {
      id: 'current',
      name: 'current.png',
      path: '.vibe-images/current.png',
      previewUrl: 'blob:current',
    };
    const replacedCurrent = {
      id: 'current-shared',
      name: 'current-shared.png',
      path: '.vibe-images/shared.png',
      previewUrl: 'blob:current-shared',
    };

    expect(
      getUploadedImageApplication({
        fallbackMessage: 'local draft',
        currentAttachments: [replacedCurrent, current],
        uploadResponse: {
          id: 'upload',
          original_name: 'shared.png',
          file_path: '.vibe-images/shared.png',
        },
        previewUrl: 'blob:upload',
      })
    ).toEqual({
      scratchMessage: 'local draft',
      attachments: [
        {
          id: 'upload',
          name: 'shared.png',
          path: '.vibe-images/shared.png',
          previewUrl: 'blob:upload',
        },
        current,
      ],
      imageToRevoke: replacedCurrent,
      scratchImagePaths: ['.vibe-images/shared.png', '.vibe-images/current.png'],
    });
  });
});
