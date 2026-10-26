import {
  getBeforeSendCleanup,
  restoreComposerAttachmentsAfterSendFailure,
} from '@/components/tasks/follow-up/sessionComposerSubmit';
import {
  revokeComposerImagePreviewUrl,
  type SessionComposerImageAttachment,
} from '@/components/tasks/follow-up/sessionComposerImages';

export function buildCollaborationSendContent(
  rawText: string,
  attachments: SessionComposerImageAttachment[]
): string {
  const textPart = rawText.replace(/\u00a0/g, ' ').trim();
  const attachmentMarkdown = attachments
    .map((image) => `![${image.name}](${image.path})`)
    .join('\n');
  return [textPart, attachmentMarkdown].filter(Boolean).join('\n\n');
}

export function beginCollaborationComposerSend(
  attachments: SessionComposerImageAttachment[]
) {
  return getBeforeSendCleanup(attachments);
}

export function restoreCollaborationComposerAfterSendFailure({
  currentAttachments,
  sentAttachments,
}: {
  currentAttachments: SessionComposerImageAttachment[];
  sentAttachments: SessionComposerImageAttachment[];
}) {
  return restoreComposerAttachmentsAfterSendFailure({
    currentAttachments,
    sentAttachments,
  });
}

export function revokeCollaborationSendAttachments(
  attachments: SessionComposerImageAttachment[]
) {
  attachments.forEach(revokeComposerImagePreviewUrl);
}
