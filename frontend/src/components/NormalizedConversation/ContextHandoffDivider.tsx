import { ArrowLeftRight, ArrowRight, GitFork, Loader2 } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentKind, AgentSessionConfigOption } from 'shared/types';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { resolveSessionModelDisplayLabel } from '@/components/tasks/follow-up/SessionSettingsSummary';
import { usePendingAgentHandoff } from '@/contexts/ActiveExecutorProfileContext';
import { useSelectableAgents } from '@/features/agents/useSelectableAgents';
import { usePendingForkHandoff } from '@/features/conversation/pendingForkStore';
import { cn } from '@/lib/utils';

type AgentVisualMeta = {
  iconLight?: string | null;
  iconDark?: string | null;
  iconSvg?: string | null;
};

/**
 * Contrast-safe brand-tinted text color per agent using Dimo semantic session
 * slot variables mixed with `--text-strong` so labels adapt cleanly across both
 * light and dark themes without hard-coded hex values.
 */
function agentAccentColor(agentId: string): string {
  switch (agentId) {
    case 'claude_code':
      return 'color-mix(in srgb, hsl(var(--session-slot-12)) 78%, var(--text-strong))';
    case 'antigravity':
    case 'gemini':
    case 'deepseek_harness':
      return 'color-mix(in srgb, hsl(var(--session-slot-19)) 78%, var(--text-strong))';
    case 'codex':
      return 'color-mix(in srgb, hsl(var(--session-slot-8)) 72%, var(--text-strong))';
    case 'kimi_code':
    case 'qwen_code':
      return 'color-mix(in srgb, hsl(var(--session-slot-15)) 75%, var(--text-strong))';
    default:
      return 'var(--conv-text-secondary)';
  }
}

/**
 * Prettifies a raw runtime model identifier (such as `claude-opus-4-6-20250929`
 * or `gemini-4-carbon`) when only the turn-level raw model string is available,
 * stripping leading vendor prefixes and trailing 8-digit release dates while
 * preserving already human-readable ACP option labels untouched.
 */
export function formatHandoffModelLabel(
  raw: string | null | undefined
): string | null {
  const trimmed = raw?.trim() ?? '';
  if (!trimmed) return null;
  if (trimmed.includes(' ')) {
    return (
      trimmed.replace(/^(?:Claude|Anthropic|Google|Gemini)\s+/i, '').trim() ||
      trimmed
    );
  }

  const withoutProvider = trimmed.includes('/')
    ? (trimmed.split('/').pop() ?? trimmed)
    : trimmed;
  const withoutDate = withoutProvider.replace(/-\d{8}$/, '');
  const withoutVendorPrefix = withoutDate.replace(
    /^(?:claude|gemini|anthropic|google)-/i,
    ''
  );
  if (/^gpt-/i.test(withoutVendorPrefix)) {
    return withoutVendorPrefix.replace(/^gpt-/i, 'GPT-');
  }
  const tokens = withoutVendorPrefix.split('-').filter(Boolean);
  if (tokens.length === 0) return trimmed;

  const formatted: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const current = tokens[i]!;
    const next = tokens[i + 1];
    if (/^\d+$/.test(current) && next && /^\d+$/.test(next)) {
      formatted.push(`${current}.${next}`);
      i += 1;
      continue;
    }
    if (/^\d+(?:\.\d+)?$/.test(current)) {
      formatted.push(current);
      continue;
    }
    formatted.push(current.charAt(0).toUpperCase() + current.slice(1));
  }
  return formatted.join(' ');
}

export function formatHandoffTokens(
  tokens: number | null | undefined
): string | null {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) {
    return null;
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M Tokens`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}K Tokens`;
  }
  return `${Math.round(tokens)} Tokens`;
}

export type ContextHandoffDividerProps = {
  fromAgent: AgentKind | string;
  toAgent: AgentKind | string;
  fromLabel: string;
  toLabel: string;
  fromIcon?: AgentVisualMeta;
  toIcon?: AgentVisualMeta;
  handoffTokens?: number | null;
  continuationPolicy?: 'portable' | 'fresh';
  mode?: 'switch' | 'fork' | 'forking';
  className?: string;
};

