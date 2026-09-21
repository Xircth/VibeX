import type { ConversationFileChange } from 'shared/types';

export const RESEND_CHECKPOINT_PREVIEW_TIMEOUT_MS = 5_000;

export type ResendCheckpointPreview = {
  files: ConversationFileChange[];
  previewUnavailable: boolean;
};

export async function loadResendCheckpointPreview(
  preview: () => Promise<{ files: ConversationFileChange[] }>,
  timeoutMs = RESEND_CHECKPOINT_PREVIEW_TIMEOUT_MS
): Promise<ResendCheckpointPreview> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const files = await Promise.race([
      preview().then((result) => result.files),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('checkpoint preview timed out'));
        }, timeoutMs);
      }),
    ]);
    return { files, previewUnavailable: false };
  } catch {
    return { files: [], previewUnavailable: true };
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
