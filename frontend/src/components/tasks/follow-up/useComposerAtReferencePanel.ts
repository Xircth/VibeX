import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';
import type {
  ChatComposerInputHandle,
  ChatComposerToken,
} from '@astryxdesign/core/Chat';
import { fileTreeApi, repoApi, tagsApi } from '@/lib/api';
import { attemptsApi } from '@/lib/api/attempts';
import { searchTagsAndFiles } from '@/lib/searchTagsAndFiles';
import {
  callApplicationCommand,
  type BackendTransport,
} from '@/lib/backendTransport';
import { createConversationApi } from '@/features/conversation/conversationApi';
import type { DbConversationSummary, GitLogEntry, Tag } from 'shared/types';
import {
  AT_REFERENCE_TAB_ORDER,
  buildAtReferenceGroups,
  firstNonEmptyTab,
  matchAtReferenceTrigger,
  type AtReferenceGroup,
  type AtReferenceItem,
  type AtReferenceTab,
} from './composerAtReferences';

export type ComposerAtReferenceContext = {
  sessionId?: string;
  workspaceId?: string;
  repoId?: string;
  repoIds?: string[];
  projectId?: string;
  transport?: BackendTransport;
};

type PanelState = {
  query: string;
  groups: AtReferenceGroup[];
  activeTab: AtReferenceTab;
  selectedIndex: number;
  loading: boolean;
  pinnedTab: AtReferenceTab | null;
  left: number;
  top: number;
  width: number;
};

const EMPTY_GROUPS: AtReferenceGroup[] = AT_REFERENCE_TAB_ORDER.map((tab) => ({
  tab,
  items: [],
  truncated: false,
}));

function atReferenceItemToToken(item: AtReferenceItem): ChatComposerToken {
  const variant =
    item.tab === 'instruction'
      ? 'orange'
      : item.tab === 'commit'
        ? 'neutral'
        : 'cyan';
  return {
    value: item.insertText,
    label: item.label,
    variant,
  };
}

function getEditor(root: HTMLElement | null): HTMLDivElement | null {
  return (
    root?.querySelector<HTMLDivElement>(
      '[contenteditable="true"], [contenteditable="false"][role="combobox"]'
    ) ?? null
  );
}

function getTextBeforeCursor(editable: HTMLElement): string | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!editable.contains(range.startContainer)) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  return (node.textContent ?? '').slice(0, range.startOffset);
}

function deleteTriggerText(
  _editable: HTMLElement,
  triggerStart: number
): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return false;
  const text = node.textContent ?? '';
  node.textContent =
    text.slice(0, triggerStart) + text.slice(range.startOffset);
  const next = document.createRange();
  next.setStart(node, triggerStart);
  next.collapse(true);
  selection.removeAllRanges();
  selection.addRange(next);
  return true;
}

async function loadInstructions(query: string): Promise<Tag[]> {
  const results = await searchTagsAndFiles(query, {
    includeTags: true,
    includeFiles: false,
  });
  return results.flatMap((item) => (item.tag ? [item.tag] : []));
}

async function loadFiles(
  query: string,
  context: ComposerAtReferenceContext
): Promise<Array<{ path: string; name: string }>> {
  const repoIds = (context.repoIds ?? []).filter(Boolean);
  const repoId = repoIds[0] ?? context.repoId;
  const trimmed = query.trim();
  if (trimmed === '') {
    if (!repoId) return [];
    const repo = await repoApi.getById(repoId);
    if (!repo) return [];
    const entries = await fileTreeApi.listDirectoryChildren(repo.path, '');
    return [
      ...entries.files.map((path) => ({
        path,
        name: path.split(/[\\/]/).pop() || path,
      })),
      ...entries.directories.map((path) => ({
        path,
        name: path.split(/[\\/]/).pop() || path,
      })),
    ];
  }
  const results = await searchTagsAndFiles(trimmed, {
    repoIds: repoIds.length > 0 ? repoIds : repoId ? [repoId] : undefined,
    projectId: context.projectId,
    includeTags: false,
    includeFiles: true,
  });
  return results.flatMap((item) =>
    item.file ? [{ path: item.file.path, name: item.file.name }] : []
  );
}

