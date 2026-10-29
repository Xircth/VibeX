import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const mergePanelManifest = {
  id: PANEL_IDS.MERGE,
  kind: 'app.panel',
  titleKey: 'panelRegistry.merge',
  defaultPosition: 'center',
  component: () => import('@/components/panels/DockviewMergePanel'),
} as const satisfies BuiltinPanelManifest;
