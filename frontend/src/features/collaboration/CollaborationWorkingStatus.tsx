import { useEffect, useMemo, useState } from 'react';

import { MemberBotAvatar, type MemberBotAvatarConfig } from './MemberBotAvatar';
import { formatWorkingMembersCopy } from './spaceModel';

export const WORKING_AVATAR_CYCLE_MS = 1600;

export type WorkingStatusMember = {
  name: string;
  avatar: MemberBotAvatarConfig;
};

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

  useEffect(() => {
    setIndex(0);
  }, [namesKey]);

  useEffect(() => {
    if (members.length < 2) return;
    const count = members.length;
    const id = window.setInterval(() => {
      setIndex((current) => (current + 1) % count);
    }, WORKING_AVATAR_CYCLE_MS);
    return () => window.clearInterval(id);
  }, [members.length, namesKey]);

  if (members.length === 0) return null;
  const shown = members[index % members.length];
  const copy = formatWorkingMembersCopy(members.map((member) => member.name));

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
      >
        <MemberBotAvatar
          config={shown.avatar}
          animated={false}
          className="collaboration-working-avatar"
        />
      </span>
      <span className="collaboration-working-copy">{copy}</span>
    </div>
  );
}