async function loadConversations(
  transport: BackendTransport,
  context: ComposerAtReferenceContext
): Promise<DbConversationSummary[]> {
  const conversations = new Map<string, DbConversationSummary>();
  const add = (rows: unknown) => {
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (row && typeof row === 'object' && typeof row.id === 'string') {
        conversations.set(row.id, row as DbConversationSummary);
      }
    }
  };
  try {
    add(
      await callApplicationCommand(transport, 'conversation_list_recent', {
        sinceDays: 30,
        limit: 50,
        projectId: context.projectId ?? null,
      })
    );
  } catch {
    // Fall through to workspace list.
  }
  if (context.workspaceId) {
    try {
      add(await createConversationApi(transport).list(context.workspaceId));
    } catch {
      // Keep whatever recent listing succeeded.
    }
  }
  return Array.from(conversations.values());
}

async function loadCommits(
  context: ComposerAtReferenceContext
): Promise<GitLogEntry[]> {
  const repoId = context.repoIds?.find(Boolean) ?? context.repoId;
  if (!repoId) return [];
  try {
    const status = context.workspaceId
      ? await attemptsApi.getGitLog(context.workspaceId, repoId)
      : await repoApi.getGitLog(repoId);
    return status.entries;
  } catch {
    return [];
  }
}

