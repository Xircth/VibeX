export default {
  apiVersion: '2.0',
  id: 'vibex.plugin-development',
  activate(ctx) {
    ctx.ui.registerSlashCommand({
      name: 'plugin-dev',
      description: 'Scaffold, validate, or hot-reload a VibeX v2.0 plugin',
      prompt:
        'Use the VibeX Plugin SDK v2.0 conventions to design or validate this plugin:',
    });

    ctx.registerCommand({
      id: 'reload-plugins',
      title: 'Reload VibeX Plugins',
      category: 'Developer',
      icon: 'refresh-cw',
      async handler() {
        const timestamp = Date.now();
        await ctx.storage.kv.set('lastReloadAt', timestamp);
        ctx.events.emit('plugin-dev:reload-requested', { timestamp });
      },
    });

    ctx.provideService('vibex.plugin-dev', {
      version: '2.0.0',
      async reloadPlugins() {
        const timestamp = Date.now();
        await ctx.storage.kv.set('lastReloadAt', timestamp);
        ctx.events.emit('plugin-dev:reload-requested', { timestamp });
        return { reloadedAt: timestamp };
      },
      async getLastReloadAt() {
        return await ctx.storage.kv.get('lastReloadAt');
      },
    });
  },
};
