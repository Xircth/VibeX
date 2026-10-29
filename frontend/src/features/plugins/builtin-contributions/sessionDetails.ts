import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const sessionDetailsPanelManifest = {
  id: PANEL_IDS.SESSION_DETAILS,
  kind: 'app.panel',
  titleKey: 'panelRegistry.sessionDetails',
  defaultPosition: 'center',
  component: () => import('@/components/panels/DockviewSessionDetailsPanel'),
} as const satisfies BuiltinPanelManifest;
