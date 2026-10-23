import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyBeforeTurnPromptContributions,
  bindExternalStoreHook,
  collectBeforeTurnContributions,
  commandRegistry,
  conversationModeRegistry,
  createPluginContext,
  createServiceKey,
  defineVibeXPlugin,
  dispatchCapturedInternalMessage,
  extractAndStripInternalMessages,
  findMarkdownRenderer,
  internalMessageCaptureRegistry,
  isVibeXPluginDefinition,
  kanbanViewRegistry,
  markdownRegistry,
  MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES,
  overlayRegistry,
  panelRegistry,
  promptContextRegistry,
  Registry,
  serviceContainer,
  settingsPageRegistry,
  slotRegistry,
  useCommands,
  useConversationModes,
  useKanbanViewContributions,
  useMarkdownRenderers,
  useOverlays,
  usePanels,
  usePluginService,
  useSettingsPages,
  useSlotContributions,
} from './index.js';

describe('@vibex/plugin-sdk v2 core', () => {
  beforeEach(() => {
    slotRegistry.clear();
    commandRegistry.clear();
    promptContextRegistry.clear();
    internalMessageCaptureRegistry.clear();
    conversationModeRegistry.clear();
    markdownRegistry.clear();
    overlayRegistry.clear();
    panelRegistry.clear();
    kanbanViewRegistry.clear();
    settingsPageRegistry.clear();
    serviceContainer.clear();
    bindExternalStoreHook(null);
  });

  it('maintains stable snapshot references and sorts by order then id', () => {
    const reg = new Registry<{ id: string; slot: string; order?: number }>();
    const emptySnap1 = reg.getAll();
    const emptySnap2 = reg.getAll();
    expect(emptySnap1).toBe(emptySnap2);

    const disposeB = reg.register({ id: 'b', slot: 'status.right', order: 20 });
    const disposeA = reg.register({ id: 'a', slot: 'status.right', order: 10 });
    const disposeC = reg.register({ id: 'c', slot: 'status.left', order: 5 });

    const snap1 = reg.getAll();
    const snap2 = reg.getAll();
    expect(snap1).toBe(snap2);
    expect(snap1.map((x) => x.id)).toEqual(['c', 'a', 'b']);

    const right1 = reg.getBySlot('status.right');
    const right2 = reg.getBySlot('status.right');
    expect(right1).toBe(right2);
    expect(right1.map((x) => x.id)).toEqual(['a', 'b']);

    disposeA();
    expect(reg.getBySlot('status.right').map((x) => x.id)).toEqual(['b']);
    disposeB();
    disposeC();
    expect(reg.getAll()).toEqual([]);
  });

  it('tracks plugin context registrations, services, and LIFO effects and disposes them cleanly', async () => {
    const calls: string[] = [];
    const GitServiceKey = createServiceKey<{ getBranch(): string }>('vibex.git');

    const hostCallMock = vi.fn(
      async (
        _pluginId: string,
        capability: string,
        operation: string,
        input?: unknown
      ) => {
        calls.push(`${capability}.${operation}`);
        if (capability === 'storage' && operation === 'kv.get') {
          return 'main' as never;
        }
        if (capability === 'network' && operation === 'fetch') {
          return {
            status: 200,
            ok: true,
            statusText: 'OK',
            headers: {},
            body: JSON.stringify(input),
          } as never;
        }
        return null as never;
      }
    );

    const plugin = defineVibeXPlugin({
      id: 'vibex.git',
      async activate(ctx) {
        ctx.effect(() => {
          calls.push('effect:1:mount');
          return () => calls.push('effect:1:cleanup');
        });
        ctx.effect(() => {
          calls.push('effect:2:mount');
          return () => calls.push('effect:2:cleanup');
        });

        ctx.registerSlot({
          id: 'git.branch-badge',
          slot: 'status.left',
          label: 'main',
          order: 10,
        });

        ctx.registerCommand({
          id: 'git.Refresh',
          title: 'Refresh Git Status',
          handler: () => {
            calls.push('cmd:refresh');
          },
        });

        ctx.provideService(GitServiceKey, {
          getBranch: () => 'main',
        });

        ctx.registerPromptContext({
          id: 'git.prompt',
          beforeTurn: async () => ({
            hiddenContext: 'Current branch: main',
          }),
        });

        const branch = await ctx.storage.kv.get<string>('branch');
        expect(branch).toBe('main');

        const resp = await ctx.network.fetch({
          url: 'https://example.com/api',
          method: 'POST',
        });
        expect(resp.ok).toBe(true);
      },
    });

    expect(isVibeXPluginDefinition(plugin)).toBe(true);

    const ctx = createPluginContext({
      pluginId: 'vibex.git',
      generation: 1,
      hostCall: hostCallMock,
    });

    await plugin.activate(ctx);

    expect(useSlotContributions('status.left')).toHaveLength(1);
    expect(useCommands()).toHaveLength(1);
    expect(usePluginService(GitServiceKey)?.getBranch()).toBe('main');

    const turnAdditions = await collectBeforeTurnContributions({
      conversationId: 'conv-1',
      text: 'hello',
    });
    expect(turnAdditions.hiddenContexts).toEqual(['Current branch: main']);

    ctx.dispose();

    expect(calls).toEqual([
      'effect:1:mount',
      'effect:2:mount',
      'storage.kv.get',
      'network.fetch',
      'effect:2:cleanup',
      'effect:1:cleanup',
    ]);
    expect(useSlotContributions('status.left')).toHaveLength(0);
    expect(useCommands()).toHaveLength(0);
    expect(usePluginService(GitServiceKey)).toBeUndefined();
  });

  it('delegates to bound useSyncExternalStore hook when configured', () => {
    const externalStoreSpy = vi.fn(
      <Snapshot>(
        _subscribe: (onStoreChange: () => void) => () => void,
        getSnapshot: () => Snapshot
      ) => getSnapshot()
    );
    bindExternalStoreHook(externalStoreSpy);

    slotRegistry.register({
      id: 'item-1',
      slot: 'toolbar.right',
      label: 'Test',
    });

    const items = useSlotContributions('toolbar.right');
    expect(items).toHaveLength(1);
    expect(externalStoreSpy).toHaveBeenCalledTimes(1);
  });

  it('injects beforeTurn prompt context without mutating visible user text and strips internal message frames', async () => {
    const capturedPayloads: unknown[] = [];
    const ctx = createPluginContext({ pluginId: 'vibex.memory' });

    ctx.registerPromptContext({
      id: 'memory-inject',
      beforeTurn: async () => ({
        hiddenContext:
          'Emit <vibex-internal-meta channel="memory.save" nonce="n42">{"topic":"rust"}</vibex-internal-meta>',
      }),
    });

    ctx.registerInternalMessageCapture({
      id: 'memory-capture',
      channel: 'memory.save',
      nonce: 'n42',
      onCapture(msg) {
        capturedPayloads.push(msg.parsedPayload);
      },
    });

    const turn = await applyBeforeTurnPromptContributions('Fix the bug', {
      conversationId: 'conv-99',
    });
    expect(turn.visibleUserText).toBe('Fix the bug');
    expect(turn.agentPromptText).toContain('Fix the bug');
    expect(turn.agentPromptText).toContain('<vibex-plugin-context>');

    const assistantOutput =
      'Here is the fix.\n\n<vibex-internal-meta channel="memory.save" nonce="n42">{"topic":"rust"}</vibex-internal-meta>\n\nAll done!';
    const { cleanedText, captured } = extractAndStripInternalMessages(
      assistantOutput,
      { conversationId: 'conv-99' }
    );

    expect(cleanedText).toBe('Here is the fix.\n\nAll done!');
    expect(captured).toHaveLength(1);
    expect(capturedPayloads).toEqual([{ topic: 'rust' }]);

    ctx.dispose();
  });

  it('supports Cordis-style multi-dependency reactive inject(deps, effect) with automatic cleanup on service churn', () => {
    const events: string[] = [];
    const ctxConsumer = createPluginContext({ pluginId: 'plugin.consumer' });
    const ctxProviderA = createPluginContext({ pluginId: 'plugin.a' });
    const ctxProviderB = createPluginContext({ pluginId: 'plugin.b' });

    ctxConsumer.services.inject(['svc.a', 'svc.b'], (resolved) => {
      const a = resolved['svc.a'] as { v: string };
      const b = resolved['svc.b'] as { v: string };
      events.push(`ready:${a.v}+${b.v}`);
      return () => {
        events.push(`cleanup:${a.v}+${b.v}`);
      };
    });

    // Only svc.a is provided -> effect should not run yet
    const disposeA1 = ctxProviderA.services.provide('svc.a', { v: 'A1' });
    expect(events).toEqual([]);

    // Now svc.b is provided -> effect runs immediately
    ctxProviderB.services.provide('svc.b', { v: 'B1' });
    expect(events).toEqual(['ready:A1+B1']);

    // Replace svc.a -> previous cleanup runs, then new effect runs
    ctxProviderA.services.provide('svc.a', { v: 'A2' });
    expect(events).toEqual(['ready:A1+B1', 'cleanup:A1+B1', 'ready:A2+B1']);

    // Dispose provider B -> cleanup runs, and effect waits until svc.b returns
    disposeA1();
    ctxProviderB.dispose();
    expect(events).toEqual([
      'ready:A1+B1',
      'cleanup:A1+B1',
      'ready:A2+B1',
      'cleanup:A2+B1',
    ]);

    ctxConsumer.dispose();
    ctxProviderA.dispose();
  });

  it('runs onion-model waterfall interceptors with ordering, error fallback, and per-hook timeout degradation', async () => {
    const ctx1 = createPluginContext({ pluginId: 'plugin.one' });
    const ctx2 = createPluginContext({ pluginId: 'plugin.two' });
    const ctxSlow = createPluginContext({ pluginId: 'plugin.slow' });

    ctx2.hooks.beforeTurn<{ text: string }, string>(async (payload, next) => {
      const res = await next({ text: `${payload.text} -> two` });
      return `[two:${res}]`;
    }, 20);

    ctx1.hooks.beforeTurn<{ text: string }, string>(async (payload, next) => {
      const res = await next({ text: `${payload.text} -> one` });
      return `[one:${res}]`;
    }, 10);

    // Slow hook that exceeds perHookTimeoutMs (30ms) before calling next()
    ctxSlow.hooks.beforeTurn<{ text: string }, string>(async (payload, next) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return await next({ text: `${payload.text} -> slow` });
    }, 15);

    const output = await serviceContainer.runWaterfall(
      'conversation.beforeTurn',
      { text: 'start' },
      async (finalPayload) => `terminal(${finalPayload.text})`,
      25
    );

    // Slow hook timed out and was bypassed; one (order 10) and two (order 20) ran in order
    expect(output).toBe('[one:[two:terminal(start -> one -> two)]]');

    ctx1.dispose();
    ctx2.dispose();
    ctxSlow.dispose();
  });

  it('exposes structured ctx.ui, ctx.hooks, ctx.services, and ctx.host namespaces', async () => {
    const hostCalls: Array<{ capability: string; operation: string }> = [];
    const ctx = createPluginContext({
      pluginId: 'vibex.demo',
      hostCall: async (_pluginId, capability, operation) => {
        hostCalls.push({ capability, operation });
        return { exitCode: 0, stdout: 'ok', stderr: '', success: true } as never;
      },
    });

    ctx.ui.registerToolbarItem({ id: 'tb-1', label: 'Toolbar' });
    ctx.ui.registerStatusBarItem({ id: 'sb-1', label: 'Status' });
    ctx.ui.registerPanel({ id: 'panel-1', title: 'Panel' });

    expect(slotRegistry.getBySlot('toolbar.actions')).toHaveLength(1);
    expect(slotRegistry.getBySlot('statusbar.items')).toHaveLength(1);

    const execResult = await ctx.host.exec.run({
      program: 'git',
      args: ['status'],
    });
    expect(execResult.exitCode).toBe(0);
    await ctx.host.notify.toast({ title: 'Hello', variant: 'success' });

    expect(hostCalls).toEqual([
      { capability: 'exec', operation: 'run' },
      { capability: 'app', operation: 'notify.toast' },
    ]);

    ctx.dispose();
    expect(slotRegistry.getBySlot('toolbar.actions')).toHaveLength(0);
    expect(slotRegistry.getBySlot('statusbar.items')).toHaveLength(0);
  });

  it('registers and disposes Phase 2 registries (conversationMode, markdown, overlay, panel, kanbanView, settingsPage)', () => {
    const ctx = createPluginContext({ pluginId: 'vibex.phase2' });

    ctx.ui.registerConversationMode({
      id: 'voice-mode',
      label: 'Voice Mode',
      render: () => 'Voice UI',
    });
    ctx.ui.registerMarkdownRenderer({
      id: 'vega-renderer',
      language: ['vega', 'vega-lite'],
      render: ({ code }) => `chart:${code}`,
    });
    ctx.ui.registerOverlay({
      id: 'pet-overlay',
      title: 'Desktop Pet',
      render: () => 'Pet',
    });
    ctx.ui.registerPanel({
      id: 'custom-panel',
      title: 'Custom Panel',
      zone: 'editor',
    });
    ctx.ui.registerKanbanView({
      id: 'timeline-view',
      title: 'Timeline',
    });
    ctx.ui.registerSettingsPage({
      id: 'custom-settings',
      title: 'Custom Settings',
      group: 'plugins',
    });

    expect(useConversationModes()).toHaveLength(1);
    expect(useConversationModes()[0]?.takeover).toBe(true);
    expect(useMarkdownRenderers()).toHaveLength(1);
    expect(findMarkdownRenderer('{"mark":"bar"}', 'vega-lite')?.id).toBe(
      'vega-renderer'
    );
    expect(findMarkdownRenderer('console.log(1)', 'ts')).toBeUndefined();
    expect(useOverlays()).toHaveLength(1);
    expect(usePanels()).toHaveLength(1);
    expect(useKanbanViewContributions()).toHaveLength(1);
    expect(useSettingsPages()).toHaveLength(1);

    ctx.dispose();

    expect(useConversationModes()).toHaveLength(0);
    expect(useMarkdownRenderers()).toHaveLength(0);
    expect(useOverlays()).toHaveLength(0);
    expect(usePanels()).toHaveLength(0);
    expect(useKanbanViewContributions()).toHaveLength(0);
    expect(useSettingsPages()).toHaveLength(0);
  });

  it('supports Phase 3 service-instance decoration via ctx.services.intercept and child scope disposal in ctx.services.inject', () => {
    const ctxHost = createPluginContext({ pluginId: 'vibex.host' });
    const ctxDecorator = createPluginContext({ pluginId: 'vibex.decorator' });
    const ctxConsumer = createPluginContext({ pluginId: 'vibex.consumer' });

    ctxHost.services.provide('vibex.usage', {
      probe: () => 'base-quota',
    });

    ctxConsumer.services.inject(
      ['vibex.usage'],
      ([usage]: [{ probe: () => string }]) => {
        ctxConsumer.ui.registerStatusItem({
          id: 'usage-item',
          label: usage.probe(),
        });
      }
    );

    expect(slotRegistry.get('usage-item')?.label).toBe('base-quota');

    // Decorate vibex.usage service instance
    ctxDecorator.services.intercept(
      'vibex.usage',
      (prev: { probe: () => string }) => ({
        ...prev,
        probe: () => `${prev.probe()}+decorated`,
      })
    );

    expect(
      ctxConsumer.services.get<{ probe: () => string }>('vibex.usage')?.probe()
    ).toBe('base-quota+decorated');
    expect(slotRegistry.get('usage-item')?.label).toBe('base-quota+decorated');

    // Dispose decorator -> restores original service and re-runs injected child scope
    ctxDecorator.dispose();
    expect(
      ctxConsumer.services.get<{ probe: () => string }>('vibex.usage')?.probe()
    ).toBe('base-quota');
    expect(slotRegistry.get('usage-item')?.label).toBe('base-quota');

    // Dispose upstream host -> consumer child scope automatically disposes its status item
    ctxHost.dispose();
    expect(slotRegistry.has('usage-item')).toBe(false);

    ctxConsumer.dispose();
  });

  it('enforces Phase 5 16 KiB cap on beforeTurn internalPromptContributions and supports streaming partial tags + host-dispatched side-channel messages + afterTurn hooks', async () => {
    const ctx1 = createPluginContext({ pluginId: 'vibex.p5.first' });
    const ctx2 = createPluginContext({ pluginId: 'vibex.p5.huge' });
    const ctx3 = createPluginContext({ pluginId: 'vibex.p5.second' });

    ctx1.registerPromptContext({
      id: 'first-ctx',
      order: 10,
      beforeTurn: async () => ({
        hiddenContext: 'First contribution block',
      }),
    });

    ctx2.registerPromptContext({
      id: 'huge-ctx',
      order: 20,
      beforeTurn: async () => ({
        hiddenContext: 'X'.repeat(MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES + 128),
      }),
    });

    ctx3.registerPromptContext({
      id: 'second-ctx',
      order: 30,
      beforeTurn: async () => ({
        hiddenContext: 'Second contribution block',
      }),
    });

    const collected = await collectBeforeTurnContributions({
      conversationId: 'conv-p5',
      text: 'Summarize memory',
    });

    expect(collected.internalPromptContributions).toEqual([
      {
        pluginId: 'vibex.p5.first',
        label: null,
        content: 'First contribution block',
        priority: 10,
      },
      {
        pluginId: 'vibex.p5.second',
        label: null,
        content: 'Second contribution block',
        priority: 30,
      },
    ]);

    // Streaming partial tag buffering at tail
    const streamingChunk =
      'Visible response start\n<vibex-internal-meta channel="memory.extract" nonce="n1">{"partial":true';
    const partialResult = extractAndStripInternalMessages(streamingChunk, {
      conversationId: 'conv-p5',
    });
    expect(partialResult.cleanedText).toBe('Visible response start');
    expect(partialResult.hasIncompleteTrailingTag).toBe(true);
    expect(partialResult.captured).toHaveLength(0);

    // Host-dispatched side-channel message routing with nonce verification
    const capturedByPlugin: unknown[] = [];
    ctx1.registerInternalMessageCapture({
      id: 'mem-cap',
      channel: 'memory.extract',
      nonce: 'n-secret',
      onCapture(message) {
        capturedByPlugin.push(message.parsedPayload);
      },
    });

    dispatchCapturedInternalMessage({
      channel: 'memory.extract',
      nonce: 'wrong-nonce',
      rawPayload: '{"ignored":true}',
      parsedPayload: { ignored: true },
      conversationId: 'conv-p5',
      turnId: 'turn-1',
    });
    expect(capturedByPlugin).toHaveLength(0);

    dispatchCapturedInternalMessage({
      channel: 'memory.extract',
      nonce: 'n-secret',
      rawPayload: '{"saved":"fact-1"}',
      parsedPayload: { saved: 'fact-1' },
      conversationId: 'conv-p5',
      turnId: 'turn-1',
    });
    expect(capturedByPlugin).toEqual([{ saved: 'fact-1' }]);

    // afterTurn hook receives settled turn events
    const afterTurnEvents: string[] = [];
    ctx1.hooks.afterTurn((event) => {
      afterTurnEvents.push(
        `${event.conversationId}:${event.turnId}:${event.status}`
      );
    });

    await serviceContainer.emitParallel('conversation.afterTurn', {
      conversationId: 'conv-p5',
      turnId: 'turn-1',
      status: 'completed',
      assistantText: 'Visible response start',
      capturedMessages: [],
    });
    expect(afterTurnEvents).toEqual(['conv-p5:turn-1:completed']);

    ctx1.dispose();
    ctx2.dispose();
    ctx3.dispose();
  });
});
