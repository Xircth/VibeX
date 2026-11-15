import type { StudioWorkflowDefinition } from '@/features/workflow/WorkflowStudio';
import { useLayoutStore } from '@/stores/useLayoutStore';
import { useProjectViewStateStore } from '@/stores/useProjectViewStateStore';

export const OPEN_PULSE_DECK_EVENT = 'vibex:open-pulse-deck' as const;
export const OPEN_WORKFLOW_STUDIO_EVENT = 'vibex:open-workflow-studio' as const;

export interface OpenPulseDeckEventDetail {
  projectId?: string | null;
  navigateToKanban?: boolean;
}

export interface PendingWorkflowStudioOpenDetail {
  definitionId?: string | null;
  presetId?: string | null;
  initialDefinition?: StudioWorkflowDefinition | null;
  sourceRuleId?: string | null;
}

interface PulseWindowState extends Window {
  __VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__?: PendingWorkflowStudioOpenDetail | null;
}

export function consumePendingWorkflowStudioOpen(): PendingWorkflowStudioOpenDetail | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const win = window as PulseWindowState;
  const pending = win.__VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__ ?? null;
  win.__VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__ = null;
  return pending;
}

export function stashPendingWorkflowStudioOpen(
  detail: PendingWorkflowStudioOpenDetail | null
): void {
  if (typeof window === 'undefined') {
    return;
  }
  const win = window as PulseWindowState;
  win.__VIBEX_PENDING_WORKFLOW_STUDIO_OPEN__ = detail;
}

function activateKanbanBuiltinView(
  viewId: 'builtin:pulse',
  explicitProjectId?: string | null
) {
  const layoutState = useLayoutStore.getState();
  const keys = new Set<string>();
  if (layoutState.currentProjectKey) {
    keys.add(layoutState.currentProjectKey);
  }
  if (explicitProjectId) {
    keys.add(explicitProjectId);
  }
  const viewStore = useProjectViewStateStore.getState();
  for (const key of keys) {
    viewStore.setKanbanState(key, { activeViewId: viewId });
  }
  layoutState.setActiveTab('kanban');
}

/**
 * Dispatches `vibex:open-pulse-deck`. Returns `true` if an active Kanban
 * surface consumed the event (`event.preventDefault()`) or when
 * `navigateToKanban` switches the host into Kanban's `builtin:pulse` view.
 */
export function requestOpenPulseDeck(
  detail: OpenPulseDeckEventDetail = {}
): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const event = new CustomEvent<OpenPulseDeckEventDetail>(
    OPEN_PULSE_DECK_EVENT,
    {
      bubbles: true,
      cancelable: true,
      detail,
    }
  );
  const cancelled = !window.dispatchEvent(event);
  if (!cancelled && detail.navigateToKanban) {
    activateKanbanBuiltinView('builtin:pulse', detail.projectId);
    window.requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent<OpenPulseDeckEventDetail>(OPEN_PULSE_DECK_EVENT, {
          bubbles: true,
          cancelable: true,
          detail: { ...detail, navigateToKanban: false },
        })
      );
    });
    return true;
  }
  return cancelled;
}

/**
 * Stores pending Workflow Studio target metadata and opens `builtin:pulse`
 * in Kanban so Automation Tasks mounts its embedded Workflow Studio sub-view.
 */
export function requestOpenWorkflowStudio(
  detail?: PendingWorkflowStudioOpenDetail
): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  const normalizedDetail: PendingWorkflowStudioOpenDetail = detail ?? {};
  stashPendingWorkflowStudioOpen(normalizedDetail);
  const event = new CustomEvent<PendingWorkflowStudioOpenDetail>(
    OPEN_WORKFLOW_STUDIO_EVENT,
    {
      bubbles: true,
      cancelable: true,
      detail: normalizedDetail,
    }
  );
  const cancelled = !window.dispatchEvent(event);
  if (!cancelled) {
    activateKanbanBuiltinView('builtin:pulse');
    window.requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent<PendingWorkflowStudioOpenDetail>(
          OPEN_WORKFLOW_STUDIO_EVENT,
          {
            bubbles: true,
            cancelable: true,
            detail: normalizedDetail,
          }
        )
      );
    });
    return true;
  }
  return true;
}
