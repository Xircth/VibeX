import { defineVibeXPlugin } from '@vibex/plugin-sdk/app';

export default defineVibeXPlugin({
  id: 'vibex.workflow-creator',
  activate(ctx) {
    ctx.ui.registerSlashCommand({
      name: 'workflow-new',
      description: 'Author a new VibeX workflow definition',
      prompt: 'Design a multi-step VibeX workflow for:',
    });
  },
});
