import React, { createContext, useContext } from 'react';
import {
  MemberBotAvatar,
  deriveMemberBotAvatar,
  type MemberBotAvatarConfig,
} from './MemberBotAvatar';
import { splitTextByMemberMentions } from './memberMentions';

export { splitTextByMemberMentions } from './memberMentions';

export interface CollaborationMemberMentionEntry {
  nickname: string;
  avatar: MemberBotAvatarConfig;
}

export interface CollaborationMemberMentionContextValue {
  enableMemberMentions: boolean;
  membersByNickname: ReadonlyMap<string, MemberBotAvatarConfig>;
  knownNicknames: readonly string[];
  resolveMemberAvatar: (nickname: string) => MemberBotAvatarConfig;
}

const defaultContextValue: CollaborationMemberMentionContextValue = {
  enableMemberMentions: false,
  membersByNickname: new Map(),
  knownNicknames: [],
  resolveMemberAvatar: (nickname: string) => deriveMemberBotAvatar(nickname),
};

export const CollaborationMemberMentionContext =
  createContext<CollaborationMemberMentionContextValue>(defaultContextValue);

export function useCollaborationMemberMention(): CollaborationMemberMentionContextValue {
  return useContext(CollaborationMemberMentionContext);
}

export function isBroadcastMemberNickname(nickname: string): boolean {
  const clean = nickname.replace(/^@+/, '').trim();
  return clean === '全体成员' || clean === '全体';
}

export function buildMemberMentionContextValue(
  entries: readonly CollaborationMemberMentionEntry[],
  enableMemberMentions = true
): CollaborationMemberMentionContextValue {
  const map = new Map<string, MemberBotAvatarConfig>();
  for (const entry of entries) {
    const trimmed = entry.nickname.trim();
    if (!trimmed) continue;
    if (!map.has(trimmed)) {
      map.set(trimmed, entry.avatar);
    }
  }
  const knownNicknames = Array.from(map.keys()).sort(
    (a, b) => b.length - a.length
  );
  return {
    enableMemberMentions,
    membersByNickname: map,
    knownNicknames,
    resolveMemberAvatar: (nickname: string) =>
      map.get(nickname.trim()) ??
      deriveMemberBotAvatar(nickname.trim() || 'member'),
  };
}

export interface MemberMentionChipProps {
  nickname: string;
  avatar?: MemberBotAvatarConfig | null;
  className?: string;
  tokenAttribute?: string;
}

export function MemberMentionChip({
  nickname,
  avatar,
  className = '',
  tokenAttribute,
}: MemberMentionChipProps) {
  const ctx = useCollaborationMemberMention();
  const cleanName = nickname.replace(/^@+/, '').trim();
  const isBroadcast =
    !avatar &&
    !ctx.membersByNickname.has(cleanName) &&
    isBroadcastMemberNickname(cleanName);
  if (isBroadcast) {
    return (
      <span
        className={`collaboration-member-mention-chip collaboration-member-mention-all ${className}`.trim()}
        data-testid={`collaboration-member-mention-chip-${cleanName}`}
        data-member-mention={cleanName}
        data-mention-all="true"
        data-astryx-token={tokenAttribute}
        style={
          {
            display: 'inline',
            verticalAlign: 'baseline',
            lineHeight: 'inherit',
            background: 'transparent',
            backgroundColor: 'transparent',
            padding: 0,
            borderRadius: 0,
            border: 0,
            boxShadow: 'none',
          } as React.CSSProperties
        }
      >
        <span className="collaboration-member-mention-name">@{cleanName}</span>
      </span>
    );
  }

  const resolvedAvatar = avatar ?? ctx.resolveMemberAvatar(cleanName);
  const color = resolvedAvatar.color || '#2563eb';

  return (
    <span
      className={`collaboration-member-mention-chip ${className}`.trim()}
      data-testid={`collaboration-member-mention-chip-${cleanName}`}
      data-member-mention={cleanName}
      data-astryx-token={tokenAttribute}
      style={
        {
          '--member-mention-color': color,
          display: 'inline',
          verticalAlign: 'baseline',
          lineHeight: 'inherit',
          background: 'transparent',
          backgroundColor: 'transparent',
          padding: 0,
          borderRadius: 0,
          border: 0,
          boxShadow: 'none',
        } as React.CSSProperties
      }
    >
      <MemberBotAvatar
        config={resolvedAvatar}
        className="collaboration-member-mention-avatar"
      />
      <span className="collaboration-member-mention-name">{cleanName}</span>
    </span>
  );
}

export const MEMBER_PLACEHOLDER_PATTERN = /\uE100MEMBER(\d+)\uE100/g;

function replaceMentionsInPlainSegment(
  segment: string,
  knownNicknames: readonly string[],
  mentions: string[]
): string {
  const parts = splitTextByMemberMentions(segment, knownNicknames);
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return segment;
  }
  return parts
    .map((part) => {
      if (part.type === 'text') return part.value;
      const index = mentions.length;
      mentions.push(part.nickname);
      return `\uE100MEMBER${index}\uE100`;
    })
    .join('');
}

function replaceMentionsOutsideInlineCode(
  line: string,
  knownNicknames: readonly string[],
  mentions: string[]
): string {
  if (!line.includes('@')) return line;
  let result = '';
  let cursor = 0;
  while (cursor < line.length) {
    const opening = line.indexOf('`', cursor);
    if (opening < 0) {
      result += replaceMentionsInPlainSegment(
        line.slice(cursor),
        knownNicknames,
        mentions
      );
      break;
    }
    result += replaceMentionsInPlainSegment(
      line.slice(cursor, opening),
      knownNicknames,
      mentions
    );
    const run = line.slice(opening).match(/^`+/)?.[0] ?? '`';
    const closing = line.indexOf(run, opening + run.length);
    if (closing < 0) {
      result += line.slice(opening);
      break;
    }
    result += line.slice(opening, closing + run.length);
    cursor = closing + run.length;
  }
  return result;
}

export function protectMemberMentions(
  source: string,
  knownNicknames: readonly string[]
): { text: string; mentions: string[] } {
  if (!source || !source.includes('@')) {
    return { text: source, mentions: [] };
  }
  const mentions: string[] = [];
  let inFence = false;
  const text = source
    .split('\n')
    .map((line) => {
      if (/^\s*(?:`{3,}|~{3,})/u.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return replaceMentionsOutsideInlineCode(line, knownNicknames, mentions);
    })
    .join('\n');
  return { text, mentions };
}

export function renderTextWithMemberMentions(
  text: string,
  ctx: CollaborationMemberMentionContextValue,
  keyPrefix = 'mention'
): React.ReactNode {
  const segments = splitTextByMemberMentions(text, ctx.knownNicknames);
  if (segments.length === 1 && segments[0]?.type === 'text') {
    return text;
  }
  return segments.map((segment, index) => {
    if (segment.type === 'text') {
      return (
        <React.Fragment key={`${keyPrefix}-t-${index}`}>
          {segment.value}
        </React.Fragment>
      );
    }
    return (
      <MemberMentionChip
        key={`${keyPrefix}-m-${index}-${segment.nickname}`}
        nickname={segment.nickname}
        avatar={ctx.resolveMemberAvatar(segment.nickname)}
      />
    );
  });
}
