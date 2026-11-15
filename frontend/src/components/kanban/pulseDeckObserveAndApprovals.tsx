import { useTranslation } from 'react-i18next';
import { ArrowUpRight, BellRing, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type {
  PulseDryRunReport,
  PulseObservedCandidateView,
  PulseUserInteractionView,
} from '@/lib/api/pulse';
import { cn } from '@/lib/utils';
import { PulseInteractionCard } from './pulseInteractionForm';

export function PulseDeckApprovalsAndObserve({
  showApprovals,
  pendingInteractions,
  onInteractionResolved,
  showObserve,
  candidates,
  inspectedCandidateId,
  inspectedReport,
  onInspectDryRun,
  onPromoteCandidate,
}: {
  showApprovals: boolean;
  pendingInteractions: readonly PulseUserInteractionView[];
  onInteractionResolved: (interactionId: string) => void;
  showObserve: boolean;
  candidates: readonly PulseObservedCandidateView[];
  inspectedCandidateId: string | null;
  inspectedReport: PulseDryRunReport | null;
  onInspectDryRun: (candidate: PulseObservedCandidateView) => void;
  onPromoteCandidate: (candidate: PulseObservedCandidateView) => void;
}) {
  const { t } = useTranslation('panels');

  return (
    <>
      {showApprovals ? (
        <section
          aria-label={t('pulseDeck.interactionsAria')}
          className="space-y-2"
          data-testid="pulse-deck-interactions-section"
        >
          <div className="flex items-center justify-between">
            <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <BellRing className="h-3.5 w-3.5 text-warning" />
              {t('pulseDeck.interactionsTitle')}
              <span
                className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground tabular-nums"
                data-testid="pulse-deck-interactions-count"
              >
                {pendingInteractions.length}
              </span>
            </h3>
          </div>

          {pendingInteractions.length === 0 ? (
            <div
              className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-muted-foreground"
              data-testid="pulse-deck-interactions-empty"
            >
              {t('pulseDeck.interactionsEmpty')}
            </div>
          ) : (
            <div
              className="grid grid-cols-1 gap-2 lg:grid-cols-2"
              data-testid="pulse-deck-interactions-list"
            >
              {pendingInteractions.map((interaction) => (
                <PulseInteractionCard
                  key={interaction.id}
                  interaction={interaction}
                  onResolved={onInteractionResolved}
                  className="settings-surface bg-popover"
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {showObserve ? (
        <section aria-label={t('pulseDeck.observeAria')} className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <Eye className="h-3.5 w-3.5 text-warning" />
              {t('pulseDeck.observeTitle')}
              <span
                className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground tabular-nums"
                data-testid="pulse-deck-candidates-count"
              >
                {candidates.length}
              </span>
            </h3>
          </div>

          {candidates.length === 0 ? (
            <div
              className="rounded-md border border-border/70 bg-muted/20 px-3 py-3 text-muted-foreground"
              data-testid="pulse-deck-candidates-empty"
            >
              {t('pulseDeck.observeEmpty')}
            </div>
          ) : (
            <div className="space-y-2" data-testid="pulse-deck-candidates-list">
              {candidates.map((candidate) => (
                <div
                  key={candidate.id}
                  data-testid={`pulse-observed-candidate-${candidate.id}`}
                  className="settings-surface space-y-2 rounded-md border border-border bg-popover p-2.5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-foreground">
                          {candidate.ruleName}
                        </span>
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {candidate.sourceKind} · {candidate.eventType}
                        </span>
                        {candidate.threadKey ? (
                          <span className="font-mono text-[11px] text-primary">
                            {candidate.threadKey}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-foreground">
                        {candidate.summary}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        type="button"
                        size="xs"
                        variant="secondary"
                        data-testid={`pulse-candidate-inspect-${candidate.id}`}
                        onClick={() => onInspectDryRun(candidate)}
                      >
                        {t('pulseDeck.inspectDryRun')}
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="primary"
                        disabled={candidate.promoted}
                        data-testid={`pulse-candidate-promote-${candidate.id}`}
                        onClick={() => onPromoteCandidate(candidate)}
                        icon={<ArrowUpRight className="h-3 w-3" />}
                      >
                        {candidate.promoted
                          ? t('pulseDeck.promoted')
                          : t('pulseDeck.promoteToAuto')}
                      </Button>
                    </div>
                  </div>

                  {inspectedCandidateId === candidate.id && inspectedReport ? (
                    <div
                      className="border-t border-border/60 pt-2 text-[11px]"
                      data-testid={`pulse-candidate-dryrun-${candidate.id}`}
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <span className="font-medium text-foreground">
                          {t('pulseDeck.dryRunEvaluation')}
                        </span>
                        <span
                          className={cn(
                            'font-medium tabular-nums',
                            inspectedReport.matched
                              ? 'text-success'
                              : 'text-warning'
                          )}
                        >
                          {inspectedReport.matched
                            ? t('pulseDeck.matched')
                            : t('pulseDeck.filtered')}
                        </span>
                      </div>
                      {inspectedReport.renderedPreviews[0] ? (
                        <pre className="whitespace-pre-wrap rounded bg-muted/45 p-2 font-mono text-[11px] text-muted-foreground">
                          {inspectedReport.renderedPreviews[0]}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}
