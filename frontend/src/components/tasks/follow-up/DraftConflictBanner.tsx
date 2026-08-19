import { useTranslation } from 'react-i18next';

export function DraftConflictBanner({
  onKeepServer,
  onKeepLocal,
}: {
  onKeepServer: () => void;
  onKeepLocal: () => void;
}) {
  const { t } = useTranslation(['conversation']);

  return (
    <div
      className="flex items-center justify-between gap-2 rounded-md border border-border bg-background px-2 py-1.5"
      data-testid="draft-conflict-banner"
    >
      <p className="text-xs text-foreground">{t('draftConflict.title')}</p>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          className="h-7 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onKeepServer}
        >
          {t('draftConflict.keepServer')}
        </button>
        <button
          type="button"
          className="h-7 rounded-md px-2 text-xs text-foreground hover:bg-muted"
          onClick={onKeepLocal}
        >
          {t('draftConflict.keepLocal')}
        </button>
      </div>
    </div>
  );
}
