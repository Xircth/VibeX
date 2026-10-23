import { useCallback } from 'react';
import { ProjectEditorSelectionDialog } from '@/components/dialogs/projects/ProjectEditorSelectionDialog';
import { getEditorOpenerService } from '@/features/plugins/providers/hostProviderServices';
import { isLocalDesktopHost } from '@/lib/desktopShell';
import type { EditorType, Project } from 'shared/types';

export function useOpenProjectInEditor(
  project: Project | null,
  onShowEditorDialog?: () => void
) {
  return useCallback(
    async (editorType?: EditorType) => {
      if (!project || !isLocalDesktopHost()) return;

      try {
        const response = await getEditorOpenerService().openProjectInEditor(
          project.id,
          {
            editorType: editorType ?? null,
            filePath: null,
          }
        );

        // If a URL is returned, open it in a new window/tab
        if (response.url) {
          window.open(response.url, '_blank');
        }
      } catch (err) {
        console.error('Failed to open project in editor:', err);
        if (!editorType) {
          if (onShowEditorDialog) {
            onShowEditorDialog();
          } else {
            ProjectEditorSelectionDialog.show({
              selectedProject: project,
            });
          }
        }
      }
    },
    [project, onShowEditorDialog]
  );
}
