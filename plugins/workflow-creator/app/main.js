import { createElement } from 'react';

function WorkflowStudioSurface() {
  return createElement(
    'div',
    {
      className: 'dimo-workflow-studio-surface p-4',
      'data-testid': 'workflow-studio-surface',
    },
    'Dimo Workflow Studio (.dimo-workflow.json)'
  );
}

export default {
  apiVersion: '2.0',
  id: 'dimo.workflow-creator',
  activate(ctx) {
    let defaultCompletionPolicy = 'manual';

    ctx.ui.registerSlashCommand({
      name: 'workflow',
      description: 'Design or revise a Dimo DAG workflow (.dimo-workflow.json)',
      prompt: 'Design a validated Dimo DAG workflow for the following objective:',
    });

    ctx.ui.registerView({
      id: 'workflow-studio',
      title: 'Workflow Studio',
      slot: 'plugin.detail.panel',
      component: WorkflowStudioSurface,
    });

    ctx.ui.registerCommand({
      id: 'dimo.workflow-creator.new',
      title: 'Create New Dimo Workflow',
      category: 'Workflow',
      icon: 'git-branch',
      handler: () => {
        ctx.events.emit('workflow-creator:new', {
          suffix: '.dimo-workflow.json',
          defaultCompletionPolicy,
        });
      },
    });

    ctx.services.provide('dimo.workflow-creator', {
      workflowFileSuffix: '.dimo-workflow.json',
      getDefaultCompletionPolicy() {
        return defaultCompletionPolicy;
      },
      async setDefaultCompletionPolicy(policy) {
        defaultCompletionPolicy =
          policy === 'automatic' ? 'automatic' : 'manual';
        try {
          await ctx.storage.settings.set({ defaultCompletionPolicy });
        } catch {
          // Ignore when offline.
        }
        return defaultCompletionPolicy;
      },
      createWorkflowTemplate(name = 'New Workflow') {
        return {
          schemaVersion: 1,
          name,
          completionPolicy: defaultCompletionPolicy,
          nodes: [],
          edges: [],
        };
      },
    });
  },
};
