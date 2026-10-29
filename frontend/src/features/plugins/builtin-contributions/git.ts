import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const gitPanelManifest = {
  id: PANEL_IDS.GIT,
  kind: 'app.panel',
  titleKey: 'panelRegistry.git',
  defaultPosition: 'left',
  component: () => import('@/components/panels/DockviewGitPanel'),
} as const satisfies BuiltinPanelManifest;
