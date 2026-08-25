import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from 'shared/types';

import {
  resolveWorkflowAgentId,
  withDefaultWorkflowAgent,
  type WorkflowStudioAgentOption,
} from './workflowAgent';

const options: WorkflowStudioAgentOption[] = [
  { value: 'codex', label: 'Codex', runnable: true },
  { value: 'claude_code', label: 'Claude Code', runnable: false },
  { value: 'grok', label: 'Grok', runnable: true },
];

const definition: WorkflowDefinition = {
  formatVersion: 1,
  name: 'New Workflow',
  description: null,
  inputSchema: { type: 'object' },
  steps: [
    {
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
      outputLanguage: 'zh-CN',
      outputDescription: null,
      outputSchema: null,
      workspaceAccess: 'native',
      sideEffectClass: 'mutating_unknown',
      allowOneRepair: false,
      allowSkipOnReview: false,
      completionPolicy: 'manual',
    },
    {
      id: 'notify',
      dependsOn: ['start'],
      phase: null,
      inputBindings: {},
      kind: 'notify',
      title: 'Done',
    },
  ],
  policy: {
    maxConcurrentAgentSteps: 1,
    maxAgentCalls: 2,
    deadlineSeconds: 60,
    maxOutputBytes: 4096,
  },
};

describe('resolveWorkflowAgentId', () => {
  it('uses the preferred Agent when it is enabled and ready', () => {
    expect(resolveWorkflowAgentId(options, 'grok')).toBe('grok');
  });

  it('skips a preferred Agent that is not ready', () => {
    expect(resolveWorkflowAgentId(options, 'claude_code')).toBe('codex');
  });

  it('falls back to the first ready Agent', () => {
    expect(resolveWorkflowAgentId(options, null)).toBe('codex');
  });
});

describe('withDefaultWorkflowAgent', () => {
  it('rewrites Agent steps and leaves other steps unchanged', () => {
    const next = withDefaultWorkflowAgent(definition, 'grok');
    expect(next.steps[0]).toMatchObject({ kind: 'agent', agentId: 'grok' });
    expect(next.steps[1]).toMatchObject({ kind: 'notify', title: 'Done' });
  });
});
