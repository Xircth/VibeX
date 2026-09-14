import { useCallback } from 'react';
import { useOptionalAttachmentPreview } from '@/components/NormalizedConversation/attachments/AttachmentPreviewOverlay';
import { useImagePreviewPresentation } from '@/contexts/ImagePreviewPresentationContext';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { getFilePreviewKind } from '@/utils/filePreviewKind';
import type { AttachmentPreviewKind } from '@/utils/mediaAttachments';
import { useOpenImagePreview } from './useOpenImagePreview';

export type OpenAttachmentPreviewArgs = {
  kind: AttachmentPreviewKind;
  fileName: string;
  filePath?: string | null;
  imageUrl?: string;
  altText?: string;
  format?: string;
  sizeBytes?: bigint | null;
};

export function useOpenAttachmentPreview(): (
  args: OpenAttachmentPreviewArgs
) => void {
  const panelActions = useOptionalPanelActionsContext();
  const presentation = useImagePreviewPresentation();
  const overlay = useOptionalAttachmentPreview();
  const openImagePreview = useOpenImagePreview();

  return useCallback(
    (args: OpenAttachmentPreviewArgs) => {
      if (args.kind === 'image' || args.kind === 'video') {
        if (!args.imageUrl) return;
        openImagePreview({
          imageUrl: args.imageUrl,
          altText: args.altText ?? args.fileName,
          fileName: args.fileName,
          format: args.format,
          sizeBytes: args.sizeBytes,
        });
        return;
      }

      const filePath = args.filePath?.trim() || '';
      if (presentation === 'workspace-tab' && panelActions && filePath) {
        const result = panelActions.openFilePreview(filePath, {
          title: args.fileName,
          displayPath: args.fileName,
        });
        if (result !== 'unavailable') return;
      }

      overlay?.open({
        fileName: args.fileName,
        filePath,
        previewKind: getFilePreviewKind(args.fileName || filePath),
      });
    },
    [openImagePreview, overlay, panelActions, presentation]
  );
}
