export default {
  apiVersion: '2.0',
  id: 'vibex.kanban-views',
  activate(ctx) {
    ctx.ui.registerCommand({
      id: 'vibex.kanban.triage',
      title: 'Triage Kanban Board Tasks',
      category: 'Kanban',
      icon: 'layers',
      handler: () => {
        ctx.events.emit('kanban:triage');
      },
    });

    ctx.services.provide('vibex.kanban-views', {
      defaultViews: ['board', 'list', 'timeline'],
    });
  },
};
