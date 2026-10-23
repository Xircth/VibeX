export default {
  apiVersion: '2.0',
  id: 'vibex.prompt-enhancer',
  activate(ctx) {
    ctx.ui.registerSlashCommand({
      name: 'enhance',
      description: 'Refine prompt with explicit acceptance criteria and verification steps',
      prompt: 'Please structure and execute this request with root-cause analysis and verification:',
    });

    ctx.ui.registerComposerAction({
      id: 'enhance-prompt',
      title: 'Enhance Prompt',
      icon: 'sparkles',
      prompt: 'Ensure the implementation is complete, root-cause-driven, and verified with tests. ',
    });

    ctx.services.provide('vibex.prompt-enhancer', {
      enhance(promptText) {
        return `${String(promptText).trim()}\n\n[Constraints: Complete implementation, verify with tests.]`;
      },
    });
  },
};
