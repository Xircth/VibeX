import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { localizeReleaseNotes } from '@/lib/appUpdate';

interface ReleaseNotesProps {
  notes: string;
  locale: string;
  emptyLabel: string;
  label: string;
}

export function ReleaseNotes({
  notes,
  locale,
  emptyLabel,
  label,
}: ReleaseNotesProps) {
  const localized = localizeReleaseNotes(notes, locale);

  if (!localized) {
    return <p className="settings-row__description">{emptyLabel}</p>;
  }

  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className="settings-release-notes"
    >
      <AstryxMarkdown
        value={localized}
        className="settings-release-notes__body"
      />
    </div>
  );
}
