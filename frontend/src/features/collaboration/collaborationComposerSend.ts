import {
  getBeforeSendCleanup,
  restoreComposerAttachmentsAfterSendFailure,
} from '@/components/tasks/follow-up/sessionComposerSubmit';
import {
  revokeComposerImagePreviewUrl,
  type SessionComposerImageAttachment,
} from '@/components/tasks/follow-up/sessionComposerImages';
import type {
  EventSourceKind,
  GroupDispatchMode,
  PulseRuleSpec,
} from '@/lib/api/pulse';
import { splitTextByMemberMentions } from './memberMentions';
import {
  buildBotPulseProposalSpec,
  buildGroupPulseProposalSpec,
} from './collaborationPulseEvents';

export type AutomateRosterEntry = {
  memberId: string;
  nickname: string;
};

export type AutomateTargetContext =
  | {
      kind: 'bot';
      memberId: string;
      botName: string;
      workspaceId?: string | null;
      projectId?: string | null;
    }
  | {
      kind: 'group';
      spaceId: string;
      spaceName: string;
      leadMemberId?: string | null;
      workspaceId?: string | null;
      projectId?: string | null;
    };

export type ParsedAutomateSlashIntent = {
  description: string;
  mentionedNicknames: string[];
  mentionedMemberIds: string[];
  inferredSourceKind: EventSourceKind;
  spec: PulseRuleSpec;
};

export function isAutomateSlashCommand(rawText: string): boolean {
  const normalized = rawText.replace(/\u00a0/g, ' ').trim();
  return /^\/automate(?:\s|$)/i.test(normalized);
}

export function inferEventSourceFromDescription(
  description: string
): EventSourceKind {
  const lower = description.toLowerCase();
  if (lower.includes('feishu') || description.includes('飞书')) {
    return 'feishu';
  }
  if (lower.includes('jira')) {
    return 'jira';
  }
  if (
    lower.includes('github') ||
    /\b(?:pr|pull request|ci|commit|issue)\b/.test(lower)
  ) {
    return 'github';
  }
  if (
    lower.includes('sla') ||
    lower.includes('inactiv') ||
    description.includes('超时')
  ) {
    return 'time_sla';
  }
  if (
    lower.includes('interval') ||
    /\bevery\s+\d+\s*(?:s|sec|m|min|h|hr)/.test(lower)
  ) {
    return 'time_interval';
  }
  if (
    lower.includes('cron') ||
    lower.includes('daily') ||
    lower.includes('weekly') ||
    description.includes('每天') ||
    description.includes('每周') ||
    description.includes('定时')
  ) {
    return 'time_cron';
  }
  return 'webhook_standard';
}

export function parseAutomateSlashIntent(
  rawText: string,
  roster: readonly AutomateRosterEntry[],
  context: AutomateTargetContext
): ParsedAutomateSlashIntent | null {
  const normalized = rawText.replace(/\u00a0/g, ' ').trim();
  if (!isAutomateSlashCommand(normalized)) {
    return null;
  }

  const description = normalized.replace(/^\/automate\s*/i, '').trim();
  const knownNicknames = roster
    .map((entry) => entry.nickname.trim())
    .filter(Boolean);
  const segments = splitTextByMemberMentions(description, knownNicknames);

  const mentionedNicknames: string[] = [];
  const mentionedMemberIds: string[] = [];
  const seenMemberIds = new Set<string>();

  for (const segment of segments) {
    if (segment.type !== 'mention') continue;
    const match = roster.find(
      (entry) => entry.nickname.trim() === segment.nickname.trim()
    );
    if (!match || !match.memberId || seenMemberIds.has(match.memberId)) {
      continue;
    }
    seenMemberIds.add(match.memberId);
    mentionedNicknames.push(match.nickname.trim());
    mentionedMemberIds.push(match.memberId);
  }

  const inferredSourceKind = inferEventSourceFromDescription(description);

  if (context.kind === 'bot') {
    return {
      description,
      mentionedNicknames,
      mentionedMemberIds,
      inferredSourceKind,
      spec: buildBotPulseProposalSpec({
        memberId: context.memberId,
        botName: context.botName,
        sourceKind: inferredSourceKind,
        evalMode: 'observe',
        description,
        workspaceId: context.workspaceId ?? null,
        projectId: context.projectId ?? null,
      }),
    };
  }

  const dispatchMode: GroupDispatchMode =
    mentionedMemberIds.length === 1
      ? { type: 'specific_seat', memberId: mentionedMemberIds[0]! }
      : mentionedMemberIds.length > 1
        ? {
            type: 'mention_seats',
            memberIds: mentionedMemberIds,
            order: 'sequential',
          }
        : {
            type: 'moderator_triage',
            moderatorMemberId:
              context.leadMemberId?.trim() ||
              roster[0]?.memberId ||
              'moderator',
          };

  return {
    description,
    mentionedNicknames,
    mentionedMemberIds,
    inferredSourceKind,
    spec: buildGroupPulseProposalSpec({
      spaceId: context.spaceId,
      spaceName: context.spaceName,
      dispatchMode,
      sourceKind: inferredSourceKind,
      evalMode: 'observe',
      description,
      workspaceId: context.workspaceId ?? null,
      projectId: context.projectId ?? null,
    }),
  };
}

export function buildCollaborationSendContent(
  rawText: string,
  attachments: SessionComposerImageAttachment[]
): string {
  const textPart = rawText.replace(/\u00a0/g, ' ').trim();
  const attachmentMarkdown = attachments
    .map((image) => `![${image.name}](${image.path})`)
    .join('\n');
  return [textPart, attachmentMarkdown].filter(Boolean).join('\n\n');
}

export function beginCollaborationComposerSend(
  attachments: SessionComposerImageAttachment[]
) {
  return getBeforeSendCleanup(attachments);
}

export function restoreCollaborationComposerAfterSendFailure({
  currentAttachments,
  sentAttachments,
}: {
  currentAttachments: SessionComposerImageAttachment[];
  sentAttachments: SessionComposerImageAttachment[];
}) {
  return restoreComposerAttachmentsAfterSendFailure({
    currentAttachments,
    sentAttachments,
  });
}

export function revokeCollaborationSendAttachments(
  attachments: SessionComposerImageAttachment[]
) {
  attachments.forEach(revokeComposerImagePreviewUrl);
}
