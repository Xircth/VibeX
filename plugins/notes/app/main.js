export default {
  apiVersion: '2.0',
  id: 'vibex.notes',
  activate(ctx) {
    ctx.ui.registerSlashCommand({
      name: 'note',
      description: 'Save a quick note or architectural memo to the workspace scratchpad',
      prompt: 'Record the following key takeaway into the workspace notes:',
    });

    ctx.ui.registerContextMenu({
      id: 'vibex.notes.capture-selection',
      label: 'Save Selection to Notes',
      group: 'notes',
      when: (menuCtx) => Boolean(menuCtx.selectionText?.trim()),
      action: async (menuCtx) => {
        const text = menuCtx.selectionText?.trim();
        if (!text) return;
        const existing = ((await ctx.storage.kv.get('items')) || []);
        await ctx.storage.kv.set('items', [...existing, { text, createdAt: Date.now() }]);
      },
    });

    ctx.services.provide('vibex.notes', {
      async listNotes() {
        return (await ctx.storage.kv.get('items')) || [];
      },
      async addNote(text) {
        const existing = (await ctx.storage.kv.get('items')) || [];
        const next = [...existing, { text, createdAt: Date.now() }];
        await ctx.storage.kv.set('items', next);
        return next;
      },
    });
  },
};
