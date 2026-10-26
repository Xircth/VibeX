import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnimationEvent,
} from 'react';

import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';
import { COPY, formatWorkingMembersCopy } from './spaceModel';

export const WORKING_AVATAR_CYCLE_MS = 1600;
export const WORKING_AVATAR_FLIP_MS = 560;
export const WORKING_PHRASE_CYCLE_MS = 2600;

export type WorkingStatusMember = {
  name: string;
  avatar: MemberBotAvatarConfig;
};

function prefersReducedMotion() {
  return Boolean(
    typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
  );
}

function WorkingAvatar({ member }: { member: WorkingStatusMember }) {
  return (
    <MemberBotAvatar
      config={member.avatar}
      animated
      sessionActive
      className="collaboration-working-avatar"
    />
  );
}

export function CollaborationWorkingStatus({
  members,
}: {
  members: readonly WorkingStatusMember[];
}) {
  const namesKey = useMemo(
    () => members.map((member) => member.name).join('\0'),
    [members]
  );
  const [index, setIndex] = useState(0);
  const [outgoingIndex, setOutgoingIndex] = useState(0);
  const [flipping, setFlipping] = useState(false);
  const [phraseIndex, setPhraseIndex] = useState(0);
  const indexRef = useRef(0);
  const phrases = COPY.workingNowPhrases;

  useEffect(() => {
    setIndex(0);
    setOutgoingIndex(0);
    setFlipping(false);
    setPhraseIndex(0);
    indexRef.current = 0;
  }, [namesKey]);

  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  useEffect(() => {
    if (members.length < 2) return;
    const count = members.length;
    const id = window.setInterval(() => {
      const current = indexRef.current;
      const next = (current + 1) % count;
      setOutgoingIndex(current);
      setFlipping(!prefersReducedMotion());
      setIndex(next);
    }, WORKING_AVATAR_CYCLE_MS);
    return () => window.clearInterval(id);
  }, [members.length, namesKey]);

  useEffect(() => {
    if (phrases.length < 2) return;
    const count = phrases.length;
    const id = window.setInterval(() => {
      setPhraseIndex((current) => (current + 1) % count);
    }, WORKING_PHRASE_CYCLE_MS);
    return () => window.clearInterval(id);
  }, [namesKey, phrases.length]);

  useEffect(() => {
    if (!flipping) return;
    const id = window.setTimeout(() => {
      setFlipping(false);
    }, WORKING_AVATAR_FLIP_MS);
    return () => window.clearTimeout(id);
  }, [flipping, index]);

  if (members.length === 0) return null;
  const shown = members[index % members.length];
  const outgoing = members[outgoingIndex % members.length];
  const copy = formatWorkingMembersCopy(
    members.map((member) => member.name),
    phrases[phraseIndex % phrases.length] ?? COPY.workingNow
  );
  const showFlip = Boolean(
    flipping && outgoing && shown && outgoing.name !== shown.name
  );

  const handleFlipEnd = (event: AnimationEvent<HTMLSpanElement>) => {
    if (event.target !== event.currentTarget) return;
    if (
      event.animationName &&
      event.animationName !== 'collaboration-working-avatar-flip'
    ) {
      return;
    }
    setFlipping(false);
  };

  return (
    <div
      className="collaboration-working-status"
      data-testid="collaboration-working-status"
      role="status"
      aria-live="polite"
      aria-label={copy}
    >
      <span
        className="collaboration-working-avatar-slot"
        data-testid="collaboration-working-avatar"
        data-working-name={shown.name}
        data-flipping={flipping ? 'true' : 'false'}
      >
        <span
          className={
            showFlip
              ? 'collaboration-working-avatar-flipper is-flipping'
              : 'collaboration-working-avatar-flipper'
          }
          data-testid="collaboration-working-avatar-flipper"
          onAnimationEnd={handleFlipEnd}
        >
          {showFlip ? (
            <>
              <span
                className="collaboration-working-avatar-side collaboration-working-avatar-side--front"
                data-testid="collaboration-working-avatar-front"
                data-working-name={outgoing.name}
              >
                <WorkingAvatar member={outgoing} />
              </span>
              <span
                className="collaboration-working-avatar-side collaboration-working-avatar-side--back"
                data-testid="collaboration-working-avatar-back"
                data-working-name={shown.name}
              >
                <WorkingAvatar member={shown} />
              </span>
            </>
          ) : (
            <WorkingAvatar member={shown} />
          )}
        </span>
      </span>
      <span className="collaboration-working-copy">{copy}</span>
    </div>
  );
}
