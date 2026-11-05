import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const externalDirectoryPanelManifest = {
  id: PANEL_IDS.EXTERNAL_DIRECTORY,
  kind: 'app.panel',
  titleKey: 'panelRegistry.externalDirectory',
  defaultPosition: 'center',
  multiInstance: true,
  component: () => import('@/components/panels/DockviewExternalDirectoryPanel'),
} as const satisfies BuiltinPanelManifest;
