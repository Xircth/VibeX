import type { CSSProperties } from 'react';
import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';

import {
  MemberBotAvatar,
  normalizeHexColor,
  type MemberBotAvatarConfig,
} from './MemberBotAvatar';
import './chatUiPolish.css';

/** A space member that `@nickname` mentions can resolve to. */
export type MemberMentionCandidate = {
  nickname: string;
  avatar: MemberBotAvatarConfig;
};

/**
 * Shared member mention chip: small bot avatar + bold name tinted with the
 * avatar colour. Used in rendered messages and (as static markup) inside the
 * composer's atomic token span.
 */
export function MemberMention({
  nickname,
  avatar,
  className,
  'data-testid': dataTestId = 'member-mention',
}: {
  nickname: string;
  avatar: MemberBotAvatarConfig;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <span
      className={`member-mention${className ? ` ${className}` : ''}`}
      data-testid={dataTestId}
      data-member-mention={nickname}
      title={`@${nickname}`}
    >
      <MemberMentionContent nickname={nickname} avatar={avatar} />
    </span>
  );
}

/** Inner content of the chip (avatar + name); no wrapper element. */
export function MemberMentionContent({
  nickname,
  avatar,
}: {
  nickname: string;
  avatar: MemberBotAvatarConfig;
}) {
  return (
    <>
      <span className="member-mention-avatar" aria-hidden="true">
        <MemberBotAvatar config={avatar} animated={false} className="h-5 w-5" />
      </span>
      <span
        className="member-mention-name"
        style={
          {
            color: normalizeHexColor(avatar.color),
            '--member-mention-color': normalizeHexColor(avatar.color),
          } as CSSProperties
        }
      >
        <span className="sr-only">@</span>
        {nickname}
      </span>
    </>
  );
}

const MemberMentionContext = createContext<readonly MemberMentionCandidate[]>(
  []
);

export function MemberMentionProvider({
  candidates,
  children,
}: {
  candidates: readonly MemberMentionCandidate[];
  children: ReactNode;
}) {
  return (
    <MemberMentionContext.Provider value={candidates}>
      {children}
    </MemberMentionContext.Provider>
  );
}

export function useMemberMentionCandidates(): readonly MemberMentionCandidate[] {
  return useContext(MemberMentionContext);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Inline pattern for `@nickname` mentions of known members. Mirrors the
 * backend parser (`@` at start or after whitespace, name followed by
 * whitespace or the end of the text) so a chip only renders for mentions the
 * backend actually delivered.
 */
export function memberMentionPattern(
  candidates: readonly MemberMentionCandidate[]
): RegExp | null {
  const names = Array.from(
    new Set(candidates.map((c) => c.nickname.trim()).filter(Boolean))
  ).sort((a, b) => b.length - a.length);
  if (names.length === 0) return null;
  return new RegExp(
    // Horizontal whitespace around the chip is consumed so the chip's own
    // 2px margin is the only gap (matches the composer, see
    // collapseMemberMentionSpacing).
    `[^\\S\\n]*(?<=^|\\s)@(${names.map(escapeRegExp).join('|')})(?=$|\\s)[^\\S\\n]*`,
    'gu'
  );
}

export function useMemberMentionInlinePlugin(): {
  pattern: RegExp;
  render: (match: RegExpMatchArray, key: string) => ReactNode;
} | null {
  const candidates = useMemberMentionCandidates();
  return useMemo(() => {
    const pattern = memberMentionPattern(candidates);
    if (!pattern) return null;
    const byName = new Map(candidates.map((c) => [c.nickname.trim(), c]));
    return {
      pattern,
      render: (match: RegExpMatchArray, key: string) => {
        const candidate = byName.get(match[1]);
        if (!candidate) return match[0];
        return (
          <MemberMention
            key={key}
            nickname={candidate.nickname}
            avatar={candidate.avatar}
          />
        );
      },
    };
  }, [candidates]);
}

const SPACE_ONLY = /^[^\S\n]+$/u;

function measureSpace(el: HTMLElement): number {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return 0;
  const style = getComputedStyle(el);
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return ctx.measureText(' ').width || 0;
}

/**
 * Composer counterpart of the message renderer's whitespace collapsing. The
 * composer must keep the literal spaces around `@nick` (they are part of the
 * serialized text the backend parses), so instead of removing them we
 * cancel their width with a negative margin. Net gap = the chip's 2px margin.
 */
export function collapseMemberMentionSpacing(root: HTMLElement | null) {
  if (!root) return;
  const chips = root.querySelectorAll<HTMLElement>('.member-mention--composer');
  if (chips.length === 0) return;
  const space = measureSpace(root);
  const edge = (node: ChildNode | null, side: 'end' | 'start') => {
    if (!node || node.nodeType !== Node.TEXT_NODE) return 0;
    const text = node.textContent ?? '';
    const run = side === 'end' ? /[^\S\n]+$/u.exec(text) : /^[^\S\n]+/u.exec(text);
    if (!run) return 0;
    // A space shared by two chips is cancelled only once (by the left chip).
    return run[0].length;
  };
  chips.forEach((chip) => {
    const prev = chip.previousSibling;
    const before =
      prev && prev.previousSibling instanceof HTMLElement &&
      prev.previousSibling.classList.contains('member-mention--composer') &&
      SPACE_ONLY.test(prev.textContent ?? '')
        ? 0
        : edge(prev, 'end');
    const after = edge(chip.nextSibling, 'start');
    chip.style.marginLeft = before ? `${2 - before * space}px` : '';
    chip.style.marginRight = after ? `${2 - after * space}px` : '';
  });
}
