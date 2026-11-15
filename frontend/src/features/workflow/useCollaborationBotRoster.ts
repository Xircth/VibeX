import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  collaborationCall,
  listenCollaborationSpaceChanged,
} from '@/features/collaboration/collaborationApi';
import {
  readMemberBotAvatars,
  resolveMemberBotAvatar,
  type MemberBotAvatarConfig,
} from '@/features/collaboration/MemberBotAvatar';
import { loadSidebarItems } from '@/features/collaboration/threadApi';

export interface CollaborationBotOption {
  memberId: string;
  displayName: string;
  conversationId?: string | null;
  avatar: MemberBotAvatarConfig;
}

export interface CollaborationSpaceOption {
  spaceId: string;
  displayName: string;
}

const BUILTIN_BOT_LABELS: Record<string, { zh: string; en: string }> = {
  'triage-bot': { zh: '值班分诊助手', en: 'Triage Bot' },
  'release-bot': { zh: '发布汇总助手', en: 'Release Bot' },
  'reviewer-bot': { zh: '代码审查官', en: 'Reviewer Bot' },
  'oncall-bot': { zh: '值班响应助手', en: 'On-Call Bot' },
};

export function humanizeBotIdentifier(
  rawId: string,
  language = 'zh-CN'
): string {
  const trimmed = rawId.trim();
  if (!trimmed) {
    return language.startsWith('zh') ? '默认助手' : 'Assistant';
  }
  const preset = BUILTIN_BOT_LABELS[trimmed.toLowerCase()];
  if (preset) {
    return language.startsWith('zh') ? preset.zh : preset.en;
  }
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(trimmed)) {
    return `Bot ${trimmed.slice(0, 6)}`;
  }
  return trimmed;
}

export function resolveStaticBotIdentity(
  memberId: string,
  bots: readonly CollaborationBotOption[] = [],
  language = 'zh-CN'
): CollaborationBotOption {
  const trimmed = memberId.trim();
  const normalized = trimmed.toLowerCase();
  const matched = bots.find(
    (bot) =>
      bot.memberId.toLowerCase() === normalized ||
      bot.displayName.toLowerCase() === normalized
  );
  if (matched) {
    return matched;
  }
  const displayName = humanizeBotIdentifier(trimmed, language);
  return {
    memberId: trimmed || 'triage-bot',
    displayName,
    avatar: resolveMemberBotAvatar({
      identityMemberId: trimmed || 'triage-bot',
      nickname: displayName,
    }),
  };
}

export function useCollaborationBotRoster(
  workspaceId = 'default',
  language = 'zh-CN'
) {
  const [bots, setBots] = useState<CollaborationBotOption[]>([]);
  const [spaces, setSpaces] = useState<CollaborationSpaceOption[]>([]);

  const reload = useCallback(async () => {
    const storedAvatars = readMemberBotAvatars();
    const items = await loadSidebarItems(
      collaborationCall,
      workspaceId || 'default'
    ).catch(() => null);
    if (!items || items.length === 0) {
      return;
    }

    const seenBotIds = new Set<string>();
    const nextBots: CollaborationBotOption[] = [];
    const seenSpaceIds = new Set<string>();
    const nextSpaces: CollaborationSpaceOption[] = [];

    const registerMember = (
      member:
        | {
            member_id?: string | null;
            identity_member_id?: string | null;
            conversation_id?: string | null;
            name?: string | null;
          }
        | null
        | undefined
    ) => {
      if (!member) return;
      const id = (member.identity_member_id || member.member_id || '').trim();
      if (!id || seenBotIds.has(id)) return;
      seenBotIds.add(id);
      const displayName =
        member.name?.trim() || humanizeBotIdentifier(id, language);
      nextBots.push({
        memberId: id,
        displayName,
        conversationId: member.conversation_id ?? null,
        avatar: resolveMemberBotAvatar({
          identityMemberId: id,
          nickname: displayName,
          conversationId: member.conversation_id ?? null,
          stored: storedAvatars,
        }),
      });
    };

    for (const item of items) {
      if (item.member) {
        registerMember(item.member);
      }
      for (const preview of item.members_preview ?? []) {
        registerMember(preview);
      }
      const spaceId = (item.space_id ?? '').trim();
      if (spaceId && !seenSpaceIds.has(spaceId)) {
        seenSpaceIds.add(spaceId);
        nextSpaces.push({
          spaceId,
          displayName: item.name?.trim() || spaceId,
        });
      }
    }

    setBots(nextBots);
    setSpaces(nextSpaces);
  }, [language, workspaceId]);

  useEffect(() => {
    void reload();
    let unlisten: (() => void) | null = null;
    let active = true;
    void listenCollaborationSpaceChanged(() => {
      if (active) void reload();
    })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [reload]);

  const botOptions = useMemo<CollaborationBotOption[]>(() => {
    if (bots.length > 0) return bots;
    const storedAvatars = readMemberBotAvatars();
    return Object.keys(BUILTIN_BOT_LABELS).map((id) => {
      const displayName = humanizeBotIdentifier(id, language);
      return {
        memberId: id,
        displayName,
        avatar: resolveMemberBotAvatar({
          identityMemberId: id,
          nickname: displayName,
          stored: storedAvatars,
        }),
      };
    });
  }, [bots, language]);

  const resolveBotIdentity = useCallback(
    (memberId: string): CollaborationBotOption =>
      resolveStaticBotIdentity(memberId, botOptions, language),
    [botOptions, language]
  );

  const resolveSpaceName = useCallback(
    (spaceId: string): string => {
      const trimmed = spaceId.trim();
      if (!trimmed) {
        return language.startsWith('zh') ? '协作群组' : 'Collaboration Group';
      }
      return (
        spaces.find((item) => item.spaceId === trimmed)?.displayName ?? trimmed
      );
    },
    [language, spaces]
  );

  return {
    bots: botOptions,
    spaces,
    resolveBotIdentity,
    resolveSpaceName,
    reloadRoster: reload,
  };
}
