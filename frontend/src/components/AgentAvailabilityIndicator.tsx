import { Check, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentAvailabilityState } from '@/hooks/useAgentAvailability';

interface AgentAvailabilityIndicatorProps {
  availability: AgentAvailabilityState;
}

export function AgentAvailabilityIndicator({
  availability,
}: AgentAvailabilityIndicatorProps) {
  const { t } = useTranslation(['app', 'common']);

  if (!availability) return null;

  return (
    <div className="flex flex-col gap-1 text-sm">
      {availability.status === 'checking' && (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          <span className="text-muted-foreground">
            {t('agentAvailability.checking')}
          </span>
        </div>
      )}
      {availability.status === 'login_detected' && (
        <>
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-success" />
            <span className="text-success">
              {t('agentAvailability.loginDetectedTitle')}
            </span>
          </div>
          <p className="text-xs text-muted-foreground pl-6">
            {t('agentAvailability.loginDetectedDescription')}
          </p>
        </>
      )}
      {availability.status === 'installation_found' && (
        <>
          <div className="flex items-center gap-2">
            <Check className="h-4 w-4 text-success" />
            <span className="text-success">
              {t('agentAvailability.installationFoundTitle')}
            </span>
          </div>
          <p className="text-xs text-muted-foreground pl-6">
            {t('agentAvailability.installationFoundDescription')}
          </p>
        </>
      )}
    </div>
  );
}
