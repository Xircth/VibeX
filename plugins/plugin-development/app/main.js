export default {
  apiVersion: '2.0',
  id: 'vibex.plugin-development',
  activate(ctx) {
    ctx.provideService('vibex.plugin-dev', {
      version: '2.0.0',
    });

    ctx.registerCommand({
      id: 'reload-plugins',
      title: 'Reload VibeX Plugins',
      category: 'Developer',
      async handler() {
        await ctx.storage.kv.set('lastReloadAt', Date.now());
      },
    });
  },
};
