import type { DeliveryReceipt, SpaceMember } from '../spaceModel';
import type { MemberBotAvatarConfig } from '../MemberBotAvatar';

export type Space = {
  space_id: string;
  name: string;
  kind?: string;
  lead_member_id?: string | null;
};

export type SpaceMessage = {
  id?: string;
  seq: number;
  origin?: string;
  operationId?: string | null;
  operation_id?: string | null;
  in_reply_to?: string | null;
  inReplyTo?: string | null;
  turnId?: string | null;
  turn_id?: string | null;
  streaming?: boolean | null;
  receipts?: DeliveryReceipt[];
  envelope: {
    id?: string;
    sender?: string;
    actor?: string;
    attributedTo?: string;
    content?: string;
    summary?: string;
    to?: string[];
    reactions?: unknown;
    crossChatSentTo?: unknown;
    cross_chat_sent_to?: unknown;
    crossChatReceivedFrom?: unknown;
    cross_chat_received_from?: unknown;
    crossChatReplyReceivedFrom?: unknown;
    cross_chat_reply_received_from?: unknown;
  };
};

export type ScheduledSpaceMessage = {
  id?: string;
  delayed_input_id?: string;
  space_id: string;
  caller_id?: string | null;
  sender_conversation_id?: string | null;
  nickname?: string | null;
  sender_nickname?: string | null;
  content: string;
  summary?: string | null;
  to?: string[];
  deliver_at: string;
  status?: string;
  created_at: string;
  updated_at?: string;
};

export type ConversationOption = {
  conversation_id: string;
  title?: string | null;
  agent_id?: string | null;
  status?: string | null;
  updated_at?: string | null;
  turn_in_flight?: boolean;
  team_name?: string | null;
  workspace_name?: string | null;
};

export type RoleOption = {
  id: string;
  name: string;
  team_id?: string | null;
  summary?: string;
  persona_prompt?: string;
  agent_id: string;
  mode_id?: string | null;
  config_values?: Record<string, string>;
};

export type AgentOption = { agent_id: string; name: string };

export type MemberSourceOption = 'role' | 'session' | 'custom';

export type DraftSpaceMemberMeta = {
  nickname: string;
  agentId?: string;
  avatar?: MemberBotAvatarConfig;
};

export type ThreadMessagesPage = {
  messages: SpaceMessage[];
  scheduled: ScheduledSpaceMessage[];
};

export type SidebarDragPayload =
  | {
      kind: 'member';
      fromSpaceId: string;
      conversationId: string;
      nickname: string;
      memberId?: string;
      threadId?: string;
    }
  | { kind: 'thread'; threadId: string; name: string };

export type SidebarDropTarget =
  | { kind: 'space'; spaceId: string }
  | { kind: 'blocked'; spaceId: string }
  | { kind: 'section'; sectionId: string }
  | null;

export const EMPTY_MEMBERS: SpaceMember[] = [];
export const EMPTY_MESSAGES: SpaceMessage[] = [];
export const EMPTY_RECEIPTS: DeliveryReceipt[] = [];
export const EMPTY_SPACES: Space[] = [];
export const EMPTY_CONVERSATIONS: ConversationOption[] = [];
export const EMPTY_SCHEDULED: ScheduledSpaceMessage[] = [];
export const EMPTY_MEMBERS_BY_SPACE: Record<string, SpaceMember[]> = {};
export const EMPTY_MESSAGES_BY_SPACE: Record<string, SpaceMessage[]> = {};

export const COLLABORATION_FALLBACK_POLL_INTERVAL_MS = 15000;

/** Contact-list avatar edge (px), shared by DM member and group-chat rows. */
export const CONTACT_AVATAR_PX = 40;

export function stableSpaceMessageId(message: SpaceMessage): string {
  const raw = String(message.id ?? message.envelope.id ?? '').trim();
  return raw.replace(/^vibex:\/\/space-message\//, '');
}
