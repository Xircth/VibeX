import { useRef } from 'react';
import { Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SessionComposerInput } from '@/components/tasks/follow-up/SessionComposerInput';
import type { AtReferenceMember } from '@/components/tasks/follow-up/composerAtReferences';

import { THREAD_COPY } from './threadModel';

/**
 * Collaboration thread composer: the project's unified SessionComposerInput
 * (atomic `@member` MemberMention chips, @ menu, history, IME handling) plus
 * the thread send button. The serialized value stays plain `@nickname` text.
 */
export function CollabComposer({
  value,
  onChange,
  onSubmit,
  members,
  label,
  sessionId,
  disabled,
  workspaceId,
  workspacePath,
  replaceValueRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  members: readonly AtReferenceMember[];
  label: string;
  sessionId: string;
  disabled?: boolean;
  workspaceId?: string;
  workspacePath?: string;
  replaceValueRef?: React.RefObject<((next: string) => void) | null>;
}) {
  const fallbackRef = useRef<((next: string) => void) | null>(null);
  return (
    <div
      className="collab-composer-box"
      role="group"
      aria-label={label}
      data-testid="collab-composer"
    >
      <div className="min-w-0 flex-1">
        <SessionComposerInput
          value={value}
          disabled={disabled}
          replaceValueRef={replaceValueRef ?? fallbackRef}
          context={{
            sessionId,
            workspaceId,
            workspacePath,
            spaceMembers: [...members],
          }}
          onChange={onChange}
          onSubmit={onSubmit}
          onAttachImages={() => undefined}
        />
      </div>
      <Button
        variant="icon"
        aria-label={THREAD_COPY.send}
        disabled={!value.trim() || disabled}
        onClick={() => onSubmit(value)}
      >
        <Send className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
