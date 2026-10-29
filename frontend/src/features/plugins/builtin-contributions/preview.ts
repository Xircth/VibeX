import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const previewPanelManifest = {
  id: PANEL_IDS.PREVIEW,
  kind: 'app.panel',
  titleKey: 'panelRegistry.preview',
  defaultPosition: 'center',
  multiInstance: true,
  component: () => import('@/components/panels/DockviewPreviewPanel'),
} as const satisfies BuiltinPanelManifest;
