import { GroupAvatar } from './GroupAvatar';
import { type MemberBotAvatarConfig } from './MemberBotAvatar';
import { MemberMentionChip } from './MemberMentionChip';
import { COPY, type CrossChatPeer } from './spaceModel';

export const CROSS_CHAT_GROUP_AVATAR_PX = 20;

export function CrossChatPeerChip({
  peer,
  memberAvatar,
  groupAvatars,
}: {
  peer: CrossChatPeer;
  memberAvatar?: MemberBotAvatarConfig | null;
  groupAvatars?: readonly MemberBotAvatarConfig[];
}) {
  if (peer.kind === 'group') {
    return (
      <span
        className="collaboration-member-mention-chip collaboration-cross-chat-group-chip"
        data-testid={`collaboration-cross-chat-peer-${peer.name}`}
      >
        <GroupAvatar
          avatars={groupAvatars ?? []}
          size={CROSS_CHAT_GROUP_AVATAR_PX}
          data-testid={`collaboration-cross-chat-group-avatar-${peer.name}`}
        />
        <span className="collaboration-member-mention-name">{peer.name}</span>
      </span>
    );
  }
  return <MemberMentionChip nickname={peer.name} avatar={memberAvatar} />;
}

export function CollaborationCrossChatNotice({
  kind,
  peers,
  lineColor,
  seq,
  memberAvatarFor,
  groupAvatarsFor,
}: {
  kind: 'sent' | 'received';
  peers: readonly CrossChatPeer[];
  lineColor: string;
  seq: number | string;
  memberAvatarFor?: (peer: CrossChatPeer) => MemberBotAvatarConfig | undefined;
  groupAvatarsFor?: (peer: CrossChatPeer) => readonly MemberBotAvatarConfig[];
}) {
  if (peers.length === 0) return null;
  const testId =
    kind === 'sent'
      ? `collaboration-cross-chat-sent-${seq}`
      : `collaboration-cross-chat-received-${seq}`;
  return (
    <div
      className={
        kind === 'received'
          ? 'collaboration-cross-chat-notices is-received'
          : 'collaboration-cross-chat-notices'
      }
      data-testid={testId}
    >
      {peers.map((peer) => (
        <span
          key={`${kind}-${peer.kind}-${peer.id ?? peer.name}`}
          className="collaboration-cross-chat-notice"
          style={{ ['--cross-chat-line-color' as string]: lineColor }}
        >
          {kind === 'received' ? (
            <>
              <span>{COPY.crossChatReceivedPrefix}</span>
              <CrossChatPeerChip
                peer={peer}
                memberAvatar={memberAvatarFor?.(peer)}
                groupAvatars={groupAvatarsFor?.(peer)}
              />
              <span>{COPY.crossChatReceivedSuffix}</span>
            </>
          ) : (
            <>
              <span>{COPY.crossChatSentPrefix}</span>
              <CrossChatPeerChip
                peer={peer}
                memberAvatar={memberAvatarFor?.(peer)}
                groupAvatars={groupAvatarsFor?.(peer)}
              />
            </>
          )}
        </span>
      ))}
    </div>
  );
}
