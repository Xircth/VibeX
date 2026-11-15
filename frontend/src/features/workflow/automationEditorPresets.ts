import type { WorkflowDefinition } from 'shared/types';

import { getUiLanguage } from '@/lib/uiLanguage';

import type {
  StudioWorkflowDefinition,
  StudioWorkflowStep,
} from './WorkflowStudio';

const BASE_AGENT_STEP: Extract<StudioWorkflowStep, { kind: 'agent' }> = {
  id: 'start',
  dependsOn: [],
  phase: null,
  inputBindings: {},
  kind: 'agent',
  agentId: 'codex',
  prompt: '',
  executorProfileId: null,
  modeOverride: null,
  configOverrides: {},
  outputLanguage: getUiLanguage(),
  outputDescription: null,
  outputSchema: {
    type: 'object',
    required: ['summary'],
    properties: { summary: { type: 'string' } },
  },
  workspaceAccess: 'native',
  sideEffectClass: 'mutating_unknown',
  allowOneRepair: false,
  allowSkipOnReview: false,
  completionPolicy: 'manual',
};

export const SIMPLE_WORKFLOW: StudioWorkflowDefinition = {
  formatVersion: 1,
  name: 'New Workflow',
  description: null,
  inputSchema: { type: 'object' },
  orchestratorPreset: null,
  steps: [BASE_AGENT_STEP],
  policy: {
    maxConcurrentAgentSteps: 2,
    maxAgentCalls: 20,
    deadlineSeconds: 3600,
    maxOutputBytes: 1048576,
  },
};

export const RESEARCH_WORKFLOW: StudioWorkflowDefinition = {
  ...SIMPLE_WORKFLOW,
  name: 'Research brief',
  description:
    'Research in parallel, synthesize the evidence, review, and publish.',
  steps: [
    {
      ...BASE_AGENT_STEP,
      id: 'research-primary',
      prompt:
        'Research primary sources for the requested topic. Return findings with source URLs.',
      outputSchema: {
        type: 'object',
        required: ['findings'],
        properties: { findings: { type: 'array' } },
      },
      completionPolicy: 'automatic',
    },
    {
      ...BASE_AGENT_STEP,
      id: 'research-risks',
      prompt:
        'Challenge the request and identify risks, unknowns, and contradictory evidence.',
      outputSchema: {
        type: 'object',
        required: ['risks'],
        properties: { risks: { type: 'array' } },
      },
      completionPolicy: 'automatic',
    },
    {
      ...BASE_AGENT_STEP,
      id: 'synthesize',
      dependsOn: ['research-primary', 'research-risks'],
      prompt:
        'Synthesize the accepted upstream results into a decision-ready brief.',
      completionPolicy: 'manual',
    },
    {
      id: 'approve',
      dependsOn: ['synthesize'],
      phase: null,
      inputBindings: {},
      kind: 'approval',
      title: 'Approve publication',
      decisionSchema: {
        type: 'object',
        required: ['approved'],
        properties: { approved: { type: 'boolean' } },
      },
      approverScope: 'workflow.approve',
      skippable: false,
    },
  ],
};

export function serializeDefinition(
  definition: StudioWorkflowDefinition | WorkflowDefinition
) {
  return JSON.stringify(
    definition,
    (_key, value) => (typeof value === 'bigint' ? Number(value) : value),
    2
  );
}

function joinPath(root: string, relative: string) {
  return `${root.replace(/\/$/, '')}/${relative.replace(/^\//, '')}`;
}

export function workflowSourceFilePath(root: string, sourcePath: string) {
  return sourcePath.startsWith('~/') || sourcePath.startsWith('/')
    ? sourcePath
    : joinPath(root, sourcePath);
}

export function releaseVersionFromInternal(version: bigint | null | undefined) {
  return (Number(version ?? 0n) / 10).toFixed(1);
}

export function nextReleaseVersion(version: bigint | null | undefined) {
  return (Number(version ?? 0n) / 10 + 0.1).toFixed(1);
}

export type ScheduleTimer = {
  mode: 'once' | 'repeat';
  repeatKind: 'daily' | 'monthly';
  onceYear: number;
  onceMonth: number;
  onceDay: number;
  repeatDay: number;
  time: string;
};

export function defaultTimer(): ScheduleTimer {
  const now = new Date();
  return {
    mode: 'repeat',
    repeatKind: 'daily',
    onceYear: now.getFullYear(),
    onceMonth: now.getMonth() + 1,
    onceDay: now.getDate(),
    repeatDay: 1,
    time: '09:00',
  };
}

export function timerToCron(timer: ScheduleTimer): string {
  const [hour = '0', minute = '0'] = timer.time.split(':');
  const h = Number(hour);
  const m = Number(minute);
  if (timer.mode === 'once') {
    return `${m} ${h} ${timer.onceDay} ${timer.onceMonth} * ${timer.onceYear}`;
  }
  if (timer.repeatKind === 'monthly') {
    return `${m} ${h} ${timer.repeatDay} * *`;
  }
  return `${m} ${h} * * *`;
}

export function cronToTimer(cron: string): ScheduleTimer {
  const fields = cron.trim().split(/\s+/);
  const minute = Number(fields[0] ?? 0);
  const hour = Number(fields[1] ?? 9);
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const now = new Date();
  const base = {
    ...defaultTimer(),
    time,
  };
  if (fields.length === 6) {
    return {
      ...base,
      mode: 'once',
      onceYear: Number(fields[5] ?? now.getFullYear()),
      onceMonth: Number(fields[3] ?? 1),
      onceDay: Number(fields[2] ?? 1),
    };
  }
  if (fields.length === 5 && fields[2] !== '*' && fields[4] === '*') {
    return {
      ...base,
      mode: 'repeat',
      repeatKind: 'monthly',
      repeatDay: Number(fields[2] ?? 1),
    };
  }
  return {
    ...base,
    mode: 'repeat',
    repeatKind: 'daily',
  };
}

export function daysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate();
}
