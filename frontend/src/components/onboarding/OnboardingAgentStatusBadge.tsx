import { CheckCircle2, CircleAlert, Download, KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { OnboardingAgentStatus } from './onboardingAgentModel';

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
      className={cn('onboarding-agent-status', className)}
    >
      <Icon aria-hidden="true" className="h-3 w-3 shrink-0" />
      {t(`onboarding.agentStatus.${availability}`)}
    </Badge>
  );
}
