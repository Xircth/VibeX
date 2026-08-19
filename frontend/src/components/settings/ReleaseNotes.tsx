import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { localizeReleaseNotes } from '@/lib/appUpdate';

interface ReleaseNotesProps {
  notes: string;
  locale: string;
  emptyLabel: string;
  className?: string;
}

export function ReleaseNotes({
  notes,
  locale,
  emptyLabel,
  className,
}: ReleaseNotesProps) {
  const localized = localizeReleaseNotes(notes, locale);

  if (!localized) {
    return (
      <p className="text-xs leading-5 text-muted-foreground">{emptyLabel}</p>
    );
  }

  return (
    <AstryxMarkdown
      value={localized}
      className={
        className ??
        'max-h-72 overflow-auto text-xs leading-6 text-muted-foreground'
      }
    />
  );
}
