export default {
  apiVersion: '2.0',
  id: 'vibex.open-connector',
  activate(ctx) {
    ctx.ui.registerSlashCommand({
      name: 'connector',
      description: 'List or invoke connected third-party SaaS integrations',
      prompt: 'Inspect available Open Connector integrations for this task:',
    });

    ctx.services.provide('vibex.open-connector', {
      gatewayVersion: '2.0.0',
    });
  },
};
