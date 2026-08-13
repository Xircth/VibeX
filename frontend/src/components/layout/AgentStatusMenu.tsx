import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentLifecycleState, AgentManagementView } from 'shared/types';

import { AgentManagementIcon } from '@/components/agents/AgentManagementIcon';
import { cn } from '@/lib/utils';

type AgentStatusMenuProps = {
  agents: AgentManagementView[];
  defaultAgentId: string | null;
};

function statusDotClass(lifecycle: AgentLifecycleState): string {
  switch (lifecycle) {
    case 'ready':
      return 'bg-[hsl(var(--success))]';
    case 'needs_auth':
    case 'needs_config':
      return 'bg-warning';
    case 'needs_repair':
    case 'platform_unsupported':
    case 'retired':
      return 'bg-destructive';
    case 'queued':
    case 'installing':
    case 'updating':
    case 'repairing':
    case 'uninstalled':
      return 'bg-primary';
  }
}

export function AgentStatusMenu({
  agents,
  defaultAgentId,
}: AgentStatusMenuProps) {
  const { t } = useTranslation(['statusbar', 'settings']);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const enabledAgents = useMemo(
    () => agents.filter((agent) => agent.enabled),
    [agents]
  );
  const defaultAgent =
    enabledAgents.find((agent) => agent.agent_id === defaultAgentId) ??
    enabledAgents[0];

  if (!defaultAgent) return null;

  const statusLabel = (agent: AgentManagementView) =>
    t(`agents.lifecycleStatus.${agent.lifecycle}`, { ns: 'settings' });
  const defaultStatus = statusLabel(defaultAgent);

  return (
    <div
      className="relative flex h-5 items-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpen(false);
          event.currentTarget.querySelector('button')?.focus();
        }
      }}
    >
      <button
        type="button"
        aria-controls={menuId}
        aria-expanded={open}
        aria-label={t('agentStatus.defaultAgentAria', {
          ns: 'statusbar',
          agent: defaultAgent.display_name,
          status: defaultStatus,
        })}
        className="flex h-5 items-center gap-1 rounded-full border border-border/60 bg-background/50 px-1.5 text-foreground/85 outline-none transition-colors hover:border-border hover:bg-accent/70 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => setOpen(true)}
      >
        <span
          aria-hidden="true"
          className={cn(
            'h-2 w-2 shrink-0 rounded-full',
            statusDotClass(defaultAgent.lifecycle)
          )}
        />
        <AgentManagementIcon
          agent={defaultAgent}
          className="h-3.5 w-3.5 shrink-0"
        />
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-50 pb-1.5">
          <div className="tahoe-popover max-h-[min(24rem,calc(100vh-3rem))] min-w-48 overflow-y-auto rounded-lg p-1 text-popover-foreground shadow-xl animate-in fade-in-0 slide-in-from-bottom-1 motion-reduce:animate-none">
            <div
              id={menuId}
              role="list"
              aria-label={t('agentStatus.enabledAgentsAria', {
                ns: 'statusbar',
              })}
              className="flex flex-col"
            >
              {enabledAgents.map((agent) => {
                const isDefault = agent.agent_id === defaultAgent.agent_id;
                return (
                  <div
                    key={agent.agent_id}
                    role="listitem"
                    className="flex min-h-8 items-center gap-2 rounded-md px-2 py-1 text-xs"
                  >
                    <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                      <AgentManagementIcon agent={agent} className="h-4 w-4" />
                      <span
                        aria-hidden="true"
                        className={cn(
                          'absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2 ring-popover',
                          statusDotClass(agent.lifecycle)
                        )}
                      />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {agent.display_name}
                    </span>
                    {isDefault && (
                      <span className="rounded bg-primary/10 px-1 py-0.5 text-[9px] font-medium text-primary">
                        {t('agentStatus.defaultBadge', { ns: 'statusbar' })}
                      </span>
                    )}
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {statusLabel(agent)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
