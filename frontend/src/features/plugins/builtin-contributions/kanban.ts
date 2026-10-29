import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const kanbanPanelManifest = {
  id: PANEL_IDS.KANBAN,
  kind: 'app.panel',
  titleKey: 'panelRegistry.kanban',
  defaultPosition: 'center',
  component: () => import('@/components/panels/DockviewKanbanPanel'),
} as const satisfies BuiltinPanelManifest;
