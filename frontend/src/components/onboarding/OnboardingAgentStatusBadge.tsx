import { CheckCircle2, CircleAlert, Download, KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { OnboardingAgentStatus } from './onboardingAgentModel';

const STATUS_BADGE_CLASSES = {
  ready:
    'border-[hsl(var(--success)/0.32)] bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success-foreground))]',
  needs_auth:
    'border-[hsl(var(--warning)/0.34)] bg-[hsl(var(--warning)/0.12)] text-[var(--status-warning-text)]',
  uninstalled:
    'border-[var(--border-subtle)] bg-[var(--surface-control)] text-[var(--text-muted)]',
  install_failed:
    'border-[hsl(var(--destructive)/0.34)] bg-[hsl(var(--destructive)/0.1)] text-destructive',
} as const;

export function OnboardingAgentStatusBadge({
  status,
  className,
}: {
  status: OnboardingAgentStatus;
  className?: string;
}) {
  const { t } = useTranslation('dialogs');
  if (status === 'checking' || status === 'installing') return null;
  const availability =
    status === 'check_failed' || status === 'unsupported'
      ? 'uninstalled'
      : status;
  const Icon = {
    ready: CheckCircle2,
    needs_auth: KeyRound,
    uninstalled: Download,
    install_failed: CircleAlert,
  }[availability];
  return (
    <Badge
      variant="outline"
      role="status"
      data-status={availability}
      className={cn(
        'onboarding-agent-status gap-1 whitespace-nowrap px-1.5 py-0.5 text-[11px] font-medium leading-[1.4]',
        STATUS_BADGE_CLASSES[availability],
        className
      )}
    >
      <Icon aria-hidden="true" className="h-3 w-3 shrink-0" />
      {t(`onboarding.agentStatus.${availability}`)}
    </Badge>
  );
}
