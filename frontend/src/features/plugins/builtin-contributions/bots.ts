import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const botsPanelManifest = {
  id: PANEL_IDS.BOTS,
  kind: 'app.panel',
  titleKey: 'panelRegistry.bots',
  defaultPosition: 'left',
  component: () => import('@/features/collaboration/WorkspaceBotsDockPanel'),
} as const satisfies BuiltinPanelManifest;
