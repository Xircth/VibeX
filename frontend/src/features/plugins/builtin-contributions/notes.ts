import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const notesPanelManifest = {
  id: PANEL_IDS.NOTES,
  kind: 'app.panel',
  titleKey: 'panelRegistry.notes',
  defaultPosition: 'center',
  component: () => import('@/components/panels/DockviewNotesPanel'),
} as const satisfies BuiltinPanelManifest;
