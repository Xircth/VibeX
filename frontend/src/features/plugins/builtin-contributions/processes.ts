import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const processesPanelManifest = {
  id: PANEL_IDS.PROCESSES,
  kind: 'app.panel',
  titleKey: 'panelRegistry.processes',
  defaultPosition: 'center',
  component: () => import('@/components/panels/DockviewProcessesPanel'),
} as const satisfies BuiltinPanelManifest;
