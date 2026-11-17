import { ArrowLeftRight, ArrowRight } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentKind, AgentSessionConfigOption } from 'shared/types';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { resolveSessionModelDisplayLabel } from '@/components/tasks/follow-up/SessionSettingsSummary';
import { usePendingAgentHandoff } from '@/contexts/ActiveExecutorProfileContext';
import { useSelectableAgents } from '@/features/agents/useSelectableAgents';
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
  className,
}: ContextHandoffDividerProps) {
  const { t } = useTranslation(['app']);
  const title =
    continuationPolicy === 'fresh'
      ? t('app:continuation.fresh')
      : t('app:continuation.handoff');
  const formattedTokens =
    continuationPolicy === 'fresh' ? null : formatHandoffTokens(handoffTokens);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="context-handoff-divider"
      className={cn(
        'flex select-none items-center gap-3 px-4 py-3 text-xs text-muted-foreground',
        className
      )}
    >
      <div aria-hidden="true" className="h-px min-w-6 flex-1 bg-border/60" />
      <div className="inline-flex min-w-0 max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1">
        <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-muted-foreground">
          <ArrowLeftRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
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
  const pendingHandoff = usePendingAgentHandoff(sessionId);
  const agentById = useAgentVisualMap();
  const visible = Boolean(
    pendingHandoff && hasMessages && !suppressedByInlineHandoff
  );
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
    pendingHandoff?.fromAgent,
    pendingHandoff?.toAgent,
    pendingHandoff?.toModelLabel,
  ]);

  if (!pendingHandoff || !hasMessages || suppressedByInlineHandoff) {
    return null;
  }

  const fromMeta = agentById.get(pendingHandoff.fromAgent);
  const toMeta = agentById.get(pendingHandoff.toAgent);
  const fromAgentName =
    fromMeta?.displayName ?? getAgentName(pendingHandoff.fromAgent);
  const toAgentName =
    toMeta?.displayName ?? getAgentName(pendingHandoff.toAgent);
  const resolvedLiveFromModel = resolveSessionModelDisplayLabel(
    sessionConfigOptions,
    {}
  );
  const fromLabel =
    formatHandoffModelLabel(
      pendingHandoff.fromModelLabel ??
        resolvedLiveFromModel ??
        fallbackFromModel
    ) ?? fromAgentName;
  const toLabel =
    formatHandoffModelLabel(pendingHandoff.toModelLabel) ?? toAgentName;

  return (
    <ContextHandoffDivider
      fromAgent={pendingHandoff.fromAgent}
      toAgent={pendingHandoff.toAgent}
      fromLabel={fromLabel}
      toLabel={toLabel}
      fromIcon={fromMeta}
      toIcon={toMeta}
      handoffTokens={pendingHandoff.handoffTokens}
      continuationPolicy={pendingHandoff.continuationPolicy}
    />
  );
}
