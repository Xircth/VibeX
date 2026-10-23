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
  commandRegistry,
  type CommandContribution,
  type Disposer,
  useCommands,
  type VibeXPluginContext,
} from '@vibex/plugin-sdk';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { createPluginControlApi } from '@/lib/api/plugins';
import { useBackendTransport } from '@/lib/transport';
import { useAppContextMenu } from '@/components/context-menu';
import { writeClipboardViaBridge } from '@/vscode/bridge';
import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import { Command, type LucideIcon } from 'lucide-react';
import { NativeSurfaceOcclusionHold } from '@/contexts/WorkspaceOverlayContext';

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
  onExecute?: () => void | Promise<void>;
  icon?: LucideIcon;
}

function dispatchHostEvent(name: string, detail?: Record<string, unknown>) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(name, detail ? { detail } : undefined)
    );
  }
}

export const BUILTIN_PALETTE_COMMANDS: readonly CommandContribution[] = [
  {
    id: 'builtin.open-settings',
    pluginId: 'vibex.core.settings',
    title: 'Open Settings',
    category: 'Settings',
    icon: 'settings',
    order: 100,
    handler: () => {
      dispatchHostEvent('vibex:open-settings');
    },
  },
  {
    id: 'builtin.manage-plugins',
    pluginId: 'vibex.core.plugin-manager',
    title: 'Manage Plugins',
    category: 'Plugins',
    icon: 'puzzle',
    order: 110,
    handler: () => {
      dispatchHostEvent('vibex:open-settings', { section: 'plugins' });
    },
  },
  {
    id: 'builtin.hmr.reset-boundaries',
    pluginId: 'vibex.core.hmr',
    title: 'Reset Plugin Crash Boundaries',
    category: 'System',
    icon: 'refresh-cw',
    order: 120,
    handler: () => {
      dispatchHostEvent('vibex:hmr-reset-boundaries');
    },
  },
  {
    id: 'builtin.credentials.probe-usage',
    pluginId: 'vibex.core.credentials',
    title: 'Probe Agent Subscription Usage',
    category: 'Account',
    icon: 'activity',
    order: 130,
    handler: () => {
      dispatchHostEvent('vibex:probe-usage');
    },
  },
  {
    id: 'builtin.agent.configure',
    pluginId: 'vibex.core.agent-runtime',
    title: 'Configure Coding Agents',
    category: 'Agent',
    icon: 'bot',
    order: 140,
    handler: () => {
      dispatchHostEvent('vibex:open-settings', { section: 'agents' });
    },
  },
  {
    id: 'builtin.session.focus-list',
    pluginId: 'vibex.core.session',
    title: 'Focus Session List',
    category: 'Session',
    icon: 'list',
    order: 150,
    handler: () => {
      dispatchHostEvent('vibex:focus-panel', { panelId: 'session-list' });
    },
  },
  {
    id: 'builtin.models.browse-catalog',
    pluginId: 'vibex.core.llm-providers',
    title: 'Browse LLM Model Catalog',
    category: 'Models',
    icon: 'cpu',
    order: 160,
    handler: () => {
      dispatchHostEvent('vibex:open-settings', { section: 'models' });
    },
  },
  {
    id: 'builtin.skills.manage',
    pluginId: 'vibex.core.skills',
    title: 'Manage Agent Skills',
    category: 'Skills',
    icon: 'book-open',
    order: 170,
    handler: () => {
      dispatchHostEvent('vibex:open-settings', { section: 'skills' });
    },
  },
  {
    id: 'builtin.mcp.manage',
    pluginId: 'vibex.core.mcp',
    title: 'Manage MCP Servers',
    category: 'MCP',
    icon: 'plug-zap',
    order: 180,
    handler: () => {
      dispatchHostEvent('vibex:open-settings', { section: 'mcp' });
    },
  },
  {
    id: 'builtin.delegation.subagents',
    pluginId: 'vibex.core.delegation',
    title: 'Manage Subagent Delegation',
    category: 'Agent',
    icon: 'users',
    order: 190,
    handler: () => {
      dispatchHostEvent('vibex:open-settings', { section: 'subagents' });
    },
  },
  {
    id: 'builtin.compaction.compact',
    pluginId: 'vibex.core.compaction',
    title: 'Compact Session Context',
    category: 'Session',
    icon: 'minimize-2',
    order: 200,
    handler: () => {
      dispatchHostEvent('vibex:compact-session');
    },
  },
  {
    id: 'builtin.approval.policies',
    pluginId: 'vibex.core.approval',
    title: 'Configure Tool Approval Gate',
    category: 'Approval',
    icon: 'shield-check',
    order: 210,
    handler: () => {
      dispatchHostEvent('vibex:open-settings', { section: 'approval' });
    },
  },
  {
    id: 'builtin.shell.new-terminal',
    pluginId: 'vibex.core.shell',
    title: 'New Terminal',
    category: 'Terminal',
    icon: 'terminal',
    order: 220,
    handler: () => {
      dispatchHostEvent('vibex:new-terminal');
    },
  },
  {
    id: 'builtin.git.status',
    pluginId: 'vibex.core.workspace-git',
    title: 'Open Git Changes & Worktrees',
    category: 'Git',
    icon: 'git-branch',
    order: 230,
    handler: () => {
      dispatchHostEvent('vibex:focus-panel', { panelId: 'git' });
    },
  },
  {
    id: 'builtin.filesystem.explorer',
    pluginId: 'vibex.core.filesystem',
    title: 'Focus File Explorer',
    category: 'Files',
    icon: 'folder-tree',
    order: 240,
    handler: () => {
      dispatchHostEvent('vibex:focus-panel', { panelId: 'file-tree' });
    },
  },
  {
    id: 'builtin.automation.schedules',
    pluginId: 'vibex.core.automation',
    title: 'Manage Scheduled Automations',
    category: 'Automation',
    icon: 'clock',
    order: 250,
    handler: () => {
      dispatchHostEvent('vibex:open-settings', { section: 'automations' });
    },
  },
  {
    id: 'builtin.channels.gateway',
    pluginId: 'vibex.core.channels',
    title: 'Configure Chat Channels Gateway',
    category: 'Channels',
    icon: 'send',
    order: 260,
    handler: () => {
      dispatchHostEvent('vibex:open-settings', { section: 'chat-channels' });
    },
  },
  {
    id: 'builtin.layout.reset-workbench',
    pluginId: 'vibex.webui.layout',
    title: 'Focus Workbench Welcome',
    category: 'View',
    icon: 'house',
    order: 270,
    handler: () => {
      dispatchHostEvent('vibex:focus-panel', { panelId: 'welcome' });
    },
  },
  {
    id: 'builtin.conversation.new-chat',
    pluginId: 'vibex.webui.conversation',
    title: 'Focus AI Conversation',
    category: 'Conversation',
    icon: 'message-square',
    order: 280,
    handler: () => {
      dispatchHostEvent('vibex:focus-panel', { panelId: 'ai-chat' });
    },
  },
  {
    id: 'builtin.kanban.open-board',
    pluginId: 'vibex.webui.kanban',
    title: 'Open Kanban Board',
    category: 'View',
    icon: 'columns-3',
    order: 290,
    handler: () => {
      dispatchHostEvent('vibex:focus-panel', { panelId: 'kanban' });
    },
  },
  {
    id: 'builtin.commands.shortcuts',
    pluginId: 'vibex.webui.commands',
    title: 'Configure Keyboard Shortcuts',
    category: 'Shortcuts',
    icon: 'keyboard',
    order: 300,
    handler: () => {
      dispatchHostEvent('vibex:open-settings', { section: 'shortcuts' });
    },
  },
  {
    id: 'builtin.theme.switch',
    pluginId: 'vibex.webui.theme',
    title: 'Switch Appearance Theme',
    category: 'Appearance',
    icon: 'sun',
    order: 310,
    handler: () => {
      dispatchHostEvent('vibex:toggle-theme');
    },
  },
];

