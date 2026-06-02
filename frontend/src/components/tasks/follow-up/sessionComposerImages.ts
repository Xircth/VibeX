import type { ImageResponse } from 'shared/types';
import { toVibeImagePath } from '@/utils/images';
import { getAttachImageQueueSeed } from './sessionComposerQueue';

export type SessionComposerImageAttachment = {
  id: string;
  name: string;
  path: string;
  previewUrl?: string;
};

export function imageAttachmentFromPath(
  path: string
): SessionComposerImageAttachment {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return {
    id: path,
    name,
    path,
  };
}

export function createUploadedImageAttachment(
  response: Pick<ImageResponse, 'id' | 'original_name' | 'file_path'>,
  previewUrl: string
): SessionComposerImageAttachment {
  return {
    id: response.id,
    name: response.original_name,
    path: toVibeImagePath(response.file_path),
    previewUrl,
  };
}

export function mergeComposerImageAttachments({
  queuedAttachments,
  currentAttachments,
  newAttachment,
}: {
  queuedAttachments: SessionComposerImageAttachment[];
  currentAttachments: SessionComposerImageAttachment[];
  newAttachment: SessionComposerImageAttachment;
}): {
  attachments: SessionComposerImageAttachment[];
  imageToRevoke: SessionComposerImageAttachment | null;
} {
  const merged = new Map<string, SessionComposerImageAttachment>();
  for (const image of [...queuedAttachments, ...currentAttachments]) {
    merged.set(image.path, image);
  }

  const replaced = merged.get(newAttachment.path);
  merged.set(newAttachment.path, newAttachment);

  const shouldRevokeReplacedPreview =
    !!replaced?.previewUrl && replaced.previewUrl !== newAttachment.previewUrl;

  return {
    attachments: Array.from(merged.values()),
    imageToRevoke: shouldRevokeReplacedPreview ? replaced : null,
  };
}

export function removeComposerImageAttachment(
  attachments: SessionComposerImageAttachment[],
  imageId: string
): {
  attachments: SessionComposerImageAttachment[];
  imagesToRevoke: SessionComposerImageAttachment[];
} {
  return {
    attachments: attachments.filter((image) => image.id !== imageId),
    imagesToRevoke: attachments.filter((image) => image.id === imageId),
  };
}

export function clearComposerImageAttachments(
  attachments: SessionComposerImageAttachment[]
): {
  attachments: SessionComposerImageAttachment[];
  imagesToRevoke: SessionComposerImageAttachment[];
} {
  return {
    attachments: [],
    imagesToRevoke: attachments,
  };
}

export function revokeComposerImagePreviewUrl(
  image: SessionComposerImageAttachment
): void {
  if (image.previewUrl) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

export function getUploadedImageApplication({
  fallbackMessage,
  currentAttachments,
  uploadResponse,
  previewUrl,
}: {
  fallbackMessage: string;
  currentAttachments: SessionComposerImageAttachment[];
  uploadResponse: Pick<ImageResponse, 'id' | 'original_name' | 'file_path'>;
  previewUrl: string;
}): {
  scratchMessage: string;
  attachments: SessionComposerImageAttachment[];
  imageToRevoke: SessionComposerImageAttachment | null;
  scratchImagePaths: string[];
} {
  const { scratchMessage } = getAttachImageQueueSeed({ fallbackMessage });
  const newAttachment = createUploadedImageAttachment(
    uploadResponse,
    previewUrl
  );
  const { attachments, imageToRevoke } = mergeComposerImageAttachments({
    queuedAttachments: [],
    currentAttachments,
    newAttachment,
  });

  return {
    scratchMessage,
    attachments,
    imageToRevoke,
    scratchImagePaths: attachments.map((image) => image.path),
  };
}
