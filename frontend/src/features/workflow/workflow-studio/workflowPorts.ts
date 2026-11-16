import i18n from '@/i18n';

import type { StudioWorkflowStep } from './types';

export type PortTranslateFn = (
  key: string,
  options?: Record<string, unknown>
) => string;

export type StudioPortAccent =
  | 'default'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'primary';

export type StudioOutputPort = {
  id: string;
  label: string;
  shortLabel: string;
  tooltip: string;
  accent: StudioPortAccent;
  isBranchPort: boolean;
};

function resolvePortTranslator(t?: PortTranslateFn): PortTranslateFn {
  if (t) return t;
  const fixed = i18n.getFixedT(
    i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN',
    'workflow'
  );
  return (key, options) => String(fixed(key, options));
}

export function getStepOutputPorts(
  step: StudioWorkflowStep,
  t?: PortTranslateFn
): StudioOutputPort[] {
  const tr = resolvePortTranslator(t);

  if (step.kind === 'control' && step.controlKind === 'condition') {
    return [
      {
        id: 'branch:true',
        label: tr('ports.conditionTrue'),
        shortLabel: tr('ports.conditionTrueShort'),
        tooltip: tr('ports.conditionTrueTooltip'),
        accent: 'success',
        isBranchPort: true,
      },
      {
        id: 'branch:false',
        label: tr('ports.conditionFalse'),
        shortLabel: tr('ports.conditionFalseShort'),
        tooltip: tr('ports.conditionFalseTooltip'),
        accent: 'warning',
        isBranchPort: true,
      },
    ];
  }

  if (
    step.kind === 'approval' ||
    (step.kind === 'user_gate' && step.interactionKind === 'approval')
  ) {
    return [
      {
        id: 'branch:approved',
        label: tr('ports.approvalApproved'),
        shortLabel: tr('ports.approvalApprovedShort'),
        tooltip: tr('ports.approvalApprovedTooltip'),
        accent: 'success',
        isBranchPort: true,
      },
      {
        id: 'branch:rejected',
        label: tr('ports.approvalRejected'),
        shortLabel: tr('ports.approvalRejectedShort'),
        tooltip: tr('ports.approvalRejectedTooltip'),
        accent: 'destructive',
        isBranchPort: true,
      },
    ];
  }

  if (step.kind === 'control' && step.controlKind === 'bounded_loop') {
    return [
      {
        id: 'branch:loop_body',
        label: tr('ports.loopBody'),
        shortLabel: tr('ports.loopBodyShort'),
        tooltip: tr('ports.loopBodyTooltip'),
        accent: 'primary',
        isBranchPort: true,
      },
      {
        id: 'branch:loop_exit',
        label: tr('ports.loopExit'),
        shortLabel: tr('ports.loopExitShort'),
        tooltip: tr('ports.loopExitTooltip'),
        accent: 'success',
        isBranchPort: true,
      },
    ];
  }

  return [
    {
      id: 'source',
      label: '',
      shortLabel: '',
      tooltip: tr('ports.sourceOutputTooltip'),
      accent: 'default',
      isBranchPort: false,
    },
  ];
}

export function isMultiPortStep(step: StudioWorkflowStep): boolean {
  return (
    (step.kind === 'control' &&
      (step.controlKind === 'condition' ||
        step.controlKind === 'bounded_loop')) ||
    step.kind === 'approval' ||
    (step.kind === 'user_gate' && step.interactionKind === 'approval')
  );
}

export function defaultSourceHandleFor(
  step?: StudioWorkflowStep | null
): string {
  if (!step) return 'source';
  if (step.kind === 'control' && step.controlKind === 'condition') {
    return 'branch:true';
  }
  if (
    step.kind === 'approval' ||
    (step.kind === 'user_gate' && step.interactionKind === 'approval')
  ) {
    return 'branch:approved';
  }
  if (step.kind === 'control' && step.controlKind === 'bounded_loop') {
    return 'branch:loop_exit';
  }
  return 'source';
}