export function ContextHandoffDivider({
  fromAgent,
  toAgent,
  fromLabel,
  toLabel,
  fromIcon,
  toIcon,
  handoffTokens = null,
  continuationPolicy = 'portable',
  mode = 'switch',
  className,
}: ContextHandoffDividerProps) {
  const { t } = useTranslation(['app']);
  const title =
    mode === 'forking'
      ? t('app:continuation.forking')
      : mode === 'fork'
        ? t('app:continuation.forkHandoff')
        : continuationPolicy === 'fresh'
          ? t('app:continuation.fresh')
          : t('app:continuation.handoff');
  const formattedTokens =
    mode === 'forking' || continuationPolicy === 'fresh'
      ? null
      : formatHandoffTokens(handoffTokens);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="context-handoff-divider"
      data-handoff-mode={mode}
      className={cn(
        'flex select-none items-center gap-3 px-4 py-3 text-xs text-muted-foreground',
        className
      )}
    >
      <div aria-hidden="true" className="h-px min-w-6 flex-1 bg-border/60" />
      <div className="inline-flex min-w-0 max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1">
        <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-muted-foreground">
          {mode === 'forking' ? (
            <Loader2
              className="h-3.5 w-3.5 shrink-0 animate-spin"
              aria-hidden="true"
            />
          ) : mode === 'fork' ? (
            <GitFork className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <ArrowLeftRight
              className="h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
          )}
          <span>
            {title}
            {formattedTokens ? (
              <>
                {' '}
                <span
                  data-testid="context-handoff-tokens"
                  className="tabular-nums"
                >
                  {formattedTokens}
                </span>
              </>
            ) : null}
          </span>
        </span>
        <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
          <AgentIcon
            agent={fromAgent}
            className="h-3.5 w-3.5 shrink-0"
            iconLight={fromIcon?.iconLight}
            iconDark={fromIcon?.iconDark}
            iconSvg={fromIcon?.iconSvg}
          />
          <span
            data-testid="context-handoff-from-label"
            className="truncate"
            style={{ color: agentAccentColor(fromAgent) }}
          >
            {fromLabel}
          </span>
        </span>
        <ArrowRight
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80"
          aria-hidden="true"
        />
        <span className="inline-flex min-w-0 items-center gap-1.5 font-medium">
          <AgentIcon
            agent={toAgent}
            className="h-3.5 w-3.5 shrink-0"
            iconLight={toIcon?.iconLight}
            iconDark={toIcon?.iconDark}
            iconSvg={toIcon?.iconSvg}
          />
          <span
            data-testid="context-handoff-to-label"
            className="truncate"
            style={{ color: agentAccentColor(toAgent) }}
          >
            {toLabel}
          </span>
        </span>
      </div>
      <div aria-hidden="true" className="h-px min-w-6 flex-1 bg-border/60" />
    </div>
  );
}

function useAgentVisualMap() {
  const selectableAgents = useSelectableAgents();
  return useMemo(() => {
    const map = new Map<
      string,
      {
        displayName: string;
        iconLight: string | null;
        iconDark: string | null;
        iconSvg: string | null;
      }
    >();
    for (const agent of selectableAgents) {
      map.set(agent.agentId, {
        displayName: agent.displayName,
        iconLight: agent.iconLight,
        iconDark: agent.iconDark,
        iconSvg: agent.iconSvg,
      });
    }
    return map;
  }, [selectableAgents]);
}