export function useComposerAtReferencePanel({
  composerRootRef,
  composerHandleRef,
  context,
  disabled,
  onChange,
}: {
  composerRootRef: RefObject<HTMLDivElement | null>;
  composerHandleRef: RefObject<ChatComposerInputHandle | null>;
  context?: ComposerAtReferenceContext;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [panel, setPanel] = useState<PanelState | null>(null);
  const triggerStartRef = useRef(-1);
  const requestRef = useRef(0);
  const pinnedTabRef = useRef<AtReferenceTab | null>(null);
  const panelRef = useRef<PanelState | null>(null);
  panelRef.current = panel;

  const close = useCallback(() => {
    pinnedTabRef.current = null;
    triggerStartRef.current = -1;
    setPanel(null);
  }, []);

  const search = useCallback(
    async (query: string) => {
      const requestId = ++requestRef.current;
      const ctx = context ?? {};
      const transport = ctx.transport;
      const [files, conversations, commits, instructions] = await Promise.all([
        loadFiles(query, ctx).catch(() => []),
        transport
          ? loadConversations(transport, ctx).catch(() => [])
          : Promise.resolve([]),
        loadCommits(ctx).catch(() => []),
        loadInstructions(query).catch(async () => {
          try {
            return await tagsApi.list();
          } catch {
            return [];
          }
        }),
      ]);
      if (requestId !== requestRef.current) return;
      const groups = buildAtReferenceGroups(query, {
        files,
        conversations,
        commits,
        repoId: ctx.repoIds?.find(Boolean) ?? ctx.repoId ?? null,
        instructions,
        currentConversationId: ctx.sessionId,
      });
      setPanel((current) => {
        if (!current) return current;
        const activeTab = firstNonEmptyTab(groups, pinnedTabRef.current);
        return {
          ...current,
          query,
          groups,
          activeTab,
          selectedIndex: 0,
          loading: false,
        };
      });
    },
    [context]
  );

  const openOrUpdate = useCallback(
    (query: string, triggerStart: number, editable: HTMLElement) => {
      const rect = editable.getBoundingClientRect();
      const width =
        composerRootRef.current?.getBoundingClientRect().width ?? rect.width;
      triggerStartRef.current = triggerStart;
      setPanel((current) => ({
        query,
        groups: current?.groups ?? EMPTY_GROUPS,
        activeTab: current?.activeTab ?? 'file',
        selectedIndex: current?.query === query ? current.selectedIndex : 0,
        loading: true,
        pinnedTab: pinnedTabRef.current,
        left:
          composerRootRef.current?.getBoundingClientRect().left ?? rect.left,
        top: rect.top,
        width,
      }));
      void search(query);
    },
    [composerRootRef, search]
  );

  const detect = useCallback(() => {
    if (disabled) {
      close();
      return;
    }
    const editor = getEditor(composerRootRef.current);
    if (!editor) {
      close();
      return;
    }
    const text = getTextBeforeCursor(editor);
    if (text == null) {
      close();
      return;
    }
    const match = matchAtReferenceTrigger(text);
    if (!match) {
      close();
      return;
    }
    openOrUpdate(match.matchingString, match.leadOffset, editor);
  }, [close, composerRootRef, disabled, openOrUpdate]);

  useEffect(() => {
    const root = composerRootRef.current;
    const editor = getEditor(root);
    if (!editor) return undefined;
    const onInput = () => detect();
    editor.addEventListener('input', onInput);
    editor.addEventListener('keyup', onInput);
    editor.addEventListener('click', onInput);
    return () => {
      editor.removeEventListener('input', onInput);
      editor.removeEventListener('keyup', onInput);
      editor.removeEventListener('click', onInput);
    };
  }, [detect, composerRootRef]);

  const selectItem = useCallback(
    (item: AtReferenceItem) => {
      const editor = getEditor(composerRootRef.current);
      const handle = composerHandleRef.current;
      if (!editor || !handle) return;
      deleteTriggerText(editor, triggerStartRef.current);
      handle.insertToken(atReferenceItemToToken(item));
      onChange(handle.getValue());
      close();
    },
    [close, composerHandleRef, composerRootRef, onChange]
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): boolean => {
      const current = panelRef.current;
      if (!current) return false;
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
        return false;
      }
      const activeItems =
        current.groups.find((group) => group.tab === current.activeTab)
          ?.items ?? [];
      switch (event.key) {
        case 'ArrowDown': {
          event.preventDefault();
          if (activeItems.length === 0) return true;
          setPanel((panel) =>
            panel
              ? {
                  ...panel,
                  selectedIndex: (panel.selectedIndex + 1) % activeItems.length,
                }
              : panel
          );
          return true;
        }
        case 'ArrowUp': {
          event.preventDefault();
          if (activeItems.length === 0) return true;
          setPanel((panel) =>
            panel
              ? {
                  ...panel,
                  selectedIndex:
                    (panel.selectedIndex - 1 + activeItems.length) %
                    activeItems.length,
                }
              : panel
          );
          return true;
        }
        case 'Tab': {
          event.preventDefault();
          const dir = event.shiftKey ? -1 : 1;
          const at = AT_REFERENCE_TAB_ORDER.indexOf(current.activeTab);
          const next =
            AT_REFERENCE_TAB_ORDER[
              (at + dir + AT_REFERENCE_TAB_ORDER.length) %
                AT_REFERENCE_TAB_ORDER.length
            ];
          pinnedTabRef.current = next;
          setPanel((panel) =>
            panel ? { ...panel, activeTab: next, selectedIndex: 0 } : panel
          );
          return true;
        }
        case 'Enter': {
          const chosen = activeItems[current.selectedIndex];
          if (!chosen) return false;
          event.preventDefault();
          selectItem(chosen);
          return true;
        }
        case 'Escape': {
          event.preventDefault();
          close();
          return true;
        }
        default:
          return false;
      }
    },
    [close, selectItem]
  );

  const selectTab = useCallback((tab: AtReferenceTab) => {
    pinnedTabRef.current = tab;
    setPanel((current) =>
      current ? { ...current, activeTab: tab, selectedIndex: 0 } : current
    );
  }, []);

  const highlight = useCallback((index: number) => {
    setPanel((current) =>
      current ? { ...current, selectedIndex: index } : current
    );
  }, []);

  return {
    panel,
    handleKeyDown,
    detect,
    selectItem,
    selectTab,
    highlight,
    isOpen: panel != null,
  };
}
