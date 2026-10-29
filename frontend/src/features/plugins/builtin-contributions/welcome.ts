import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const welcomePanelManifest = {
  id: PANEL_IDS.WELCOME,
  kind: 'app.panel',
  titleKey: 'panelRegistry.welcome',
  defaultPosition: 'center',
  component: () => import('@/components/panels/DockviewWelcomePanel'),
} as const satisfies BuiltinPanelManifest;
