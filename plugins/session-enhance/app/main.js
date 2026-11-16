export default {
  apiVersion: '2.0',
  id: 'dimo.session-enhance',
  activate(ctx) {
    ctx.registerPromptContext({
      id: 'session-enhance-turn-context',
      async beforeTurn() {
        const enabled = await ctx.storage.kv.get('injectHints');
        if (!enabled) return null;
        return {
          hiddenContext:
            'If structured session metadata is updated, emit <dimo-internal-meta channel="session.meta" nonce="v2">{"updated":true}</dimo-internal-meta>.',
        };
      },
    });

    ctx.registerInternalMessageCapture({
      id: 'session-enhance-meta-capture',
      channel: 'session.meta',
      async onCapture(message) {
        await ctx.storage.kv.set('lastCapturedMeta', message.parsedPayload);
      },
    });

    ctx.ui.registerCommand({
      id: 'dimo.session-enhance.toggle-hints',
      title: 'Toggle Session Enhance Turn Hints',
      category: 'Session',
      icon: 'message-square',
      handler: async () => {
        const current = Boolean(await ctx.storage.kv.get('injectHints'));
        await ctx.storage.kv.set('injectHints', !current);
        return { injectHints: !current };
      },
    });

    ctx.services.inject(
      ['dimo.provider-catalog', 'dimo.usage'],
      ([providerCatalog, usageService]) => {
        const templates =
          typeof providerCatalog?.listTemplates === 'function'
            ? providerCatalog.listTemplates('opencode')
            : [];
        ctx.ui.registerStatusItem({
          id: 'session-enhance-status',
          label: `Session Enhance (${templates.length} templates)`,
        });
        ctx.services.provide('dimo.session-enhance', {
          activeTemplateCount: templates.length,
          canProbeUsage: typeof usageService?.probeAgentUsage === 'function',
          async getLastCapturedMeta() {
            return await ctx.storage.kv.get('lastCapturedMeta');
          },
        });
      }
    );
  },
};
