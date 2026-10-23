import { createElement, useEffect, useMemo, useState } from 'react';

function normalizeNoteItem(item, index = 0) {
  if (!item || typeof item !== 'object') {
    const text = String(item ?? '').trim();
    return {
      id: `note-${Date.now()}-${index}`,
      text,
      source: 'manual',
      createdAt: Date.now(),
    };
  }
  const createdAt =
    typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
      ? item.createdAt
      : Date.now();
  return {
    id:
      typeof item.id === 'string' && item.id.trim()
        ? item.id.trim()
        : `note-${createdAt}-${index}`,
    text: String(item.text ?? '').trim(),
    source: typeof item.source === 'string' ? item.source : 'manual',
    createdAt,
  };
}

function formatNotesAsMarkdown(items) {
  const normalized = (Array.isArray(items) ? items : [])
    .map((item, idx) => normalizeNoteItem(item, idx))
    .filter((item) => item.text.length > 0);
  if (normalized.length === 0) {
    return '# Workspace Notes\n\n_No notes recorded._\n';
  }
  const blocks = normalized.map((item, idx) => {
    const iso = new Date(item.createdAt).toISOString();
    return `## Note ${idx + 1} (${iso})\n\n${item.text}`;
  });
  return `# Workspace Notes\n\n${blocks.join('\n\n---\n\n')}\n`;
}

function createWorkspaceNotesPanel(notesService) {
  return function WorkspaceNotesPanel() {
    const [notes, setNotes] = useState([]);
    const [draft, setDraft] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [exportedMarkdown, setExportedMarkdown] = useState('');

    useEffect(() => {
      let active = true;
      void notesService.listNotes().then((initial) => {
        if (active && Array.isArray(initial)) {
          setNotes(initial);
        }
      });
      const unsubscribe = notesService.subscribe((nextNotes) => {
        if (active) {
          setNotes(Array.isArray(nextNotes) ? [...nextNotes] : []);
        }
      });
      return () => {
        active = false;
        unsubscribe();
      };
    }, []);

    const filteredNotes = useMemo(() => {
      const needle = searchQuery.trim().toLowerCase();
      if (!needle) return notes;
      return notes.filter((item) =>
        String(item.text ?? '')
          .toLowerCase()
          .includes(needle)
      );
    }, [notes, searchQuery]);

    const handleAddNote = async () => {
      const text = draft.trim();
      if (!text) return;
      setDraft('');
      await notesService.addNote(text, { source: 'panel' });
    };

    const handleDeleteNote = async (noteIdOrIndex) => {
      await notesService.deleteNote(noteIdOrIndex);
    };

    const handleExportMarkdown = async () => {
      const md = await notesService.exportMarkdown();
      setExportedMarkdown(md);
    };

    return createElement(
      'div',
      {
        className: 'vibex-notes-panel h-full w-full p-3 flex flex-col gap-3',
        'data-panel': 'notes',
        'data-testid': 'vibex-notes-panel',
      },
      createElement(
        'div',
        { className: 'flex items-center justify-between gap-2' },
        createElement(
          'span',
          { className: 'text-sm font-medium' },
          `Workspace Notes (${notes.length})`
        ),
        createElement(
          'button',
          {
            type: 'button',
            'data-testid': 'notes-export-btn',
            onClick: () => void handleExportMarkdown(),
          },
          'Export Markdown'
        )
      ),
      createElement('input', {
        type: 'search',
        placeholder: 'Search workspace notes...',
        'data-testid': 'notes-search-input',
        value: searchQuery,
        onChange: (event) => setSearchQuery(event.target.value),
      }),
      createElement(
        'div',
        { className: 'flex gap-2' },
        createElement('textarea', {
          placeholder: 'Write a quick workspace note...',
          'data-testid': 'notes-new-input',
          value: draft,
          onChange: (event) => setDraft(event.target.value),
        }),
        createElement(
          'button',
          {
            type: 'button',
            'data-testid': 'notes-add-btn',
            onClick: () => void handleAddNote(),
          },
          'Add Note'
        )
      ),
      createElement(
        'ul',
        {
          className: 'flex-1 overflow-auto flex flex-col gap-2',
          'data-testid': 'notes-list',
        },
        filteredNotes.map((note, idx) =>
          createElement(
            'li',
            {
              key: note.id || `note-row-${idx}`,
              'data-testid': 'notes-item',
              className: 'flex items-start justify-between gap-2',
            },
            createElement('span', null, note.text),
            createElement(
              'button',
              {
                type: 'button',
                'data-testid': `notes-delete-${note.id || idx}`,
                onClick: () => void handleDeleteNote(note.id ?? idx),
              },
              'Delete'
            )
          )
        )
      ),
      exportedMarkdown
        ? createElement(
            'pre',
            { 'data-testid': 'notes-markdown-preview' },
            exportedMarkdown
          )
        : null
    );
  };
}

