import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const logsPanelManifest = {
  id: PANEL_IDS.LOGS,
  kind: 'app.panel',
  titleKey: 'panelRegistry.logs',
  defaultPosition: 'center',
  component: () => import('@/components/panels/DockviewLogsPanel'),
} as const satisfies BuiltinPanelManifest;
