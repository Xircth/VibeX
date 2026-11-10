import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const collaborationSpacePanelManifest = {
  id: PANEL_IDS.COLLABORATION_SPACE,
  kind: 'app.panel',
  titleKey: 'panelRegistry.collaborationSpace',
  defaultPosition: 'center',
  component: () =>
    import('@/features/collaboration/WorkspaceCollaborationStagePanel'),
} as const satisfies BuiltinPanelManifest;
