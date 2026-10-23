export default {
  apiVersion: '2.0',
  id: 'vibex.browser',
  activate(ctx) {
    ctx.ui.registerSlashCommand({
      name: 'browse',
      description: 'Open URL or inspect active browser tab in the current session',
      prompt: 'Open and inspect the target URL using the built-in browser tools:',
    });

    ctx.ui.registerCommand({
      id: 'vibex.browser.open-tab',
      title: 'Open Built-in Browser Tab',
      category: 'Browser',
      icon: 'globe',
      handler: () => {
        ctx.events.emit('browser:open-tab', { url: 'about:blank' });
      },
    });

    ctx.services.provide('vibex.browser', {
      openUrl(url) {
        ctx.events.emit('browser:open-tab', { url });
        return { opened: true, url };
      },
    });
  },
};
