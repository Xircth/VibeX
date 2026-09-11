import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, ShieldCheck, X } from 'lucide-react';
import type { AgentId, PiProjectTrustStateView } from 'shared/types';

import { Button } from '@/components/ui/button';
import { agentManagementApi } from '@/features/agent-management';
import { agentManagementErrorMessage as errorMessage } from '@/features/agent-management';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

export function PiProjectTrustBanner({
  agentId,
  workingDir,
  turnInFlight,
}: {
  agentId: AgentId | string | null | undefined;
  workingDir: string | null | undefined;
  turnInFlight: boolean;
}) {
  const { t } = useTranslation('conversation');
  const [state, setState] = useState<PiProjectTrustStateView | null>(null);
  const [requestedFor, setRequestedFor] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [applying, setApplying] = useState(false);
  const generation = useRef(0);
  const eligible = agentId === 'pi' && Boolean(workingDir);

  const refresh = useCallback(async () => {
    if (!eligible || !workingDir) return;
    const issuedAt = generation.current;
    const requested = workingDir;
    try {
      const next = await agentManagementApi.piProjectTrustState(requested);
      if (generation.current !== issuedAt) return;
      setRequestedFor(requested);
      setState(next);
    } catch {
      if (generation.current !== issuedAt) return;
      setState(null);
    }
  }, [eligible, workingDir]);

  useEffect(() => {
    generation.current += 1;
    setState(null);
    if (!eligible) return;
    void refresh();
    setDismissed(false);
  }, [eligible, refresh]);

  const current =
    state && eligible && requestedFor === workingDir ? state : null;
  const hasResources = Boolean(current && current.resources.length > 0);
  const undecided = hasResources && current?.decision === null;
  const undisclosedGrant =
    hasResources && current?.decision === true && !current.acknowledged;
  const visible = (undecided || undisclosedGrant) && !dismissed && current;
  if (!visible || !current) return null;

  const executes = current.resources.some((resource) => resource.executes_code);
  const inherited =
    Boolean(current.decided_at) && current.decided_at !== current.workspace;
  const busy = applying;
  const actionDisabled = turnInFlight || busy;

  const decide = async (trusted: boolean | null) => {
    if (actionDisabled) return;
    setApplying(true);
    try {
      await agentManagementApi.setPiProjectTrust(current.workspace, trusted);
      if (trusted === false) {
        toast.success(t('piProjectTrust.declinedToast'));
      } else {
        toast.success(
          trusted
            ? t('piProjectTrust.trustedToast')
            : t('piProjectTrust.revokedToast')
        );
      }
      await refresh();
    } catch (cause) {
      toast.error(errorMessage(cause, t('piProjectTrust.saveFailed')));
    } finally {
      setApplying(false);
    }
  };

  const keepGrant = async () => {
    if (actionDisabled) return;
    setApplying(true);
    try {
      await agentManagementApi.acknowledgePiProjectTrust(current.workspace);
      toast.success(t('piProjectTrust.keptToast'));
      await refresh();
    } catch (cause) {
      toast.error(errorMessage(cause, t('piProjectTrust.saveFailed')));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      className="border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
      role="status"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 leading-snug">
          <span className="font-medium">
            {undisclosedGrant
              ? t('piProjectTrust.grantTitle')
              : t('piProjectTrust.title')}
          </span>{' '}
          <span className="opacity-80">
            {undisclosedGrant
              ? inherited
                ? t('piProjectTrust.grantInheritedDescription')
                : t('piProjectTrust.grantDescription')
              : executes
                ? t('piProjectTrust.descriptionExecutable')
                : t('piProjectTrust.description')}
          </span>
          <ul className="mt-1 space-y-0.5 font-mono text-[11px] opacity-80">
            {current.resources.map((resource) => (
              <li key={resource.path} className="break-all">
                <span
                  className={cn(
                    'mr-1 rounded px-1 py-px',
                    resource.executes_code
                      ? 'bg-destructive/15 text-destructive'
                      : 'bg-muted text-muted-foreground'
                  )}
                >
                  {resource.kind}
                </span>
                {resource.path}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {undisclosedGrant ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                disabled={actionDisabled}
                onClick={() => void decide(null)}
              >
                {busy ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : null}
                {t('piProjectTrust.revoke')}
              </Button>
              <Button
                size="sm"
                className="h-7"
                disabled={actionDisabled}
                onClick={() => void keepGrant()}
              >
                <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                {t('piProjectTrust.keepTrusted')}
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                disabled={actionDisabled}
                onClick={() => void decide(false)}
              >
                {t('piProjectTrust.decline')}
              </Button>
              <Button
                size="sm"
                className="h-7"
                disabled={actionDisabled}
                onClick={() => void decide(true)}
              >
                {busy ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="mr-1 h-3.5 w-3.5" />
                )}
                {t('piProjectTrust.trust')}
              </Button>
            </>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            aria-label={t('piProjectTrust.dismiss')}
            onClick={() => setDismissed(true)}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
