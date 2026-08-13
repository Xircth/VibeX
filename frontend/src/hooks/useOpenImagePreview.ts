import { useCallback } from 'react';
import { ImagePreviewDialog } from '@/components/dialogs/wysiwyg/ImagePreviewDialog';
import { useImagePreviewPresentation } from '@/contexts/ImagePreviewPresentationContext';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';

export interface OpenImagePreviewArgs {
  imageUrl: string;
  altText: string;
  fileName?: string;
  format?: string;
  sizeBytes?: bigint | null;
}

/**
 * Opens a conversation image using the presentation selected by its page.
 * Kanban surfaces default to a dialog; workspace surfaces explicitly opt into
 * a dockview tab. Transient image data is kept outside persisted panel params.
 */
export function useOpenImagePreview(): (args: OpenImagePreviewArgs) => void {
  const panelActions = useOptionalPanelActionsContext();
  const presentation = useImagePreviewPresentation();

  return useCallback(
    (args: OpenImagePreviewArgs) => {
      if (presentation === 'workspace-tab' && panelActions) {
        panelActions.openImagePreview(args.imageUrl, {
          title: args.fileName ?? args.altText,
        });
        return;
      }

      ImagePreviewDialog.show(args);
    },
    [panelActions, presentation]
  );
}
