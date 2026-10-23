import { createElement } from 'react';

function WorkflowStudioSurface() {
  return createElement(
    'div',
    {
      className: 'vibex-workflow-studio-surface p-4',
      'data-testid': 'workflow-studio-surface',
    },
    'VibeX Workflow Studio (.vibex-workflow.json)'
  );
}

export default {
  apiVersion: '2.0',
  id: 'vibex.workflow-creator',
  activate(ctx) {
    let defaultCompletionPolicy = 'manual';

    ctx.ui.registerSlashCommand({
      name: 'workflow',
      description: 'Design or revise a VibeX DAG workflow (.vibex-workflow.json)',
      prompt: 'Design a validated VibeX DAG workflow for the following objective:',
    });

    ctx.ui.registerView({
      id: 'workflow-studio',
      title: 'Workflow Studio',
      slot: 'plugin.detail.panel',
      component: WorkflowStudioSurface,
    });

    ctx.ui.registerCommand({
      id: 'vibex.workflow-creator.new',
      title: 'Create New VibeX Workflow',
      category: 'Workflow',
      icon: 'git-branch',
      handler: () => {
        ctx.events.emit('workflow-creator:new', {
          suffix: '.vibex-workflow.json',
          defaultCompletionPolicy,
        });
      },
    });

    ctx.services.provide('vibex.workflow-creator', {
      workflowFileSuffix: '.vibex-workflow.json',
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
