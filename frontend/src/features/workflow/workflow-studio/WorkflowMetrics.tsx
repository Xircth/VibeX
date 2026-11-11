import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export function WorkflowMetrics({
  nodeCount,
  agentCount,
  releaseVersion,
  dirty,
}: {
  nodeCount: number;
  agentCount: number;
  releaseVersion?: string;
  dirty: boolean;
}) {
  const { t } = useTranslation('workflow');
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className="workflow-studio-floating-controls pointer-events-auto flex h-10 shrink-0 items-center gap-1.5 px-3 text-[10px] text-muted-foreground"
      aria-expanded={open}
      aria-label={t('studio.previewInformation')}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={() => setOpen((current) => !current)}
    >
      <span>{t('studio.nodeCount', { count: nodeCount })}</span>
      {open ? (
        <>
          <span aria-hidden="true">·</span>
          <span>{t('studio.agentCount', { count: agentCount })}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">v{releaseVersion ?? '0.1'}</span>
        </>
      ) : null}
      {dirty ? (
        <span
          className="size-1.5 rounded-full bg-warning"
          title={t('studio.unsaved')}
        />
      ) : null}
    </button>
  );
}
