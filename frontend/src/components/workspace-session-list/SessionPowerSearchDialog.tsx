import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  FolderGit2,
  GitBranch,
  Search,
} from 'lucide-react';
import {
  PowerSearch,
  type EnumItem,
  type PowerSearchConfig,
  type PowerSearchFilter,
  type PowerSearchHandle,
  type PowerSearchOperator,
} from '@astryxdesign/core/PowerSearch';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { sessionListAgentKey } from '@/components/kanban/session-hub/utils';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { NativeSurfaceOcclusionHold } from '@/contexts/WorkspaceOverlayContext';
import {
  MemberBotAvatar,
  resolveMemberBotAvatar,
} from '@/features/collaboration/MemberBotAvatar';
import { conversationApi } from '@/features/conversation/conversationApi';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import { cn } from '@/lib/utils';
import { dateTimestamp } from '@/utils/date';
import type { ExecutorProfileId } from 'shared/types';
import { WorkspaceSessionStatusIndicator } from './WorkspaceSessionList';
import {
  formatCompactSessionAge,
  sessionAgentLabel,
  sessionListTitle,
  sessionMatchesQuery,
  workspaceGroupLabel,
  workspaceSessionStatusTone,
  type WorkspaceSessionStatusTone,
} from './workspaceSessionListModel';

export const ANY_BOT_FILTER_VALUE = '__any_bot__' as const;
export const NO_BOT_FILTER_VALUE = '__no_bot__' as const;

export type SearchableSessionStatus = WorkspaceSessionStatusTone | 'archived';

const FALLBACK_AGENT_KEYS = [
  'claude_code',
  'codex',
  'antigravity',
  'grok',
  'pi',
  'deepseek_harness',
] as const;

export function resolveSearchSessionStatus(session: {
  status: string;
  isRunning?: boolean;
}): SearchableSessionStatus {
  if (session.status === 'archived') {
    return 'archived';
  }
  return workspaceSessionStatusTone(session);
}

export function resolveSessionBotKey(
  session: Pick<KanbanProjectSessionRecord, 'collaboration'>
): string {
  const collaboration = session.collaboration;
  if (!collaboration) {
    return '';
  }
  return (
    collaboration.memberName?.trim() || collaboration.memberId?.trim() || ''
  );
}

function matchesEnumOrListOperator(
  operator: string,
  actualValue: string,
  expectedValues: readonly string[]
): boolean {
  if (expectedValues.length === 0) {
    return true;
  }
  switch (operator) {
    case 'is':
    case 'is_any_of':
      return expectedValues.includes(actualValue);
    case 'is_not':
    case 'is_none_of':
      return !expectedValues.includes(actualValue);
    default:
      return expectedValues.includes(actualValue);
  }
}

function extractStringTargets(filter: PowerSearchFilter): string[] {
  if (filter.value.type === 'enum' || filter.value.type === 'string') {
    return filter.value.value ? [filter.value.value] : [];
  }
  if (
    filter.value.type === 'enum_list' ||
    filter.value.type === 'string_list'
  ) {
    return [...filter.value.value];
  }
  return [];
}

export function sessionMatchesGlobalText(
  session: KanbanProjectSessionRecord,
  query: string,
  fullTextHitIds?: ReadonlySet<string> | null
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  if (sessionMatchesQuery(session, needle)) {
    return true;
  }
  if (fullTextHitIds?.has(session.id)) {
    return true;
  }
  const worktreeText = workspaceGroupLabel(session).toLowerCase();
  const branchText = (session.branch ?? '').toLowerCase();
  const botText = resolveSessionBotKey(session).toLowerCase();
  const agentText = sessionAgentLabel(session).toLowerCase();

  return (
    worktreeText.includes(needle) ||
    branchText.includes(needle) ||
    botText.includes(needle) ||
    agentText.includes(needle)
  );
}

