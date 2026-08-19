import { describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from 'shared/types';

import type { BackendTransport } from '@/lib/transport';

import { createWorkflowApi } from './workflowApi';

/**
 * Faithful copy of Tauri's injected `process-ipc-message-fn.js`: it serializes
 * every invoke payload with `JSON.stringify(message, replacer)`, and the
 * replacer handles Map / Uint8Array / ArrayBuffer / toIPC — but not BigInt.
 * A BigInt anywhere in the args makes the webview throw
 * "JSON.stringify cannot serialize BigInt" before the command is ever sent.
 */
function tauriIpcReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (value instanceof Uint8Array) return Array.from(value);
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  return value;
}

function serializeAsTauriIpc(payload: unknown): string {
  return JSON.stringify(payload, tauriIpcReplacer);
}

function capturingTransport() {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const transport = {
    environment: 'desktop' as const,
    call: vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args: args ?? {} });
      return { id: 'run-1' };
    }),
  };
  return { transport: transport as unknown as BackendTransport, calls };
}

function definitionWithPolicy(policy: WorkflowDefinition['policy']) {
  const definition: WorkflowDefinition = {
    formatVersion: 1,
    name: 'Visible workflow',
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
        prompt: 'Start',
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
    ],
    policy,
  };
  return definition;
}

describe('workflow API IPC payloads', () => {
  it('keeps workflow_debug args serializable through Tauri JSON IPC', async () => {
    const { transport, calls } = capturingTransport();
    const api = createWorkflowApi(transport);
    const definition = definitionWithPolicy({
      maxConcurrentAgentSteps: 2,
      maxAgentCalls: 20,
      deadlineSeconds: 3600,
      maxOutputBytes: 1048576,
    });

    await api.debug(definition, 'start', { scope: 'node' });

    const { args } = calls[0];
    // Regression: deadlineSeconds used to be a BigInt literal (3600n), which
    // makes Tauri's JSON.stringify-based IPC throw before the command is sent.
    expect(() => serializeAsTauriIpc({ command: 'workflow_debug', args })).not.toThrow();
    const serialized = serializeAsTauriIpc(args);
    expect(serialized).toContain('"deadlineSeconds":3600');
  });

  it('keeps workflow_validate args serializable through Tauri JSON IPC', async () => {
    const { transport, calls } = capturingTransport();
    const api = createWorkflowApi(transport);
    const definition = definitionWithPolicy({
      maxConcurrentAgentSteps: 1,
      maxAgentCalls: 2,
      deadlineSeconds: 60,
      maxOutputBytes: 4096,
    });

    await api.validate(definition);

    const { args } = calls[0];
    expect(() =>
      serializeAsTauriIpc({ command: 'workflow_validate', args })
    ).not.toThrow();
  });
});