export interface RegisterBuiltinCommandsOptions {
  readonly ctx?: VibeXPluginContext;
  readonly commandIds?: readonly string[];
  readonly pluginId?: string;
}

export function registerBuiltinCommands(
  options?: RegisterBuiltinCommandsOptions
): Disposer {
  const allowedIds = options?.commandIds ? new Set(options.commandIds) : null;
  const filterPluginId = options?.ctx?.pluginId ?? options?.pluginId;
  const targetCommands = allowedIds
    ? BUILTIN_PALETTE_COMMANDS.filter((c) => allowedIds.has(c.id))
    : filterPluginId
      ? BUILTIN_PALETTE_COMMANDS.filter((c) => c.pluginId === filterPluginId)
      : BUILTIN_PALETTE_COMMANDS;

  const disposers: Disposer[] = [];
  for (const command of targetCommands) {
    const ownerPluginId = filterPluginId ?? command.pluginId ?? 'builtin';
    if (options?.ctx) {
      disposers.push(
        options.ctx.ui.registerCommand({
          id: command.id,
          title: command.title,
          category: command.category,
          icon: command.icon,
          shortcut: command.shortcut,
          order: command.order,
          handler: command.handler,
        })
      );
    } else {
      disposers.push(
        commandRegistry.register(
          { ...command, pluginId: ownerPluginId },
          ownerPluginId
        )
      );
    }
  }

  const cleanup: Disposer = () => {
    for (let i = disposers.length - 1; i >= 0; i -= 1) {
      disposers[i]?.();
    }
  };

  if (options?.ctx) {
    options.ctx.effect(() => cleanup);
  }

  return cleanup;
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
  const { openSurfaceMenu } = useAppContextMenu();
  const { openFilePreview } = usePanelActionsContext();
  const pluginCommands = usePluginHostContributions('command');
  const sdkCommands = useCommands();
  const transport = useBackendTransport();
  const pluginApi = useMemo(
    () => createPluginControlApi(transport),
    [transport]
  );
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
    const seenCommandIds = new Set<string>();
    const sdkCommandResults: PaletteResult[] = sdkCommands
      .filter((cmd) => {
        if (!needle) return true;
        return (
          cmd.title.toLocaleLowerCase().includes(needle) ||
          cmd.id.toLocaleLowerCase().includes(needle) ||
          (cmd.category?.toLocaleLowerCase().includes(needle) ?? false)
        );
      })
      .map((cmd) => {
        const pluginId = cmd.pluginId ?? 'builtin';
        const key = `cmd:${pluginId}:${cmd.id}`;
        seenCommandIds.add(key);
        return {
          id: key,
          kind: 'command' as const,
          title: cmd.title,
          subtitle: cmd.category ?? cmd.pluginId,
          pluginId,
          onExecute: () => cmd.handler(),
          icon: contributionIconComponent(cmd.icon, Command),
        };
      });
    const catalogCommands: PaletteResult[] = pluginCommands
      .filter((item) => {
        const key = `cmd:${item.pluginId}:${item.id}`;
        if (seenCommandIds.has(key)) return false;
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
          subtitle:
            typeof metadata.subtitle === 'string'
              ? metadata.subtitle
              : item.pluginId,
          pluginId: item.pluginId,
          handler:
            typeof metadata.handler === 'string' ? metadata.handler : item.id,
          icon: contributionIconComponent(metadata.icon, Command),
        };
      });
    return [
      ...sdkCommandResults,
      ...catalogCommands,
      ...conversations,
      ...files,
    ];
  }, [
    fileResults,
    conversationResults,
    pluginCommands,
    sdkCommands,
    paletteQuery,
    t,
  ]);

  const handleSelect = useCallback(
    (result: PaletteResult) => {
      if (result.kind === 'command') {
        if (result.onExecute) {
          void Promise.resolve(result.onExecute()).catch(() => undefined);
        } else if (result.pluginId && result.handler) {
          void pluginApi.invokeContribution(result.pluginId, result.handler);
        }
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
    activeEl?.scrollIntoView?.({ block: 'nearest' });
  }, [paletteSelectedIndex]);

  if (!isSearchPaletteOpen) return null;

  return (
    <div
      data-floating-layer="modal"
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh]"
      onClick={closeSearchPalette}
      role="presentation"
    >
      <NativeSurfaceOcclusionHold />
      {/* Backdrop */}
      <div className="dialog-backdrop absolute inset-0" />

      {/* Palette */}
      <div
        className="modal-surface relative mx-4 w-full max-w-[600px] overflow-hidden rounded-lg"
        role="dialog"
        aria-modal="true"
        aria-label={t('searchPalette.dialogLabel')}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input row */}
        <div
          data-control-frame="true"
          className="flex items-center gap-2 border-b border-[var(--border-content)] px-3 py-2.5"
        >
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
                onContextMenu={(event) => {
                  event.stopPropagation();
                  openSurfaceMenu(event, [
                    {
                      id: 'open',
                      label: t('common:contextMenu.open'),
                      onSelect: () => handleSelect(result),
                    },
                    {
                      id: 'copy',
                      label:
                        result.kind === 'conversation'
                          ? t('common:contextMenu.copyTitle')
                          : t('common:contextMenu.copyPath'),
                      onSelect: () => {
                        void writeClipboardViaBridge(
                          result.filePath ?? result.subtitle ?? result.title
                        );
                      },
                    },
                  ]);
                }}
              >
                {result.kind === 'file' ? (
                  <File className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : result.kind === 'conversation' ? (
                  <MessagesSquare className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : result.kind === 'command' ? (
                  (() => {
                    const Icon = result.icon ?? Command;
                    return (
                      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                    );
                  })()
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