export function matchesPowerSearchFilters(
  session: KanbanProjectSessionRecord,
  filters: readonly PowerSearchFilter[],
  options: {
    liveQuery?: string;
    fullTextHitIds?: ReadonlySet<string> | null;
  } = {}
): boolean {
  const { liveQuery = '', fullTextHitIds = null } = options;

  for (const filter of filters) {
    const targets = extractStringTargets(filter);

    switch (filter.field) {
      case 'query': {
        const needle = targets[0] ?? '';
        const matches = sessionMatchesGlobalText(
          session,
          needle,
          fullTextHitIds
        );
        if (filter.operator === 'not_contains' ? matches : !matches) {
          return false;
        }
        break;
      }

      case 'status': {
        const actualStatus = resolveSearchSessionStatus(session);
        if (!matchesEnumOrListOperator(filter.operator, actualStatus, targets)) {
          return false;
        }
        break;
      }

      case 'worktree': {
        if (filter.operator === 'contains') {
          const needle = (targets[0] ?? '').trim().toLowerCase();
          if (needle) {
            const label = workspaceGroupLabel(session).toLowerCase();
            const branch = (session.branch ?? '').toLowerCase();
            if (!label.includes(needle) && !branch.includes(needle)) {
              return false;
            }
          }
          break;
        }
        if (
          !matchesEnumOrListOperator(
            filter.operator,
            session.workspace.id,
            targets
          )
        ) {
          return false;
        }
        break;
      }

      case 'bot': {
        const botKey = resolveSessionBotKey(session);
        const matchesTarget = (target: string) => {
          if (target === ANY_BOT_FILTER_VALUE) {
            return Boolean(session.collaboration);
          }
          if (target === NO_BOT_FILTER_VALUE) {
            return !session.collaboration;
          }
          return botKey === target;
        };
        const anyMatched =
          targets.length === 0 || targets.some((target) => matchesTarget(target));
        if (
          filter.operator === 'is_not' || filter.operator === 'is_none_of'
            ? anyMatched && targets.length > 0
            : !anyMatched
        ) {
          return false;
        }
        break;
      }

      case 'agent': {
        const agentKey = sessionListAgentKey(session) ?? '';
        if (!matchesEnumOrListOperator(filter.operator, agentKey, targets)) {
          return false;
        }
        break;
      }

      default:
        break;
    }
  }

  if (liveQuery.trim()) {
    if (!sessionMatchesGlobalText(session, liveQuery, fullTextHitIds)) {
      return false;
    }
  }

  return true;
}

function hidePopoverElementWithSync(popoverEl: HTMLElement | null) {
  if (!popoverEl) {
    return;
  }
  const wasOpen =
    popoverEl.hasAttribute('open') ||
    safeMatchesPopoverOpen(popoverEl);
  if (typeof popoverEl.hidePopover === 'function') {
    try {
      popoverEl.hidePopover();
    } catch {
      // Ignore InvalidStateError when already hidden.
    }
  } else {
    popoverEl.style.display = 'none';
  }
  if (wasOpen) {
    const toggleEvent = Object.assign(new Event('toggle'), {
      newState: 'closed',
      oldState: 'open',
    });
    popoverEl.dispatchEvent(toggleEvent);
  }
}

function safeMatchesPopoverOpen(el: HTMLElement): boolean {
  try {
    if (el.matches(':popover-open')) {
      return true;
    }
  } catch {
    // Selector unsupported in jsdom.
  }
  return el.hasAttribute('open');
}

export interface SessionPowerSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessions: KanbanProjectSessionRecord[];
  activeSessionId?: string | null;
  onSelectSession: (session: KanbanProjectSessionRecord) => void;
}

