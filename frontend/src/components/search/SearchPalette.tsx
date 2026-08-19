import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  Search as SearchIcon,
  File,
  KanbanSquare,
  MessagesSquare,
} from 'lucide-react';
import { useSearchStore } from '@/stores/useSearchStore';
import { useProject } from '@/contexts/ProjectContext';
import { projectsApi } from '@/lib/api';
import { conversationApi } from '@/features/conversation/conversationApi';
import type {
  SearchResult as FileSearchResult,
  ConversationSearchHit,
} from 'shared/types';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { createPluginControlApi } from '@/lib/api/plugins';
import { useBackendTransport } from '@/lib/transport';
import { Command } from 'lucide-react';

type PaletteResultKind = 'file' | 'directory' | 'conversation' | 'command';

interface PaletteResult {
  id: string;
  kind: PaletteResultKind;
  title: string;
  subtitle?: string;
  filePath?: string;
  conversationId?: string;
  workspaceId?: string;
  pluginId?: string;
  handler?: string;
}

export function SearchPalette() {
  const {
    isSearchPaletteOpen,
    paletteQuery,
    paletteSelectedIndex,
    closeSearchPalette,
    setPaletteQuery,
    movePaletteSelection,
  } = useSearchStore();

  const { t } = useTranslation(['panels', 'common']);
  const { openFilePreview } = usePanelActionsContext();
  const pluginCommands = usePluginHostContributions('command');
  const transport = useBackendTransport();
  const pluginApi = useMemo(() => createPluginControlApi(transport), [transport]);
  const { projectId } = useProject();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [fileResults, setFileResults] = useState<FileSearchResult[]>([]);
  const [conversationResults, setConversationResults] = useState<
    ConversationSearchHit[]
  >([]);

  // Focus input when opened
  useEffect(() => {
    if (isSearchPaletteOpen) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isSearchPaletteOpen]);

  // Search files when query changes
  useEffect(() => {
    if (!isSearchPaletteOpen || !projectId) {
      setFileResults([]);
      return;
    }

    const trimmed = paletteQuery.trim();
    if (!trimmed) {
      setFileResults([]);
      return;
    }

    let cancelled = false;

    projectsApi
      .searchFiles(projectId, trimmed)
      .then((results: FileSearchResult[]) => {
        if (!cancelled) {
          setFileResults(results);
        }
      })
      .catch(() => {
        if (!cancelled) setFileResults([]);
      });

    return () => {
      cancelled = true;
    };
  }, [paletteQuery, isSearchPaletteOpen, projectId]);

  // Full-text search across conversations (P1-2). Debounced so we don't fire on
  // every keystroke; needs at least 3 chars (trigram index minimum).
  useEffect(() => {
    if (!isSearchPaletteOpen) {
      setConversationResults([]);
      return;
    }
    const trimmed = paletteQuery.trim();
    if (trimmed.length < 3) {
      setConversationResults([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      conversationApi
        .search(trimmed, null, 20)
        .then((hits) => {
          if (!cancelled) setConversationResults(hits);
        })
        .catch(() => {
          if (!cancelled) setConversationResults([]);
        });
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [paletteQuery, isSearchPaletteOpen]);

  const results: PaletteResult[] = useMemo(() => {
    const files: PaletteResult[] = fileResults.map((r) => ({
      id: `file:${r.path}`,
      kind: r.is_file ? ('file' as const) : ('directory' as const),
      title: r.path.split(/[/\\]/).pop() || r.path,
      subtitle: r.path,
      filePath: r.path,
    }));
    const conversations: PaletteResult[] = conversationResults.map((hit) => ({
      id: `conv:${hit.conversation_id}`,
      kind: 'conversation' as const,
      title: hit.title || t('searchPalette.untitledConversation'),
      subtitle: hit.snippet,
      conversationId: hit.conversation_id,
      workspaceId: hit.workspace_id,
    }));
    const needle = paletteQuery.trim().toLocaleLowerCase();
    const commands: PaletteResult[] = pluginCommands
      .filter((item) => {
        if (!needle) return true;
        return (
          item.label.toLocaleLowerCase().includes(needle) ||
          item.id.toLocaleLowerCase().includes(needle)
        );
      })
      .map((item) => {
        const metadata = contributionMetadata(item);
        return {
          id: `cmd:${item.pluginId}:${item.id}`,
          kind: 'command' as const,
          title: String(metadata.title ?? item.label),
          subtitle: typeof metadata.subtitle === 'string' ? metadata.subtitle : item.pluginId,
          pluginId: item.pluginId,
          handler: typeof metadata.handler === 'string' ? metadata.handler : item.id,
        };
      });
    return [...commands, ...conversations, ...files];
  }, [fileResults, conversationResults, pluginCommands, paletteQuery, t]);

  const handleSelect = useCallback(
    (result: PaletteResult) => {
      if (result.kind === 'command' && result.pluginId && result.handler) {
        void pluginApi.invokeContribution(result.pluginId, result.handler);
      } else if (result.kind === 'file' && result.filePath) {
        openFilePreview(result.filePath);
      } else if (
        result.kind === 'conversation' &&
        result.conversationId &&
        result.workspaceId &&
        projectId
      ) {
        navigate(
          `/local-projects/${projectId}/workspaces/${result.workspaceId}/sessions/${result.conversationId}`
        );
      }
      closeSearchPalette();
    },
    [openFilePreview, closeSearchPalette, navigate, projectId, pluginApi]
  );

  // Keyboard navigation
  useEffect(() => {
    if (!isSearchPaletteOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSearchPalette();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        movePaletteSelection('down', results.length - 1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        movePaletteSelection('up', results.length - 1);
        return;
      }
      if (e.key === 'Enter') {
        if (
          results.length > 0 &&
          paletteSelectedIndex >= 0 &&
          paletteSelectedIndex < results.length
        ) {
          e.preventDefault();
          handleSelect(results[paletteSelectedIndex]);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    isSearchPaletteOpen,
    closeSearchPalette,
    movePaletteSelection,
    handleSelect,
    results,
    paletteSelectedIndex,
  ]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const activeEl = listRef.current.querySelector('[data-active="true"]');
    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [paletteSelectedIndex]);

  if (!isSearchPaletteOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      onClick={closeSearchPalette}
      role="presentation"
    >
      {/* Backdrop */}
      <div className="dialog-backdrop absolute inset-0" />

      {/* Palette */}
      <div
        className="tahoe-popover modal-surface relative mx-4 w-full max-w-[600px] overflow-hidden rounded-lg"
        role="dialog"
        aria-modal="true"
        aria-label={t('searchPalette.dialogLabel')}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input row */}
        <div className="flex items-center gap-2 border-b border-[var(--border-content)] px-3 py-2.5">
          <SearchIcon className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            placeholder={t('searchPalette.placeholder')}
            value={paletteQuery}
            onChange={(e) => setPaletteQuery(e.target.value)}
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[min(50vh,400px)] overflow-y-auto">
          {results.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {paletteQuery.trim()
                ? t('searchPalette.noResults')
                : t('searchPalette.emptyHint')}
            </div>
          ) : (
            results.map((result, index) => (
              <button
                key={result.id}
                type="button"
                data-active={index === paletteSelectedIndex}
                className={`workspace-command-row flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                  index === paletteSelectedIndex ? 'is-active' : ''
                }`}
                onClick={() => handleSelect(result)}
              >
                {result.kind === 'file' ? (
                  <File className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : result.kind === 'conversation' ? (
                  <MessagesSquare className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : result.kind === 'command' ? (
                  <Command className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <KanbanSquare className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
                <span className="flex-1 min-w-0">
                  <span className="block text-sm truncate">{result.title}</span>
                  {result.subtitle && (
                    <span className="block text-xs text-muted-foreground truncate">
                      {result.subtitle}
                    </span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-4 border-t border-[var(--border-content)] px-3 py-1.5 text-[10px] text-muted-foreground">
          <span>
            <kbd className="workspace-command-kbd px-1 py-0.5 text-[10px]">
              ↑↓
            </kbd>{' '}
            {t('searchPalette.navigate')}
          </span>
          <span>
            <kbd className="workspace-command-kbd px-1 py-0.5 text-[10px]">
              Enter
            </kbd>{' '}
            {t('searchPalette.open')}
          </span>
          <span>
            <kbd className="workspace-command-kbd px-1 py-0.5 text-[10px]">
              Esc
            </kbd>{' '}
            {t('common:close')}
          </span>
        </div>
      </div>
    </div>
  );
}
