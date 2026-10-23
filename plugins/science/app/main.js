export default {
  apiVersion: '2.0',
  id: 'vibex.science',
  activate(ctx) {
    ctx.ui.registerSlashCommand({
      name: 'science-literature',
      description: 'Synthesize primary scientific literature and experimental methodology',
      prompt: 'Conduct a rigorous primary-source scientific review and methodology synthesis on:',
    });

    ctx.services.provide('vibex.science', {
      domains: ['general', 'genomics', 'dataScience'],
    });
  },
};
