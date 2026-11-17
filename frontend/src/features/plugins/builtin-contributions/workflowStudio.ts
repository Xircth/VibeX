import { PANEL_IDS } from '@/stores/useLayoutStore';
import { type BuiltinPanelManifest } from './types';

export const workflowStudioPanelManifest = {
  id: PANEL_IDS.WORKFLOW_STUDIO,
  kind: 'app.panel',
  titleKey: 'panelRegistry.workflowStudio',
  defaultPosition: 'center',
  component: () => import('@/features/workflow/WorkflowStudioDockPanel'),
} as const satisfies BuiltinPanelManifest;
