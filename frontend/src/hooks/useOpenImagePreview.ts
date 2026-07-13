import { useCallback } from 'react';
import { ImagePreviewDialog } from '@/components/dialogs/wysiwyg/ImagePreviewDialog';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';

export interface OpenImagePreviewArgs {
  imageUrl: string;
  altText: string;
  fileName?: string;
  format?: string;
  sizeBytes?: bigint | null;
}

/**
 * Opens a conversation image in a workspace preview tab when possible.
 * data:/blob: URLs (ephemeral, or too large to persist as panel params) and
 * contexts without panel actions fall back to the modal dialog.
 */
export function useOpenImagePreview(): (args: OpenImagePreviewArgs) => void {
  const panelActions = useOptionalPanelActionsContext();

  return useCallback(
    (args: OpenImagePreviewArgs) => {
      const { imageUrl } = args;
      const isEphemeralUrl =
        imageUrl.startsWith('data:') || imageUrl.startsWith('blob:');

      if (panelActions && !isEphemeralUrl) {
        panelActions.openImagePreview(imageUrl, {
          title: args.fileName ?? args.altText,
        });
        return;
      }

      ImagePreviewDialog.show(args);
    },
    [panelActions]
  );
}
