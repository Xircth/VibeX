import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const aiChatPanelManifest = {
  id: PANEL_IDS.AI_CHAT,
  kind: 'app.panel',
  titleKey: 'panelRegistry.aiChat',
  defaultPosition: 'session',
  component: () => import('@/components/panels/DockviewAIChatPanel'),
} as const satisfies BuiltinPanelManifest;