export const AUXILIARY_SOURCE_HANDLES = new Set([
  'source:secondary',
  'source:bottom',
]);

export const VALID_TARGET_HANDLES = new Set([
  'target',
  'target:secondary',
  'target:top',
]);

export function resolveValidSourceHandle(
  step: StudioWorkflowStep | undefined,
  requestedHandle: string | null | undefined
): string {
  if (!step) {
    return requestedHandle || 'source';
  }
  if (requestedHandle && AUXILIARY_SOURCE_HANDLES.has(requestedHandle)) {
    if (!isMultiPortStep(step) || requestedHandle === 'source:bottom') {
      return requestedHandle;
    }
  }
  const ports = getStepOutputPorts(step);
  if (requestedHandle && ports.some((port) => port.id === requestedHandle)) {
    return requestedHandle;
  }
  return defaultSourceHandleFor(step);
}

export function resolveValidTargetHandle(
  requestedHandle: string | null | undefined
): string {
  if (requestedHandle && VALID_TARGET_HANDLES.has(requestedHandle)) {
    return requestedHandle;
  }
  return 'target';
}

export function isNamedBranchHandle(
  handleId: string | null | undefined
): handleId is string {
  return Boolean(handleId && handleId.startsWith('branch:'));
}

export function isPersistedSourceHandle(
  handleId: string | null | undefined
): handleId is string {
  return Boolean(
    handleId &&
      (handleId.startsWith('branch:') || AUXILIARY_SOURCE_HANDLES.has(handleId))
  );
}

export function isPersistedTargetHandle(
  handleId: string | null | undefined
): handleId is string {
  return Boolean(
    handleId && handleId !== 'target' && VALID_TARGET_HANDLES.has(handleId)
  );
}

export function describeBranchEdge(
  sourceHandle: string | null | undefined,
  t?: PortTranslateFn
): {
  label?: string;
  accent?: StudioPortAccent;
  edgeClassName?: string;
} {
  if (!sourceHandle || !sourceHandle.startsWith('branch:')) {
    return {};
  }
  const tr = resolvePortTranslator(t);
  switch (sourceHandle) {
    case 'branch:true':
      return {
        label: tr('ports.conditionTrueShort'),
        accent: 'success',
        edgeClassName: 'workflow-edge-branch-success',
      };
    case 'branch:false':
      return {
        label: tr('ports.conditionFalseShort'),
        accent: 'warning',
        edgeClassName: 'workflow-edge-branch-warning',
      };
    case 'branch:approved':
      return {
        label: tr('ports.approvalApprovedShort'),
        accent: 'success',
        edgeClassName: 'workflow-edge-branch-success',
      };
    case 'branch:rejected':
      return {
        label: tr('ports.approvalRejectedShort'),
        accent: 'destructive',
        edgeClassName: 'workflow-edge-branch-destructive',
      };
    case 'branch:loop_body':
      return {
        label: tr('ports.loopBodyShort'),
        accent: 'primary',
        edgeClassName: 'workflow-edge-branch-primary',
      };
    case 'branch:loop_exit':
      return {
        label: tr('ports.loopExitShort'),
        accent: 'success',
        edgeClassName: 'workflow-edge-branch-success',
      };
    default:
      return {};
  }
}

export function withoutRemovedBranchPorts(
  branchPorts: Record<string, string> | undefined,
  removedStepIds: ReadonlySet<string>
): Record<string, string> | undefined {
  if (!branchPorts) return undefined;
  const entries = Object.entries(branchPorts).filter(
    ([stepId, handleId]) => Boolean(handleId) && !removedStepIds.has(stepId)
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function renameBranchPortKeys(
  branchPorts: Record<string, string> | undefined,
  fromStepId: string,
  toStepId: string
): Record<string, string> | undefined {
  if (!branchPorts) return undefined;
  const entries = Object.entries(branchPorts).map(([stepId, handleId]) => [
    stepId === fromStepId ? toStepId : stepId,
    handleId,
  ]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