export function TimelineAgentHandoffRow({
  handoff,
}: {
  handoff: {
    handoffKind?: 'switch' | 'fork';
    fromAgent: string;
    toAgent: string;
    fromModel: string | null;
    toModel: string | null;
    handoffTokens?: number | null;
    continuationPolicy: 'portable' | 'fresh';
  };
}) {
  const agentById = useAgentVisualMap();
  const fromMeta = agentById.get(handoff.fromAgent);
  const toMeta = agentById.get(handoff.toAgent);
  const fromAgentName =
    fromMeta?.displayName ?? getAgentName(handoff.fromAgent);
  const toAgentName = toMeta?.displayName ?? getAgentName(handoff.toAgent);
  const fromLabel = formatHandoffModelLabel(handoff.fromModel) ?? fromAgentName;
  const toLabel = formatHandoffModelLabel(handoff.toModel) ?? toAgentName;

  return (
    <ContextHandoffDivider
      fromAgent={handoff.fromAgent}
      toAgent={handoff.toAgent}
      fromLabel={fromLabel}
      toLabel={toLabel}
      fromIcon={fromMeta}
      toIcon={toMeta}
      handoffTokens={handoff.handoffTokens}
      continuationPolicy={handoff.continuationPolicy}
      mode={handoff.handoffKind === 'fork' ? 'fork' : 'switch'}
    />
  );
}

export function ConversationTailHandoff({
  sessionId,
  hasMessages,
  fallbackFromModel = null,
  sessionConfigOptions,
  suppressedByInlineHandoff = false,
  onReveal,
}: {
  sessionId: string | null | undefined;
  hasMessages: boolean;
  fallbackFromModel?: string | null;
  sessionConfigOptions?: AgentSessionConfigOption[];
  suppressedByInlineHandoff?: boolean;
  onReveal?: () => void;
}) {
  const pendingFork = usePendingForkHandoff(sessionId);
  const pendingHandoff = usePendingAgentHandoff(sessionId);
  const agentById = useAgentVisualMap();
  const activeTail = pendingFork
    ? {
        mode: 'forking' as const,
        fromAgent: pendingFork.fromAgent,
        toAgent: pendingFork.toAgent,
        fromModelLabel: pendingFork.fromModelLabel,
        toModelLabel: pendingFork.toModelLabel,
        handoffTokens: null,
        continuationPolicy: 'portable' as const,
      }
    : pendingHandoff && hasMessages && !suppressedByInlineHandoff
      ? {
          mode: 'switch' as const,
          fromAgent: pendingHandoff.fromAgent,
          toAgent: pendingHandoff.toAgent,
          fromModelLabel: pendingHandoff.fromModelLabel,
          toModelLabel: pendingHandoff.toModelLabel,
          handoffTokens: pendingHandoff.handoffTokens ?? null,
          continuationPolicy: pendingHandoff.continuationPolicy,
        }
      : null;
  const visible = Boolean(activeTail);
  const wasVisibleRef = useRef(false);
  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;

  useLayoutEffect(() => {
    if (visible && !wasVisibleRef.current) {
      onRevealRef.current?.();
    }
    wasVisibleRef.current = visible;
  }, [
    visible,
    activeTail?.mode,
    activeTail?.fromAgent,
    activeTail?.toAgent,
    activeTail?.toModelLabel,
  ]);

  if (!activeTail) {
    return null;
  }

  const fromMeta = agentById.get(activeTail.fromAgent);
  const toMeta = agentById.get(activeTail.toAgent);
  const fromAgentName =
    fromMeta?.displayName ?? getAgentName(activeTail.fromAgent);
  const toAgentName = toMeta?.displayName ?? getAgentName(activeTail.toAgent);
  const resolvedLiveFromModel = resolveSessionModelDisplayLabel(
    sessionConfigOptions,
    {}
  );
  const fromLabel =
    formatHandoffModelLabel(
      activeTail.fromModelLabel ?? resolvedLiveFromModel ?? fallbackFromModel
    ) ?? fromAgentName;
  const toLabel =
    formatHandoffModelLabel(activeTail.toModelLabel) ?? toAgentName;

  return (
    <ContextHandoffDivider
      fromAgent={activeTail.fromAgent}
      toAgent={activeTail.toAgent}
      fromLabel={fromLabel}
      toLabel={toLabel}
      fromIcon={fromMeta}
      toIcon={toMeta}
      handoffTokens={activeTail.handoffTokens}
      continuationPolicy={activeTail.continuationPolicy}
      mode={activeTail.mode}
    />
  );
}
