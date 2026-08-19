import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, GitBranch, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { WorkflowRunView, WorkflowStepView } from 'shared/types';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useBackendTransport } from '@/lib/transport';
import { createWorkflowApi } from './workflowApi';
import { workflowProgress } from './workflowProjection';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export function WorkflowRunCard({ runId }: { runId: string }) {
  const { t } = useTranslation('workflow');
  const transport = useBackendTransport();
  const api = useMemo(() => createWorkflowApi(transport), [transport]);
  const [run, setRun] = useState<WorkflowRunView | null>(null);
  const [steps, setSteps] = useState<WorkflowStepView[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const [nextRun, nextSteps] = await Promise.all([
          api.show(runId),
          api.steps(runId),
        ]);
        if (!active) return;
        setRun(nextRun);
        setSteps(nextSteps);
        setFailed(false);
        if (!TERMINAL.has(nextRun.status)) {
          timer = window.setTimeout(load, 1500);
        }
      } catch {
        if (active) setFailed(true);
      }
    };
    void load();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, runId]);

  if (failed) return null;
  if (!run) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('loading')}
      </div>
    );
  }
  const progress = workflowProgress(steps);

  return (
    <Card className="mb-3 overflow-hidden border-border/80 bg-card/90 p-0 shadow-sm">
      <div className="flex items-start justify-between gap-3 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-primary" />
            <span className="text-xs font-semibold tracking-wide">
              {t('eyebrow')}
            </span>
            <Badge variant="secondary">{t(`status.${run.status}`)}</Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('progress', { done: progress.done, total: progress.total })}
          </p>
        </div>
        <Link
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
          to={`/workflows/${runId}`}
        >
          {t('openInspector')}
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <Progress value={progress.percent} className="h-1 rounded-none" />
    </Card>
  );
}