export default {
  apiVersion: '2.0',
  id: 'vibex.notes',
  activate(ctx) {
    const listeners = new Set();
    let cachedNotes = null;

    ctx.effect(() => () => {
      listeners.clear();
      cachedNotes = null;
    });

    function notifyListeners(items) {
      for (const listener of listeners) {
        try {
          listener(items);
        } catch {
          // Isolate listener errors.
        }
      }
      ctx.events.emit('notes:changed', { count: items.length, items });
    }

    async function readNotes() {
      try {
        const stored = await ctx.storage.kv.get('items');
        if (Array.isArray(stored)) {
          cachedNotes = stored.map((item, idx) => normalizeNoteItem(item, idx));
          return cachedNotes;
        }
      } catch {
        // Fallback to in-memory cache if KV transport is not available.
      }
      return Array.isArray(cachedNotes) ? cachedNotes : [];
    }

    async function writeNotes(nextItems) {
      const normalized = (Array.isArray(nextItems) ? nextItems : []).map(
        (item, idx) => normalizeNoteItem(item, idx)
      );
      cachedNotes = normalized;
      try {
        await ctx.storage.kv.set('items', normalized);
      } catch {
        // Keep in-memory cache in sync even if KV write fails.
      }
      notifyListeners(normalized);
      return normalized;
    }

    const notesService = {
      async listNotes() {
        return await readNotes();
      },
      async addNote(text, meta = {}) {
        const trimmed = String(text ?? '').trim();
        if (!trimmed) {
          return await readNotes();
        }
        const existing = await readNotes();
        const createdAt = Date.now();
        const newNote = {
          id:
            typeof meta?.id === 'string' && meta.id.trim()
              ? meta.id.trim()
              : `note-${createdAt}-${existing.length + 1}`,
          text: trimmed,
          source: typeof meta?.source === 'string' ? meta.source : 'manual',
          createdAt,
        };
        return await writeNotes([...existing, newNote]);
      },
      async searchNotes(query) {
        const all = await readNotes();
        const needle = String(query ?? '')
          .trim()
          .toLowerCase();
        if (!needle) return all;
        return all.filter((item) =>
          String(item.text ?? '')
            .toLowerCase()
            .includes(needle)
        );
      },
      async deleteNote(idOrIndex) {
        const existing = await readNotes();
        const next = existing.filter((item, idx) => {
          if (typeof idOrIndex === 'number') {
            return idx !== idOrIndex;
          }
          return item.id !== idOrIndex && item.text !== idOrIndex;
        });
        return await writeNotes(next);
      },
      async clearNotes() {
        return await writeNotes([]);
      },
      async exportMarkdown() {
        const existing = await readNotes();
        const markdown = formatNotesAsMarkdown(existing);
        try {
          await ctx.storage.kv.set('lastExportedMarkdown', markdown);
        } catch {
          // Ignore KV write failure.
        }
        ctx.events.emit('notes:exported', {
          markdown,
          count: existing.length,
        });
        return markdown;
      },
      subscribe(listener) {
        if (typeof listener !== 'function') {
          return () => undefined;
        }
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };

    const WorkspaceNotesPanel = createWorkspaceNotesPanel(notesService);

    ctx.ui.registerPanel({
      id: 'notes',
      title: 'Workspace Notes',
      icon: 'sticky-note',
      zone: 'session',
      component: WorkspaceNotesPanel,
    });

    ctx.ui.registerView({
      id: 'notes-view',
      title: 'Workspace Notes',
      slot: 'plugin.detail.panel',
      component: WorkspaceNotesPanel,
    });

    ctx.ui.registerSlashCommand({
      name: 'note',
      description:
        'Save a quick note or architectural memo to the workspace scratchpad',
      prompt: 'Record the following key takeaway into the workspace notes:',
      execute: async (args) => {
        const text = String(args ?? '').trim();
        if (text) {
          await notesService.addNote(text, { source: 'slash-command' });
        }
        return 'Record the following key takeaway into the workspace notes:';
      },
    });

    ctx.ui.registerContextMenu({
      id: 'vibex.notes.capture-selection',
      label: 'Save Selection to Notes',
      group: 'notes',
      when: (menuCtx) => Boolean(menuCtx.selectionText?.trim()),
      action: async (menuCtx) => {
        const text = menuCtx.selectionText?.trim();
        if (!text) return;
        await notesService.addNote(text, { source: 'selection' });
      },
    });

    ctx.ui.registerCommand({
      id: 'open-notes',
      title: 'Open Workspace Notes',
      category: 'Notes',
      icon: 'sticky-note',
      handler: () => {
        ctx.events.emit('notes:open-panel', { panelId: 'notes' });
      },
    });

    ctx.ui.registerCommand({
      id: 'vibex.notes.new',
      title: 'Create Quick Note',
      category: 'Notes',
      icon: 'plus',
      handler: async () => {
        const draft =
          (await ctx.storage.kv.get('quickNoteDraft')) || 'Quick workspace note';
        return await notesService.addNote(String(draft), {
          source: 'command',
        });
      },
    });

    ctx.ui.registerCommand({
      id: 'vibex.notes.export-markdown',
      title: 'Export Workspace Notes as Markdown',
      category: 'Notes',
      icon: 'download',
      handler: async () => {
        return await notesService.exportMarkdown();
      },
    });

    ctx.services.provide('vibex.notes', notesService);
  },
};
