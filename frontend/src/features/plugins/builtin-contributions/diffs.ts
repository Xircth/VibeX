import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const diffsPanelManifest = {
  id: PANEL_IDS.DIFFS,
  kind: 'app.panel',
  titleKey: 'panelRegistry.diffs',
  defaultPosition: 'center',
  component: () => import('@/components/panels/DockviewDiffsReviewPanel'),
} as const satisfies BuiltinPanelManifest;
