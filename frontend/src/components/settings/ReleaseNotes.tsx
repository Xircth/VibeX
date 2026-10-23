import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { localizeReleaseNotes } from '@/lib/appUpdate';
import { cn } from '@/lib/utils';

interface ReleaseNotesProps {
  notes: string;
  locale: string;
  emptyLabel?: string;
  label?: string;
  className?: string;
}

export function ReleaseNotes({
  notes,
  locale,
  emptyLabel,
  label,
  className,
}: ReleaseNotesProps) {
  const localized = localizeReleaseNotes(notes, locale);

  if (!localized) {
    return emptyLabel ? (
      <p className="settings-row__description">{emptyLabel}</p>
    ) : null;
  }

  return (
    <div
      role={label ? 'region' : undefined}
      aria-label={label}
      tabIndex={0}
      className={cn(
        'settings-release-notes max-h-56 overflow-auto rounded-md border border-border bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground',
        className
      )}
    >
      <AstryxMarkdown
        value={localized}
        className="settings-release-notes__body"
      />
    </div>
  );
}
