import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const terminalPanelManifest = {
  id: PANEL_IDS.TERMINAL,
  kind: 'app.panel',
  titleKey: 'panelRegistry.terminal',
  defaultPosition: 'bottom',
  multiInstance: true,
  component: () => import('@/components/panels/DockviewTerminalPanel'),
} as const satisfies BuiltinPanelManifest;
