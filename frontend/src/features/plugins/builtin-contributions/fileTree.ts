import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const fileTreePanelManifest = {
  id: PANEL_IDS.FILE_TREE,
  kind: 'app.panel',
  titleKey: 'panelRegistry.fileExplorer',
  defaultPosition: 'left',
  component: () => import('@/components/panels/DockviewFileTreePanel'),
} as const satisfies BuiltinPanelManifest;
