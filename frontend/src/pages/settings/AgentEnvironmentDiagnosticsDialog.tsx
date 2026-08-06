import {
  CheckCircle2,
  CircleAlert,
  Copy,
  Info,
  Loader2,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentEnvironmentDiagnosticLevel,
  AgentEnvironmentDiagnosticsView,
  AgentId,
} from 'shared/types';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage,
} from '@/features/agent-management';
import { cn } from '@/lib/utils';

type Props = {
  agentId: AgentId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function AgentEnvironmentDiagnosticsDialog({
  agentId,
  open,
  onOpenChange,
}: Props) {
  const { t } = useTranslation('settings');
  const [report, setReport] = useState<AgentEnvironmentDiagnosticsView | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await agentManagementApi.environmentDiagnostics(agentId));
    } catch (cause) {
      setError(
        agentManagementErrorMessage(
          cause,
          t('agents.environmentDiagnosticsFailed')
        )
      );
    } finally {
      setLoading(false);
    }
  }, [agentId, t]);

  useEffect(() => {
    if (open) {
      void load();
    } else {
      setReport(null);
      setError(null);
    }
  }, [load, open]);

  const copy = useCallback(async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.plain_text);
      toast.success(t('agents.environmentDiagnosticsCopied'));
    } catch {
      toast.error(t('agents.environmentDiagnosticsCopyFailed'));
    }
  }, [report, t]);

  return (
    <Dialog
      aria-labelledby="agent-environment-diagnostics-title"
      className="max-w-3xl"
      open={open}
      onOpenChange={onOpenChange}
    >
      <DialogHeader>
        <DialogTitle id="agent-environment-diagnostics-title">
          {t('agents.environmentDiagnosticsTitle')}
        </DialogTitle>
        <DialogDescription>
          {t('agents.environmentDiagnosticsDescription')}
        </DialogDescription>
      </DialogHeader>
      <DialogContent>
        <div className="max-h-[60vh] min-h-32 space-y-3 overflow-y-auto pr-1">
          {loading && !report ? (
            <p
              aria-live="polite"
              className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
            >
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              {t('agents.environmentDiagnosticsRunning')}
            </p>
          ) : null}
          {error ? (
            <p
              className="rounded-md bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          {report ? (
            <>
              <div
                className={cn(
                  'flex items-start gap-2 rounded-md border px-3 py-2 text-sm font-medium',
                  verdictClass(report.verdict_level)
                )}
                role="status"
              >
                <DiagnosticIcon level={report.verdict_level} />
                {t(
                  `agents.environmentDiagnosticVerdict.${report.verdict_code}`,
                  {
                    defaultValue: report.verdict_code,
                  }
                )}
              </div>
              {report.sections.map((section) => (
                <section
                  className="overflow-hidden rounded-md border"
                  key={section.id}
                >
                  <h4 className="border-b bg-muted/30 px-3 py-2 text-xs font-semibold">
                    {t(section.title_key, {
                      defaultValue: humanize(section.id),
                    })}
                  </h4>
                  <ul className="divide-y">
                    {section.checks.map((check) => (
                      <li
                        className="flex items-start gap-2.5 px-3 py-2"
                        key={check.id}
                      >
                        <DiagnosticIcon level={check.level} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2">
                            <strong className="text-xs">
                              {t(check.label_key, {
                                defaultValue: humanize(check.id),
                              })}
                            </strong>
                            <code className="break-all text-[11px] text-muted-foreground">
                              {localizedDiagnosticValue(t, check.value)}
                            </code>
                          </div>
                          {check.detail_key ? (
                            <p className="mt-0.5 text-[11px] text-muted-foreground">
                              {t(check.detail_key)}
                            </p>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              <p className="text-center text-[11px] text-muted-foreground">
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'medium',
                }).format(new Date(report.generated_at))}
              </p>
            </>
          ) : null}
        </div>
      </DialogContent>
      <DialogFooter className="sm:justify-between">
        <Button
          disabled={loading}
          size="sm"
          variant="outline"
          onClick={() => void load()}
        >
          <RefreshCw
            aria-hidden="true"
            className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')}
          />
          {t('agents.environmentDiagnosticsRerun')}
        </Button>
        <Button
          disabled={loading || !report}
          size="sm"
          onClick={() => void copy()}
        >
          <Copy aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          {t('agents.environmentDiagnosticsCopy')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function DiagnosticIcon({ level }: { level: AgentEnvironmentDiagnosticLevel }) {
  const Icon =
    level === 'ok'
      ? CheckCircle2
      : level === 'warning'
        ? CircleAlert
        : level === 'error'
          ? XCircle
          : Info;
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        'mt-0.5 h-3.5 w-3.5 shrink-0',
        level === 'ok'
          ? 'text-success'
          : level === 'warning'
            ? 'text-warning'
            : level === 'error'
              ? 'text-destructive'
              : 'text-muted-foreground'
      )}
    />
  );
}

function verdictClass(level: AgentEnvironmentDiagnosticLevel): string {
  if (level === 'ok') return 'border-success/30 bg-success/10 text-success';
  if (level === 'warning')
    return 'border-warning/30 bg-warning/10 text-warning';
  if (level === 'error')
    return 'border-destructive/30 bg-destructive/10 text-destructive';
  return 'bg-muted/30 text-foreground';
}

function humanize(value: string): string {
  return value
    .replace(/^dependency\.|^component\./u, '')
    .split(/[._-]+/u)
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ');
}

function localizedDiagnosticValue(
  t: TFunction<'settings'>,
  value: string
): string {
  if (value === 'none') return t('agents.environmentDiagnosticNone');
  if (value === 'managed installation lock')
    return t('agents.environmentDiagnosticManagedLock');
  if (value === 'NOT RESOLVED')
    return t('agents.environmentDiagnosticNotResolved');
  return value;
}
