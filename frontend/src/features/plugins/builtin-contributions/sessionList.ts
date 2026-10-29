import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const sessionListPanelManifest = {
  id: PANEL_IDS.SESSION_LIST,
  kind: 'app.panel',
  titleKey: 'panelRegistry.sessionList',
  defaultPosition: 'left',
  component: () =>
    import('@/components/workspace-session-list/WorkspaceSessionListPanel'),
} as const satisfies BuiltinPanelManifest;
