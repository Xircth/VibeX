import { AlertCircle, Check, Loader2, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentAvailabilityState } from '@/hooks/useAgentAvailability';

interface AgentAvailabilityIndicatorProps {
  availability: AgentAvailabilityState;
  /** When provided, the not-found state renders an inline quick-fix button. */
  onQuickFix?: () => void;
  fixing?: boolean;
  fixError?: string | null;
}

export function AgentAvailabilityIndicator({
  availability,
  onQuickFix,
  fixing = false,
  fixError = null,
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
      {availability.status === 'not_found' && (
        <>
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-warning" />
            <span className="text-warning">
              {t('agentAvailability.notFoundTitle')}
            </span>
          </div>
          <p className="text-xs text-muted-foreground pl-6">
            {t('agentAvailability.notFoundDescription')}
          </p>
          {onQuickFix ? (
            <div className="pl-6 pt-1">
              <button
                type="button"
                onClick={onQuickFix}
                disabled={fixing}
                className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-50"
              >
                {fixing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Wrench className="h-3.5 w-3.5" />
                )}
                {fixing
                  ? t('agentAvailability.fixing')
                  : t('agentAvailability.fixNow')}
              </button>
            </div>
          ) : null}
          {fixError ? (
            <p className="pl-6 text-xs text-destructive">
              {t('agentAvailability.fixFailed', { error: fixError })}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
