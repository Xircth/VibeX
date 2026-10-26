import { X } from 'lucide-react';
import i18n from '@/i18n';

export function replyCapsuleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function CollaborationReplyCapsule({
  text,
  onDismiss,
}: {
  text: string;
  onDismiss: () => void;
}) {
  const display = replyCapsuleText(text);
  if (!display) return null;
  return (
    <div
      className="collaboration-reply-capsule"
      data-testid="collaboration-reply-capsule"
    >
      <p className="collaboration-reply-capsule-text">{display}</p>
      <button
        type="button"
        className="collaboration-reply-capsule-dismiss"
        aria-label={i18n.t('panels:collabCopy.dismissReply')}
        onClick={onDismiss}
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
