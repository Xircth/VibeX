export default {
  apiVersion: '2.0',
  id: 'dimo.plugin-development',
  activate(ctx) {
    ctx.ui.registerSlashCommand({
      name: 'plugin-dev',
      description: 'Scaffold, validate, or hot-reload a Dimo v2.0 plugin',
      prompt:
        'Use the Dimo Plugin SDK v2.0 conventions to design or validate this plugin:',
    });

    ctx.ui.registerCommand({
      id: 'reload-plugins',
      title: 'Reload Dimo Plugins',
      category: 'Developer',
      icon: 'refresh-cw',
      async handler() {
        const timestamp = Date.now();
        await ctx.host.storage.kv.set('lastReloadAt', timestamp);
        ctx.events.emit('plugin-dev:reload-requested', { timestamp });
      },
    });

    ctx.services.provide('dimo.plugin-dev', {
      version: '2.0.0',
      async reloadPlugins() {
        const timestamp = Date.now();
        await ctx.host.storage.kv.set('lastReloadAt', timestamp);
        ctx.events.emit('plugin-dev:reload-requested', { timestamp });
        return { reloadedAt: timestamp };
      },
      async getLastReloadAt() {
        return await ctx.host.storage.kv.get('lastReloadAt');
      },
    });
  },
};
