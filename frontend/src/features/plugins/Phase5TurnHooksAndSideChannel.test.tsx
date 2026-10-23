import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPluginContext,
  createPluginTestHarness,
  definePlugin,
  dispatchCapturedInternalMessage,
  extractAndStripInternalMessages,
  internalMessageCaptureRegistry,
  promptContextRegistry,
  serviceContainer,
  slotRegistry,
} from '@vibex/plugin-sdk';
import { createConversationApi } from '@/features/conversation/conversationApi';
import {
  loadPluginRuntime,
  unloadPluginRuntime,
} from '@/features/plugins/PluginRuntimeLoader';
import type { BackendTransport } from '@/lib/transport';

describe('Phase 5: beforeTurn Implicit Prompt Contributions, InternalMessageCapture Side-Channel & afterTurn Hooks', () => {
  beforeEach(() => {
    promptContextRegistry.clear();
    internalMessageCaptureRegistry.clear();
    serviceContainer.clear();
  });

  it('collects beforeTurn contributions from both promptContextRegistry and ctx.hooks.beforeTurn without mutating displayText', async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> =
      [];
    const fakeTransport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return {
          conversationId: 'conv-1',
          turnId: 'turn-1',
          status: 'running',
        };
      }),
      listen: vi.fn(async () => () => undefined),
    };

    const ctxMemory = createPluginContext({ pluginId: 'vibex.memory' });
    const ctxRules = createPluginContext({ pluginId: 'vibex.rules' });

    ctxMemory.registerPromptContext({
      id: 'memory-recall',
      order: 10,
      beforeTurn: async () => ({
        label: 'Memory Context',
        content:
          'User prefers Rust 2024 edition.\nWhen storing facts emit <vibex-internal-meta channel="memory.save" nonce="n99">{"fact":"..."}</vibex-internal-meta>',
      }),
    });

    ctxRules.hooks.beforeTurn(() => 'Always run cargo check before finishing.', 20);

    const api = createConversationApi(fakeTransport);
    await api.startTurn({
      agentId: 'claude-code' as never,
      workspaceId: 'ws-1',
      conversationId: 'conv-1',
      text: 'Fix the parser bug',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('conversation_start_turn');
    const reqPayload = calls[0]?.args?.request as Record<string, unknown>;
    expect(reqPayload?.text).toBe('Fix the parser bug');
    expect(reqPayload?.internalPromptContributions).toEqual([
      {
        pluginId: 'vibex.memory',
        label: 'Memory Context',
        content:
          'User prefers Rust 2024 edition.\nWhen storing facts emit <vibex-internal-meta channel="memory.save" nonce="n99">{"fact":"..."}</vibex-internal-meta>',
        priority: 10,
      },
      {
        pluginId: 'vibex.rules',
        label: null,
        content: 'Always run cargo check before finishing.',
        priority: 20,
      },
    ]);

    ctxMemory.dispose();
    ctxRules.dispose();
  });

  it('strips internal side-channel frames across streaming chunks and routes validated payloads to plugins', async () => {
    const ctx = createPluginContext({ pluginId: 'vibex.memory' });
    const captured: Array<{ fact: string }> = [];

    ctx.hooks.captureInternalMessage({
      id: 'save-fact',
      channel: 'memory.save',
      nonce: 'n99',
      validate: (payload): payload is { fact: string } =>
        Boolean(
          payload &&
            typeof payload === 'object' &&
            typeof (payload as { fact?: unknown }).fact === 'string'
        ),
      onCapture(msg) {
        captured.push(msg.parsedPayload as { fact: string });
      },
    });

    // Chunk 1: trailing incomplete internal tag is hidden from user-visible text
    const chunk1 =
      'I fixed the parser bug.\n<vibex-internal-meta channel="memory.save" nonce="n99">{"fact":"parser';
    const res1 = extractAndStripInternalMessages(chunk1, {
      conversationId: 'conv-1',
      turnId: 'turn-1',
    });
    expect(res1.cleanedText).toBe('I fixed the parser bug.');
    expect(res1.hasIncompleteTrailingTag).toBe(true);
    expect(captured).toHaveLength(0);

    // Chunk 2: complete tag is stripped and dispatched
    const fullText = `${chunk1} uses nom"}</vibex-internal-meta>\n\nAll tests pass.`;
    const res2 = extractAndStripInternalMessages(fullText, {
      conversationId: 'conv-1',
      turnId: 'turn-1',
    });
    expect(res2.cleanedText).toBe('I fixed the parser bug.\n\nAll tests pass.');
    expect(res2.hasIncompleteTrailingTag).toBe(false);
    expect(captured).toEqual([{ fact: 'parser uses nom' }]);

    // Host-pushed event via dispatchCapturedInternalMessage also validates nonce + schema
    dispatchCapturedInternalMessage({
      pluginId: 'vibex.memory',
      channel: 'memory.save',
      nonce: 'n99',
      rawPayload: '{"fact":"second fact"}',
      parsedPayload: { fact: 'second fact' },
      conversationId: 'conv-1',
      turnId: 'turn-1',
    });
    expect(captured).toEqual([
      { fact: 'parser uses nom' },
      { fact: 'second fact' },
    ]);

    ctx.dispose();
  });

  it('invokes ctx.hooks.afterTurn when conversation-after-turn settles', async () => {
    const ctx = createPluginContext({ pluginId: 'vibex.audit' });
    const settled: string[] = [];

    ctx.hooks.afterTurn((event) => {
      settled.push(`${event.conversationId}/${event.turnId}:${event.status}`);
    });

    await serviceContainer.runWaterfall('conversation.afterTurn', {
      conversationId: 'conv-1',
      turnId: 'turn-1',
      status: 'completed',
      assistantText: 'Done!',
      capturedMessages: [],
    });

    expect(settled).toEqual(['conv-1/turn-1:completed']);
    ctx.dispose();
  });

  it('hot-loads an AI-authored single-file ESM plugin (with bare react & @vibex/plugin-sdk imports) end-to-end', async () => {
    slotRegistry.clear();
    const generatedMainJs = `
      import React, { createElement } from 'react';
      import { serviceContainer } from '@vibex/plugin-sdk';

      export default function activate(ctx) {
        ctx.ui.registerStatusBarItem({
          id: 'git-unpushed',
          label: '↑3 unpushed',
          component: () => createElement('span', { 'data-testid': 'ai-chip' }, '↑3'),
        });

        ctx.hooks.beforeTurn(() => ({
          label: 'Git Status',
          content: 'Branch feat/nextgen has 3 unpushed commits.',
        }));

        ctx.hooks.captureInternalMessage('git.autoPush', (msg) => {
          serviceContainer.provide('test.aiCapturedPush', msg.parsedPayload, ctx.pluginId);
        });
      }
    `;

    const dispose = await loadPluginRuntime('user.git-unpushed', {
      kind: 'esm-code',
      code: generatedMainJs,
      css: '.ai-chip { color: var(--text-primary); }',
    });

    expect(
      slotRegistry.get('user.git-unpushed:git-unpushed')?.label
    ).toBe('↑3 unpushed');

    const extracted = extractAndStripInternalMessages(
      'Pushing now.\n```vibex-internal:git.autoPush:n1\n{"branch":"feat/nextgen","pushed":3}\n```',
      { conversationId: 'conv-ai', turnId: 'turn-ai' }
    );
    expect(extracted.cleanedText).toBe('Pushing now.');
    expect(serviceContainer.get('test.aiCapturedPush')).toEqual({
      branch: 'feat/nextgen',
      pushed: 3,
    });

    dispose();
    unloadPluginRuntime('user.git-unpushed');
    expect(
      slotRegistry.get('user.git-unpushed:git-unpushed')
    ).toBeUndefined();
  });

  it('supports createPluginTestHarness, beforeTurn draft text rewriting, onRuntimeEvent, and TypeScript import type stripping', async () => {
    const plugin = definePlugin({
      id: 'user.review-helper',
      activate(ctx) {
        ctx.ui.registerStatusBarItem({
          id: 'status',
          label: 'Review Ready',
        });
        ctx.hooks.beforeTurn(async (turn) => ({
          text: `${turn.text}\n[Reviewed]`,
          blocks: [{ label: 'Policy', content: 'Enforce strict checks' }],
        }));
      },
    });

    const harness = createPluginTestHarness(plugin);
    await harness.activate();
    expect(
      harness.registries.slot.get('user.review-helper:status')?.label
    ).toBe('Review Ready');

    const observedEvents: string[] = [];
    harness.ctx.hooks.onRuntimeEvent((event) => {
      observedEvents.push(String(event.kind));
    });

    await serviceContainer.runWaterfall('runtime.event', {
      id: 'evt-1',
      conversationId: 'conv-1',
      sequence: 1,
      source: 'agent',
      kind: 'tool_call_upsert',
      event: { type: 'tool_call_upsert' },
    });
    expect(observedEvents).toEqual(['tool_call_upsert']);

    const calls: Array<{ command: string; args?: Record<string, unknown> }> =
      [];
    const fakeTransport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return {
          conversationId: 'conv-1',
          turnId: 'turn-1',
          status: 'running',
        };
      }),
      listen: vi.fn(async () => () => undefined),
    };
    const api = createConversationApi(fakeTransport);
    await api.startTurn({
      agentId: 'claude-code' as never,
      workspaceId: 'ws-1',
      conversationId: 'conv-1',
      text: 'Ship feature',
    });

    const reqPayload = calls[0]?.args?.request as Record<string, unknown>;
    expect(reqPayload?.text).toBe('Ship feature\n[Reviewed]');
    expect(reqPayload?.displayText).toBe('Ship feature');
    expect(reqPayload?.internalPromptContributions).toEqual([
      {
        pluginId: 'user.review-helper',
        label: 'Policy',
        content: 'Enforce strict checks',
        priority: 100,
      },
    ]);

    harness.dispose();

    // Also verify single-file ESM with `import type` and inline `type` specifiers loads cleanly
    const tsFlavoredEsm = `
      import type { PluginContext } from '@vibex/plugin-sdk';
      import { type VibeXPlugin, defineVibeXPlugin } from '@vibex/plugin-sdk';

      export default defineVibeXPlugin({
        id: 'user.ts-esm',
        activate(ctx) {
          ctx.ui.registerStatusBarItem({ id: 'ts-chip', label: 'TS OK' });
        },
      });
    `;
    const disposeTs = await loadPluginRuntime('user.ts-esm', {
      kind: 'esm-code',
      code: tsFlavoredEsm,
    });
    expect(slotRegistry.get('user.ts-esm:ts-chip')?.label).toBe('TS OK');
    disposeTs();
    unloadPluginRuntime('user.ts-esm');
  });
});
