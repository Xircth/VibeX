import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const searchPanelManifest = {
  id: PANEL_IDS.SEARCH,
  kind: 'app.panel',
  titleKey: 'panelRegistry.search',
  defaultPosition: 'left',
  component: () => import('@/components/panels/DockviewSearchPanel'),
} as const satisfies BuiltinPanelManifest;
