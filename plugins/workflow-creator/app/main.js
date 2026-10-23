export default {
  apiVersion: '2.0',
  id: 'vibex.workflow-creator',
  activate(ctx) {
    ctx.ui.registerSlashCommand({
      name: 'workflow',
      description: 'Design or revise a VibeX DAG workflow (.vibex-workflow.json)',
      prompt: 'Design a validated VibeX DAG workflow for the following objective:',
    });

    ctx.services.provide('vibex.workflow-creator', {
      workflowFileSuffix: '.vibex-workflow.json',
    });
  },
};