export function SessionPowerSearchDialog({
  open,
  onOpenChange,
  sessions,
  activeSessionId = null,
  onSelectSession,
}: SessionPowerSearchDialogProps) {
  const { t } = useTranslation(['panels', 'common']);
  const portalContainer = usePortalContainer();
  const powerSearchHandleRef = useRef<PowerSearchHandle>(null);
  const searchWrapperRef = useRef<HTMLDivElement>(null);
  const resultsListRef = useRef<HTMLDivElement>(null);
  const filterMenuAllowedRef = useRef(false);

  const [filters, setFilters] = useState<ReadonlyArray<PowerSearchFilter>>([]);
  const [liveQuery, setLiveQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [fullTextHitIds, setFullTextHitIds] = useState<Set<string> | null>(
    null
  );

  const statusEnumValues = useMemo<EnumItem[]>(
    () => [
      {
        value: 'inprogress',
        label: t('workspaceSessionList.statusInProgress', '进行中'),
      },
      {
        value: 'inreview',
        label: t('workspaceSessionList.statusInReview', '待复核'),
      },
      {
        value: 'todo',
        label: t('workspaceSessionList.statusTodo', '待办'),
      },
      {
        value: 'done',
        label: t('workspaceSessionList.statusDone', '已完成'),
      },
      {
        value: 'archived',
        label: t('workspaceSessionList.statusArchived', '已归档'),
      },
    ],
    [t]
  );

  const worktreeEnumValues = useMemo<EnumItem[]>(() => {
    const byId = new Map<string, { label: string; useWorktree: boolean }>();
    for (const session of sessions) {
      const workspaceId = session.workspace.id;
      if (byId.has(workspaceId)) continue;
      const baseLabel =
        workspaceGroupLabel(session) ||
        session.workspace.branch ||
        workspaceId.slice(0, 8);
      const label = session.workspace.use_worktree
        ? baseLabel
        : `${baseLabel} (${t('workspaceSessionList.globalSearch.defaultWorkspaceSuffix', '默认工作区')})`;
      byId.set(workspaceId, {
        label,
        useWorktree: session.workspace.use_worktree,
      });
    }
    return [...byId.entries()]
      .sort(([, left], [, right]) => {
        if (left.useWorktree !== right.useWorktree) {
          return left.useWorktree ? 1 : -1;
        }
        return left.label.localeCompare(right.label);
      })
      .map(([value, entry]) => ({ value, label: entry.label }));
  }, [sessions, t]);

  const botEnumValues = useMemo<EnumItem[]>(() => {
    const distinctBots = new Set<string>();
    for (const session of sessions) {
      const key = resolveSessionBotKey(session);
      if (key) {
        distinctBots.add(key);
      }
    }
    return [
      {
        value: ANY_BOT_FILTER_VALUE,
        label: t('workspaceSessionList.globalSearch.anyBot', '任意 Bot'),
      },
      {
        value: NO_BOT_FILTER_VALUE,
        label: t('workspaceSessionList.globalSearch.noBot', '非 Bot 会话'),
      },
      ...[...distinctBots]
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ value: name, label: name })),
    ];
  }, [sessions, t]);

  const agentEnumValues = useMemo<EnumItem[]>(() => {
    const byKey = new Map<string, string>();
    for (const session of sessions) {
      const key = sessionListAgentKey(session);
      if (!key || byKey.has(key)) continue;
      const label =
        sessionAgentLabel(session) ||
        getAgentName(key as ExecutorProfileId['executor']) ||
        key;
      byKey.set(key, label);
    }
    if (byKey.size === 0) {
      for (const fallbackKey of FALLBACK_AGENT_KEYS) {
        byKey.set(
          fallbackKey,
          getAgentName(fallbackKey as ExecutorProfileId['executor'])
        );
      }
    }
    return [...byKey.entries()].map(([value, label]) => ({ value, label }));
  }, [sessions]);

  const powerSearchConfig = useMemo<PowerSearchConfig>(() => {
    const opIs = t('workspaceSessionList.globalSearch.operatorIs', '是');
    const opIsAnyOf = t(
      'workspaceSessionList.globalSearch.operatorIsAnyOf',
      '属于'
    );
    const opIsNot = t(
      'workspaceSessionList.globalSearch.operatorIsNot',
      '不是'
    );
    const opContains = t(
      'workspaceSessionList.globalSearch.operatorContains',
      '包含'
    );

    const buildEnumOperators = (
      values: ReadonlyArray<EnumItem>
    ): PowerSearchOperator[] => [
      { key: 'is', label: opIs, value: { type: 'enum', values } },
      { key: 'is_any_of', label: opIsAnyOf, value: { type: 'enum_list', values } },
      { key: 'is_not', label: opIsNot, value: { type: 'enum', values } },
    ];

    const worktreeOperators: PowerSearchOperator[] =
      worktreeEnumValues.length > 0
        ? [
            ...buildEnumOperators(worktreeEnumValues),
            { key: 'contains', label: opContains, value: { type: 'string' } },
          ]
        : [{ key: 'contains', label: opContains, value: { type: 'string' } }];

    return {
      name: 'WorkspaceSessionGlobalSearch',
      contentSearchFieldKey: 'query',
      fields: [
        {
          key: 'status',
          label: t('workspaceSessionList.globalSearch.fieldStatus', '状态'),
          typeaheadAliases: ['status', '状态'],
          defaultOperator: 'is',
          operators: buildEnumOperators(statusEnumValues),
        },
        {
          key: 'worktree',
          label: t('workspaceSessionList.globalSearch.fieldWorktree', '工作树'),
          typeaheadAliases: [
            'worktree',
            'workspace',
            'branch',
            '工作树',
            '工作区',
            '分支',
          ],
          defaultOperator:
            worktreeEnumValues.length > 0 ? 'is' : 'contains',
          operators: worktreeOperators,
        },
        {
          key: 'bot',
          label: t('workspaceSessionList.globalSearch.fieldBot', 'Bot'),
          typeaheadAliases: ['bot', '机器人', '协作'],
          defaultOperator: 'is',
          operators: buildEnumOperators(botEnumValues),
        },
        {
          key: 'agent',
          label: t('workspaceSessionList.globalSearch.fieldAgent', 'Agent'),
          typeaheadAliases: ['agent', 'executor', '执行器'],
          defaultOperator: 'is',
          operators: buildEnumOperators(agentEnumValues),
        },
        {
          key: 'query',
          label: t('workspaceSessionList.globalSearch.fieldQuery', '关键字'),
          typeaheadAliases: ['query', 'keyword', 'title', '关键字', '标题'],
          typeaheadMinQueryLength: 2,
          isValueMatchAllowed: false,
          defaultOperator: 'contains',
          operators: [
            { key: 'contains', label: opContains, value: { type: 'string' } },
          ],
        },
      ],
    };
  }, [
    agentEnumValues,
    botEnumValues,
    statusEnumValues,
    t,
    worktreeEnumValues,
  ]);

  const getComboboxInput = useCallback((): HTMLInputElement | null => {
    const root = searchWrapperRef.current?.querySelector('.astryx-power-search');
    return root?.querySelector<HTMLInputElement>('input[role="combobox"]') ?? null;
  }, []);

  const getTypeaheadPopover = useCallback((): HTMLElement | null => {
    const input = getComboboxInput();
    const listboxId = input?.getAttribute('aria-controls');
    if (!listboxId) {
      return null;
    }
    return (
      document.getElementById(listboxId)?.closest<HTMLElement>('[popover]') ??
      null
    );
  }, [getComboboxInput]);

  const isEditPopoverOpen = useCallback((): boolean => {
    const wrapper = searchWrapperRef.current;
    if (!wrapper) {
      return false;
    }
    const typeaheadPopover = getTypeaheadPopover();
    const popovers = wrapper.querySelectorAll<HTMLElement>('[popover]');
    for (const popover of popovers) {
      if (popover === typeaheadPopover) continue;
      if (safeMatchesPopoverOpen(popover)) {
        return true;
      }
    }
    return false;
  }, [getTypeaheadPopover]);

  const isTypeaheadPopoverOpen = useCallback((): boolean => {
    const input = getComboboxInput();
    return input?.getAttribute('aria-expanded') === 'true';
  }, [getComboboxInput]);

  const suppressUnrequestedTypeahead = useCallback(() => {
    if (filterMenuAllowedRef.current) {
      return;
    }
    const popover = getTypeaheadPopover();
    if (popover && safeMatchesPopoverOpen(popover)) {
      hidePopoverElementWithSync(popover);
    }
  }, [getTypeaheadPopover]);

  // Reset modal state on open and focus the PowerSearch input cleanly without
  // popping the field menu until the user requests filtering (Tab / Filter).
  useEffect(() => {
    if (!open) {
      filterMenuAllowedRef.current = false;
      return;
    }

    setFilters([]);
    setLiveQuery('');
    setActiveIndex(0);
    setFullTextHitIds(null);
    filterMenuAllowedRef.current = false;

    const frame = requestAnimationFrame(() => {
      powerSearchHandleRef.current?.focusTypeahead();
      suppressUnrequestedTypeahead();
      requestAnimationFrame(() => {
        suppressUnrequestedTypeahead();
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [open, suppressUnrequestedTypeahead]);

  // Keep the combobox field menu suppressed unless explicitly opened via Tab / Filter.
  useEffect(() => {
    if (!open) return;
    const popover = getTypeaheadPopover();
    if (!popover) return;

    const handleToggle = () => {
      if (!filterMenuAllowedRef.current && safeMatchesPopoverOpen(popover)) {
        hidePopoverElementWithSync(popover);
      } else if (!safeMatchesPopoverOpen(popover)) {
        filterMenuAllowedRef.current = false;
      }
    };

    popover.addEventListener('toggle', handleToggle);
    return () => popover.removeEventListener('toggle', handleToggle);
  }, [getTypeaheadPopover, open]);

  // Collect all active text search terms (committed query tokens + live input).
  const searchTerms = useMemo(() => {
    const terms: string[] = [];
    for (const filter of filters) {
      if (filter.field === 'query' && filter.operator === 'contains') {
        const targets = extractStringTargets(filter);
        if (targets[0]?.trim()) {
          terms.push(targets[0].trim());
        }
      }
    }
    if (liveQuery.trim()) {
      terms.push(liveQuery.trim());
    }
    return terms;
  }, [filters, liveQuery]);

  useEffect(() => {
    if (!open || searchTerms.length === 0) {
      setFullTextHitIds(null);
      return;
    }

    const combinedQuery = searchTerms[searchTerms.length - 1] ?? '';
    if (!combinedQuery) {
      setFullTextHitIds(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      conversationApi
        .search(combinedQuery, null, 80)
        .then((hits) => {
          if (!cancelled) {
            setFullTextHitIds(new Set(hits.map((hit) => hit.conversation_id)));
          }
        })
        .catch(() => {
          if (!cancelled) {
            setFullTextHitIds(new Set());
          }
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, searchTerms]);

  const matchingSessions = useMemo(() => {
    const filtered = sessions.filter((session) =>
      matchesPowerSearchFilters(session, filters, {
        liveQuery,
        fullTextHitIds,
      })
    );

    return filtered.sort((left, right) => {
      const leftArchived = left.status === 'archived';
      const rightArchived = right.status === 'archived';
      if (leftArchived !== rightArchived) {
        return leftArchived ? 1 : -1;
      }
      if (left.id === activeSessionId && right.id !== activeSessionId) {
        return -1;
      }
      if (right.id === activeSessionId && left.id !== activeSessionId) {
        return 1;
      }
      return dateTimestamp(right.updatedAt) - dateTimestamp(left.updatedAt);
    });
  }, [activeSessionId, filters, fullTextHitIds, liveQuery, sessions]);

  useEffect(() => {
    setActiveIndex((current) => {
      if (matchingSessions.length === 0) return 0;
      return Math.min(current, matchingSessions.length - 1);
    });
  }, [matchingSessions.length]);

  useEffect(() => {
    if (!open) return;
    const activeRow = resultsListRef.current?.querySelector<HTMLElement>(
      '[data-search-active="true"]'
    );
    activeRow?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, open]);

  const openFilterSuggestions = useCallback(() => {
    filterMenuAllowedRef.current = true;
    const input = getComboboxInput();
    if (!input) return;
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      })
    );
  }, [getComboboxInput]);

  const handleSelectResult = useCallback(
    (session: KanbanProjectSessionRecord) => {
      onSelectSession(session);
      onOpenChange(false);
    },
    [onOpenChange, onSelectSession]
  );

  const handleFiltersChange = useCallback(
    (nextFilters: ReadonlyArray<PowerSearchFilter>) => {
      filterMenuAllowedRef.current = false;
      setFilters(nextFilters);
      setActiveIndex(0);
      requestAnimationFrame(() => {
        const input = getComboboxInput();
        setLiveQuery(input?.value ?? '');
        suppressUnrequestedTypeahead();
      });
    },
    [getComboboxInput, suppressUnrequestedTypeahead]
  );

  const handleSearchInputCapture = useCallback(
    (event: FormEvent<HTMLDivElement>) => {
      const comboboxInput = getComboboxInput();
      if (event.target !== comboboxInput) {
        return;
      }
      setLiveQuery(comboboxInput.value);
      setActiveIndex(0);
      queueMicrotask(() => {
        suppressUnrequestedTypeahead();
      });
    },
    [getComboboxInput, suppressUnrequestedTypeahead]
  );

  const handleModalKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.nativeEvent.isComposing) {
        return;
      }

      const editOpen = isEditPopoverOpen();
      const typeaheadOpen =
        filterMenuAllowedRef.current && isTypeaheadPopoverOpen();

      // Let Astryx PowerSearch own keyboard interaction whenever its filter
      // dropdown or filter value editor popover is open.
      if (editOpen || typeaheadOpen) {
        if (event.key === 'Escape' && typeaheadOpen && !editOpen) {
          filterMenuAllowedRef.current = false;
        }
        return;
      }

      switch (event.key) {
        case 'ArrowDown': {
          event.preventDefault();
          event.stopPropagation();
          if (matchingSessions.length > 0) {
            setActiveIndex((prev) => (prev + 1) % matchingSessions.length);
          }
          break;
        }
        case 'ArrowUp': {
          event.preventDefault();
          event.stopPropagation();
          if (matchingSessions.length > 0) {
            setActiveIndex(
              (prev) =>
                (prev - 1 + matchingSessions.length) % matchingSessions.length
            );
          }
          break;
        }
        case 'Enter': {
          const targetSession = matchingSessions[activeIndex];
          if (targetSession) {
            event.preventDefault();
            event.stopPropagation();
            handleSelectResult(targetSession);
          }
          break;
        }
        case 'Escape': {
          event.preventDefault();
          event.stopPropagation();
          onOpenChange(false);
          break;
        }
        case 'Tab': {
          if (!event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            openFilterSuggestions();
          }
          break;
        }
        default:
          break;
      }
    },
    [
      activeIndex,
      handleSelectResult,
      isEditPopoverOpen,
      isTypeaheadPopoverOpen,
      matchingSessions,
      onOpenChange,
      openFilterSuggestions,
    ]
  );

  if (!open) {
    return null;
  }

  const hasQueryOrFilters = filters.length > 0 || liveQuery.trim().length > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-[9990] flex items-start justify-center px-4 pt-[11vh]"
      data-floating-layer="dialog"
      data-testid="session-power-search-overlay"
    >
      <NativeSurfaceOcclusionHold />
      <div
        className="dialog-backdrop fixed inset-0 backdrop-blur-[2px]"
        aria-hidden="true"
        onClick={() => onOpenChange(false)}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t(
          'workspaceSessionList.globalSearch.dialogLabel',
          '全局搜索会话'
        )}
        onKeyDownCapture={handleModalKeyDownCapture}
        className="relative z-10 flex w-full max-w-[680px] flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover text-popover-foreground shadow-2xl"
      >
        <div
          ref={searchWrapperRef}
          onInputCapture={handleSearchInputCapture}
          className="px-3.5 pb-2.5 pt-3.5"
        >
          <PowerSearch
            handleRef={powerSearchHandleRef}
            config={powerSearchConfig}
            filters={filters}
            onChange={handleFiltersChange}
            label={t(
              'workspaceSessionList.globalSearch.dialogLabel',
              '全局搜索会话'
            )}
            isLabelHidden
            placeholder={t(
              'workspaceSessionList.globalSearch.placeholder',
              '搜索会话、工作树、Bot、Agent...'
            )}
            popoverSaveButtonLabel={t(
              'workspaceSessionList.globalSearch.applyFilter',
              '应用'
            )}
            startIcon={
              <Search
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-muted-foreground"
              />
            }
            size="lg"
            hasClear
            data-testid="session-power-search-input"
          />
        </div>

        <div
          ref={resultsListRef}
          role="listbox"
          aria-label={t('workspaceSessionList.title', '会话列表')}
          className="max-h-[50vh] min-h-[210px] overflow-y-auto px-2 pb-2 pt-0.5"
        >
          {matchingSessions.length === 0 ? (
            <div className="flex min-h-[196px] flex-col items-center justify-center px-6 text-center">
              <p className="text-[13px] font-semibold text-foreground">
                {sessions.length === 0 && !hasQueryOrFilters
                  ? t(
                      'workspaceSessionList.globalSearch.emptyNoSessionsTitle',
                      '暂无可搜索的会话'
                    )
                  : t(
                      'workspaceSessionList.globalSearch.emptyNoMatchTitle',
                      '没有匹配的会话'
                    )}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {sessions.length === 0 && !hasQueryOrFilters
                  ? t(
                      'workspaceSessionList.globalSearch.emptyNoSessionsHint',
                      '创建新会话或切换工作树即可开始。'
                    )
                  : t(
                      'workspaceSessionList.globalSearch.emptyNoMatchHint',
                      '请尝试调整搜索词或清除筛选条件。'
                    )}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {matchingSessions.map((session, index) => {
                const isActive = index === activeIndex;
                const title = sessionListTitle(session);
                const isArchived = session.status === 'archived';
                const statusTone = workspaceSessionStatusTone(session);
                const worktreeLabel = workspaceGroupLabel(session);
                const agentKey = sessionListAgentKey(session);
                const agentLabel = sessionAgentLabel(session);
                const age = session.updatedAt
                  ? formatCompactSessionAge(session.updatedAt)
                  : '';

                return (
                  <button
                    key={session.id}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    data-search-active={isActive ? 'true' : undefined}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => handleSelectResult(session)}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors focus:outline-none',
                      isActive
                        ? 'bg-foreground/[0.07] text-foreground'
                        : 'text-foreground/90 hover:bg-foreground/[0.04]'
                    )}
                  >
                    <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
                      {isArchived ? (
                        <Archive
                          className="h-3.5 w-3.5 text-muted-foreground"
                          aria-hidden="true"
                        />
                      ) : (
                        <WorkspaceSessionStatusIndicator tone={statusTone} />
                      )}
                    </span>

                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      {session.collaboration ? (
                        <SearchBotChip
                          conversationId={session.id}
                          memberName={session.collaboration.memberName}
                        />
                      ) : null}
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">
                        {title}
                      </span>
                    </span>

                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      {worktreeLabel ? (
                        <span className="inline-flex max-w-[148px] items-center gap-1 rounded-md bg-foreground/[0.05] px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {session.workspace.use_worktree ? (
                            <FolderGit2
                              className="h-3 w-3 shrink-0"
                              aria-hidden="true"
                            />
                          ) : (
                            <GitBranch
                              className="h-3 w-3 shrink-0"
                              aria-hidden="true"
                            />
                          )}
                          <span className="truncate">{worktreeLabel}</span>
                        </span>
                      ) : null}

                      {agentKey ? (
                        <span
                          className="inline-flex items-center gap-1 text-[11px]"
                          title={agentLabel}
                        >
                          <AgentIcon agent={agentKey} className="h-3.5 w-3.5" />
                        </span>
                      ) : null}

                      {age ? (
                        <span className="w-7 text-right text-[11px] text-muted-foreground/80 tabular-nums">
                          {age}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3.5 border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground select-none">
          <span className="inline-flex items-center gap-1.5">
            <kbd className="rounded-md border border-border/70 bg-foreground/[0.04] px-1.5 py-0.5 font-sans text-[11px] font-medium text-foreground/80">
              {t('workspaceSessionList.globalSearch.keyEnter', '进入')}
            </kbd>
            <span>
              {t('workspaceSessionList.globalSearch.hintOpen', '打开')}
            </span>
          </span>

          <span className="inline-flex items-center gap-1.5">
            <kbd className="rounded-md border border-border/70 bg-foreground/[0.04] px-1.5 py-0.5 font-sans text-[11px] font-medium text-foreground/80">
              {t('workspaceSessionList.globalSearch.keyEsc', 'Esc键')}
            </kbd>
            <span>
              {t('workspaceSessionList.globalSearch.hintClose', '关闭')}
            </span>
          </span>

          <span className="inline-flex items-center gap-1.5">
            <kbd className="rounded-md border border-border/70 bg-foreground/[0.04] px-1.5 py-0.5 font-sans text-[11px] font-medium text-foreground/80">
              {t('workspaceSessionList.globalSearch.keyArrows', '↑↓')}
            </kbd>
            <span>
              {t('workspaceSessionList.globalSearch.hintMove', '移动')}
            </span>
          </span>

          <button
            type="button"
            onClick={openFilterSuggestions}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
          >
            <kbd className="rounded-md border border-border/70 bg-foreground/[0.04] px-1.5 py-0.5 font-sans text-[11px] font-medium text-foreground/80">
              {t('workspaceSessionList.globalSearch.keyTab', 'Tab')}
            </kbd>
            <span>
              {t('workspaceSessionList.globalSearch.hintFilter', '筛选')}
            </span>
          </button>
        </div>
      </div>
    </div>,
    portalContainer ?? document.body
  );
}

function SearchBotChip({
  conversationId,
  memberName,
}: {
  conversationId: string;
  memberName: string;
}) {
  const avatar = useMemo(
    () =>
      resolveMemberBotAvatar({
        conversationId,
        nickname: memberName,
      }),
    [conversationId, memberName]
  );

  return (
    <span className="inline-flex min-w-0 max-w-[7.5rem] shrink-0 items-center gap-1 rounded-md bg-foreground/[0.05] px-1.5 py-0.5">
      <MemberBotAvatar
        config={avatar}
        animated={false}
        className="h-3.5 w-3.5 shrink-0"
      />
      <span
        className="min-w-0 truncate text-[11px] font-semibold"
        style={{ color: avatar.color }}
      >
        {memberName}
      </span>
    </span>
  );
}
