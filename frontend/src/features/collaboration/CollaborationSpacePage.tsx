import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from 'dockview-react';
import {
  AtSign,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Filter,
  FolderPlus,
  LayoutGrid,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Tag,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ExecutorProfileId } from 'shared/types';
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';

import { useCollaborationArrangement } from '@/lib/layoutArrangement';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { ConversationMessageNav } from '@/components/conversation-thread/ConversationMessageNav';
import type { ConversationMessageNavEntry } from '@/components/conversation-thread/messageNavEntries';
import {
  SESSION_LIST_ACTION_BUTTON_CLASS,
  SESSION_LIST_ACTION_ICON_CLASS,
} from '@/components/kanban/session-hub/utils';
import { WorkspaceTabAddMenu } from '@/components/layout/panels/WorkspaceTabAddMenu';
import { ProductContextMenu } from '@/components/context-menu/ProductContextMenu';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  PRODUCT_MENU_CONTENT_CLASS,
  PRODUCT_MENU_ITEM_CLASS,
} from '@/components/ui/product-menu-classes';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ConversationSelectionToolbar } from '@/components/NormalizedConversation/ConversationSelectionToolbar';
import { ActionBarUtilityButtons } from '@/components/tasks/follow-up/ActionBarUtilityButtons';
import { ComposerPrimaryActionButton } from '@/components/tasks/follow-up/ComposerPrimaryActionButton';
import {
  MessageQueueIndicator,
  formatCountdownTimer,
} from '@/components/tasks/follow-up/MessageQueueIndicator';
import {
  clearComposerImageAttachments,
  createUploadedImageAttachment,
  revokeComposerImagePreviewUrl,
  type SessionComposerImageAttachment,
} from '@/components/tasks/follow-up/sessionComposerImages';
import {
  formatQuoteToken,
  quoteTokenChipLabel,
} from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import type { QueuedMessage } from '@/components/tasks/follow-up/sessionComposerQueue';
import { SessionComposerFrame } from '@/components/tasks/follow-up/SessionComposerFrame';
import {
  SessionComposerAttachmentDrawer,
  SessionComposerInput,
} from '@/components/tasks/follow-up/SessionComposerInput';
import { useSessionComposerPromptEnhancement } from '@/components/tasks/follow-up/useSessionComposerPromptEnhancement';
import { toast } from '@/components/ui/toast';
import { SessionListDeleteControl } from '@/components/workspace-session-list/SessionListDeleteControl';
import {
  formatCompactSessionAge,
  workspaceSessionStatusTone,
} from '@/components/workspace-session-list/workspaceSessionListModel';
import { useOptionalProject } from '@/contexts/ProjectContext';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { imagesApi, sessionsApi } from '@/lib/api';
import { backendListen } from '@/lib/backendTransport';
import { requestComposerTokenInsert } from '@/lib/composerInsert';
import {
  WORKSPACE_SESSIONS_CHANGED_EVENT,
  type WorkspaceSessionsChangedPayload,
} from '@/lib/sessionQueryCache';
import { cn } from '@/lib/utils';
import { type PreviewPanelParams } from '@/types/panels';
import { prepareImageFileForUpload } from '@/utils/clipboard';
import '@/styles/conversation.css';
import '@/styles/dockview-ayu.css';

import {
  collaborationCall,
  listenCollaborationSpaceChanged,
} from './collaborationApi';
import {
  SPACE_WARMUP_DEBOUNCE_MS,
  SpaceWarmupCooldown,
  shouldWarmupGroupComposer,
} from './spaceComposerWarmup';
import {
  beginCollaborationComposerSend,
  buildCollaborationSendContent,
  restoreCollaborationComposerAfterSendFailure,
  revokeCollaborationSendAttachments,
} from './collaborationComposerSend';
import { useCollaborationLayoutStore } from './collaborationLayoutStore';
import {
  attachSidebarIdentityIds,
  loadSidebarItems,
  loadDirectMessages,
  markThreadRead,
  markThreadUnread,
  postDirectMessage,
  resolveMemberSession,
  updateThreadTagColor,
} from './threadApi';
import { CollaborationGlobalSearchModal } from './CollaborationGlobalSearchModal';
import {
  applyContactListView,
  chatEntryThreadId,
  conversationIdForCopy,
  cycleTypeFilter,
  readContactChrome,
  toggleHiddenThread,
  togglePinnedThread,
  writeContactChrome,
  type ContactChromeState,
  type ContactListSort,
  type ContactTypeFilter,
} from './contactChrome';
import {
  buildContactRowMenuItems,
  moveTargetsForEntry,
} from './contactRowMenu';
import {
  buildContactSections,
  createContactGroup,
  deleteContactGroup,
  listContactGroups,
  readCollapsedSections,
  renameContactGroup,
  setThreadGroup,
  nextNewContactGroupName,
  sortContactGroups,
  UNGROUPED_SECTION_ID,
  withThreadGroup,
  writeCollapsedSections,
  type ContactGroup,
  type ContactSection,
} from './contactGroups';
import { ContactGroupSections } from './ContactGroupSections';
import {
  COLLABORATION_PREVIEW_COMPONENTS,
  CollaborationPreviewDockviewTab,
  CollaborationPreviewHeaderActions,
  CollaborationPreviewScope,
  filePreviewPanelId,
  filePreviewTitle,
  memberPreviewPanelId,
  previewMemberKey,
  type PreviewTabItem,
} from './CollaborationPreviewDockview';
import { spaceCollectionPreviewPanelId } from './CollaborationSpaceCollectionPanel';
import { CollaborationWorkingStatus } from './CollaborationWorkingStatus';
import {
  COLLABORATION_ADD_MEMBER_EVENT,
  COLLABORATION_MEMBERS_CHANGED_EVENT,
} from './GroupDetailsMembersTab';
import { MemberSessionConfigControls } from './MemberSessionConfigControls';
import {
  COPY,
  DEFAULT_MASTER_BOT_NAME,
  DEFAULT_MASTER_BOT_PERSONA_PROMPT,
  SPACE_TAG_PRESETS,
  VIRTUAL_DEFAULT_SPACE_ID,
  agentRoster,
  deliveryFailureCopy,
  displayName,
  latestMessageSeq,
  matchesSpaceMemberIdentity,
  memberSelectionKey as deleteMemberKey,
  mergeSpaceMessages,
  messageAuthor,
  parseMemberSelectionKey,
  parseSpaceChangedEvent,
  postRecipients,
  randomEnglishNickname,
  readSpaceTags,
  extractEnvelopeCrossChatMeta,
  receiptStatusCopy,
  resolveMessageConversationId,
  resolveMessageDeliveryStatus,
  resolveMessageReceipts,
  sidebarMemberToSpaceMember,
  sortMembersLeadFirst,
  strayMentions,
  surfaceErrorCopy,
  toggleMemberDeleteSelection,
  toggleSpaceDeleteSelection,
  unassignedSpaceId,
  writeSpaceTags,
  type DeliveryReceipt,
  type SpaceMember,
  type SpaceTagConfig,
  buildChatList,
  defaultGroupChatNameFromMembers,
  uniqueBotsForGroupMemberPicker,
  resolvePrivateChatTarget,
  type ChatListEntry,
  type SidebarItem,
  directThreadIdFor,
  reconcilePendingDirectMessages,
  type PendingDirectMessage,
  isPrivateChatKind,
  memberTabTitle,
  buildCollabDmBootstrapPrompt,
  isCollabDmBootstrapPrompt,
  isCollaborationLimitNotice,
  contactLastMessagePreview,
  isMemberWorking,
} from './spaceModel';

const COLLABORATION_FALLBACK_POLL_INTERVAL_MS = 15000;
import {
  DEFAULT_MASTER_BOT_AVATAR,
  MemberBotAvatar,
  MemberBotAvatarPicker,
  deriveMemberBotAvatar,
  randomMemberBotAvatar,
  readMemberBotAvatars,
  resolveMemberBotAvatar,
  writeMemberBotAvatars,
  type MemberBotAvatarConfig,
} from './MemberBotAvatar';
import {
  botSilhouetteOutline,
  GroupAvatar,
  groupAvatarMemberSlotPx,
} from './GroupAvatar';
import {
  memberMessageClusters,
  showsClusterAvatar,
  showsClusterName,
} from './messageCluster';
import {
  SpaceMessageBody,
  bubbleText,
  messagePreviewText,
} from './SpaceMessageBody';
import {
  CollaborationMemberMentionContext,
  MemberMentionChip,
  buildMemberMentionContextValue,
} from './MemberMentionChip';
import './collaboration.css';
import i18n from '@/i18n';

if (
  typeof globalThis !== 'undefined' &&
  typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver ===
    'undefined'
) {
  class FallbackResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (
    globalThis as unknown as {
      ResizeObserver: typeof FallbackResizeObserver;
    }
  ).ResizeObserver = FallbackResizeObserver;
}

type Space = {
  space_id: string;
  name: string;
  kind?: string;
  lead_member_id?: string | null;
};
type SpaceMessage = {
  seq: number;
  origin?: string;
  operationId?: string | null;
  operation_id?: string | null;
  receipts?: DeliveryReceipt[];
  envelope: {
    actor?: string;
    attributedTo?: string;
    content?: string;
    summary?: string;
    to?: string[];
    crossChatSentTo?: string[];
    cross_chat_sent_to?: string[];
    crossChatReceivedFrom?: string | string[];
    cross_chat_received_from?: string | string[];
    crossChatReplyReceivedFrom?: string[];
    cross_chat_reply_received_from?: string[];
  };
};
type ScheduledSpaceMessage = {
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
type ConversationOption = {
  conversation_id: string;
  title?: string | null;
  agent_id?: string | null;
  status?: string | null;
  updated_at?: string | null;
  turn_in_flight?: boolean;
  team_name?: string | null;
  workspace_name?: string | null;
};
type RoleOption = {
  id: string;
  name: string;
  team_id?: string | null;
  summary?: string;
  persona_prompt?: string;
  agent_id: string;
  mode_id?: string | null;
  config_values?: Record<string, string>;
};
type AgentOption = { agent_id: string; name: string };
type MemberSourceOption = 'role' | 'session' | 'custom';
type DraftSpaceMemberMeta = {
  nickname: string;
  agentId?: string;
  avatar?: MemberBotAvatarConfig;
};

const EMPTY_MEMBERS: SpaceMember[] = [];
const EMPTY_MESSAGES: SpaceMessage[] = [];
const EMPTY_RECEIPTS: DeliveryReceipt[] = [];

function DelayedMessageCountdown({ deliverAt }: { deliverAt: string }) {
  const [tickNow, setTickNow] = useState(() => Date.now());
  useEffect(() => {
    setTickNow(Date.now());
    const intervalId = window.setInterval(() => {
      setTickNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [deliverAt]);
  return <span>{formatCountdownTimer(deliverAt, tickNow)}</span>;
}

type CollaborationSelectOption<T extends string = string> = {
  value: T;
  label: string;
  icon?: ReactNode;
};

function CollaborationOptionSelect<T extends string = string>({
  ariaLabel,
  value,
  placeholder,
  options,
  onChange,
  size = 'default',
  disabled = false,
}: {
  ariaLabel: string;
  value: T;
  placeholder?: string;
  options: readonly CollaborationSelectOption<T>[];
  onChange: (value: T) => void;
  size?: 'default' | 'compact';
  disabled?: boolean;
}) {
  const selectedOption = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          data-value={value}
          disabled={disabled}
          className={cn(
            'raised-control w-full justify-between px-2.5 font-normal',
            size === 'compact' ? 'h-7 text-xs' : 'h-8 text-[13px]'
          )}
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            {selectedOption?.icon ? (
              <span aria-hidden="true" className="inline-flex shrink-0">
                {selectedOption.icon}
              </span>
            ) : null}
            <span className="truncate">
              {selectedOption?.label || placeholder || ''}
            </span>
          </span>
          <ChevronDown
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[180px]"
      >
        {options.map((option) => {
          const isSelected = option.value === value;
          return (
            <DropdownMenuItem
              key={option.value || '__empty__'}
              data-state={isSelected ? 'checked' : undefined}
              onSelect={() => onChange(option.value)}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                {option.icon ? (
                  <span aria-hidden="true" className="inline-flex shrink-0">
                    {option.icon}
                  </span>
                ) : null}
                <span className="truncate">{option.label}</span>
              </span>
              {isSelected ? (
                <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Contact-list avatar edge (px), shared by DM member and group-chat rows. */
const CONTACT_AVATAR_PX = 40;

type SidebarDragPayload =
  | {
      kind: 'member';
      fromSpaceId: string;
      conversationId: string;
      nickname: string;
      memberId?: string;
      /** The member's private-chat thread, when it is a DM row. */
      threadId?: string;
    }
  | { kind: 'thread'; threadId: string; name: string };

type SidebarDropTarget =
  | { kind: 'space'; spaceId: string }
  | { kind: 'blocked'; spaceId: string }
  | { kind: 'section'; sectionId: string }
  | null;

export function CollaborationSpacePage({
  workspaceId,
}: {
  workspaceId: string | null;
}) {
  const { t } = useTranslation('panels');
  const workspace = workspaceId ?? '';
  const unassignedId = workspace ? unassignedSpaceId(workspace) : '';
  const projectContext = useOptionalProject();
  const { repos } = useAttemptRepo(workspace || undefined);
  const workspacePath = repos[0]?.path;
  const repoIds = useMemo(
    () => repos.map((repo) => repo.id).filter(Boolean),
    [repos]
  );
  const userSystem = useOptionalUserSystem();
  const userSystemRef = useRef(userSystem);
  userSystemRef.current = userSystem;
  const promptEnhancementEnabled =
    userSystem?.config?.prompt_enhancement_enabled === true;
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const threadLogRef = useRef<HTMLDivElement | null>(null);
  const messageItemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [activeNavIndex, setActiveNavIndex] = useState<number | null>(null);
  const [topMemberBarExpanded, setTopMemberBarExpanded] = useState(true);
  const [composerMembersMenuOpen, setComposerMembersMenuOpen] = useState(false);
  const composerMembersCloseTimeoutRef = useRef<number | null>(null);

  const [spaces, setSpaces] = useState<Space[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [membersBySpace, setMembersBySpace] = useState<
    Record<string, SpaceMember[]>
  >({});
  const [messagesBySpace, setMessagesBySpace] = useState<
    Record<string, SpaceMessage[]>
  >({});
  const [messages, setMessages] = useState<SpaceMessage[]>([]);
  const [receiptsBySeq, setReceiptsBySeq] = useState<
    Record<number, DeliveryReceipt[]>
  >({});
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [spaceTags, setSpaceTags] = useState<Record<string, SpaceTagConfig>>(
    () => readSpaceTags()
  );
  const [memberAvatars, setMemberAvatars] = useState<
    Record<string, MemberBotAvatarConfig>
  >(() => readMemberBotAvatars());

  // Search & Filter state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [listSort, setListSort] = useState<ContactListSort>('activity');
  const [typeFilter, setTypeFilter] = useState<ContactTypeFilter>('group');
  const [contactChrome, setContactChrome] = useState<ContactChromeState>({
    pinned: [],
    hidden: [],
  });

  // Batch Delete state
  const [isDeleteMode, setIsDeleteMode] = useState(false);
  const [isDeletingBatch, setIsDeletingBatch] = useState(false);
  const [selectedDeleteSpaceIds, setSelectedDeleteSpaceIds] = useState<
    Set<string>
  >(() => new Set());
  const [selectedDeleteMemberKeys, setSelectedDeleteMemberKeys] = useState<
    Set<string>
  >(() => new Set());

  // Create Space & Add Member overlay state
  const [createOpen, setCreateOpen] = useState(false);
  const [spaceName, setSpaceName] = useState('');
  const [spaceTagColorId, setSpaceTagColorId] = useState('');
  const [spaceTagCustomLabel, setSpaceTagCustomLabel] = useState('');
  const [selectedSpaceMemberConvIds, setSelectedSpaceMemberConvIds] = useState<
    Set<string>
  >(() => new Set());
  const [draftMemberMetaByConvId, setDraftMemberMetaByConvId] = useState<
    Record<string, DraftSpaceMemberMeta>
  >({});
  const [createError, setCreateError] = useState('');
  const overlayOpenedByUserRef = useRef(false);

  // Unified Create Member overlay state (role / session / custom)
  const [createMemberOpen, setCreateMemberOpen] = useState(false);
  const [createMemberSpaceId, setCreateMemberSpaceId] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberAvatar, setNewMemberAvatar] = useState<MemberBotAvatarConfig>(
    () => randomMemberBotAvatar()
  );
  const [newMemberSource, setNewMemberSource] =
    useState<MemberSourceOption>('role');
  const [newMemberRoleId, setNewMemberRoleId] = useState('');
  const [newMemberSessionId, setNewMemberSessionId] = useState('');
  const [newMemberAgentId, setNewMemberAgentId] = useState('');
  const [newMemberModeId, setNewMemberModeId] = useState('');
  const [newMemberConfigValues, setNewMemberConfigValues] = useState<
    Record<string, string>
  >({});
  const [newMemberPersonaPrompt, setNewMemberPersonaPrompt] = useState('');
  const [createMemberError, setCreateMemberError] = useState('');

  // Rename Member overlay state
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameSpaceId, setRenameSpaceId] = useState('');
  const [renameConversationId, setRenameConversationId] = useState('');
  const [renameNickname, setRenameNickname] = useState('');
  const [renameAvatar, setRenameAvatar] = useState<MemberBotAvatarConfig>(() =>
    deriveMemberBotAvatar('bot')
  );
  const [renameOperationId, setRenameOperationId] = useState(() =>
    crypto.randomUUID()
  );
  const [renameError, setRenameError] = useState('');

  // Inline Rename Space state
  const [virtualDefaultSpaceName, setVirtualDefaultSpaceName] =
    useState<string>(COPY.defaultSpaceName);
  const [renameSpaceOpen, setRenameSpaceOpen] = useState(false);
  const [renameSpaceTargetId, setRenameSpaceTargetId] = useState('');
  const [renameSpaceName, setRenameSpaceName] = useState('');
  const [renameSpaceError, setRenameSpaceError] = useState('');

  // Member hover cursor position & Drag-and-drop state
  const [memberHoverCursorPos, setMemberHoverCursorPos] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [draggingMember, setDraggingMember] = useState<{
    fromSpaceId: string;
    conversationId: string;
    nickname: string;
  } | null>(null);
  const [pointerDragCursor, setPointerDragCursor] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const suppressNextMemberClickRef = useRef(false);
  const [dropTargetSpaceId, setDropTargetSpaceId] = useState('');
  // Pointer drag of sidebar rows (members and group chats).
  const [sidebarDropTarget, setSidebarDropTarget] =
    useState<SidebarDropTarget>(null);
  const [draggingThreadName, setDraggingThreadName] = useState<string | null>(
    null
  );

  // Pane resize state & refs
  const spacesPaneRef = useRef<HTMLElement | null>(null);
  const previewPaneRef = useRef<HTMLElement | null>(null);
  const [spacesPaneWidth, setSpacesPaneWidth] = useState<number | null>(null);
  const [previewPaneWidth, setPreviewPaneWidth] = useState<number | null>(null);
  const [isResizingPane, setIsResizingPane] = useState(false);

  const handleSpacesResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const measured =
        spacesPaneRef.current?.getBoundingClientRect().width ?? 0;
      const startWidth = spacesPaneWidth ?? (measured > 0 ? measured : 266);
      setIsResizingPane(true);

      const handleMove = (moveEvent: PointerEvent) => {
        const delta =
          spacesResizerSideRef.current === 'right'
            ? moveEvent.clientX - startX
            : startX - moveEvent.clientX;
        const nextWidth = Math.min(
          Math.max(Math.round(startWidth + delta), 180),
          640
        );
        setSpacesPaneWidth(nextWidth);
      };

      const handleUp = () => {
        setIsResizingPane(false);
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        window.removeEventListener('pointercancel', handleUp);
      };

      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
      window.addEventListener('pointercancel', handleUp);
    },
    [spacesPaneWidth]
  );

  const handlePreviewResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const measured =
        previewPaneRef.current?.getBoundingClientRect().width ?? 0;
      const startWidth = previewPaneWidth ?? (measured > 0 ? measured : 420);
      setIsResizingPane(true);

      const handleMove = (moveEvent: PointerEvent) => {
        const delta =
          previewResizerSideRef.current === 'right'
            ? moveEvent.clientX - startX
            : startX - moveEvent.clientX;
        const nextWidth = Math.min(
          Math.max(Math.round(startWidth + delta), 240),
          960
        );
        setPreviewPaneWidth(nextWidth);
      };

      const handleUp = () => {
        setIsResizingPane(false);
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        window.removeEventListener('pointercancel', handleUp);
      };

      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
      window.addEventListener('pointercancel', handleUp);
    },
    [previewPaneWidth]
  );

  // Composer & Dockview preview state
  const [draft, setDraft] = useState('');
  const replaceDraftRef = useRef<((next: string) => void) | null>(null);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [scheduledMessages, setScheduledMessages] = useState<
    ScheduledSpaceMessage[]
  >([]);
  const [spaceQueuedMessages, setSpaceQueuedMessages] = useState<
    QueuedMessage[]
  >([]);
  const [editingSpaceMessageId, setEditingSpaceMessageId] = useState<
    string | null
  >(null);
  const [hoveredDelayedMemberKey, setHoveredDelayedMemberKey] = useState<
    string | null
  >(null);
  const delayedMemberCloseTimeoutRef = useRef<number | null>(null);
  const messagesRef = useRef<SpaceMessage[]>([]);
  messagesRef.current = messages;
  const [selectedMemberKey, setSelectedMemberKey] = useState('');
  const chatListRef = useRef<ChatListEntry[]>([]);
  // `thread.listSidebar` items; null while unavailable (older backend).
  const [sidebarItems, setSidebarItems] = useState<SidebarItem[] | null>(null);
  const sidebarItemsRef = useRef<SidebarItem[] | null>(null);
  sidebarItemsRef.current = sidebarItems;
  const inFlightSidebarRef = useRef<Promise<void> | null>(null);
  const refreshSidebar = useCallback(async () => {
    if (!workspace) return;
    if (inFlightSidebarRef.current) {
      return inFlightSidebarRef.current;
    }
    const task = (async () => {
      try {
        const items = await loadSidebarItems(collaborationCall, workspace);
        sidebarItemsRef.current = items;
        setSidebarItems(items);
        if (items) {
          setMembersBySpace((current) => {
            const next: Record<string, SpaceMember[]> = {};
            for (const [k, list] of Object.entries(current)) {
              next[k] = attachSidebarIdentityIds(list, items);
            }
            return next;
          });
        }
      } finally {
        inFlightSidebarRef.current = null;
      }
    })();
    inFlightSidebarRef.current = task;
    return task;
  }, [workspace]);
  useEffect(() => {
    void refreshSidebar();
  }, [refreshSidebar]);
  const sidebarAvailable = sidebarItems !== null;
  // Contact groups (backend: contactGroup.*). null = unavailable / not loaded.
  const [contactGroups, setContactGroups] = useState<ContactGroup[] | null>(
    null
  );
  const refreshContactGroups = useCallback(async () => {
    if (!workspace) return;
    setContactGroups(await listContactGroups(collaborationCall, workspace));
  }, [workspace]);
  useEffect(() => {
    void refreshContactGroups();
  }, [refreshContactGroups]);
  // Only the collapsed state is local.
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    () => new Set()
  );
  useEffect(() => {
    setCollapsedSections(
      workspace ? readCollapsedSections(workspace) : new Set()
    );
    setContactChrome(
      workspace ? readContactChrome(workspace) : { pinned: [], hidden: [] }
    );
  }, [workspace]);
  const persistContactChrome = useCallback(
    (next: ContactChromeState) => {
      setContactChrome(next);
      if (workspace) writeContactChrome(workspace, next);
    },
    [workspace]
  );
  const toggleContactSection = useCallback(
    (sectionId: string) => {
      setCollapsedSections((current) => {
        const next = new Set(current);
        if (next.has(sectionId)) next.delete(sectionId);
        else next.add(sectionId);
        if (workspace) writeCollapsedSections(workspace, next);
        return next;
      });
    },
    [workspace]
  );

  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [contactMenu, setContactMenu] = useState<{
    x: number;
    y: number;
    items: ProductContextMenuItem[];
  } | null>(null);
  const contactGroupFailed = useCallback(() => {
    toast.error(t('collaborationSpace.contactGroupFailed', '分组操作失败'));
  }, [t]);
  const moveContactToSection = useCallback(
    async (threadId: string, sectionId: string) => {
      const groupId = sectionId === UNGROUPED_SECTION_ID ? null : sectionId;
      setSidebarItems((items) =>
        items ? withThreadGroup(items, threadId, groupId) : items
      );
      try {
        await setThreadGroup(collaborationCall, threadId, groupId);
      } catch {
        contactGroupFailed();
        void refreshSidebar();
      }
    },
    [contactGroupFailed, refreshSidebar]
  );
  const createGroup = useCallback(async () => {
    if (!workspace) return;
    const name = nextNewContactGroupName(
      (contactGroups ?? []).map((group) => group.name),
      t(
        'collaborationSpace.contactGroupDefaultName',
        COPY.defaultContactGroupName
      )
    );
    try {
      const group = await createContactGroup(
        collaborationCall,
        workspace,
        name
      );
      setContactGroups((current) =>
        sortContactGroups([
          ...(current ?? []).filter((g) => g.group_id !== group.group_id),
          group,
        ])
      );
      setRenamingGroupId(group.group_id);
    } catch {
      contactGroupFailed();
    }
  }, [contactGroups, contactGroupFailed, t, workspace]);
  const renameGroup = useCallback(
    async (groupId: string, name: string) => {
      setContactGroups((current) =>
        current
          ? current.map((group) =>
              group.group_id === groupId ? { ...group, name } : group
            )
          : current
      );
      try {
        const group = await renameContactGroup(
          collaborationCall,
          groupId,
          name
        );
        setContactGroups((current) =>
          current
            ? current.map((g) => (g.group_id === group.group_id ? group : g))
            : current
        );
      } catch {
        contactGroupFailed();
        void refreshContactGroups();
      }
    },
    [contactGroupFailed, refreshContactGroups]
  );
  const deleteGroup = useCallback(
    async (groupId: string) => {
      setContactGroups((current) =>
        current
          ? current.filter((group) => group.group_id !== groupId)
          : current
      );
      // Its contacts fall back to 未分组.
      setSidebarItems((items) =>
        items
          ? items.map((item) =>
              item.group_id === groupId ? { ...item, group_id: null } : item
            )
          : items
      );
      try {
        const { ungroupedThreadIds } = await deleteContactGroup(
          collaborationCall,
          groupId
        );
        const ungrouped = new Set(ungroupedThreadIds);
        setSidebarItems((items) =>
          items
            ? items.map((item) =>
                ungrouped.has(item.thread_id)
                  ? { ...item, group_id: null }
                  : item
              )
            : items
        );
      } catch {
        contactGroupFailed();
        void refreshContactGroups();
        void refreshSidebar();
      }
    },
    [contactGroupFailed, refreshContactGroups, refreshSidebar]
  );
  // Private chat (DM) whose messages live at `direct:<identity_member_id>`.
  const [activeDirect, setActiveDirect] = useState<{
    spaceId: string;
    memberKey: string;
    threadId: string;
    name: string;
  } | null>(null);
  const [pendingDirectMessages, setPendingDirectMessages] = useState<
    PendingDirectMessage[]
  >([]);
  const activeDirectThreadId =
    activeDirect &&
    activeDirect.spaceId === selectedId &&
    activeDirect.memberKey === selectedMemberKey
      ? activeDirect.threadId
      : null;
  const directThreadRef = useRef<string | null>(null);
  directThreadRef.current = activeDirectThreadId;
  const applyDirectMessages = useCallback(
    (threadId: string, incoming: SpaceMessage[], merge: boolean) => {
      setScheduledMessages([]);
      setMessages((current) => {
        const next = merge ? mergeSpaceMessages(current, incoming) : [...incoming];
        setMessagesBySpace((bySpace) => ({ ...bySpace, [threadId]: next }));
        return next;
      });
      setPendingDirectMessages((current) =>
        reconcilePendingDirectMessages(current, incoming)
      );
      const seq = latestMessageSeq(incoming);
      void markThreadRead(collaborationCall, threadId, seq || undefined);
    },
    []
  );
  useEffect(() => {
    // Groups address their thread by space id; DMs are marked in openPrivateChat.
    if (!sidebarAvailable || !selectedId) return;
    const isGroup = chatListRef.current.some(
      (entry) => entry.type === 'group' && entry.spaceId === selectedId
    );
    if (isGroup) void markThreadRead(collaborationCall, selectedId);
  }, [sidebarAvailable, selectedId]);
  const [previewTabs, setPreviewTabs] = useState<PreviewTabItem[]>([]);
  const [activePreviewTabId, setActivePreviewTabId] = useState('');
  const previewTabsRef = useRef<PreviewTabItem[]>([]);
  previewTabsRef.current = previewTabs;
  const activePreviewTabIdRef = useRef('');
  activePreviewTabIdRef.current = activePreviewTabId;
  const previewDockviewApiRef = useRef<DockviewApi | null>(null);
  const syncingDockviewRef = useRef(false);

  const phone = useMediaQuery('(max-width: 768px)');
  const {
    isSpacesVisible,
    isThreadVisible,
    isPreviewVisible,
    setSpacesVisible,
    setThreadVisible,
    setPreviewVisible,
    setHasOpenedSpaceThread,
    setHasMountedPreviewTabs,
    sessionFocus,
    consumeSessionFocus,
    resetCollaborationLayout,
  } = useCollaborationLayoutStore();
  const sessionFocusRef = useRef(sessionFocus);
  sessionFocusRef.current = sessionFocus;

  const listedSelected =
    selectedId.startsWith('direct:')
      ? null
      : (spaces.find((space) => space.space_id === selectedId) ?? null);
  // A private chat addresses `direct:<member_id>`; it is not a group space.
  const selected = useMemo<Space | null>(
    () =>
      activeDirectThreadId && selectedId
        ? {
            space_id: selectedId,
            name: activeDirect?.name || '',
            kind: 'direct',
          }
        : listedSelected,
    [
      activeDirect?.name,
      activeDirectThreadId,
      listedSelected,
      selectedId,
    ]
  );
  const isDefaultVirtualSpaceSelected =
    spaces.length === 0 && selectedId === VIRTUAL_DEFAULT_SPACE_ID;
  const hasOpenedSpaceThread =
    Boolean(selected) || isDefaultVirtualSpaceSelected;
  const hasMountedPreviewTabs = previewTabs.length > 0;
  const hasActiveOverlay = createOpen || createMemberOpen;
  const hasThread =
    Boolean(error) ||
    hasActiveOverlay ||
    (hasOpenedSpaceThread && isThreadVisible);
  const showSpaces = isSpacesVisible && (!phone || !hasActiveOverlay);
  const showPreview = hasMountedPreviewTabs && isPreviewVisible;
  const collaborationArrangement = useCollaborationArrangement();
  const orderedZones = useMemo(
    () =>
      [
        collaborationArrangement.left,
        collaborationArrangement.center,
        collaborationArrangement.right,
      ] as const,
    [collaborationArrangement]
  );
  const visibleOrderedZones = useMemo(
    () =>
      orderedZones.filter((zone) =>
        zone === 'spaces'
          ? showSpaces
          : zone === 'thread'
            ? hasThread
            : showPreview
      ),
    [hasThread, orderedZones, showPreview, showSpaces]
  );
  const shellGridTemplateColumns = useMemo(() => {
    if (visibleOrderedZones.length <= 1) return 'minmax(0, 1fr)';
    return visibleOrderedZones
      .map((zone) => {
        if (zone === 'spaces') {
          return 'var(--collaboration-spaces-width, 16.65rem)';
        }
        if (zone === 'thread') {
          return 'minmax(0, 1fr)';
        }
        return hasThread
          ? 'var(--collaboration-preview-width, minmax(22rem, 1.05fr))'
          : 'minmax(0, 1fr)';
      })
      .join(' ');
  }, [hasThread, visibleOrderedZones]);
  const spacesOrder = orderedZones.indexOf('spaces');
  const threadOrder = orderedZones.indexOf('thread');
  const previewOrder = orderedZones.indexOf('preview');
  const spacesResizerSide: 'left' | 'right' = hasThread
    ? spacesOrder < threadOrder
      ? 'right'
      : 'left'
    : spacesOrder < previewOrder
      ? 'right'
      : 'left';
  const previewResizerSide: 'left' | 'right' =
    previewOrder < threadOrder ? 'right' : 'left';
  const spacesResizerSideRef = useRef<'left' | 'right'>(spacesResizerSide);
  spacesResizerSideRef.current = spacesResizerSide;
  const previewResizerSideRef = useRef<'left' | 'right'>(previewResizerSide);
  previewResizerSideRef.current = previewResizerSide;

  useEffect(() => {
    setHasOpenedSpaceThread(hasOpenedSpaceThread);
  }, [hasOpenedSpaceThread, setHasOpenedSpaceThread]);

  useEffect(() => {
    setHasMountedPreviewTabs(hasMountedPreviewTabs);
  }, [hasMountedPreviewTabs, setHasMountedPreviewTabs]);

  const members = membersBySpace[selectedId] ?? EMPTY_MEMBERS;

  const conversationById = useMemo(() => {
    const map = new Map<string, ConversationOption>();
    for (const item of conversations) {
      if (item?.conversation_id) {
        map.set(item.conversation_id, item);
      }
    }
    return map;
  }, [conversations]);

  const memberNicknameByConversationId = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of Object.values(membersBySpace)) {
      for (const member of agentRoster(group)) {
        const convId = String(member.conversation_id ?? '').trim();
        const nick = String(member.nickname ?? '').trim();
        if (convId && nick && !map.has(convId)) {
          map.set(convId, nick);
        }
      }
    }
    return map;
  }, [membersBySpace]);

  const allExistingNicknames = useMemo(() => {
    const names = new Set<string>();
    for (const group of Object.values(membersBySpace)) {
      for (const member of agentRoster(group)) {
        const nick = String(member.nickname ?? '').trim();
        if (nick) names.add(nick);
      }
    }
    return names;
  }, [membersBySpace]);

  const allWorkspaceMembers = useMemo<SpaceMember[]>(() => {
    const byNick = new Map<string, SpaceMember>();
    const addMember = (member: SpaceMember | null | undefined) => {
      if (!member || member.kind !== 'agent') return;
      if (Number(member.visible_to_agents) === 0) return;
      const nick = String(member.nickname ?? '').trim();
      if (!nick) return;
      const existing = byNick.get(nick);
      if (!existing) {
        byNick.set(nick, member);
      } else {
        byNick.set(nick, {
          ...existing,
          ...member,
          conversation_id: existing.conversation_id || member.conversation_id,
          member_id: existing.member_id || member.member_id,
          direct_thread_id:
            existing.direct_thread_id || member.direct_thread_id,
          private_thread_id:
            existing.private_thread_id || member.private_thread_id,
        });
      }
    };
    for (const member of agentRoster(members)) {
      addMember(member);
    }
    for (const group of Object.values(membersBySpace)) {
      for (const member of agentRoster(group)) {
        addMember(member);
      }
    }
    for (const item of sidebarItems ?? []) {
      if (item.member) {
        addMember(sidebarMemberToSpaceMember(item.member));
      }
      for (const preview of item.members_preview ?? []) {
        addMember(sidebarMemberToSpaceMember(preview));
      }
    }
    return [...byNick.values()];
  }, [members, membersBySpace, sidebarItems]);

  const activeChatRoster = useMemo<SpaceMember[]>(() => {
    if (activeDirectThreadId) {
      for (const item of sidebarItems ?? []) {
        if (item.thread_id === activeDirectThreadId && item.member) {
          return [sidebarMemberToSpaceMember(item.member)];
        }
      }
    }
    if (
      selectedMemberKey &&
      (selectedId === unassignedId || Boolean(activeDirectThreadId))
    ) {
      const matched = agentRoster(members).find(
        (member) => previewMemberKey(selectedId, member) === selectedMemberKey
      );
      if (matched) return [matched];
    }
    return agentRoster(members);
  }, [
    activeDirectThreadId,
    members,
    selectedId,
    selectedMemberKey,
    sidebarItems,
    unassignedId,
  ]);

  const updateMemberAvatar = useCallback(
    (
      keys: ReadonlyArray<string | undefined>,
      config: MemberBotAvatarConfig
    ) => {
      setMemberAvatars((current) => {
        const next = { ...current };
        for (const rawKey of keys) {
          const key = rawKey?.trim();
          if (key) {
            next[key] = config;
          }
        }
        writeMemberBotAvatars(next);
        return next;
      });
    },
    []
  );

  const getMemberAvatar = useCallback(
    (
      conversationId?: string,
      nickname?: string,
      identityMemberId?: string | null
    ): MemberBotAvatarConfig => {
      const convKey = conversationId?.trim() ?? '';
      if (convKey && draftMemberMetaByConvId[convKey]?.avatar) {
        return draftMemberMetaByConvId[convKey].avatar;
      }
      return resolveMemberBotAvatar({
        conversationId,
        nickname,
        identityMemberId,
        stored: memberAvatars,
      });
    },
    [draftMemberMetaByConvId, memberAvatars]
  );

  const isPrivateChatActive =
    Boolean(activeDirectThreadId) ||
    selectedId.startsWith('direct:') ||
    (selectedId === unassignedId && Boolean(selectedMemberKey));

  const selectedLeadMemberId = String(selected?.lead_member_id ?? '').trim();

  const spaceMemberRefs = useMemo(() => {
    if (isPrivateChatActive) {
      return [];
    }
    const ordered: SpaceMember[] = [];
    const seen = new Set<string>();
    for (const member of activeChatRoster) {
      const nick = String(member.nickname ?? '').trim();
      if (!nick || seen.has(nick)) continue;
      seen.add(nick);
      ordered.push(member);
    }
    const refs: Array<{
      id: string;
      nickname: string;
      detail?: string;
      avatar?: MemberBotAvatarConfig;
      mentionAll?: boolean;
      isLead?: boolean;
    }> = sortMembersLeadFirst(ordered, selectedLeadMemberId).map((member) => {
      const nick = String(member.nickname ?? '').trim();
      const conv = member.conversation_id
        ? conversationById.get(member.conversation_id)
        : undefined;
      const memberId = String(member.member_id ?? '').trim();
      return {
        id: member.member_id ?? member.conversation_id ?? nick,
        nickname: nick,
        detail: conv?.title || member.conversation_id || undefined,
        avatar: getMemberAvatar(member.conversation_id ?? undefined, nick),
        ...(memberId && memberId === selectedLeadMemberId
          ? { isLead: true }
          : {}),
      };
    });
    if (
      refs.length > 0 &&
      !seen.has('全体') &&
      !seen.has('全体成员')
    ) {
      refs.unshift({
        id: '__all__',
        nickname: '全体成员',
        detail: '通知本群所有成员',
        mentionAll: true,
      });
    }
    return refs;
  }, [
    activeChatRoster,
    conversationById,
    getMemberAvatar,
    isPrivateChatActive,
    selectedLeadMemberId,
  ]);

  const memberMentionContextValue = useMemo(() => {
    const entries: Array<{ nickname: string; avatar: MemberBotAvatarConfig }> = [];
    const seen = new Set<string>();
    for (const member of [...activeChatRoster, ...allWorkspaceMembers]) {
      const nick = String(member.nickname ?? '').trim();
      if (!nick || seen.has(nick)) continue;
      seen.add(nick);
      entries.push({
        nickname: nick,
        avatar: getMemberAvatar(member.conversation_id ?? undefined, nick),
      });
    }
    return buildMemberMentionContextValue(entries);
  }, [activeChatRoster, allWorkspaceMembers, getMemberAvatar]);

  const openSpaceKey = useMemo(() => {
    const ids = spaces
      .filter((space) =>
        space.space_id in expanded
          ? expanded[space.space_id]
          : space.space_id === selectedId
      )
      .map((space) => space.space_id);
    if (unassignedId && (expanded[unassignedId] ?? true)) {
      ids.push(unassignedId);
    }
    return ids.join('\n');
  }, [expanded, selectedId, spaces, unassignedId]);

  const addOrFocusDockviewTab = useCallback(
    (api: DockviewApi, item: PreviewTabItem, activate = true) => {
      const existing = api.getPanel(item.id);
      if (existing) {
        if (existing.api.title !== item.title) {
          existing.api.setTitle(item.title);
        }
        if (item.kind === 'member') {
          existing.api.updateParameters({
            workspaceId: item.workspaceId,
            conversationId: item.conversationId,
            nickname: item.title,
            agentId: item.agentId,
            threadKind: item.threadKind,
            memberName: item.memberName,
            memberAvatar: item.memberAvatar,
            groupAvatars: item.groupAvatars,
            tagHue: item.tagHue,
          });
        } else if (item.kind === 'file') {
          existing.api.updateParameters(item.fileParams);
        } else if (item.params) {
          existing.api.updateParameters(item.params);
        }
        if (activate) {
          existing.api.setActive();
        }
        return;
      }

      const activeGroup = api.activeGroup ?? api.groups[0];
      if (item.kind === 'member') {
        api.addPanel({
          id: item.id,
          component: 'member-session',
          title: item.title,
          params: {
            workspaceId: item.workspaceId,
            conversationId: item.conversationId,
            nickname: item.title,
            agentId: item.agentId,
            threadKind: item.threadKind,
            memberName: item.memberName,
            memberAvatar: item.memberAvatar,
            groupAvatars: item.groupAvatars,
            tagHue: item.tagHue,
          },
          ...(activeGroup
            ? {
                position: {
                  referenceGroup: activeGroup,
                  direction: 'within' as const,
                },
              }
            : {}),
        });
      } else if (item.kind === 'file') {
        api.addPanel({
          id: item.id,
          component: 'file-preview',
          title: item.title,
          params: item.fileParams,
          ...(activeGroup
            ? {
                position: {
                  referenceGroup: activeGroup,
                  direction: 'within' as const,
                },
              }
            : {}),
        });
      } else {
        api.addPanel({
          id: item.id,
          component: item.component,
          title: item.title,
          params: item.params ?? {},
          ...(activeGroup
            ? {
                position: {
                  referenceGroup: activeGroup,
                  direction: 'within' as const,
                },
              }
            : {}),
        });
      }
    },
    []
  );

  const handlePreviewDockviewReady = useCallback(
    (event: DockviewReadyEvent) => {
      const api = event.api;
      previewDockviewApiRef.current = api;
      syncingDockviewRef.current = true;
      try {
        for (const item of previewTabsRef.current) {
          addOrFocusDockviewTab(
            api,
            item,
            item.id === activePreviewTabIdRef.current
          );
        }
        if (activePreviewTabIdRef.current) {
          api.getPanel(activePreviewTabIdRef.current)?.api.setActive();
        }
      } finally {
        syncingDockviewRef.current = false;
      }

      api.onDidActivePanelChange((panel) => {
        if (!panel) return;
        setActivePreviewTabId(panel.id);
      });

      api.onDidRemovePanel((removedPanel) => {
        if (syncingDockviewRef.current) return;
        setPreviewTabs((current) => {
          const next = current.filter((tab) => tab.id !== removedPanel.id);
          if (next.length === 0) {
            previewDockviewApiRef.current = null;
            setSelectedMemberKey('');
            setActivePreviewTabId('');
          }
          return next;
        });
      });
    },
    [addOrFocusDockviewTab]
  );

  const inFlightConversationsRef = useRef<Promise<void> | null>(null);
  const loadConversations = useCallback(async () => {
    if (!workspace) return;
    if (inFlightConversationsRef.current) {
      return inFlightConversationsRef.current;
    }
    const task = (async () => {
      try {
        const page = await collaborationCall<{
          conversations?: ConversationOption[];
        }>('collaboration', 'space.listConversations', {
          workspaceId: workspace,
        });
        setConversations(page.conversations ?? []);
      } catch {
        // Ignore background metadata fetch errors if collaboration is disabled
      } finally {
        inFlightConversationsRef.current = null;
      }
    })();
    inFlightConversationsRef.current = task;
    return task;
  }, [workspace]);

  const reloadSpaceMembers = useCallback(async (spaceId: string) => {
    if (!spaceId || spaceId.startsWith('direct:')) return;
    const memberPage = await collaborationCall<{ members?: SpaceMember[] }>(
      'collaboration',
      'space.listMembers',
      { spaceId }
    );
    const enriched = attachSidebarIdentityIds(
      memberPage.members ?? [],
      sidebarItemsRef.current
    );
    setMembersBySpace((current) => ({
      ...current,
      [spaceId]: enriched,
    }));
  }, []);

  useEffect(() => {
    if (!workspace) return;
    const intervalId = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      void refreshSidebar();
      void loadConversations();
    }, COLLABORATION_FALLBACK_POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadConversations, refreshSidebar, workspace]);

  useEffect(() => {
    const onMembersChanged = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          spaceId?: string;
          leadMemberId?: string | null;
        }>
      ).detail;
      const targetSpaceId = detail?.spaceId || selectedId;
      if (targetSpaceId && !targetSpaceId.startsWith('direct:')) {
        void reloadSpaceMembers(targetSpaceId);
        if (
          detail &&
          Object.prototype.hasOwnProperty.call(detail, 'leadMemberId')
        ) {
          const lead = String(detail.leadMemberId ?? '').trim() || undefined;
          setSpaces((current) =>
            current.map((space) =>
              space.space_id === targetSpaceId
                ? { ...space, lead_member_id: lead }
                : space
            )
          );
        }
      }
      void refreshSidebar();
    };
    window.addEventListener(
      COLLABORATION_MEMBERS_CHANGED_EVENT,
      onMembersChanged
    );
    return () => {
      window.removeEventListener(
        COLLABORATION_MEMBERS_CHANGED_EVENT,
        onMembersChanged
      );
    };
  }, [refreshSidebar, reloadSpaceMembers, selectedId]);

  const markMemberConversationViewed = useCallback(
    (conversationId: string) => {
      const trimmed = conversationId.trim();
      if (!trimmed) return;
      const conv = conversationById.get(trimmed);
      if (!conv || conv.turn_in_flight || conv.status !== 'inreview') {
        return;
      }
      setConversations((current) =>
        current.map((item) =>
          item.conversation_id === trimmed && !item.turn_in_flight
            ? { ...item, status: 'done' }
            : item
        )
      );
      void sessionsApi
        .markViewed(trimmed)
        .then(() => {
          void loadConversations();
        })
        .catch(() => {
          void loadConversations();
        });
    },
    [conversationById, loadConversations]
  );

  const getMemberLastMessageInSpace = useCallback(
    (spaceId: string, member: SpaceMember): string => {
      const spaceMessages =
        spaceId === selectedId
          ? messages
          : (messagesBySpace[spaceId] ?? EMPTY_MESSAGES);
      if (spaceMessages.length === 0) return '';
      const spaceMembers = membersBySpace[spaceId] ?? EMPTY_MEMBERS;
      const targetConvId = String(member.conversation_id ?? '').trim();
      const targetName = displayName(member).trim();
      for (let index = spaceMessages.length - 1; index >= 0; index -= 1) {
        const msg = spaceMessages[index];
        if (!msg?.envelope) continue;
        const author = messageAuthor(msg.envelope).trim();
        if (!author || author === COPY.you) continue;
        const msgConvId = resolveMessageConversationId(
          msg.envelope,
          spaceMembers
        );
        if (
          (targetConvId && msgConvId && msgConvId === targetConvId) ||
          (targetName && author === targetName)
        ) {
          return messagePreviewText(bubbleText(msg.envelope));
        }
      }
      return '';
    },
    [membersBySpace, messages, messagesBySpace, selectedId]
  );

  const markSpaceInReviewMembersViewed = useCallback(
    (spaceId: string) => {
      const trimmedSpaceId = spaceId.trim();
      if (!trimmedSpaceId || trimmedSpaceId === VIRTUAL_DEFAULT_SPACE_ID) {
        return;
      }
      const spaceRoster = agentRoster(
        membersBySpace[trimmedSpaceId] ?? EMPTY_MEMBERS
      );
      for (const member of spaceRoster) {
        const convId = String(member.conversation_id ?? '').trim();
        if (!convId) continue;
        const conv = conversationById.get(convId);
        if (!conv || conv.turn_in_flight || conv.status !== 'inreview') {
          continue;
        }
        if (!getMemberLastMessageInSpace(trimmedSpaceId, member)) {
          continue;
        }
        markMemberConversationViewed(convId);
      }
    },
    [
      conversationById,
      getMemberLastMessageInSpace,
      markMemberConversationViewed,
      membersBySpace,
    ]
  );

  const markActivePreviewMemberViewed = useCallback(() => {
    if (!showPreview || !activePreviewTabId) return;
    const activeTab = previewTabs.find((tab) => tab.id === activePreviewTabId);
    if (activeTab?.kind === 'member' && activeTab.conversationId) {
      markMemberConversationViewed(activeTab.conversationId);
    }
  }, [
    activePreviewTabId,
    markMemberConversationViewed,
    previewTabs,
    showPreview,
  ]);

  const openPreviewItem = useCallback(
    (item: PreviewTabItem) => {
      setPreviewTabs((current) => {
        const index = current.findIndex((existing) => existing.id === item.id);
        if (index >= 0) {
          const next = [...current];
          next[index] = item;
          return next;
        }
        return [...current, item];
      });
      setActivePreviewTabId(item.id);
      setPreviewVisible(true);
      if (item.kind === 'member' && item.conversationId) {
        markMemberConversationViewed(item.conversationId);
      }
      const api = previewDockviewApiRef.current;
      if (api) {
        addOrFocusDockviewTab(api, item, true);
      }
    },
    [addOrFocusDockviewTab, markMemberConversationViewed, setPreviewVisible]
  );

  const inFlightRolesAndAgentsRef = useRef<Promise<{
    roles: RoleOption[];
    agents: AgentOption[];
  }> | null>(null);
  const loadRolesAndAgents = useCallback(async () => {
    if (inFlightRolesAndAgentsRef.current) {
      return inFlightRolesAndAgentsRef.current;
    }
    const task = (async () => {
      try {
        const [rolePage, agentPage] = await Promise.all([
          collaborationCall<{ roles?: RoleOption[] }>(
            'collaboration',
            'role.list'
          ),
          collaborationCall<{ agents?: AgentOption[] }>(
            'collaboration',
            'role.agents'
          ),
        ]);
        const nextRoles = rolePage?.roles ?? [];
        const nextAgents = agentPage?.agents ?? [];
        setRoles(nextRoles);
        setAgents(nextAgents);
        setNewMemberRoleId((current) => current || nextRoles[0]?.id || '');
        setNewMemberAgentId(
          (current) => current || nextAgents[0]?.agent_id || ''
        );
        return { roles: nextRoles, agents: nextAgents };
      } catch {
        // Handled by form submit if capability is disabled
        return { roles: [] as RoleOption[], agents: [] as AgentOption[] };
      } finally {
        inFlightRolesAndAgentsRef.current = null;
      }
    })();
    inFlightRolesAndAgentsRef.current = task;
    return task;
  }, []);

  const loadedMemberSpaceKeyRef = useRef('');
  const bootstrappedDefaultBotWorkspaceRef = useRef('');
  useEffect(() => {
    overlayOpenedByUserRef.current = false;
    loadedMemberSpaceKeyRef.current = '';
    bootstrappedDefaultBotWorkspaceRef.current = '';
    inFlightConversationsRef.current = null;
    inFlightRolesAndAgentsRef.current = null;
    setExpanded({});
    setMembersBySpace({});
    setMessagesBySpace({});
    setSelectedMemberKey('');
    setPreviewTabs([]);
    setActivePreviewTabId('');
    previewDockviewApiRef.current = null;
    setIsDeleteMode(false);
    setSelectedDeleteSpaceIds(new Set());
    setSelectedDeleteMemberKeys(new Set());
    setVirtualDefaultSpaceName(COPY.defaultSpaceName);
    setRenameSpaceOpen(false);
    setRenameSpaceTargetId('');
    setRenameSpaceName('');
    setRenameSpaceError('');
    resetCollaborationLayout();
  }, [resetCollaborationLayout, workspace]);

  useEffect(() => {
    if (!workspace) {
      setSpaces([]);
      setSelectedId('');
      setCreateOpen(false);
      return;
    }
    let cancelled = false;
    void collaborationCall<{ spaces?: Space[] }>(
      'collaboration',
      'space.list',
      {
        workspaceId: workspace,
      }
    )
      .then(async (page) => {
        if (cancelled) return;
        const next = page.spaces ?? [];
        setSpaces(next);
        if (next.length > 0) {
          setSelectedId((current) => current || next[0]?.space_id || '');
          return;
        }
        const targetUnassignedId = unassignedSpaceId(workspace);
        const [, unassignedPage, { agents: loadedAgents }] = await Promise.all([
          inFlightSidebarRef.current ?? refreshSidebar(),
          collaborationCall<{ members?: SpaceMember[] }>(
            'collaboration',
            'space.listMembers',
            { spaceId: targetUnassignedId }
          ).catch(() => ({ members: [] as SpaceMember[] })),
          loadRolesAndAgents(),
        ]);
        if (cancelled) return;
        const currentSidebar = sidebarItemsRef.current;
        const unassignedMembers = attachSidebarIdentityIds(
          unassignedPage?.members ?? [],
          currentSidebar
        );
        setMembersBySpace((current) => ({
          ...current,
          [targetUnassignedId]: unassignedMembers,
        }));
        const sidebarGroups = (currentSidebar ?? []).filter(
          (item) => !isPrivateChatKind(item.kind)
        );
        const sidebarDirects = (currentSidebar ?? []).filter(
          (item) => isPrivateChatKind(item.kind) && Boolean(item.member)
        );
        const directRoster = agentRoster(unassignedMembers);
        if (sidebarGroups.length > 0) {
          setSelectedId(
            (current) => current || sidebarGroups[0]?.thread_id || ''
          );
          return;
        }
        if (sidebarDirects.length > 0) {
          const firstDirect = sidebarDirects[0];
          if (
            firstDirect?.member &&
            !sessionFocusRef.current &&
            !selectedIdRef.current
          ) {
            const dmSpaceId =
              firstDirect.space_id || targetUnassignedId || firstDirect.thread_id;
            applyPrivateChatRef.current(
              dmSpaceId,
              sidebarMemberToSpaceMember(firstDirect.member),
              firstDirect.thread_id
            );
          }
          return;
        }
        if (directRoster.length > 0) {
          const firstMember = directRoster[0];
          if (
            firstMember &&
            !sessionFocusRef.current &&
            !selectedIdRef.current
          ) {
            const dmThreadId = directThreadIdFor(firstMember) ?? undefined;
            applyPrivateChatRef.current(
              dmThreadId || targetUnassignedId,
              firstMember,
              dmThreadId
            );
          }
          return;
        }
        if (bootstrappedDefaultBotWorkspaceRef.current === workspace) {
          return;
        }
        bootstrappedDefaultBotWorkspaceRef.current = workspace;
        const configuredExecutor =
          userSystemRef.current?.config?.executor_profile?.executor?.trim() ||
          '';
        const matchedConfiguredAgent = configuredExecutor
          ? loadedAgents.find(
              (item) =>
                item.agent_id.toLowerCase() === configuredExecutor.toLowerCase()
            )?.agent_id
          : undefined;
        const defaultAgentId =
          matchedConfiguredAgent ||
          loadedAgents[0]?.agent_id ||
          configuredExecutor ||
          '';
        const avatarJson = JSON.stringify(DEFAULT_MASTER_BOT_AVATAR);
        const created = await collaborationCall<{
          space_id?: string;
          member_id?: string;
          conversation_id?: string;
          nickname?: string;
          private_thread_id?: string;
          private_conversation_id?: string;
          identity_member_id?: string;
          direct_thread_id?: string;
        }>('collaboration', 'space.createMember', {
          workspaceId: workspace,
          spaceId: '',
          nickname: DEFAULT_MASTER_BOT_NAME,
          source: 'custom',
          avatar: avatarJson,
          color: DEFAULT_MASTER_BOT_AVATAR.color,
          agentId: defaultAgentId,
          modeId: '',
          configValues: {},
          personaPrompt: DEFAULT_MASTER_BOT_PERSONA_PROMPT,
          operationId: crypto.randomUUID(),
        });
        if (cancelled) return;
        const finalNickname = created?.nickname || DEFAULT_MASTER_BOT_NAME;
        const createdConvId =
          created?.private_conversation_id ||
          created?.conversation_id ||
          created?.member_id ||
          '';
        updateMemberAvatar(
          [
            created?.conversation_id,
            created?.private_conversation_id,
            created?.member_id,
            created?.identity_member_id,
            finalNickname,
          ],
          DEFAULT_MASTER_BOT_AVATAR
        );
        if (createdConvId) {
          setDraftMemberMetaByConvId((current) => ({
            ...current,
            [createdConvId]: {
              nickname: finalNickname,
              agentId: defaultAgentId || undefined,
              avatar: DEFAULT_MASTER_BOT_AVATAR,
            },
          }));
        }
        const effectiveSpaceId = created?.space_id || targetUnassignedId;
        await loadConversations();
        if (effectiveSpaceId && !effectiveSpaceId.startsWith('direct:')) {
          await reloadSpaceMembers(effectiveSpaceId);
        }
        if (targetUnassignedId && targetUnassignedId !== effectiveSpaceId) {
          await reloadSpaceMembers(targetUnassignedId);
        }
        await refreshSidebar();
        if (cancelled) return;
        if (
          created?.conversation_id ||
          created?.private_conversation_id ||
          created?.identity_member_id ||
          created?.member_id
        ) {
          const target = resolvePrivateChatTarget({
            created,
            fallbackNickname: finalNickname,
            directSpaceId: targetUnassignedId || effectiveSpaceId,
            chatList: chatListRef.current,
          });
          applyPrivateChatRef.current(
            target.spaceId,
            target.member,
            target.threadId
          );
          if (target.threadId) {
            void postDirectMessage(
              collaborationCall,
              target.threadId,
              buildCollabDmBootstrapPrompt({
                userName: COPY.you,
                botName: finalNickname,
                personaPrompt: DEFAULT_MASTER_BOT_PERSONA_PROMPT,
                spaceId: target.threadId,
              }),
              crypto.randomUUID()
            )
              .then(() => {
                void refreshSidebar();
              })
              .catch(() => {
                // Greeting is best-effort; the private chat is already open.
              });
          }
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(surfaceErrorCopy(cause));
      });
    void loadConversations();
    void loadRolesAndAgents();
    return () => {
      cancelled = true;
    };
  }, [
    loadConversations,
    loadRolesAndAgents,
    refreshSidebar,
    reloadSpaceMembers,
    updateMemberAvatar,
    workspace,
  ]);

  useEffect(() => {
    if (!workspace) return;
    const ids = openSpaceKey ? openSpaceKey.split('\n').filter(Boolean) : [];
    const allSpaceIds = spaces.map((space) => space.space_id);
    const memberIds = Array.from(
      new Set([
        ...allSpaceIds,
        ...ids,
        ...(selectedId &&
        selectedId !== VIRTUAL_DEFAULT_SPACE_ID &&
        !selectedId.startsWith('direct:')
          ? [selectedId]
          : []),
        ...(unassignedId ? [unassignedId] : []),
      ])
    );
    if (memberIds.length === 0) return;
    const nextMemberSpaceKey = `${workspace}:${memberIds.join('\n')}`;
    const shouldLoadMembers =
      loadedMemberSpaceKeyRef.current !== nextMemberSpaceKey;
    let cancelled = false;
    const load = async () => {
      if (shouldLoadMembers) {
        const memberPages = await Promise.all(
          memberIds.map((spaceId) =>
            collaborationCall<{ members?: SpaceMember[] }>(
              'collaboration',
              'space.listMembers',
              { spaceId }
            )
              .then((page) => [spaceId, page?.members ?? []] as const)
              .catch(() => [spaceId, [] as SpaceMember[]] as const)
          )
        );
        if (cancelled) return;
        loadedMemberSpaceKeyRef.current = nextMemberSpaceKey;
        setMembersBySpace((current) => {
          const next = { ...current };
          for (const [spaceId, nextMembers] of memberPages) {
            next[spaceId] = attachSidebarIdentityIds(
              nextMembers,
              sidebarItemsRef.current
            );
          }
          return next;
        });
      }
      if (!selectedId || selectedId === VIRTUAL_DEFAULT_SPACE_ID) return;
      const directThreadId = directThreadRef.current;
      if (directThreadId) {
        const page = await loadDirectMessages<SpaceMessage>(
          collaborationCall,
          directThreadId
        );
        if (cancelled) return;
        if (page) {
          applyDirectMessages(directThreadId, page.messages, false);
          return;
        }
        if (selectedId.startsWith('direct:')) return;
        // Older backend without direct threads: fall back to the space log.
      }
      if (selectedId.startsWith('direct:')) return;
      const messagePage = await collaborationCall<{
        messages?: SpaceMessage[];
        scheduled?: ScheduledSpaceMessage[];
      }>('collaboration', 'space.listMessages', {
        spaceId: selectedId,
        latest: true,
        limit: 200,
      });
      if (cancelled) return;
      const nextMessages = messagePage.messages ?? [];
      setMessages(nextMessages);
      if (Array.isArray(messagePage.scheduled)) {
        setScheduledMessages(messagePage.scheduled);
      }
      setMessagesBySpace((current) => ({
        ...current,
        [selectedId]: nextMessages,
      }));
    };
    void load().catch((cause: unknown) => {
      if (!cancelled) setError(surfaceErrorCopy(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [
    activeDirectThreadId,
    applyDirectMessages,
    openSpaceKey,
    selectedId,
    spaces,
    unassignedId,
    workspace,
  ]);

  useEffect(() => {
    if (!workspace) return;
    const ids = openSpaceKey ? openSpaceKey.split('\n').filter(Boolean) : [];
    const activeSpaceIds = new Set([
      ...ids,
      ...spaces.map((space) => space.space_id),
      ...(selectedId && selectedId !== VIRTUAL_DEFAULT_SPACE_ID
        ? [selectedId]
        : []),
      ...(unassignedId ? [unassignedId] : []),
    ]);
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let unlistenWorkspaceSessions: (() => void) | undefined;

    const refreshSpaceMembers = async (spaceId: string) => {
      if (spaceId.startsWith('direct:')) return;
      const page = await collaborationCall<{ members?: SpaceMember[] }>(
        'collaboration',
        'space.listMembers',
        { spaceId }
      );
      if (cancelled) return;
      setMembersBySpace((current) => ({
        ...current,
        [spaceId]: attachSidebarIdentityIds(
          page.members ?? [],
          sidebarItemsRef.current
        ),
      }));
    };

    const syncIncrementalMessages = async (spaceId: string) => {
      const sinceSeq = latestMessageSeq(messagesRef.current);
      const directThreadId = directThreadRef.current;
      if (directThreadId) {
        const direct = await loadDirectMessages<SpaceMessage>(
          collaborationCall,
          directThreadId
        );
        if (cancelled) return;
        if (direct) {
          applyDirectMessages(directThreadId, direct.messages, false);
          return;
        }
        if (spaceId.startsWith('direct:')) return;
      }
      if (spaceId.startsWith('direct:')) return;
      const page = await collaborationCall<{
        messages?: SpaceMessage[];
        scheduled?: ScheduledSpaceMessage[];
      }>(
        'collaboration',
        'space.listMessages',
        sinceSeq > 0
          ? { spaceId, sinceSeq }
          : { spaceId, latest: true, limit: 200 }
      );
      if (cancelled) return;
      if (Array.isArray(page.scheduled)) {
        setScheduledMessages(page.scheduled);
      }
      const incoming = page.messages ?? [];
      setMessages((current) => {
        const merged =
          sinceSeq > 0 ? mergeSpaceMessages(current, incoming) : incoming;
        setMessagesBySpace((bySpace) => ({
          ...bySpace,
          [spaceId]: merged,
        }));
        return merged;
      });
      setPendingDirectMessages((current) =>
        reconcilePendingDirectMessages(current, incoming)
      );
    };

    const refreshSpaces = async () => {
      const page = await collaborationCall<{ spaces?: Space[] }>(
        'collaboration',
        'space.list',
        { workspaceId: workspace }
      );
      if (cancelled) return;
      const next = page.spaces ?? [];
      setSpaces(next);
      setSelectedId((current) =>
        next.some((item) => item.space_id === current)
          ? current
          : (next[0]?.space_id ?? '')
      );
    };

    void listenCollaborationSpaceChanged((payload) => {
      const event = parseSpaceChangedEvent(payload);
      if (!event || event.workspaceId !== workspace) return;
      void refreshSidebar();
      if (
        (event.seq === undefined && event.memberId === undefined) ||
        event.memberId === 'batch_delete'
      ) {
        void refreshSpaces().catch((cause: unknown) => {
          if (!cancelled) setError(surfaceErrorCopy(cause));
        });
      }
      if (event.memberId && activeSpaceIds.has(event.spaceId)) {
        void refreshSpaceMembers(event.spaceId).catch((cause: unknown) => {
          if (!cancelled) setError(surfaceErrorCopy(cause));
        });
        void loadConversations();
        if (
          selectedId &&
          selectedId !== VIRTUAL_DEFAULT_SPACE_ID &&
          (event.spaceId === selectedId ||
            event.spaceId === directThreadRef.current)
        ) {
          void syncIncrementalMessages(selectedId).catch((cause: unknown) => {
            if (!cancelled) setError(surfaceErrorCopy(cause));
          });
        }
      }
      if (event.seq !== undefined) {
        void loadConversations();
        if (
          selectedId &&
          selectedId !== VIRTUAL_DEFAULT_SPACE_ID &&
          (event.spaceId === selectedId ||
            (Boolean(directThreadRef.current) &&
              event.spaceId === directThreadRef.current))
        ) {
          void syncIncrementalMessages(selectedId).catch((cause: unknown) => {
            if (!cancelled) setError(surfaceErrorCopy(cause));
          });
        }
      }
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });

    void backendListen<WorkspaceSessionsChangedPayload>(
      WORKSPACE_SESSIONS_CHANGED_EVENT,
      (payload) => {
        if (cancelled) return;
        const payloadWorkspaceId = String(payload?.workspace_id ?? '').trim();
        const payloadConversationId = String(
          payload?.conversation_id ?? ''
        ).trim();
        if (
          !payloadWorkspaceId ||
          payloadWorkspaceId === workspace ||
          Boolean(payloadConversationId)
        ) {
          void loadConversations();
        }
      }
    ).then((stop) => {
      if (cancelled) stop();
      else unlistenWorkspaceSessions = stop;
    });

    const handleReconnect = () => {
      void refreshSpaces().catch((cause: unknown) => {
        if (!cancelled) setError(surfaceErrorCopy(cause));
      });
      void loadConversations();
      for (const spaceId of activeSpaceIds) {
        void refreshSpaceMembers(spaceId).catch((cause: unknown) => {
          if (!cancelled) setError(surfaceErrorCopy(cause));
        });
      }
      if (selectedId && selectedId !== VIRTUAL_DEFAULT_SPACE_ID) {
        void syncIncrementalMessages(selectedId).catch((cause: unknown) => {
          if (!cancelled) setError(surfaceErrorCopy(cause));
        });
      }
    };
    window.addEventListener('online', handleReconnect);
    window.addEventListener('vibex:host-client-changed', handleReconnect);

    return () => {
      cancelled = true;
      unlisten?.();
      unlistenWorkspaceSessions?.();
      window.removeEventListener('online', handleReconnect);
      window.removeEventListener('vibex:host-client-changed', handleReconnect);
    };
  }, [
    applyDirectMessages,
    loadConversations,
    refreshSidebar,
    openSpaceKey,
    selectedId,
    spaces,
    unassignedId,
    workspace,
  ]);

  const prevActivePreviewKeyRef = useRef<string>('');
  useEffect(() => {
    const currentKey =
      showPreview && activePreviewTabId ? activePreviewTabId : '';
    const prevKey = prevActivePreviewKeyRef.current;
    prevActivePreviewKeyRef.current = currentKey;
    if (!currentKey || currentKey === prevKey) return;
    const activeTab = previewTabs.find((tab) => tab.id === currentKey);
    if (activeTab?.kind === 'member' && activeTab.conversationId) {
      markMemberConversationViewed(activeTab.conversationId);
    }
  }, [
    activePreviewTabId,
    markMemberConversationViewed,
    previewTabs,
    showPreview,
  ]);

  const pendingViewedSpaceIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !pendingViewedSpaceIdRef.current ||
      pendingViewedSpaceIdRef.current !== selectedId
    ) {
      return;
    }
    if (messages.length === 0) return;
    markSpaceInReviewMembersViewed(selectedId);
    pendingViewedSpaceIdRef.current = null;
  }, [markSpaceInReviewMembersViewed, messages, selectedId]);

  useEffect(() => {
    setMessages([]);
    setScheduledMessages([]);
    setSpaceQueuedMessages([]);
    setEditingSpaceMessageId(null);
    setHoveredDelayedMemberKey(null);
    setReceiptsBySeq({});
    setDraft('');
    replaceDraftRef.current?.('');
    setError('');
    setOperationId(crypto.randomUUID());
  }, [selectedId]);

  useEffect(() => {
    if ((!createMemberOpen && !createOpen) || !workspace) return;
    let cancelled = false;
    void collaborationCall<{ conversations?: ConversationOption[] }>(
      'collaboration',
      'space.listConversations',
      { workspaceId: workspace }
    )
      .then((page) => {
        if (!cancelled) setConversations(page.conversations ?? []);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          if (createMemberOpen) setCreateMemberError(surfaceErrorCopy(cause));
          if (createOpen) setCreateError(surfaceErrorCopy(cause));
        }
      });
    void loadRolesAndAgents();
    return () => {
      cancelled = true;
    };
  }, [createMemberOpen, createOpen, loadRolesAndAgents, workspace]);

  const closeAllOverlays = useCallback(() => {
    overlayOpenedByUserRef.current = true;
    setCreateOpen(false);
    setCreateError('');
    setCreateMemberOpen(false);
    setCreateMemberError('');
    setRenameOpen(false);
    setRenameError('');
    setRenameSpaceOpen(false);
    setRenameSpaceError('');
    if (selectedIdRef.current) {
      setThreadVisible(true);
    }
  }, [setThreadVisible]);

  useEffect(() => {
    if (!hasActiveOverlay) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeAllOverlays();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeAllOverlays, hasActiveOverlay]);

  const ensureMessageAreaOpenForOverlay = () => {
    setThreadVisible(true);
    if (phone) {
      setSpacesVisible(false);
    }
  };

  const updateSpaceTag = (spaceId: string, config: SpaceTagConfig | null) => {
    setSpaceTags((current) => {
      const next = { ...current };
      if (!config || !config.colorId) {
        delete next[spaceId];
      } else {
        next[spaceId] = config;
      }
      if (!sidebarItems) writeSpaceTags(next);
      return next;
    });
    if (sidebarItems) {
      void updateThreadTagColor(
        collaborationCall,
        spaceId,
        config?.colorId ?? ''
      ).then((ok) => {
        if (!ok) {
          setSpaceTags((current) => {
            writeSpaceTags(current);
            return current;
          });
        }
      });
    }
  };

  const openFilePreview = useCallback(
    (params: PreviewPanelParams) => {
      openPreviewItem({
        id: filePreviewPanelId(params),
        kind: 'file',
        title: filePreviewTitle(params),
        fileParams: params,
      });
    },
    [openPreviewItem]
  );

  const openWorkspacePanel = useCallback(
    (item: {
      id: string;
      component: string;
      title: string;
      params?: Record<string, unknown>;
    }) => {
      openPreviewItem({
        id: item.id,
        kind: 'workspace-panel',
        component: item.component,
        title: item.title,
        params: item.params,
      });
    },
    [openPreviewItem]
  );

  const runInCollaborationEditorGroup = useCallback(
    (_groupId: string, action: () => void) => {
      action();
    },
    []
  );

  const openCreateSpaceDialog = () => {
    closeAllOverlays();
    ensureMessageAreaOpenForOverlay();
    setSpaceName('');
    setSpaceTagColorId('');
    setSpaceTagCustomLabel('');
    setSelectedSpaceMemberConvIds(new Set());
    setDraftMemberMetaByConvId({});
    setCreateError('');
    setCreateOpen(true);
  };

  const openCreateMemberDialog = (
    spaceId?: string,
    defaultSource?: MemberSourceOption
  ) => {
    closeAllOverlays();
    ensureMessageAreaOpenForOverlay();
    const resolvedSpaceId =
      spaceId ??
      ((selectedId && selectedId !== VIRTUAL_DEFAULT_SPACE_ID
        ? selectedId
        : undefined) ||
        (spaces[0]?.space_id ?? unassignedId));
    if (spaceId && spaces.some((item) => item.space_id === spaceId)) {
      setSelectedId(spaceId);
    }
    setCreateMemberSpaceId(resolvedSpaceId);
    setNewMemberName('');
    setNewMemberAvatar(randomMemberBotAvatar());
    setNewMemberSessionId('');
    setNewMemberPersonaPrompt('');
    setCreateMemberError('');
    if (defaultSource) {
      setNewMemberSource(defaultSource);
    } else if (roles.length === 0 && agents.length > 0) {
      setNewMemberSource('custom');
    } else {
      setNewMemberSource('role');
    }
    setCreateMemberOpen(true);
  };

  const openCreateMemberDialogRef = useRef(openCreateMemberDialog);
  openCreateMemberDialogRef.current = openCreateMemberDialog;

  useEffect(() => {
    const onAdd = (event: Event) => {
      const spaceId = (event as CustomEvent<{ spaceId?: string }>).detail
        ?.spaceId;
      if (spaceId) openCreateMemberDialogRef.current(spaceId);
    };
    window.addEventListener(COLLABORATION_ADD_MEMBER_EVENT, onAdd);
    return () => {
      window.removeEventListener(COLLABORATION_ADD_MEMBER_EVENT, onAdd);
    };
  }, []);

  const selectSpace = (spaceId: string, nextExpanded = true) => {
    closeAllOverlays();
    setActiveDirect(null);
    setSelectedMemberKey('');
    pendingViewedSpaceIdRef.current = spaceId;
    setSelectedId(spaceId);
    setThreadVisible(true);
    setExpanded((current) => ({ ...current, [spaceId]: nextExpanded }));
    markSpaceInReviewMembersViewed(spaceId);
  };

  // Select a member's private (1:1) chat in the flat list and show the chat
  // message area. Never opens a member session or session tab.
  const openPrivateChat = (
    spaceId: string,
    member: SpaceMember,
    threadId?: string
  ) => {
    const directThreadId = directThreadIdFor(member, threadId);
    const paneId = directThreadId || threadId || spaceId;
    if (sidebarItems) {
      const lastSeq = sidebarItems.find((item) => item.thread_id === paneId)
        ?.last_message?.seq;
      void markThreadRead(
        collaborationCall,
        paneId,
        typeof lastSeq === 'number' ? lastSeq : undefined
      );
    }
    const memberKey = previewMemberKey(paneId, member);
    setActiveDirect(
      directThreadId
        ? {
            spaceId: paneId,
            memberKey,
            threadId: directThreadId,
            name: displayName(member),
          }
        : null
    );
    if (directThreadId) {
      setMembersBySpace((current) => ({
        ...current,
        [directThreadId]: [member],
      }));
    }
    if (member.conversation_id) {
      markMemberConversationViewed(member.conversation_id);
    }
    closeAllOverlays();
    pendingViewedSpaceIdRef.current = paneId;
    setSelectedId(paneId);
    setSelectedMemberKey(memberKey);
    setThreadVisible(true);
  };

  const selectMemberForPreview = (spaceId: string, member: SpaceMember) => {
    if (spaces.some((item) => item.space_id === spaceId)) {
      setSelectedId(spaceId);
    }
    const memberKey = previewMemberKey(spaceId, member);
    const threadId =
      activeDirectThreadId ||
      chatListRef.current.find(
        (entry) => entry.type === 'group' && entry.spaceId === spaceId
      )?.threadId ||
      spaceId;
    const openWith = (conversationId: string) => {
      if (!conversationId) return;
      setSelectedMemberKey(memberKey);
      openMemberPreview(spaceId, member, conversationId);
    };
    if (member.member_id && threadId) {
      void resolveMemberSession(
        collaborationCall,
        member.member_id,
        threadId
      ).then((resolved) => {
        openWith(resolved || member.conversation_id || '');
      });
      return;
    }
    openWith(member.conversation_id || '');
  };

  // The chat a member tab is opened from: its `kind` decides the tab title.
  const memberTabThread = (
    spaceId: string | undefined
  ): { kind?: string | null; name?: string | null } | undefined => {
    if (!spaceId) return undefined;
    const item = sidebarItems?.find(
      (candidate) =>
        candidate.thread_id === spaceId ||
        (candidate.kind === 'group' && candidate.space_id === spaceId)
    );
    if (item) return item;
    if (activeDirectThreadId) {
      const direct = sidebarItems?.find(
        (candidate) => candidate.thread_id === activeDirectThreadId
      );
      return direct ?? { kind: 'direct' };
    }
    return spaces.find((space) => space.space_id === spaceId);
  };
  const memberTabTitleFor = (spaceId: string | undefined, name: string) =>
    memberTabTitle(name, memberTabThread(spaceId));

  const memberPreviewChrome = (
    spaceId: string | undefined,
    member: SpaceMember,
    conversationId: string,
    threadOverride?: { kind?: string | null; name?: string | null }
  ) => {
    const thread = threadOverride ?? memberTabThread(spaceId);
    const isGroup = thread?.kind === 'group';
    const sidebarGroup =
      isGroup && spaceId
        ? sidebarItems?.find(
            (candidate) =>
              candidate.thread_id === spaceId || candidate.space_id === spaceId
          )
        : undefined;
    const groupMembers =
      isGroup && spaceId
        ? (chatListRef.current.find(
            (entry): entry is Extract<ChatListEntry, { type: 'group' }> =>
              entry.type === 'group' &&
              (entry.spaceId === spaceId || entry.threadId === spaceId)
          )?.members ??
          membersBySpace[spaceId] ??
          sidebarGroup?.members_preview?.map(sidebarMemberToSpaceMember) ??
          [])
        : [];
    const tagColorId =
      (spaceId && spaceTags[spaceId]?.colorId) ||
      sidebarGroup?.tag_color ||
      (thread && 'tag_color' in thread ? thread.tag_color : undefined) ||
      '';
    const tagHue = SPACE_TAG_PRESETS.find(
      (preset) => preset.id === tagColorId
    )?.hue;
    return {
      title: memberTabTitle(displayName(member), thread),
      threadKind: thread?.kind ?? undefined,
      memberName: displayName(member),
      memberAvatar: getMemberAvatar(conversationId, displayName(member)),
      groupAvatars: groupMembers.map((item) =>
        getMemberAvatar(item.conversation_id ?? undefined, displayName(item))
      ),
      tagHue,
    };
  };

  const openMemberPreview = (
    spaceId: string,
    member: SpaceMember,
    conversationId: string,
    threadOverride?: { kind?: string | null; name?: string | null }
  ) => {
    const conv = conversationById.get(conversationId);
    const agentId =
      conv?.agent_id || draftMemberMetaByConvId[conversationId]?.agentId;
    const chrome = memberPreviewChrome(
      spaceId,
      member,
      conversationId,
      threadOverride
    );
    openPreviewItem({
      id: memberPreviewPanelId(conversationId),
      kind: 'member',
      title: chrome.title,
      workspaceId: workspace,
      conversationId,
      ...(agentId ? { agentId: String(agentId) } : {}),
      spaceId,
      threadKind: chrome.threadKind,
      memberName: chrome.memberName,
      memberAvatar: chrome.memberAvatar,
      groupAvatars: chrome.groupAvatars,
      tagHue: chrome.tagHue,
    });
  };

  const applySessionFocusRef = useRef(openMemberPreview);
  applySessionFocusRef.current = openMemberPreview;
  const applyPrivateChatRef = useRef(openPrivateChat);
  applyPrivateChatRef.current = openPrivateChat;
  const applySelectSpaceRef = useRef(selectSpace);
  applySelectSpaceRef.current = selectSpace;

  useEffect(() => {
    if (!sessionFocus || !workspace) return;
    const focus = sessionFocus;
    consumeSessionFocus();
    const member: SpaceMember = {
      kind: 'agent',
      member_id: focus.memberId,
      nickname: focus.memberName,
      conversation_id: focus.conversationId,
    };
    const thread = {
      kind: focus.threadKind,
      name: focus.threadName,
    };
    if (focus.threadKind === 'group') {
      applySelectSpaceRef.current(focus.threadId);
      applySessionFocusRef.current(
        focus.threadId,
        member,
        focus.conversationId,
        thread
      );
      return;
    }
    const sidebar = sidebarItems?.find(
      (item) => item.thread_id === focus.threadId
    );
    const spaceId =
      sidebar?.space_id || unassignedId || unassignedSpaceId(workspace);
    const resolvedMember = sidebar?.member
      ? sidebarMemberToSpaceMember(sidebar.member)
      : member;
    applyPrivateChatRef.current(spaceId, resolvedMember, focus.threadId);
    applySessionFocusRef.current(
      spaceId,
      resolvedMember,
      focus.conversationId,
      thread
    );
  }, [
    consumeSessionFocus,
    sessionFocus,
    sidebarItems,
    unassignedId,
    workspace,
  ]);

  const addDraftSpaceMember = (member: SpaceMember) => {
    const conversationId = String(member.conversation_id ?? '').trim();
    if (!conversationId) return;
    const usedNames = new Set(allExistingNicknames);
    for (const meta of Object.values(draftMemberMetaByConvId)) {
      if (meta.nickname) usedNames.add(meta.nickname);
    }
    const existingNick =
      draftMemberMetaByConvId[conversationId]?.nickname ||
      memberNicknameByConversationId.get(conversationId) ||
      displayName(member);
    const nick = existingNick || randomEnglishNickname(usedNames);
    const conv = conversationById.get(conversationId);
    setDraftMemberMetaByConvId((current) => ({
      ...current,
      [conversationId]: {
        ...current[conversationId],
        nickname: nick,
        agentId:
          current[conversationId]?.agentId ||
          (conv?.agent_id ? String(conv.agent_id) : undefined),
      },
    }));
    setSelectedSpaceMemberConvIds((current) => {
      const next = new Set(current);
      next.add(conversationId);
      return next;
    });
  };

  const removeDraftSpaceMember = (conversationId: string) => {
    setSelectedSpaceMemberConvIds((current) => {
      const next = new Set(current);
      next.delete(conversationId);
      return next;
    });
  };

  const requestCreateMemberSession = async (params: {
    spaceId: string;
    nickname: string;
    source: Exclude<MemberSourceOption, 'session'>;
    roleId: string;
    agentId: string;
    modeId: string;
    configValues: Record<string, string>;
    personaPrompt: string;
    avatar?: MemberBotAvatarConfig;
    color?: string;
  }) => {
    const avatarPayload = params.avatar
      ? typeof params.avatar === 'string'
        ? params.avatar
        : JSON.stringify(params.avatar)
      : undefined;
    const defaultColor =
      params.color ||
      (params.avatar &&
      typeof params.avatar === 'object' &&
      'color' in params.avatar &&
      typeof params.avatar.color === 'string'
        ? params.avatar.color
        : params.avatar &&
            typeof params.avatar === 'object' &&
            'bg' in params.avatar &&
            typeof params.avatar.bg === 'string'
          ? params.avatar.bg
          : '#38bdf8');
    const created = await collaborationCall<{
      space_id?: string;
      member_id?: string;
      conversation_id?: string;
      nickname?: string;
      private_thread_id?: string;
      private_conversation_id?: string;
      identity_member_id?: string;
      direct_thread_id?: string;
    }>('collaboration', 'space.createMember', {
      workspaceId: workspace,
      spaceId: params.spaceId,
      nickname: params.nickname,
      source: params.source,
      ...(avatarPayload ? { avatar: avatarPayload } : {}),
      color: defaultColor,
      ...(params.source === 'role'
        ? { roleId: params.roleId }
        : {
            agentId: params.agentId,
            modeId: params.modeId,
            configValues: params.configValues,
            personaPrompt: params.personaPrompt,
          }),
      operationId: crypto.randomUUID(),
    });
    const resolvedAgentId =
      params.source === 'role'
        ? roles.find((item) => item.id === params.roleId)?.agent_id
        : params.agentId;
    return { created, resolvedAgentId };
  };

  const createSpace = async () => {
    if (selectedSpaceMemberConvIds.size === 0) return;
    const memberNames = [...selectedSpaceMemberConvIds].map((convId) => {
      const draftMeta = draftMemberMetaByConvId[convId];
      return (
        draftMeta?.nickname ||
        memberNicknameByConversationId.get(convId) ||
        conversationById.get(convId)?.title ||
        convId
      );
    });
    const trimmedName =
      spaceName.trim() ||
      defaultGroupChatNameFromMembers(
        memberNames,
        spaces.map((space) => space.name)
      );
    if (!trimmedName) return;
    if (!workspace) {
      setCreateError(
        t('collaborationSpace.openWorkspaceFirst', COPY.openWorkspaceFirst)
      );
      return;
    }
    const created = await collaborationCall<Space>(
      'collaboration',
      'space.create',
      {
        workspaceId: workspace,
        name: trimmedName,
        operationId: crypto.randomUUID(),
      }
    );
    const createdSpaceId = created?.space_id ?? '';
    if (createdSpaceId && spaceTagColorId) {
      updateSpaceTag(createdSpaceId, {
        colorId: spaceTagColorId,
        ...(spaceTagCustomLabel.trim()
          ? { label: spaceTagCustomLabel.trim() }
          : {}),
      });
    }

    if (createdSpaceId && selectedSpaceMemberConvIds.size > 0) {
      const usedNames = new Set(allExistingNicknames);
      for (const convId of selectedSpaceMemberConvIds) {
        const draftMeta = draftMemberMetaByConvId[convId];
        const existingNick =
          draftMeta?.nickname || memberNicknameByConversationId.get(convId);
        const nick = existingNick || randomEnglishNickname(usedNames);
        usedNames.add(nick);
        // Joining a group keeps the member's private chat: the backend
        // creates a separate group session for the new seat.
        await collaborationCall('collaboration', 'space.addMember', {
          spaceId: createdSpaceId,
          conversationId: convId,
          nickname: nick,
          operationId: crypto.randomUUID(),
        });
      }
    }

    setSpaceName('');
    setSpaceTagColorId('');
    setSpaceTagCustomLabel('');
    setSelectedSpaceMemberConvIds(new Set());
    setDraftMemberMetaByConvId({});
    setCreateError('');
    setCreateOpen(false);

    if (createdSpaceId) {
      const nextCreated: Space = {
        space_id: createdSpaceId,
        name: created?.name || trimmedName,
      };
      setSpaces((current) =>
        current.some((item) => item.space_id === nextCreated.space_id)
          ? current
          : [...current, nextCreated]
      );
      selectSpace(createdSpaceId);
      await reloadSpaceMembers(createdSpaceId);
    }
    const page = await collaborationCall<{ spaces?: Space[] }>(
      'collaboration',
      'space.list',
      { workspaceId: workspace }
    );
    if (Array.isArray(page.spaces)) {
      setSpaces(page.spaces);
      if (!createdSpaceId && page.spaces[0]?.space_id) {
        selectSpace(page.spaces[0].space_id);
      }
    }
  };

  const createNewMember = async () => {
    const trimmedNickname = newMemberName.trim();
    if (!trimmedNickname || !workspace) return;

    if (newMemberSource === 'session') {
      const targetSpaceId =
        createMemberSpaceId &&
        spaces.some((space) => space.space_id === createMemberSpaceId)
          ? createMemberSpaceId
          : (selectedId && selectedId !== VIRTUAL_DEFAULT_SPACE_ID
              ? selectedId
              : '') || unassignedId;
      if (!targetSpaceId || !newMemberSessionId) return;
      await collaborationCall('collaboration', 'space.addMember', {
        spaceId: targetSpaceId,
        conversationId: newMemberSessionId,
        nickname: trimmedNickname,
        operationId: crypto.randomUUID(),
      });
      updateMemberAvatar(
        [newMemberSessionId, trimmedNickname],
        newMemberAvatar
      );
      setNewMemberName('');
      setNewMemberAvatar(randomMemberBotAvatar());
      setNewMemberSessionId('');
      setCreateMemberError('');
      setCreateMemberOpen(false);
      await loadConversations();
      await reloadSpaceMembers(targetSpaceId);
      if (unassignedId && unassignedId !== targetSpaceId) {
        await reloadSpaceMembers(unassignedId);
      }
      await refreshSidebar();
      const target = resolvePrivateChatTarget({
        created: { conversation_id: newMemberSessionId },
        fallbackNickname: trimmedNickname,
        directSpaceId: unassignedId || targetSpaceId,
        chatList: chatListRef.current,
      });
      openPrivateChat(target.spaceId, target.member, target.threadId);
      return;
    }

    if (newMemberSource === 'role' && !newMemberRoleId) return;
    if (newMemberSource === 'custom' && !newMemberAgentId) return;

    const targetSpaceId =
      createMemberSpaceId &&
      spaces.some((space) => space.space_id === createMemberSpaceId)
        ? createMemberSpaceId
        : '';

    const personaForBootstrap =
      newMemberPersonaPrompt.trim() ||
      (newMemberSource === 'role'
        ? roles.find((role) => role.id === newMemberRoleId)?.persona_prompt
        : undefined) ||
      '';
    const { created } = await requestCreateMemberSession({
      spaceId: targetSpaceId,
      nickname: trimmedNickname,
      source: newMemberSource,
      roleId: newMemberRoleId,
      agentId: newMemberAgentId,
      modeId: newMemberModeId,
      configValues: newMemberConfigValues,
      personaPrompt: newMemberPersonaPrompt,
      avatar: newMemberAvatar,
    });

    const effectiveSpaceId = created?.space_id || targetSpaceId || unassignedId;
    updateMemberAvatar(
      [
        created?.conversation_id,
        created?.private_conversation_id,
        created?.member_id,
        created?.identity_member_id,
        created?.nickname || trimmedNickname,
      ],
      newMemberAvatar
    );
    setNewMemberName('');
    setNewMemberAvatar(randomMemberBotAvatar());
    setNewMemberPersonaPrompt('');
    setCreateMemberError('');
    setCreateMemberOpen(false);

    await loadConversations();
    if (effectiveSpaceId && !effectiveSpaceId.startsWith('direct:')) {
      await reloadSpaceMembers(effectiveSpaceId);
    }
    if (unassignedId && unassignedId !== effectiveSpaceId) {
      await reloadSpaceMembers(unassignedId);
    }
    await refreshSidebar();
    if (created?.conversation_id || created?.identity_member_id) {
      // A member is a session family: land on its private chat, not a session.
      const target = resolvePrivateChatTarget({
        created,
        fallbackNickname: trimmedNickname,
        directSpaceId: unassignedId || effectiveSpaceId,
        chatList: chatListRef.current,
      });
      openPrivateChat(target.spaceId, target.member, target.threadId);
      if (target.threadId) {
        void postDirectMessage(
          collaborationCall,
          target.threadId,
          buildCollabDmBootstrapPrompt({
            userName: COPY.you,
            botName: created?.nickname || trimmedNickname,
            personaPrompt: personaForBootstrap,
            spaceId: target.threadId,
          }),
          crypto.randomUUID()
        )
          .then(() => {
            void refreshSidebar();
          })
          .catch(() => {
            // Greeting is best-effort; the private chat is already open.
          });
      }
    }
  };

  const addMemberToSpace = async (
    fromSpaceId: string,
    toSpaceId: string,
    conversationId: string,
    fallbackNickname?: string,
    memberId?: string
  ) => {
    if (!fromSpaceId || !toSpaceId || !conversationId) return;
    if (fromSpaceId === toSpaceId) return;
    const alreadyInGroup = async () => {
      if (isSpaceMember(toSpaceId, conversationId, memberId, fallbackNickname)) return true;
      if (membersBySpace[toSpaceId] || toSpaceId === VIRTUAL_DEFAULT_SPACE_ID)
        return false;
      try {
        const page = await collaborationCall<{ members?: SpaceMember[] }>(
          'collaboration',
          'space.listMembers',
          { spaceId: toSpaceId }
        );
        const enriched = attachSidebarIdentityIds(
          page?.members ?? [],
          sidebarItemsRef.current
        );
        setMembersBySpace((current) =>
          current[toSpaceId] ? current : { ...current, [toSpaceId]: enriched }
        );
        const probe = {
          conversation_id: conversationId,
          private_conversation_id: conversationId,
          member_id: memberId ?? null,
          identity_member_id: memberId ?? null,
          nickname: fallbackNickname ?? null,
          kind: 'agent',
        };
        return enriched.some((m) => matchesSpaceMemberIdentity(m, probe));
      } catch {
        return false;
      }
    };
    if (await alreadyInGroup()) {
      toast.info(
        t('collaborationSpace.memberAlreadyInGroup', {
          name: fallbackNickname || conversationId,
          defaultValue: '{{name}} 已在该群中',
        })
      );
      return;
    }

    // Adding to a group keeps the source seat (the private chat stays).
    setMembersBySpace((current) => {
      const sourceList = current[fromSpaceId] ?? [];
      const targetList = current[toSpaceId] ?? [];
      const moving = sourceList.find(
        (item) => item.conversation_id === conversationId
      );
      if (!moving) return current;
      return {
        ...current,
        [toSpaceId]: targetList.some(
          (item) => item.conversation_id === conversationId
        )
          ? targetList
          : [...targetList, moving],
      };
    });
    setExpanded((current) => ({ ...current, [toSpaceId]: true }));

    try {
      let effectiveToSpaceId = toSpaceId;
      const effectiveFromSpaceId =
        fromSpaceId === VIRTUAL_DEFAULT_SPACE_ID
          ? unassignedId || fromSpaceId
          : fromSpaceId;

      if (toSpaceId === VIRTUAL_DEFAULT_SPACE_ID && workspace) {
        const created = await collaborationCall<Space>(
          'collaboration',
          'space.create',
          {
            workspaceId: workspace,
            name: virtualDefaultSpaceName,
            operationId: crypto.randomUUID(),
          }
        );
        if (created?.space_id) {
          effectiveToSpaceId = created.space_id;
          if (spaceTags[VIRTUAL_DEFAULT_SPACE_ID]) {
            updateSpaceTag(
              created.space_id,
              spaceTags[VIRTUAL_DEFAULT_SPACE_ID]
            );
          }
          setSpaces((current) =>
            current.some((item) => item.space_id === created.space_id)
              ? current
              : [
                  ...current,
                  {
                    space_id: created.space_id,
                    name: created.name || virtualDefaultSpaceName,
                  },
                ]
          );
          setExpanded((current) => ({
            ...current,
            [created.space_id]: true,
          }));
          if (selectedId === VIRTUAL_DEFAULT_SPACE_ID || !selectedId) {
            setSelectedId(created.space_id);
          }
        }
      }

      await collaborationCall('collaboration', 'space.addMember', {
        spaceId: effectiveToSpaceId,
        conversationId,
        ...(fallbackNickname ? { nickname: fallbackNickname } : {}),
        operationId: crypto.randomUUID(),
      });
      const [fromPage, toPage] = await Promise.all([
        collaborationCall<{ members?: SpaceMember[] }>(
          'collaboration',
          'space.listMembers',
          { spaceId: effectiveFromSpaceId }
        ),
        collaborationCall<{ members?: SpaceMember[] }>(
          'collaboration',
          'space.listMembers',
          { spaceId: effectiveToSpaceId }
        ),
      ]);
      setMembersBySpace((current) => ({
        ...current,
        ...(Array.isArray(fromPage.members)
          ? {
              [effectiveFromSpaceId]: attachSidebarIdentityIds(
                fromPage.members,
                sidebarItemsRef.current
              ),
            }
          : {}),
        ...(Array.isArray(toPage.members)
          ? {
              [effectiveToSpaceId]: attachSidebarIdentityIds(
                toPage.members,
                sidebarItemsRef.current
              ),
            }
          : {}),
      }));
      void refreshSidebar();
    } catch (cause) {
      setError(surfaceErrorCopy(cause));
    }
  };

  const renameSpace = async () => {
    const nextName = renameSpaceName.trim();
    if (!renameSpaceTargetId || !nextName) return;
    const targetId = renameSpaceTargetId;
    setRenameSpaceName('');
    setRenameSpaceError('');
    setRenameSpaceOpen(false);
    setRenameSpaceTargetId('');

    if (targetId === VIRTUAL_DEFAULT_SPACE_ID) {
      setVirtualDefaultSpaceName(nextName);
      if (workspace) {
        try {
          const created = await collaborationCall<Space>(
            'collaboration',
            'space.create',
            {
              workspaceId: workspace,
              name: nextName,
              operationId: crypto.randomUUID(),
            }
          );
          if (created?.space_id) {
            if (spaceTags[VIRTUAL_DEFAULT_SPACE_ID]) {
              updateSpaceTag(
                created.space_id,
                spaceTags[VIRTUAL_DEFAULT_SPACE_ID]
              );
            }
            setSpaces((current) =>
              current.some((item) => item.space_id === created.space_id)
                ? current
                : [
                    ...current,
                    {
                      space_id: created.space_id,
                      name: created.name || nextName,
                    },
                  ]
            );
            if (selectedId === VIRTUAL_DEFAULT_SPACE_ID || !selectedId) {
              setSelectedId(created.space_id);
            }
          }
        } catch {
          // Keep updated local default space name if backend creation fails
        }
      }
      return;
    }

    setSpaces((current) =>
      current.map((item) =>
        item.space_id === targetId ? { ...item, name: nextName } : item
      )
    );
    await collaborationCall('collaboration', 'space.rename', {
      spaceId: targetId,
      name: nextName,
    });
  };

  const renameMember = async () => {
    const nextNickname = renameNickname.trim();
    if (!renameSpaceId || !renameConversationId || !nextNickname) return;
    await collaborationCall('collaboration', 'space.setIdentity', {
      spaceId: renameSpaceId,
      conversationId: renameConversationId,
      nickname: nextNickname,
      operationId: renameOperationId,
    });
    updateMemberAvatar([renameConversationId, nextNickname], renameAvatar);
    setRenameNickname('');
    setRenameError('');
    setRenameOpen(false);
    setRenameOperationId(crypto.randomUUID());
    const tabId = memberPreviewPanelId(renameConversationId);
    const nextTitle = memberTabTitleFor(
      (() => {
        const tab = previewTabs.find((item) => item.id === tabId);
        return tab && 'spaceId' in tab ? tab.spaceId : renameSpaceId;
      })(),
      nextNickname
    );
    setPreviewTabs((current) =>
      current.map((item) =>
        item.id === tabId ? { ...item, title: nextTitle } : item
      )
    );
    previewDockviewApiRef.current?.getPanel(tabId)?.api.setTitle(nextTitle);
    const memberPage = await collaborationCall<{ members?: SpaceMember[] }>(
      'collaboration',
      'space.listMembers',
      { spaceId: renameSpaceId }
    );
    setMembersBySpace((current) => ({
      ...current,
      [renameSpaceId]: memberPage.members ?? [],
    }));
  };

  const handleToggleDeleteMode = () => {
    setIsDeleteMode((current) => {
      const next = !current;
      if (!next) {
        setSelectedDeleteSpaceIds(new Set());
        setSelectedDeleteMemberKeys(new Set());
      }
      return next;
    });
  };

  const handleToggleSpaceDelete = (
    spaceId: string,
    spaceMembers: SpaceMember[]
  ) => {
    const updated = toggleSpaceDeleteSelection(
      spaceId,
      spaceMembers,
      selectedDeleteSpaceIds,
      selectedDeleteMemberKeys
    );
    setSelectedDeleteSpaceIds(updated.selectedSpaceIds);
    setSelectedDeleteMemberKeys(updated.selectedMemberKeys);
  };

  const handleToggleMemberDelete = (
    spaceId: string,
    conversationId: string
  ) => {
    setSelectedDeleteMemberKeys((current) =>
      toggleMemberDeleteSelection(spaceId, conversationId, current)
    );
  };

  const selectedDeleteCount =
    selectedDeleteSpaceIds.size + selectedDeleteMemberKeys.size;

  const confirmBatchDelete = async () => {
    if (!workspace || selectedDeleteCount === 0 || isDeletingBatch) return;
    setIsDeletingBatch(true);
    try {
      const spaceIds = [...selectedDeleteSpaceIds];
      const memberTargets = [...selectedDeleteMemberKeys]
        .map(parseMemberSelectionKey)
        .filter((item): item is NonNullable<typeof item> => Boolean(item));

      await collaborationCall('collaboration', 'space.batchDelete', {
        workspaceId: workspace,
        spaceIds,
        memberTargets,
        operationId: crypto.randomUUID(),
      });

      setSelectedDeleteSpaceIds(new Set());
      setSelectedDeleteMemberKeys(new Set());
      setIsDeleteMode(false);

      const spacePage = await collaborationCall<{ spaces?: Space[] }>(
        'collaboration',
        'space.list',
        { workspaceId: workspace }
      );
      const nextSpaces = spacePage.spaces ?? [];
      setSpaces(nextSpaces);
      setSelectedId((current) =>
        nextSpaces.some((item) => item.space_id === current)
          ? current
          : (nextSpaces[0]?.space_id ?? '')
      );
      // Do not force-open create space dialog when spaces become empty.
      await loadConversations();

      const refreshIds = [
        ...nextSpaces.map((item) => item.space_id),
        ...(unassignedId ? [unassignedId] : []),
      ];
      const memberPages = await Promise.all(
        refreshIds.map((spaceId) =>
          collaborationCall<{ members?: SpaceMember[] }>(
            'collaboration',
            'space.listMembers',
            { spaceId }
          )
            .then((page) => [spaceId, page?.members ?? []] as const)
            .catch(() => [spaceId, [] as SpaceMember[]] as const)
        )
      );
      setMembersBySpace(() => {
        const next: Record<string, SpaceMember[]> = {};
        for (const [spaceId, list] of memberPages) {
          next[spaceId] = list;
        }
        return next;
      });
    } catch (cause) {
      setError(surfaceErrorCopy(cause));
    } finally {
      setIsDeletingBatch(false);
    }
  };

  const restoreDraft = (value: string) => {
    setDraft(value);
    replaceDraftRef.current?.(value);
  };

  const warmupCooldownRef = useRef(new SpaceWarmupCooldown());
  useEffect(() => {
    const spaceId = selected?.space_id;
    const isDirect =
      Boolean(activeDirectThreadId) || Boolean(spaceId?.startsWith('direct:'));
    if (
      !shouldWarmupGroupComposer({
        spaceId,
        isDirect,
        content: draft,
      })
    ) {
      return;
    }
    const to = postRecipients(draft, activeChatRoster);
    const handle = window.setTimeout(() => {
      if (!spaceId || !warmupCooldownRef.current.tryAcquire(spaceId, to)) {
        return;
      }
      void collaborationCall('collaboration', 'space.warmup', {
        spaceId,
        content: draft,
        to,
      }).catch((error) => {
        console.debug('collaboration space warmup failed', error);
      });
    }, SPACE_WARMUP_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [activeChatRoster, activeDirectThreadId, draft, selected?.space_id]);

  const promptContextMessages = useMemo(
    () =>
      messages.map((message) => {
        const author = messageAuthor(message.envelope);
        return {
          role: (author === COPY.you ? 'user' : 'assistant') as
            | 'user'
            | 'assistant',
          content: bubbleText(message.envelope),
          timestamp: null,
        };
      }),
    [messages]
  );

  const { isEnhancingPrompt, handleEnhancePrompt } =
    useSessionComposerPromptEnhancement({
      draftPrompt: draft,
      sessionId: selected?.space_id ?? null,
      workspaceId: workspace || null,
      contextMessages: promptContextMessages,
      applyEnhancedPrompt: restoreDraft,
      setFollowUpError: (message) => setError(message ?? ''),
    });

  const [attachedImages, setAttachedImages] = useState<
    SessionComposerImageAttachment[]
  >([]);
  const attachedImagesRef = useRef<SessionComposerImageAttachment[]>([]);
  const sentAttachmentsRef = useRef<SessionComposerImageAttachment[]>([]);
  useEffect(() => {
    attachedImagesRef.current = attachedImages;
  }, [attachedImages]);
  useEffect(
    () => () => {
      clearComposerImageAttachments(attachedImagesRef.current);
    },
    []
  );

  const handleRemoveAttachedImage = useCallback((id: string) => {
    setAttachedImages((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) {
        revokeComposerImagePreviewUrl(target);
      }
      return prev.filter((item) => item.id !== id);
    });
  }, []);

  const handleAttachFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setError('');
      for (const file of files) {
        try {
          const prepared = await prepareImageFileForUpload(file);
          const response = workspace
            ? await imagesApi
                .uploadForAttempt(workspace, prepared)
                .catch(() => imagesApi.upload(prepared))
            : await imagesApi.upload(prepared);
          const nextAttachment = createUploadedImageAttachment(
            response,
            URL.createObjectURL(file)
          );
          setAttachedImages((prev) => [...prev, nextAttachment]);
        } catch (cause) {
          setError(surfaceErrorCopy(cause));
        }
      }
    },
    [workspace]
  );

  const handleComposerFileSelect = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = '';
      if (files.length === 0) return;
      void handleAttachFiles(files);
    },
    [handleAttachFiles]
  );

  const openSpaceCollectionTab = useCallback(
    (spaceId: string, name?: string) => {
      if (!spaceId || spaceId === VIRTUAL_DEFAULT_SPACE_ID) return;
      const spaceMembers = agentRoster(
        membersBySpace[spaceId] ?? EMPTY_MEMBERS
      );
      const spaceAvatars = spaceMembers.map((member) =>
        getMemberAvatar(
          member.conversation_id ?? undefined,
          displayName(member)
        )
      );
      const tagColorId = spaceTags[spaceId]?.colorId;
      openWorkspacePanel({
        id: spaceCollectionPreviewPanelId(spaceId),
        component: 'space-collection',
        title: COPY.groupDetailsButton,
        params: {
          spaceId,
          spaceName: name ?? i18n.t('panels:ui.collabPage.spaces'),
          spaceAvatars,
          tagColorId,
          projectId: projectContext?.projectId ?? undefined,
          workspaceId: workspace || undefined,
          workspacePath,
        },
      });
    },
    [
      getMemberAvatar,
      membersBySpace,
      openWorkspacePanel,
      projectContext?.projectId,
      spaceTags,
      workspace,
      workspacePath,
    ]
  );

  const openAssistantDetailsTab = useCallback(() => {
    const threadId = activeDirectThreadId;
    if (!threadId) return;
    const sidebarMember = sidebarItems?.find(
      (item) => item.thread_id === threadId
    )?.member;
    if (!sidebarMember) return;
    const member = sidebarMemberToSpaceMember(sidebarMember);
    const name = displayName(member);
    const conversationId = member.conversation_id ?? '';
    const avatar = getMemberAvatar(conversationId, name);
    openWorkspacePanel({
      id: spaceCollectionPreviewPanelId(threadId),
      component: 'space-collection',
      title: COPY.assistantDetailsButton,
      params: {
        variant: 'assistant',
        spaceId: threadId,
        spaceName: name,
        spaceAvatars: [avatar],
        memberId: member.member_id,
        conversationId,
        memberAvatar: avatar,
        projectId: projectContext?.projectId ?? undefined,
        workspaceId: workspace || undefined,
        workspacePath,
      },
    });
  }, [
    activeDirectThreadId,
    getMemberAvatar,
    openWorkspacePanel,
    projectContext?.projectId,
    sidebarItems,
    workspace,
    workspacePath,
  ]);

  const handleQuoteSelection = useCallback((selectedText: string) => {
    const trimmed = selectedText.trim();
    if (!trimmed) return;
    requestComposerTokenInsert({
      value: formatQuoteToken(trimmed),
      label: quoteTokenChipLabel(trimmed),
      conversationId: 'collaboration-space-composer',
    });
  }, []);

  const handleAddSelectionToCollection = useCallback(
    async (selectedText: string) => {
      const trimmed = selectedText.trim();
      if (
        !trimmed ||
        !selected ||
        selected.space_id === VIRTUAL_DEFAULT_SPACE_ID
      ) {
        return;
      }
      try {
        await collaborationCall('collaboration', 'space.addCollectionItem', {
          spaceId: selected.space_id,
          projectId: projectContext?.projectId ?? undefined,
          kind: 'text',
          content: trimmed,
          creatorNickname: 'User',
        });
        toast.success(i18n.t('panels:ui.collabPage.addedToGroupSaved'));
        openSpaceCollectionTab(selected.space_id, selected.name);
      } catch (cause) {
        setError(surfaceErrorCopy(cause));
      }
    },
    [openSpaceCollectionTab, projectContext?.projectId, selected]
  );

  const handleTriggerAtMember = useCallback(() => {
    const nextValue = draft.endsWith('@')
      ? draft
      : draft.length > 0 && !/\s$/.test(draft)
        ? `${draft} @`
        : `${draft}@`;
    setDraft(nextValue);
    replaceDraftRef.current?.(nextValue);

    const root = composerContainerRef.current;
    const editable = root?.querySelector<HTMLDivElement>(
      '[contenteditable="true"], [contenteditable="false"][role="combobox"]'
    );
    if (!editable) return;
    editable.focus();

    let lastTextNode: Text | null = null;
    const walker = document.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      lastTextNode = current as Text;
      current = walker.nextNode();
    }
    if (!lastTextNode || !(lastTextNode.textContent ?? '').endsWith('@')) {
      const suffix =
        editable.textContent &&
        !editable.textContent.endsWith('@') &&
        !/\s$/.test(editable.textContent)
          ? ' @'
          : !editable.textContent?.endsWith('@')
            ? '@'
            : '';
      if (suffix) {
        if (lastTextNode) {
          lastTextNode.textContent = `${lastTextNode.textContent ?? ''}${suffix}`;
        } else {
          lastTextNode = document.createTextNode(nextValue || '@');
          editable.appendChild(lastTextNode);
        }
      }
    }
    if (lastTextNode) {
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        const offset = (lastTextNode.textContent ?? '').length;
        range.setStart(lastTextNode, offset);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    editable.dispatchEvent(new Event('input', { bubbles: true }));
  }, [draft]);

  const send = async (rawText: string) => {
    const sendingAttachments = attachedImagesRef.current;
    const content = buildCollaborationSendContent(
      rawText,
      sendingAttachments
    );
    const textPart = rawText.replace(/\u00a0/g, ' ').trim();
    if (!selected || !content || sending) return;
    const sendingDirect =
      Boolean(directThreadRef.current) ||
      selected.space_id.startsWith('direct:');
    if (
      !sendingDirect &&
      textPart &&
      strayMentions(textPart, activeChatRoster).length > 0
    ) {
      restoreDraft(rawText);
      setError(COPY.nicknameMissing);
      return;
    }
    const beforeSend = beginCollaborationComposerSend(sendingAttachments);
    sentAttachmentsRef.current = beforeSend.sentAttachments;
    setDraft(beforeSend.message);
    replaceDraftRef.current?.('');
    setAttachedImages(beforeSend.attachments);
    const restoreComposer = () => {
      restoreDraft(rawText);
      setAttachedImages((current) => {
        const restored = restoreCollaborationComposerAfterSendFailure({
          currentAttachments: current,
          sentAttachments: sentAttachmentsRef.current,
        });
        sentAttachmentsRef.current = [];
        return restored;
      });
    };
    const finishSuccessfulSend = () => {
      revokeCollaborationSendAttachments(sentAttachmentsRef.current);
      sentAttachmentsRef.current = [];
      setError('');
      setOperationId(crypto.randomUUID());
    };
    setSending(true);
    try {
      const directThreadId =
        directThreadRef.current ||
        (selected.space_id.startsWith('direct:') ? selected.space_id : null);
      if (directThreadId) {
        // Queueing is immediate; listMessages may lag one round-trip, so keep
        // an optimistic bubble until operationId/content matches.
        const op = operationId;
        setPendingDirectMessages((current) => [
          ...current.filter((item) => item.operationId !== op),
          {
            operationId: op,
            threadId: directThreadId,
            content,
            createdAt: Date.now(),
          },
        ]);
        try {
          await postDirectMessage(
            collaborationCall,
            directThreadId,
            content,
            op
          );
        } catch (cause) {
          setPendingDirectMessages((current) =>
            current.filter((item) => item.operationId !== op)
          );
          throw cause;
        }
        finishSuccessfulSend();
        void loadConversations();
        void refreshSidebar();
        const page = await loadDirectMessages<SpaceMessage>(
          collaborationCall,
          directThreadId
        );
        if (page) {
          applyDirectMessages(directThreadId, page.messages, false);
        }
        return;
      }
      const recipients = postRecipients(textPart || content, activeChatRoster);
      const op = operationId;
      const spaceId = selected.space_id;
      setPendingDirectMessages((current) => [
        ...current.filter((item) => item.operationId !== op),
        {
          operationId: op,
          threadId: spaceId,
          content,
          createdAt: Date.now(),
        },
      ]);
      let posted: {
        seq?: number;
        receipts?: DeliveryReceipt[];
      };
      try {
        posted = await collaborationCall<{
          seq?: number;
          receipts?: DeliveryReceipt[];
        }>('collaboration', 'space.post', {
          spaceId,
          content,
          to: recipients,
          operationId: op,
        });
      } catch (cause) {
        setPendingDirectMessages((current) =>
          current.filter((item) => item.operationId !== op)
        );
        throw cause;
      }
      const nextSeq =
        typeof posted.seq === 'number' && Number.isInteger(posted.seq)
          ? posted.seq
          : latestMessageSeq(messagesRef.current) + 1;
      const optimisticMessage: SpaceMessage = {
        seq: nextSeq,
        envelope: {
          actor: `vibex://space/${spaceId}/user`,
          content,
          ...(recipients.length > 0
            ? {
                to: recipients.map(
                  (nick) =>
                    `vibex://space/${spaceId}/member/${encodeURIComponent(nick)}`
                ),
              }
            : {}),
        },
      };
      setMessages((current) =>
        mergeSpaceMessages(current, [optimisticMessage])
      );
      setPendingDirectMessages((current) =>
        current.filter((item) => item.operationId !== op)
      );
      if (Array.isArray(posted.receipts) && posted.receipts.length > 0) {
        setReceiptsBySeq((current) => ({
          ...current,
          [nextSeq]: posted.receipts ?? [],
        }));
      }
      const failure = deliveryFailureCopy(posted.receipts);
      if (failure) {
        restoreComposer();
        setError(failure);
        return;
      }
      finishSuccessfulSend();
      void loadConversations();
      const sinceSeq = latestMessageSeq(messagesRef.current);
      const messagePage = await collaborationCall<{
        messages?: SpaceMessage[];
        scheduled?: ScheduledSpaceMessage[];
      }>(
        'collaboration',
        'space.listMessages',
        sinceSeq > 0
          ? { spaceId, sinceSeq }
          : { spaceId, latest: true, limit: 200 }
      );
      if (Array.isArray(messagePage.scheduled)) {
        setScheduledMessages(messagePage.scheduled);
      }
      const incoming = messagePage.messages ?? [];
      setPendingDirectMessages((current) =>
        reconcilePendingDirectMessages(current, incoming)
      );
      setMessages((current) =>
        sinceSeq > 0
          ? mergeSpaceMessages(current, incoming)
          : mergeSpaceMessages([optimisticMessage], incoming)
      );
    } catch (cause) {
      restoreComposer();
      setError(surfaceErrorCopy(cause));
    } finally {
      setSending(false);
    }
  };

  const clearDelayedMemberCloseTimeout = useCallback(() => {
    if (delayedMemberCloseTimeoutRef.current !== null) {
      window.clearTimeout(delayedMemberCloseTimeoutRef.current);
      delayedMemberCloseTimeoutRef.current = null;
    }
  }, []);

  const openDelayedMemberPopover = useCallback(
    (memberKey: string) => {
      clearDelayedMemberCloseTimeout();
      setHoveredDelayedMemberKey(memberKey);
    },
    [clearDelayedMemberCloseTimeout]
  );

  const scheduleCloseDelayedMemberPopover = useCallback(() => {
    clearDelayedMemberCloseTimeout();
    delayedMemberCloseTimeoutRef.current = window.setTimeout(() => {
      setHoveredDelayedMemberKey(null);
      delayedMemberCloseTimeoutRef.current = null;
    }, 150);
  }, [clearDelayedMemberCloseTimeout]);

  useEffect(
    () => () => {
      clearDelayedMemberCloseTimeout();
    },
    [clearDelayedMemberCloseTimeout]
  );

  const userDelayedSpaceMessages = useMemo<QueuedMessage[]>(
    () =>
      scheduledMessages
        .filter((item) => {
          const status = item.status ?? 'scheduled';
          const senderConv = item.caller_id ?? item.sender_conversation_id;
          const senderNick = item.nickname ?? item.sender_nickname;
          return (
            status === 'scheduled' &&
            !senderConv &&
            (!senderNick || senderNick === 'user')
          );
        })
        .map((item) => {
          const itemId = item.id ?? item.delayed_input_id ?? '';
          return {
            id: itemId,
            session_id: selected?.space_id ?? '',
            operationId: itemId,
            revision: 1n,
            sortKey: 1n,
            status: 'scheduled',
            deliverAt: item.deliver_at,
            data: {
              message: item.content,
              agentMessage: item.content,
              images: [],
              pluginActions: [],
            },
            executorProfileId: { executor: 'CLAUDE_CODE' },
            created_at: item.created_at,
            updated_at: item.updated_at ?? item.created_at,
          };
        }),
    [scheduledMessages, selected?.space_id]
  );

  const handleEditSpaceQueuedMessage = useCallback((message: QueuedMessage) => {
    setEditingSpaceMessageId(message.id);
    restoreDraft(message.data.message);
  }, []);

  const handleDeleteSpaceQueuedMessage = useCallback(
    async (message: QueuedMessage) => {
      if (!selected) return;
      if (message.deliverAt) {
        setScheduledMessages((current) =>
          current.filter(
            (item) => (item.id ?? item.delayed_input_id) !== message.id
          )
        );
        try {
          await collaborationCall(
            'collaboration',
            'space.cancelScheduledMessage',
            {
              spaceId: selected.space_id,
              id: message.id,
            }
          );
        } catch (cause) {
          setError(surfaceErrorCopy(cause));
        }
      } else {
        setSpaceQueuedMessages((current) =>
          current.filter((item) => item.id !== message.id)
        );
      }
      if (editingSpaceMessageId === message.id) {
        setEditingSpaceMessageId(null);
      }
    },
    [editingSpaceMessageId, selected]
  );

  const handleDelaySpaceQueuedMessage = useCallback(
    async (message: QueuedMessage, delaySeconds: number) => {
      if (!selected || delaySeconds <= 0) return;
      setSpaceQueuedMessages((current) =>
        current.filter((item) => item.id !== message.id)
      );
      try {
        const recipients = postRecipients(message.data.message, members);
        const posted = await collaborationCall<{
          message_id?: string;
          scheduled?: ScheduledSpaceMessage;
        }>('collaboration', 'space.post', {
          spaceId: selected.space_id,
          content: message.data.message,
          to: recipients,
          delaySeconds,
          operationId: crypto.randomUUID(),
        });
        if (posted?.scheduled) {
          const postedId =
            posted.scheduled.id ?? posted.scheduled.delayed_input_id;
          setScheduledMessages((current) => [
            ...current.filter(
              (item) => (item.id ?? item.delayed_input_id) !== postedId
            ),
            posted.scheduled!,
          ]);
        } else {
          const page = await collaborationCall<{
            scheduled?: ScheduledSpaceMessage[];
          }>('collaboration', 'space.listScheduledMessages', {
            spaceId: selected.space_id,
          });
          if (Array.isArray(page?.scheduled)) {
            setScheduledMessages(page.scheduled);
          }
        }
      } catch (cause) {
        setError(surfaceErrorCopy(cause));
      }
    },
    [members, selected]
  );

  const receiptLabels = useMemo(
    () => ({
      queued: COPY.receiptQueued,
      claimed: COPY.receiptClaimed,
      failed: t('collaborationSpace.receiptFailed', COPY.receiptFailed),
    }),
    [t]
  );

  const visibleRoster = useMemo(() => {
    if (activeDirectThreadId) {
      if (activeChatRoster.length > 0) return activeChatRoster;
      const item = sidebarItems?.find(
        (candidate) => candidate.thread_id === activeDirectThreadId
      );
      if (item?.member) return [sidebarMemberToSpaceMember(item.member)];
    }
    const fromSpace = agentRoster(members);
    if (fromSpace.length > 0) return fromSpace;
    if (!selectedId) return fromSpace;
    const sidebarGroup = sidebarItems?.find(
      (candidate) =>
        candidate.kind === 'group' &&
        (candidate.thread_id === selectedId ||
          candidate.space_id === selectedId)
    );
    if (sidebarGroup?.members_preview?.length) {
      return agentRoster(
        sidebarGroup.members_preview.map(sidebarMemberToSpaceMember)
      );
    }
    return fromSpace;
  }, [
    activeDirectThreadId,
    activeChatRoster,
    members,
    selectedId,
    sidebarItems,
  ]);

  const leadConversationIds = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedLeadMemberId) return ids;
    for (const member of [...members, ...visibleRoster]) {
      if (String(member.member_id ?? '').trim() !== selectedLeadMemberId) {
        continue;
      }
      const conversationId = String(member.conversation_id ?? '').trim();
      if (conversationId) ids.add(conversationId);
    }
    return ids;
  }, [members, selectedLeadMemberId, visibleRoster]);

  const workingMembers = useMemo(
    () =>
      visibleRoster
        .filter((member) => {
          const convId = member.conversation_id ?? '';
          return isMemberWorking(
            convId ? conversationById.get(convId) : undefined
          );
        })
        .map((member) => {
          const nick = displayName(member);
          const convId = member.conversation_id ?? '';
          return { name: nick, avatar: getMemberAvatar(convId, nick) };
        }),
    [conversationById, getMemberAvatar, visibleRoster]
  );

  const filteredMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          !isCollabDmBootstrapPrompt(bubbleText(message.envelope ?? {}))
      ),
    [messages]
  );

  const listAvatarPx = groupAvatarMemberSlotPx(
    CONTACT_AVATAR_PX,
    Math.max(visibleRoster.length, 1)
  );
  const listAvatarStyle = {
    width: `${listAvatarPx}px`,
    height: `${listAvatarPx}px`,
  } as CSSProperties;
  const listAvatarOutline = botSilhouetteOutline(listAvatarPx);

  const messageClusters = useMemo(
    () =>
      memberMessageClusters(
        filteredMessages.map((message, index) => {
          if (isCollaborationLimitNotice(message)) {
            return { fromYou: false, authorKey: `system:${index}` };
          }
          const author = messageAuthor(message.envelope);
          const fromYou = author === COPY.you;
          if (fromYou) return { fromYou: true, authorKey: '' };
          const conversationId = resolveMessageConversationId(
            message.envelope,
            members
          );
          return {
            fromYou: false,
            authorKey: conversationId || author || `anon:${index}`,
          };
        })
      ),
    [filteredMessages, members]
  );

  const navEntries = useMemo<ConversationMessageNavEntry[]>(
    () =>
      filteredMessages.map((message, index) => {
        const text = bubbleText(message.envelope);
        const singleLine = text.replace(/\s+/g, ' ').trim();
        return {
          key: `space-msg-${message.seq}`,
          index,
          ordinal: index + 1,
          preview:
            singleLine.length > 80
              ? `${singleLine.slice(0, 80)}…`
              : singleLine || `Message ${index + 1}`,
          additions: 0,
          deletions: 0,
        };
      }),
    [filteredMessages]
  );

  const scrollToMessage = useCallback(
    (index: number) => {
      setActiveNavIndex(index);
      const target = filteredMessages[index];
      if (!target) return;
      const el = messageItemRefs.current.get(String(target.seq));
      if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    },
    [filteredMessages]
  );

  const selectedTagConfig = useMemo(() => {
    if (!selected) return undefined;
    if (spaceTags[selected.space_id]) return spaceTags[selected.space_id];
    const sidebarGroup = sidebarItems?.find(
      (candidate) =>
        candidate.kind === 'group' &&
        (candidate.thread_id === selected.space_id ||
          candidate.space_id === selected.space_id)
    );
    if (sidebarGroup?.tag_color) {
      return { colorId: sidebarGroup.tag_color };
    }
    return undefined;
  }, [selected, sidebarItems, spaceTags]);
  const selectedTagPreset = selectedTagConfig
    ? SPACE_TAG_PRESETS.find(
        (preset) => preset.id === selectedTagConfig.colorId
      )
    : undefined;

  const clearComposerMembersCloseTimeout = useCallback(() => {
    if (composerMembersCloseTimeoutRef.current !== null) {
      window.clearTimeout(composerMembersCloseTimeoutRef.current);
      composerMembersCloseTimeoutRef.current = null;
    }
  }, []);

  const openComposerMembersMenu = useCallback(() => {
    clearComposerMembersCloseTimeout();
    setComposerMembersMenuOpen(true);
  }, [clearComposerMembersCloseTimeout]);

  const scheduleCloseComposerMembersMenu = useCallback(() => {
    clearComposerMembersCloseTimeout();
    composerMembersCloseTimeoutRef.current = window.setTimeout(() => {
      setComposerMembersMenuOpen(false);
      composerMembersCloseTimeoutRef.current = null;
    }, 140);
  }, [clearComposerMembersCloseTimeout]);

  useEffect(
    () => () => {
      clearComposerMembersCloseTimeout();
    },
    [clearComposerMembersCloseTimeout]
  );

  const unassignedMembers = useMemo(() => {
    if (!unassignedId) return EMPTY_MEMBERS;
    const assignedKeys = new Set<string>();
    for (const space of spaces) {
      for (const member of membersBySpace[space.space_id] ?? EMPTY_MEMBERS) {
        const key =
          member.conversation_id || member.member_id || member.nickname;
        if (key) assignedKeys.add(String(key));
      }
    }
    for (const member of membersBySpace[VIRTUAL_DEFAULT_SPACE_ID] ??
      EMPTY_MEMBERS) {
      const key = member.conversation_id || member.member_id || member.nickname;
      if (key) assignedKeys.add(String(key));
    }
    return agentRoster(membersBySpace[unassignedId] ?? EMPTY_MEMBERS).filter(
      (member) => {
        const key =
          member.conversation_id || member.member_id || member.nickname;
        return !key || !assignedKeys.has(String(key));
      }
    );
  }, [membersBySpace, spaces, unassignedId]);

  const hasActiveFilter = listSort !== 'activity';

  const doesMemberMatchQuery = useCallback(
    (member: SpaceMember, queryLower: string): boolean => {
      if (!queryLower) return true;
      const nick = displayName(member).toLowerCase();
      if (nick.includes(queryLower)) return true;
      const conv = member.conversation_id
        ? conversationById.get(member.conversation_id)
        : undefined;
      if (conv?.title && conv.title.toLowerCase().includes(queryLower)) {
        return true;
      }
      if (conv?.agent_id && conv.agent_id.toLowerCase().includes(queryLower)) {
        return true;
      }
      return false;
    },
    [conversationById]
  );

  const memberSourceOptions = useMemo<
    readonly CollaborationSelectOption<MemberSourceOption>[]
  >(
    () => [
      {
        value: 'role',
        label: COPY.memberSourceRole,
        icon: <Bot className="h-3 w-3 shrink-0" aria-hidden="true" />,
      },
      {
        value: 'session',
        label: COPY.memberSourceSession,
        icon: <MessageSquare className="h-3 w-3 shrink-0" aria-hidden="true" />,
      },
      {
        value: 'custom',
        label: COPY.memberSourceCustom,
        icon: <UserPlus className="h-3 w-3 shrink-0" aria-hidden="true" />,
      },
    ],
    []
  );

  const roleSelectOptions = useMemo<readonly CollaborationSelectOption[]>(
    () => [
      { value: '', label: COPY.chooseRole },
      ...roles.map((role) => ({
        value: role.id,
        label: `${role.name} (${getAgentName(role.agent_id) || role.agent_id})`,
        icon: role.agent_id ? (
          <AgentIcon
            agent={role.agent_id as ExecutorProfileId['executor']}
            className="h-3.5 w-3.5 shrink-0"
          />
        ) : undefined,
      })),
    ],
    [roles]
  );

  const chooseConversationLabel = t(
    'collaborationSpace.chooseConversation',
    COPY.chooseConversation
  );

  const conversationSelectOptions = useMemo<
    readonly CollaborationSelectOption[]
  >(
    () => [
      { value: '', label: chooseConversationLabel },
      ...conversations.map((conversation) => ({
        value: conversation.conversation_id,
        label:
          conversation.title ||
          conversation.agent_id ||
          conversation.conversation_id,
        icon: conversation.agent_id ? (
          <AgentIcon
            agent={conversation.agent_id as ExecutorProfileId['executor']}
            className="h-3.5 w-3.5 shrink-0"
          />
        ) : undefined,
      })),
    ],
    [chooseConversationLabel, conversations]
  );

  const agentSelectOptions = useMemo<readonly CollaborationSelectOption[]>(
    () => [
      { value: '', label: COPY.chooseAgent },
      ...agents.map((agent) => ({
        value: agent.agent_id,
        label: getAgentName(agent.agent_id) || agent.name || agent.agent_id,
        icon: (
          <AgentIcon
            agent={agent.agent_id as ExecutorProfileId['executor']}
            className="h-3.5 w-3.5 shrink-0"
          />
        ),
      })),
    ],
    [agents]
  );

  const defaultWorkspaceName = useMemo(() => {
    const pathName = workspacePath
      ?.replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .pop();
    return pathName || projectContext?.project?.name || workspace;
  }, [projectContext?.project?.name, workspace, workspacePath]);

  // Is this member already in the group chat? Uses the full space member list
  // when loaded, plus the sidebar's members_preview.
  const isSpaceMember = (
    spaceId: string,
    conversationId: string,
    memberId?: string,
    nickname?: string
  ): boolean => {
    const item = sidebarItems?.find(
      (candidate) =>
        candidate.kind === 'group' &&
        (candidate.space_id === spaceId || candidate.thread_id === spaceId)
    );
    const resolvedNickname =
      nickname ||
      memberNicknameByConversationId.get(conversationId) ||
      sidebarItems?.find(
        (candidate) =>
          isPrivateChatKind(candidate.kind) &&
          (candidate.member?.conversation_id === conversationId ||
            (Boolean(memberId) && candidate.member?.member_id === memberId))
      )?.member?.name ||
      allWorkspaceMembers.find(
        (m) =>
          m.conversation_id === conversationId ||
          (Boolean(memberId) &&
            (m.member_id === memberId || m.identity_member_id === memberId))
      )?.nickname ||
      null;
    const probe = {
      conversation_id: conversationId,
      private_conversation_id: conversationId,
      member_id: memberId ?? null,
      identity_member_id: memberId ?? null,
      nickname: resolvedNickname,
      kind: 'agent',
    };
    return (
      (membersBySpace[spaceId] ?? []).some((m) =>
        matchesSpaceMemberIdentity(m, probe)
      ) ||
      (item?.members_preview ?? []).some((m) =>
        matchesSpaceMemberIdentity(m, probe)
      )
    );
  };
  // Load full member lists for group chats whose preview is truncated, so
  // the duplicate check holds for groups with more than 4 members.
  const ensureGroupMembersLoaded = () => {
    for (const item of sidebarItems ?? []) {
      const spaceId = item.space_id;
      if (item.kind !== 'group' || !spaceId || membersBySpace[spaceId])
        continue;
      if ((item.member_count ?? 0) <= (item.members_preview?.length ?? 0))
        continue;
      void collaborationCall<{ members?: SpaceMember[] }>(
        'collaboration',
        'space.listMembers',
        { spaceId }
      )
        .then((page) => {
          const members = page?.members;
          if (Array.isArray(members)) {
            const enriched = attachSidebarIdentityIds(
              members,
              sidebarItemsRef.current
            );
            setMembersBySpace((current) =>
              current[spaceId] ? current : { ...current, [spaceId]: enriched }
            );
          }
        })
        .catch(() => undefined);
    }
  };
  const directThreadIdForMember = (member: SpaceMember) =>
    sidebarItems?.find(
      (item) =>
        isPrivateChatKind(item.kind) &&
        ((member.member_id && item.member?.member_id === member.member_id) ||
          (member.conversation_id &&
            item.member?.conversation_id === member.conversation_id))
    )?.thread_id;
  const currentSectionOf = (threadId: string): string => {
    const groupId = sidebarItems?.find(
      (item) => item.thread_id === threadId
    )?.group_id;
    return groupId && contactGroups?.some((g) => g.group_id === groupId)
      ? groupId
      : UNGROUPED_SECTION_ID;
  };
  const resolveSidebarDrop = (
    payload: SidebarDragPayload,
    clientX: number,
    clientY: number
  ): SidebarDropTarget => {
    let spaceId = '';
    let sectionId = '';
    const els =
      typeof document.elementsFromPoint === 'function'
        ? document.elementsFromPoint(clientX, clientY)
        : [];
    for (const el of els) {
      const node = el as HTMLElement;
      if (!spaceId)
        spaceId =
          (node.closest?.('[data-space-id]') as HTMLElement | null)?.dataset
            .spaceId ?? '';
      if (!sectionId)
        sectionId =
          (node.closest?.('[data-contact-section-id]') as HTMLElement | null)
            ?.dataset.contactSectionId ?? '';
    }
    if (els.length === 0) {
      for (const spaceEl of document.querySelectorAll<HTMLElement>(
        '[data-space-id]'
      )) {
        const rect = spaceEl.getBoundingClientRect();
        if (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          spaceId = spaceEl.dataset.spaceId ?? '';
          break;
        }
      }
    }
    // Member onto a group-chat row: add to that group (unless already in).
    if (payload.kind === 'member' && spaceId) {
      if (spaceId === payload.fromSpaceId) return null;
      return isSpaceMember(
        spaceId,
        payload.conversationId,
        payload.memberId,
        payload.nickname
      )
        ? { kind: 'blocked', spaceId }
        : { kind: 'space', spaceId };
    }
    // Otherwise (incl. a group chat over another group chat): the contact
    // group section under the pointer, header or body.
    const threadId = payload.threadId;
    if (!sectionId || !threadId) return null;
    if (currentSectionOf(threadId) === sectionId) return null;
    return { kind: 'section', sectionId };
  };
  const startSidebarPointerDrag = (
    event: React.PointerEvent,
    payload: SidebarDragPayload
  ) => {
    const startX = event.clientX;
    const startY = event.clientY;
    let activeDrag = false;
    let currentTarget: SidebarDropTarget = null;
    const setBodyBlocked = (blocked: boolean) =>
      document.body.classList.toggle('is-drag-blocked', blocked);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (
        !activeDrag &&
        Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5
      ) {
        return;
      }
      if (!activeDrag) {
        activeDrag = true;
        suppressNextMemberClickRef.current = true;
        if (payload.kind === 'member') {
          setDraggingMember({
            fromSpaceId: payload.fromSpaceId,
            conversationId: payload.conversationId,
            nickname: payload.nickname,
          });
          ensureGroupMembersLoaded();
        } else {
          setDraggingThreadName(payload.name);
        }
        document.body.classList.add('is-dragging-collaboration-member');
      }
      setPointerDragCursor({ x: moveEvent.clientX, y: moveEvent.clientY });
      currentTarget = resolveSidebarDrop(
        payload,
        moveEvent.clientX,
        moveEvent.clientY
      );
      setSidebarDropTarget(currentTarget);
      setBodyBlocked(currentTarget?.kind === 'blocked');
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      document.body.classList.remove('is-dragging-collaboration-member');
      setBodyBlocked(false);
      setPointerDragCursor(null);
      setDraggingMember(null);
      setDraggingThreadName(null);
      setSidebarDropTarget(null);
      setDropTargetSpaceId('');
    };

    const handlePointerUp = (upEvent: PointerEvent) => {
      const target =
        resolveSidebarDrop(payload, upEvent.clientX, upEvent.clientY) ??
        currentTarget;
      const wasDragging = activeDrag;
      cleanup();
      if (!wasDragging) return;
      window.setTimeout(() => {
        suppressNextMemberClickRef.current = false;
      }, 0);
      if (!target) return;
      if (target.kind === 'section') {
        if (payload.threadId)
          void moveContactToSection(payload.threadId, target.sectionId);
      } else if (payload.kind === 'member') {
        void addMemberToSpace(
          payload.fromSpaceId,
          target.spaceId,
          payload.conversationId,
          payload.nickname,
          payload.memberId
        );
      }
    };

    const handlePointerCancel = () => {
      cleanup();
      suppressNextMemberClickRef.current = false;
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
  };

  const renderMemberRow = (
    spaceId: string,
    member: SpaceMember,
    onOpen?: () => void,
    /** Sidebar chat entry: its preview/unread render inside the row. */
    chatEntry?: ChatListEntry
  ) => {
    const conversationId = member.conversation_id ?? '';
    const memberKey = previewMemberKey(spaceId, member);
    const tabId = conversationId ? memberPreviewPanelId(conversationId) : '';
    const memberDirectId = directThreadIdFor(member, chatEntry?.threadId);
    const directSelected =
      Boolean(activeDirectThreadId) &&
      Boolean(memberDirectId) &&
      activeDirectThreadId === memberDirectId;
    const active =
      selectedMemberKey === memberKey ||
      directSelected ||
      (tabId !== '' && activePreviewTabId === tabId);
    const name = displayName(member);
    const conv = conversationId
      ? conversationById.get(conversationId)
      : undefined;
    const resolvedAgentId =
      conv?.agent_id || draftMemberMetaByConvId[conversationId]?.agentId;
    const agentDisplayName = resolvedAgentId
      ? getAgentName(resolvedAgentId as ExecutorProfileId['executor'])
      : 'Agent';
    const isRunning = Boolean(conv?.turn_in_flight);
    const tone = workspaceSessionStatusTone({
      status: conv?.status ?? 'todo',
      isRunning,
    });
    const compactAge = conv?.updated_at
      ? formatCompactSessionAge(conv.updated_at)
      : i18n.t('panels:ui.collabPage.justNow');
    const rawWorkspaceLabel = (
      conv?.workspace_name ||
      defaultWorkspaceName ||
      ''
    ).trim();
    const isNonGitProject = projectContext?.project?.is_git === false;
    const workspaceDisplayLabel =
      isNonGitProject ||
      !rawWorkspaceLabel ||
      rawWorkspaceLabel.toLowerCase() === 'global'
        ? '-'
        : rawWorkspaceLabel;
    const teamDisplayLabel = conv?.team_name?.trim() || '-';
    const isEditingMemberName =
      renameOpen &&
      renameSpaceId === spaceId &&
      renameConversationId === conversationId &&
      Boolean(conversationId);
    const canDrag =
      !isDeleteMode &&
      !isEditingMemberName &&
      member.kind === 'agent' &&
      Boolean(conversationId);
    const isMemberCheckedForDelete =
      Boolean(conversationId) &&
      selectedDeleteMemberKeys.has(deleteMemberKey(spaceId, conversationId));
    const lastMessageText = contactLastMessagePreview(
      chatEntry,
      getMemberLastMessageInSpace(spaceId, member)
    );

    return (
      <div
        key={member.member_id ?? member.nickname ?? conversationId}
        className="collaboration-member-row-outer"
      >
        {isDeleteMode && member.kind === 'agent' && conversationId ? (
          <Checkbox
            className="collaboration-delete-checkbox"
            aria-label={i18n.t('panels:ui.collabPage.selectBotName', { name: name })}
            checked={isMemberCheckedForDelete}
            onCheckedChange={() =>
              handleToggleMemberDelete(spaceId, conversationId)
            }
          />
        ) : null}
        <div
          className={cn(
            'workspace-session-row collaboration-member-row flex-1 min-w-0',
            canDrag && 'is-draggable',
            active && 'is-selected',
            draggingMember?.conversationId === conversationId &&
              draggingMember?.fromSpaceId === spaceId &&
              'is-dragging'
          )}
          onPointerDown={(event) => {
            if (!canDrag || event.button !== 0) return;
            const targetEl = event.target as HTMLElement | null;
            if (
              targetEl?.closest(
                '.collaboration-member-hover-actions, input, [role="checkbox"]'
              )
            ) {
              return;
            }
            startSidebarPointerDrag(event, {
              kind: 'member',
              fromSpaceId: spaceId,
              conversationId,
              nickname: String(member.nickname ?? name),
              memberId: member.member_id ?? undefined,
              threadId: directThreadIdForMember(member),
            });
          }}
          onDragStart={(event) => {
            if (!canDrag) return;
            const payload = {
              fromSpaceId: spaceId,
              conversationId,
              nickname: String(member.nickname ?? name),
            };
            setDraggingMember(payload);
            const serialized = JSON.stringify(payload);
            event.dataTransfer?.setData(
              'application/x-vibex-space-member',
              serialized
            );
            event.dataTransfer?.setData('text/plain', serialized);
            if (event.dataTransfer) {
              event.dataTransfer.effectAllowed = 'move';
            }
          }}
          onDragEnd={() => {
            setDraggingMember(null);
            setPointerDragCursor(null);
            setDropTargetSpaceId('');
          }}
        >
          {isEditingMemberName ? (
            <div className="flex w-full flex-col gap-1.5 py-1">
              <form
                className="workspace-session-row-main is-editing flex items-center gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void renameMember().catch((cause: unknown) =>
                    setRenameError(surfaceErrorCopy(cause))
                  );
                }}
              >
                <span
                  className="workspace-session-icon shrink-0"
                  style={{
                    width: CONTACT_AVATAR_PX,
                    height: CONTACT_AVATAR_PX,
                  }}
                  aria-hidden="true"
                >
                  <MemberBotAvatar
                    config={renameAvatar}
                    sessionActive={Boolean(
                      isRunning || conv?.status === 'inprogress'
                    )}
                    data-testid={`collaboration-member-bot-avatar-${conversationId || name}`}
                  />
                  <span
                    className={cn(
                      'workspace-session-status',
                      `workspace-session-status--${tone}`
                    )}
                  data-status={tone}
                  title={t('conversation:children.status.' + tone, {
                    defaultValue: tone,
                  })}
                  />
                </span>
                <Input
                  aria-label={t('collaborationSpace.nickname', '昵称')}
                  value={renameNickname}
                  onChange={(event) => {
                    setRenameNickname(event.target.value);
                    setRenameOperationId(crypto.randomUUID());
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      setRenameOpen(false);
                      setRenameError('');
                    }
                  }}
                  placeholder={t('collaborationSpace.nickname', '昵称')}
                  className="workspace-session-title-input h-6 min-w-0 flex-1 px-1.5 text-[12px]"
                  autoFocus
                />
                <Button
                  type="button"
                  variant="icon"
                  size="icon"
                  className="collaboration-expand h-6 w-6 shrink-0"
                  aria-label={i18n.t('panels:ui.collabPage.cancelNicknameEdit')}
                  onClick={() => {
                    setRenameOpen(false);
                    setRenameError('');
                  }}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button
                  type="submit"
                  variant="icon"
                  size="icon"
                  className="collaboration-expand h-6 w-6 shrink-0"
                  aria-label={t(
                    'collaborationSpace.renameMember',
                    COPY.renameMember
                  )}
                  disabled={!renameNickname.trim()}
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </form>
              <div className="px-2 pb-1">
                <MemberBotAvatarPicker
                  value={renameAvatar}
                  onChange={setRenameAvatar}
                  compact
                />
              </div>
            </div>
          ) : (
            <>
              <TooltipProvider delayDuration={280}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="workspace-session-row-main collaboration-contact-row-main"
                      aria-label={name}
                      onMouseEnter={(event) => {
                        if (event.clientX > 0 || event.clientY > 0) {
                          setMemberHoverCursorPos({
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }
                      }}
                      onMouseMove={(event) => {
                        if (event.clientX > 0 || event.clientY > 0) {
                          setMemberHoverCursorPos({
                            x: event.clientX,
                            y: event.clientY,
                          });
                        }
                      }}
                      onClick={() => {
                        if (suppressNextMemberClickRef.current) {
                          suppressNextMemberClickRef.current = false;
                          return;
                        }
                        if (
                          isDeleteMode &&
                          member.kind === 'agent' &&
                          conversationId
                        ) {
                          handleToggleMemberDelete(spaceId, conversationId);
                          return;
                        }
                        if (onOpen) {
                          onOpen();
                          return;
                        }
                        openPrivateChat(spaceId, member);
                      }}
                    >
                      <span
                        className="workspace-session-icon"
                        style={{
                          width: CONTACT_AVATAR_PX,
                          height: CONTACT_AVATAR_PX,
                        }}
                        aria-hidden="true"
                      >
                        <MemberBotAvatar
                          config={getMemberAvatar(conversationId, name)}
                          sessionActive={Boolean(
                            isRunning || conv?.status === 'inprogress'
                          )}
                          data-testid={`collaboration-member-bot-avatar-${conversationId || name}`}
                        />
                        <span
                          className={cn(
                            'workspace-session-status',
                            `workspace-session-status--${tone}`
                          )}
                        data-status={tone}
                        title={t('conversation:children.status.' + tone, {
                          defaultValue: tone,
                        })}
                        />
                      </span>
                      <span className="collaboration-member-title-group">
                        <span className="collaboration-member-name">
                          {name}
                        </span>
                        {lastMessageText ? (
                          <span
                            className="collaboration-member-subtitle collaboration-member-last-message"
                            data-testid={`collaboration-member-last-message-${conversationId || name}`}
                          >
                            {lastMessageText}
                          </span>
                        ) : null}
                      </span>
                      <span
                        className={cn(
                          'workspace-session-meta-idle gap-1.5',
                          !isDeleteMode &&
                            member.kind === 'agent' &&
                            Boolean(conversationId) &&
                            'collaboration-member-meta--hide-on-hover'
                        )}
                      >
                        {isRunning ? (
                          <Loader2
                            className="h-3.5 w-3.5 shrink-0 animate-spin text-[hsl(var(--warning))]"
                            aria-hidden="true"
                          />
                        ) : null}
                        {compactAge ? (
                          <span className="workspace-session-age">
                            {compactAge}
                          </span>
                        ) : null}
                        <span
                          className="inline-flex shrink-0 items-center"
                          data-testid={`collaboration-member-row-agent-icon-${conversationId || name}`}
                        >
                          {resolvedAgentId ? (
                            <AgentIcon
                              agent={
                                resolvedAgentId as ExecutorProfileId['executor']
                              }
                              className="h-3.5 w-3.5 shrink-0"
                            />
                          ) : (
                            <Bot
                              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                              aria-hidden="true"
                            />
                          )}
                        </span>
                      </span>
                      {chatEntry ? renderChatMeta(chatEntry) : null}
                    </button>
                  </TooltipTrigger>
                  {!draggingMember ? (
                    <TooltipContent
                      side="right"
                      align="start"
                      sideOffset={8}
                      data-cursor-positioned={
                        memberHoverCursorPos ? 'true' : 'false'
                      }
                      style={
                        memberHoverCursorPos
                          ? ({
                              '--member-hover-x': `${memberHoverCursorPos.x + 12}px`,
                              '--member-hover-y': `${memberHoverCursorPos.y + 12}px`,
                              position: 'fixed',
                              left: `${memberHoverCursorPos.x + 12}px`,
                              top: `${memberHoverCursorPos.y + 12}px`,
                            } as CSSProperties)
                          : undefined
                      }
                      className="session-card-hover-info collaboration-member-hover-info"
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <div
                        className="session-card-hover-body"
                        data-testid={`collaboration-member-hover-info-${conversationId || name}`}
                      >
                        <div className="session-card-hover-name">{name}</div>
                        <div className="session-card-hover-agent">
                          {resolvedAgentId ? (
                            <AgentIcon
                              agent={
                                resolvedAgentId as ExecutorProfileId['executor']
                              }
                              className="h-3.5 w-3.5"
                            />
                          ) : (
                            <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                          <span>{agentDisplayName}</span>
                        </div>
                        <div className="session-card-hover-meta">
                          <div className="session-card-hover-field">
                            <div className="session-card-hover-label">
                              {i18n.t('panels:ui.collabPage.workspace')}
                            </div>
                            <div
                              className={cn(
                                'session-card-hover-value',
                                workspaceDisplayLabel === '-' && 'is-empty'
                              )}
                              data-testid={`collaboration-member-hover-workspace-${conversationId || name}`}
                            >
                              {workspaceDisplayLabel}
                            </div>
                          </div>
                          <div className="session-card-hover-field">
                            <div className="session-card-hover-label">
                              {i18n.t('panels:ui.collabPage.team')}
                            </div>
                            <div
                              className={cn(
                                'session-card-hover-value',
                                teamDisplayLabel === '-' && 'is-empty'
                              )}
                              data-testid={`collaboration-member-hover-team-${conversationId || name}`}
                            >
                              {teamDisplayLabel}
                            </div>
                          </div>
                        </div>
                      </div>
                    </TooltipContent>
                  ) : null}
                </Tooltip>
              </TooltipProvider>
              {!isDeleteMode && member.kind === 'agent' && conversationId ? (
                <div className="collaboration-member-hover-actions">
                  <Button
                    type="button"
                    variant="icon"
                    size="icon"
                    className="collaboration-expand collaboration-edit-name-btn"
                    aria-label={t('collaborationSpace.renameMemberAria', {
                      name,
                      defaultValue: `${COPY.renameMember} ${name}`,
                    })}
                    onClick={() => {
                      setRenameSpaceId(spaceId);
                      setRenameConversationId(conversationId);
                      setRenameNickname(String(member.nickname ?? name));
                      setRenameAvatar(getMemberAvatar(conversationId, name));
                      setRenameOperationId(crypto.randomUUID());
                      setRenameError('');
                      setRenameOpen(true);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>
              ) : null}
            </>
          )}
          {isEditingMemberName && renameError ? (
            <p className="collaboration-error px-2 text-xs">{renameError}</p>
          ) : null}
        </div>
      </div>
    );
  };

  const directFallbackMembers = (() => {
    const base = unassignedId
      ? (membersBySpace[unassignedId] ?? EMPTY_MEMBERS)
      : EMPTY_MEMBERS;
    if (sidebarItems || !activeDirect?.threadId) {
      return base;
    }
    const activeMembers = agentRoster(
      membersBySpace[activeDirect.threadId] ?? EMPTY_MEMBERS
    );
    if (activeMembers.length === 0) {
      return base;
    }
    const merged = [...base];
    for (const member of activeMembers) {
      if (
        !merged.some((existing) =>
          matchesSpaceMemberIdentity(existing, member)
        )
      ) {
        merged.push(member);
      }
    }
    return merged;
  })();

  const chatList = buildChatList({
    sidebarItems,
    spaces,
    membersBySpace,
    unassignedSpaceId: unassignedId || undefined,
    // Every agent's direct (1:1) chat lives in the unassigned space, even when
    // it also holds a seat in a group, so list the full direct roster.
    unassignedMembers: directFallbackMembers,
  });
  chatListRef.current = chatList;
  const createGroupBots = uniqueBotsForGroupMemberPicker({
    directMembers: chatList.flatMap((entry) =>
      entry.type === 'direct' ? [entry.member] : []
    ),
    unassignedMembers: unassignedId
      ? (membersBySpace[unassignedId] ?? EMPTY_MEMBERS)
      : EMPTY_MEMBERS,
    membersBySpace,
    excludeConversationIds: selectedSpaceMemberConvIds,
  });
  const queryLower = searchQuery.trim().toLowerCase();
  const globalSearchResults = (() => {
    const memberResults: Array<{
      kind: 'member';
      key: string;
      name: string;
      spaceId: string;
      member: SpaceMember;
      threadId?: string;
    }> = [];
    const seen = new Set<string>();
    for (const entry of chatList) {
      if (entry.type !== 'direct') continue;
      const name = entry.name;
      const dedupe = (
        entry.member.conversation_id ||
        entry.member.member_id ||
        name
      ).toLowerCase();
      if (!dedupe || seen.has(dedupe)) continue;
      if (queryLower && !doesMemberMatchQuery(entry.member, queryLower)) {
        continue;
      }
      seen.add(dedupe);
      memberResults.push({
        kind: 'member',
        key: `member:${dedupe}`,
        name,
        spaceId: entry.spaceId,
        member: entry.member,
        threadId: entry.threadId,
      });
    }
    const groupResults: Array<{
      kind: 'group';
      key: string;
      spaceId: string;
      name: string;
      memberNames: string;
      members: SpaceMember[];
    }> = [];
    for (const entry of chatList) {
      if (entry.type !== 'group') continue;
      const roster = entry.members;
      const memberNames = roster
        .map((member) => displayName(member))
        .join(', ');
      if (queryLower) {
        const nameMatches = entry.name.toLowerCase().includes(queryLower);
        const memberMatches = roster.some((member) =>
          doesMemberMatchQuery(member, queryLower)
        );
        if (!nameMatches && !memberMatches) continue;
      }
      groupResults.push({
        kind: 'group',
        key: entry.key,
        spaceId: entry.spaceId,
        name: entry.name,
        memberNames,
        members: roster,
      });
    }
    return [...memberResults, ...groupResults];
  })();
  const { visible: visibleChatList, hidden: hiddenChatList } =
    applyContactListView(chatList, contactChrome, listSort, typeFilter);
  const contactSections = sidebarAvailable
    ? buildContactSections(
        visibleChatList,
        contactGroups,
        t('collaborationSpace.contactGroupUngrouped', '未分组')
      )
    : null;
  const newGroupMenuItem: ProductContextMenuItem = {
    id: 'new-group',
    label: t(
      'collaborationSpace.contactGroupNew',
      COPY.createContactGroupButton
    ),
    icon: FolderPlus,
    onSelect: () => {
      void createGroup();
    },
  };
  const openContactMenu = (
    event: React.MouseEvent,
    items: ProductContextMenuItem[]
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setContactMenu({ x: event.clientX, y: event.clientY, items });
  };
  const patchSidebarUnread = (threadId: string, unreadCount: number) => {
    setSidebarItems((items) =>
      items
        ? items.map((item) =>
            item.thread_id === threadId
              ? { ...item, unread_count: unreadCount }
              : item
          )
        : items
    );
  };
  const deleteChatEntry = async (entry: ChatListEntry) => {
    if (!workspace) return;
    try {
      if (entry.type === 'group') {
        await collaborationCall('collaboration', 'space.batchDelete', {
          workspaceId: workspace,
          spaceIds: [entry.spaceId],
          memberTargets: [],
          operationId: crypto.randomUUID(),
        });
      } else {
        const conversationId = String(
          entry.member.conversation_id ?? ''
        ).trim();
        if (!conversationId) return;
        await collaborationCall('collaboration', 'space.batchDelete', {
          workspaceId: workspace,
          spaceIds: [],
          memberTargets: [{ spaceId: entry.spaceId, conversationId }],
          operationId: crypto.randomUUID(),
        });
      }
      await refreshSidebar();
      const spacePage = await collaborationCall<{ spaces?: Space[] }>(
        'collaboration',
        'space.list',
        { workspaceId: workspace }
      );
      setSpaces(spacePage.spaces ?? []);
    } catch (cause) {
      setError(surfaceErrorCopy(cause));
    }
  };
  const openRowContactMenu = (
    event: React.MouseEvent,
    entry: ChatListEntry
  ) => {
    const threadId = chatEntryThreadId(entry);
    if (!threadId) return;
    const pinned = contactChrome.pinned.includes(threadId);
    const hidden = contactChrome.hidden.includes(threadId);
    const unread = (entry.unreadCount ?? 0) > 0;
    openContactMenu(
      event,
      buildContactRowMenuItems({
        entry,
        pinned,
        hidden,
        unread,
        moveTargets: moveTargetsForEntry(entry, contactSections),
        onPin: () =>
          persistContactChrome(togglePinnedThread(contactChrome, threadId)),
        onMove: (sectionId) => void moveContactToSection(threadId, sectionId),
        onToggleUnread: () => {
          if (unread) {
            patchSidebarUnread(threadId, 0);
            void markThreadRead(collaborationCall, threadId);
          } else {
            patchSidebarUnread(threadId, Math.max(1, entry.unreadCount ?? 1));
            void markThreadUnread(collaborationCall, threadId);
          }
        },
        onRename: () => {
          if (entry.type === 'direct') {
            const conversationId = String(
              entry.member.conversation_id ?? ''
            ).trim();
            if (!conversationId) return;
            setRenameSpaceId(entry.spaceId);
            setRenameConversationId(conversationId);
            setRenameNickname(entry.name);
            setRenameAvatar(getMemberAvatar(conversationId, entry.name));
            setRenameOperationId(crypto.randomUUID());
            setRenameError('');
            setRenameOpen(true);
            return;
          }
          setRenameSpaceTargetId(entry.spaceId);
          setRenameSpaceName(entry.name);
          setRenameSpaceError('');
          setRenameSpaceOpen(true);
        },
        onCopyId: () => {
          const id = conversationIdForCopy(entry);
          void navigator.clipboard?.writeText(id);
        },
        onHide: () =>
          persistContactChrome(toggleHiddenThread(contactChrome, threadId)),
        onDelete: () => void deleteChatEntry(entry),
      })
    );
  };
  const openSectionContactMenu = (
    event: React.MouseEvent,
    section: ContactSection<ChatListEntry>
  ) => {
    openContactMenu(
      event,
      section.ungrouped
        ? [newGroupMenuItem]
        : [
            {
              id: 'rename-group',
              label: t('collaborationSpace.contactGroupRename', '重命名分组'),
              icon: Pencil,
              onSelect: () => setRenamingGroupId(section.id),
            },
            {
              id: 'delete-group',
              label: t('collaborationSpace.contactGroupDelete', '删除分组'),
              icon: Trash2,
              danger: true,
              onSelect: () => void deleteGroup(section.id),
            },
            { type: 'separator', id: 'sep-section-new' },
            newGroupMenuItem,
          ]
    );
  };
  const renderChatEntry = (entry: ChatListEntry) =>
    entry.type === 'group'
      ? renderSpaceGroup(
          { space_id: entry.spaceId, name: entry.name },
          { entry }
        )
      : renderDirectChatRow(entry);
  // Grouped mode: rows can be dragged between sections and right-clicked.
  const renderSectionEntry = (entry: ChatListEntry) => (
    <div
      key={entry.key}
      className="collaboration-contact-row"
      data-testid={`collaboration-contact-row-${entry.key}`}
      data-pinned={
        contactChrome.pinned.includes(chatEntryThreadId(entry) ?? '')
          ? 'true'
          : undefined
      }
      onPointerDown={(event) => {
        // DM rows drag through their member row (member payload); group
        // chats drag as a thread onto contact-group sections.
        if (entry.type !== 'group' || !entry.threadId || event.button !== 0)
          return;
        if (isDeleteMode) return;
        const targetEl = event.target as HTMLElement | null;
        if (
          targetEl?.closest(
            '.collaboration-space-hover-actions, input, [role="checkbox"], form'
          )
        )
          return;
        startSidebarPointerDrag(event, {
          kind: 'thread',
          threadId: entry.threadId,
          name: entry.name,
        });
      }}
      onClickCapture={(event) => {
        if (entry.type === 'group' && suppressNextMemberClickRef.current) {
          suppressNextMemberClickRef.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onContextMenu={(event) => openRowContactMenu(event, entry)}
    >
      {renderChatEntry(entry)}
    </div>
  );

  // Private chat: one agent member, rendered with that member's row (avatar,
  // name, last message); clicking opens the member's 1:1 chat.
  const renderDirectChatRow = (
    entry: Extract<ChatListEntry, { type: 'direct' }>
  ) => (
    <div
      key={entry.key}
      className="collaboration-chat-direct"
      data-testid={`collaboration-direct-chat-${entry.key}`}
      data-chat-type="direct"
    >
      {renderMemberRow(
        entry.spaceId,
        entry.member,
        () => openPrivateChat(entry.spaceId, entry.member, entry.threadId),
        entry
      )}
    </div>
  );

  // Unread badge only; last-message text lives under the name.
  const renderChatMeta = (entry: ChatListEntry) =>
    entry.unreadCount ? (
      <span
        className="collaboration-chat-meta"
        data-testid={`collaboration-chat-meta-${entry.key}`}
      >
        <span className="collaboration-chat-unread">{entry.unreadCount}</span>
      </span>
    ) : null;

  const renderSpaceGroup = (
    space: Space,
    options: {
      isUnassigned?: boolean;
      isVirtualDefault?: boolean;
      entry?: Extract<ChatListEntry, { type: 'group' }>;
    } = {}
  ) => {
    const { isUnassigned = false, isVirtualDefault = false, entry } = options;
    // Flat chat list: group rows never expand into a member list.
    const open = false;
    // Requirement 1: User ('你') is an invisible member and never appears in the member list
    const rawSpaceMembers = agentRoster(
      isUnassigned
        ? unassignedMembers
        : (membersBySpace[space.space_id] ??
            (entry?.members.length ? entry.members : EMPTY_MEMBERS))
    );
    const visibleAgentCount = entry?.memberCount ?? rawSpaceMembers.length;
    const spaceLog =
      space.space_id === selectedId
        ? messages
        : (messagesBySpace[space.space_id] ?? EMPTY_MESSAGES);
    let groupLastFallback = '';
    for (let index = spaceLog.length - 1; index >= 0; index -= 1) {
      const text = bubbleText(spaceLog[index]?.envelope ?? {});
      if (text.trim() && !isCollabDmBootstrapPrompt(text)) {
        groupLastFallback = messagePreviewText(text);
        break;
      }
    }
    const groupLastMessage = contactLastMessagePreview(entry, groupLastFallback);
    const spaceMemberAvatars = rawSpaceMembers.map((member) =>
      getMemberAvatar(member.conversation_id ?? undefined, displayName(member))
    );
    const tagConfig =
      spaceTags[space.space_id] ??
      (entry?.tagColor ? { colorId: entry.tagColor } : undefined);
    const tagPreset = tagConfig
      ? SPACE_TAG_PRESETS.find((preset) => preset.id === tagConfig.colorId)
      : undefined;
    const isDropBlocked =
      sidebarDropTarget?.kind === 'blocked' &&
      sidebarDropTarget.spaceId === space.space_id;
    const isDropTarget =
      !isDropBlocked &&
      (dropTargetSpaceId === space.space_id ||
        (sidebarDropTarget?.kind === 'space' &&
          sidebarDropTarget.spaceId === space.space_id));
    const draggedIsMember = Boolean(
      draggingMember &&
        isSpaceMember(
          space.space_id,
          draggingMember.conversationId,
          undefined,
          draggingMember.nickname
        )
    );
    const isSpaceCheckedForDelete =
      !isUnassigned &&
      !isVirtualDefault &&
      selectedDeleteSpaceIds.has(space.space_id);
    const isEditingSpaceName =
      renameSpaceOpen && renameSpaceTargetId === space.space_id;
    const hasSpaceHoverActions =
      !isDeleteMode && !isUnassigned && !isEditingSpaceName;

    return (
      <div
        key={space.space_id}
        data-space-id={space.space_id}
        data-testid={`collaboration-space-group-${space.space_id}`}
        className={cn(
          'collaboration-space',
          isDropTarget && 'is-drop-target',
          isDropBlocked && 'is-drop-blocked'
        )}
        data-drop-state={
          isDropBlocked ? 'blocked' : isDropTarget ? 'target' : undefined
        }
        onDragOver={(event) => {
          // Already a member: leave the drop disallowed (no highlight).
          if (draggedIsMember) return;
          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
          }
          if (dropTargetSpaceId !== space.space_id) {
            setDropTargetSpaceId(space.space_id);
          }
        }}
        onDragLeave={(event) => {
          if (
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setDropTargetSpaceId((current) =>
              current === space.space_id ? '' : current
            );
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDropTargetSpaceId('');
          let payload = draggingMember;
          const raw =
            event.dataTransfer?.getData('application/x-vibex-space-member') ||
            event.dataTransfer?.getData('text/plain');
          if (raw) {
            try {
              payload = JSON.parse(raw) as {
                fromSpaceId: string;
                conversationId: string;
                nickname: string;
              };
            } catch {
              // Use state fallback
            }
          }
          setDraggingMember(null);
          setPointerDragCursor(null);
          if (payload && payload.fromSpaceId !== space.space_id) {
            if (
              isSpaceMember(
                space.space_id,
                payload.conversationId,
                undefined,
                payload.nickname
              )
            ) {
              toast.info(
                t('collaborationSpace.memberAlreadyInGroup', {
                  name: payload.nickname,
                  defaultValue: '{{name}} 已在该群中',
                })
              );
              return;
            }
            void addMemberToSpace(
              payload.fromSpaceId,
              space.space_id,
              payload.conversationId,
              payload.nickname
            );
          }
        }}
      >
        <div className="collaboration-space-row-outer">
          {isDeleteMode && !isUnassigned && !isVirtualDefault ? (
            <Checkbox
              className="collaboration-delete-checkbox"
              aria-label={i18n.t('panels:ui.collabPage.selectSpaceName', { name: space.name })}
              checked={isSpaceCheckedForDelete}
              onCheckedChange={() =>
                handleToggleSpaceDelete(space.space_id, rawSpaceMembers)
              }
            />
          ) : null}
          <div
            className={cn(
              'workspace-session-row collaboration-space-row flex-1 min-w-0',
              !isUnassigned && space.space_id === selectedId && 'is-selected'
            )}
          >
            {isEditingSpaceName ? (
              <form
                className="workspace-session-row-main collaboration-space-header-main is-editing flex items-center gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  void renameSpace().catch((cause: unknown) =>
                    setRenameSpaceError(surfaceErrorCopy(cause))
                  );
                }}
              >
                <GroupAvatar
                  avatars={spaceMemberAvatars}
                  tagHue={tagPreset?.hue}
                  size={CONTACT_AVATAR_PX}
                />
                <Input
                  aria-label={i18n.t('panels:ui.collabPage.spaceNameInput')}
                  value={renameSpaceName}
                  onChange={(event) => setRenameSpaceName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      setRenameSpaceOpen(false);
                      setRenameSpaceError('');
                    }
                  }}
                  placeholder={t('collaborationSpace.spaceName', '空间名称')}
                  className="workspace-session-title-input h-6 min-w-0 flex-1 px-1.5 text-[12px]"
                  autoFocus
                />
                <Button
                  type="button"
                  variant="icon"
                  size="icon"
                  className="collaboration-expand h-6 w-6 shrink-0"
                  aria-label={i18n.t('panels:ui.collabPage.cancelSpaceRename')}
                  onClick={() => {
                    setRenameSpaceOpen(false);
                    setRenameSpaceError('');
                  }}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
                <Button
                  type="submit"
                  variant="icon"
                  size="icon"
                  className="collaboration-expand h-6 w-6 shrink-0"
                  aria-label={i18n.t('panels:ui.collabPage.confirmSpaceRename')}
                  disabled={!renameSpaceName.trim()}
                >
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              </form>
            ) : (
              <>
                <button
                  type="button"
                  className="workspace-session-row-main collaboration-space-header-main collaboration-contact-row-main"
                  aria-label={space.name}
                  onClick={() => {
                    if (!isUnassigned && !isVirtualDefault) {
                      const nextOpen =
                        space.space_id === selectedId && !hasActiveOverlay
                          ? !open
                          : true;
                      selectSpace(space.space_id, nextOpen);
                    } else if (isVirtualDefault) {
                      const nextOpen =
                        selectedId === VIRTUAL_DEFAULT_SPACE_ID &&
                        !hasActiveOverlay
                          ? !open
                          : true;
                      closeAllOverlays();
                      setSelectedId(VIRTUAL_DEFAULT_SPACE_ID);
                      setThreadVisible(true);
                      setExpanded((current) => ({
                        ...current,
                        [space.space_id]: nextOpen,
                      }));
                    } else {
                      setExpanded((current) => ({
                        ...current,
                        [space.space_id]: !open,
                      }));
                    }
                  }}
                >
                  <GroupAvatar
                    avatars={spaceMemberAvatars}
                    tagHue={tagPreset?.hue}
                    size={CONTACT_AVATAR_PX}
                  />
                  <span className="collaboration-contact-name-line">
                    <span className="workspace-session-title is-cjk">
                      {space.name}
                    </span>
                    <span
                      className="collaboration-contact-count workspace-session-group-count"
                      aria-label={`${visibleAgentCount}`}
                    >
                      ({visibleAgentCount})
                    </span>
                  </span>
                  {groupLastMessage ? (
                    <span
                      className="collaboration-member-last-message"
                      data-testid={`collaboration-contact-last-message-${entry?.key ?? space.space_id}`}
                    >
                      {groupLastMessage}
                    </span>
                  ) : null}
                  {entry ? renderChatMeta(entry) : null}
                </button>
                {hasSpaceHoverActions ? (
                  <div className="collaboration-space-hover-actions">
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="icon"
                          size="icon"
                          className="collaboration-expand"
                          aria-label={i18n.t('panels:ui.collabPage.tagFor', { name: space.name })}
                        >
                          <Tag className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-52 p-2.5">
                        <div className="flex flex-col gap-2">
                          <span className="text-xs font-medium text-[var(--text-strong)]">
                            {COPY.spaceTagLabel}
                          </span>
                          <div className="flex flex-wrap gap-1.5">
                            {SPACE_TAG_PRESETS.map((preset) => {
                              const selectedTag =
                                tagConfig?.colorId === preset.id;
                              return (
                                <button
                                  key={preset.id}
                                  type="button"
                                  className={cn(
                                    'collaboration-tag-swatch',
                                    selectedTag && 'is-selected'
                                  )}
                                  onClick={() =>
                                    updateSpaceTag(
                                      space.space_id,
                                      selectedTag
                                        ? null
                                        : {
                                            colorId: preset.id,
                                            label: tagConfig?.label,
                                          }
                                    )
                                  }
                                >
                                  <span
                                    className="collaboration-space-tag-dot"
                                    style={{
                                      backgroundColor: `hsl(${preset.hue})`,
                                    }}
                                  />
                                  <span>{preset.label}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>
                    <Button
                      type="button"
                      variant="icon"
                      size="icon"
                      className="collaboration-expand collaboration-edit-name-btn"
                      aria-label={i18n.t('panels:ui.collabPage.renameName', { name: space.name })}
                      onClick={(event) => {
                        event.stopPropagation();
                        setRenameSpaceTargetId(space.space_id);
                        setRenameSpaceName(space.name);
                        setRenameSpaceError('');
                        setRenameSpaceOpen(true);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
        {isEditingSpaceName && renameSpaceError ? (
          <p className="collaboration-error px-2 text-xs">{renameSpaceError}</p>
        ) : null}
      </div>
    );
  };

  const renderMessageAreaOverlay = () => {
    if (!hasActiveOverlay) return null;

    const overlayTitle = createOpen
      ? t('collaborationSpace.newSpace', COPY.newSpace)
      : COPY.newMemberButton;

    return (
      <div
        className="collaboration-thread-overlay absolute inset-0 z-10 flex items-center justify-center p-6"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            closeAllOverlays();
          }
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={overlayTitle}
          className="dialog-surface relative flex max-h-full w-full max-w-[440px] flex-col overflow-y-auto rounded-xl border border-border/70 p-4 shadow-xl"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-[14px] font-semibold text-foreground">
              {overlayTitle}
            </h3>
            <Button
              type="button"
              variant="icon"
              size="icon"
              className="collaboration-expand h-7 w-7"
              aria-label={t('tabCreation.close', '关闭')}
              onClick={closeAllOverlays}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>

          {createOpen ? (
            <form
              className="flex flex-col gap-3.5"
              onSubmit={(event) => {
                event.preventDefault();
                void createSpace().catch((cause: unknown) =>
                  setCreateError(surfaceErrorCopy(cause))
                );
              }}
            >
              <div className="space-y-1.5">
                <Label>
                  {t('collaborationSpace.spaceName', COPY.spaceName)}
                </Label>
                <Input
                  aria-label={t('collaborationSpace.spaceName', COPY.spaceName)}
                  value={spaceName}
                  onChange={(event) => setSpaceName(event.target.value)}
                  placeholder={t(
                    'collaborationSpace.spaceName',
                    COPY.spaceName
                  )}
                  className="h-8 px-2.5 text-[13px]"
                  autoFocus
                />
              </div>

              <div className="space-y-1.5">
                <Label>{COPY.spaceTagLabel}</Label>
                <div className="flex flex-wrap gap-1.5">
                  {SPACE_TAG_PRESETS.map((preset) => {
                    const active = spaceTagColorId === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className={cn(
                          'collaboration-tag-swatch',
                          active && 'is-selected'
                        )}
                        onClick={() =>
                          setSpaceTagColorId((current) =>
                            current === preset.id ? '' : preset.id
                          )
                        }
                      >
                        <span
                          className="collaboration-space-tag-dot"
                          style={{ backgroundColor: `hsl(${preset.hue})` }}
                        />
                        <span>{preset.label}</span>
                      </button>
                    );
                  })}
                </div>
                {spaceTagColorId ? (
                  <Input
                    aria-label={i18n.t('panels:ui.collabPage.tagName')}
                    value={spaceTagCustomLabel}
                    onChange={(event) =>
                      setSpaceTagCustomLabel(event.target.value)
                    }
                    placeholder={i18n.t('panels:ui.collabPage.tagNameOptional')}
                    className="h-8 px-2.5 text-[13px]"
                  />
                ) : null}
              </div>

              <div className="space-y-1.5">
                <Label>{COPY.spaceMembersLabel}</Label>
                {selectedSpaceMemberConvIds.size > 0 ? (
                  <div
                    className="collaboration-member-chips"
                    data-testid="collaboration-space-members-list"
                  >
                    {[...selectedSpaceMemberConvIds].map((convId) => {
                      const draftMeta = draftMemberMetaByConvId[convId];
                      const conv = conversationById.get(convId);
                      const memberName =
                        draftMeta?.nickname ||
                        memberNicknameByConversationId.get(convId) ||
                        conv?.title ||
                        convId;
                      return (
                        <span
                          key={convId}
                          className="collaboration-member-chip"
                          data-testid={`collaboration-space-member-chip-${convId}`}
                        >
                          <MemberBotAvatar
                            config={getMemberAvatar(convId, memberName)}
                            className="h-3.5 w-3.5 shrink-0"
                          />
                          <span>{memberName}</span>
                          <button
                            type="button"
                            className="collaboration-member-chip-remove"
                            aria-label={i18n.t('panels:ui.collabPage.removeBotMembername', { memberName: memberName })}
                            onClick={() => removeDraftSpaceMember(convId)}
                          >
                            <X className="h-3 w-3" aria-hidden="true" />
                          </button>
                        </span>
                      );
                    })}
                  </div>
                ) : null}
                <div
                  className="collaboration-create-member-list"
                  data-testid="collaboration-create-bot-list"
                >
                  {createGroupBots.length === 0 ? (
                    <p className="collaboration-picker-empty">
                      {COPY.noMemberSessions}
                    </p>
                  ) : (
                    createGroupBots.map((member) => {
                      const conversationId = String(
                        member.conversation_id ?? ''
                      ).trim();
                      const name = displayName(member);
                      return (
                        <button
                          key={conversationId || member.member_id || name}
                          type="button"
                          className="collaboration-create-bot-row"
                          aria-label={name}
                          onClick={() => addDraftSpaceMember(member)}
                        >
                          <MemberBotAvatar
                            config={getMemberAvatar(conversationId, name)}
                            className="h-7 w-7 shrink-0"
                          />
                          <span className="collaboration-create-bot-name">
                            {name}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {createError ? (
                <p className="collaboration-error">{createError}</p>
              ) : null}
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  type="submit"
                  variant="primary"
                  data-dialog-primary="true"
                  disabled={selectedSpaceMemberConvIds.size === 0}
                >
                  {t('collaborationSpace.newSpace', COPY.newSpace)}
                </Button>
              </div>
            </form>
          ) : null}

          {createMemberOpen ? (
            <form
              className="flex flex-col gap-3.5"
              onSubmit={(event) => {
                event.preventDefault();
                void createNewMember().catch((cause: unknown) =>
                  setCreateMemberError(surfaceErrorCopy(cause))
                );
              }}
            >
              <div className="space-y-1.5">
                <Label>{COPY.memberNameLabel}</Label>
                <Input
                  aria-label={COPY.memberNameLabel}
                  value={newMemberName}
                  onChange={(event) => setNewMemberName(event.target.value)}
                  placeholder={COPY.memberNameLabel}
                  className="h-8 px-2.5 text-[13px]"
                  autoFocus
                />
              </div>

              <MemberBotAvatarPicker
                value={newMemberAvatar}
                onChange={setNewMemberAvatar}
              />

              <div className="flex items-center justify-between gap-3">
                <Label className="shrink-0">{COPY.memberSourceLabel}</Label>
                <SegmentedControl
                  label={COPY.memberSourceLabel}
                  size="sm"
                  layout="hug"
                  className="collaboration-compact-segmented"
                  value={newMemberSource}
                  onChange={(nextValue) =>
                    setNewMemberSource(nextValue as MemberSourceOption)
                  }
                >
                  {memberSourceOptions.map((option) => (
                    <SegmentedControlItem
                      key={option.value}
                      value={option.value}
                      label={option.label}
                      icon={option.icon}
                    />
                  ))}
                </SegmentedControl>
              </div>

              {newMemberSource === 'role' ? (
                <div className="space-y-1.5">
                  <Label>{COPY.chooseRole}</Label>
                  <CollaborationOptionSelect
                    ariaLabel={COPY.chooseRole}
                    value={newMemberRoleId}
                    placeholder={COPY.chooseRole}
                    options={roleSelectOptions}
                    onChange={setNewMemberRoleId}
                  />
                </div>
              ) : newMemberSource === 'session' ? (
                <div className="space-y-1.5">
                  <Label>{chooseConversationLabel}</Label>
                  <CollaborationOptionSelect
                    ariaLabel={chooseConversationLabel}
                    value={newMemberSessionId}
                    placeholder={chooseConversationLabel}
                    options={conversationSelectOptions}
                    onChange={setNewMemberSessionId}
                  />
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>{COPY.chooseAgent}</Label>
                    <CollaborationOptionSelect
                      ariaLabel={COPY.chooseAgent}
                      value={newMemberAgentId}
                      placeholder={COPY.chooseAgent}
                      options={agentSelectOptions}
                      onChange={(nextAgentId) => {
                        setNewMemberAgentId(nextAgentId);
                        setNewMemberModeId('');
                        setNewMemberConfigValues({});
                      }}
                    />
                  </div>

                  {newMemberAgentId ? (
                    <MemberSessionConfigControls
                      agentId={newMemberAgentId}
                      modeId={newMemberModeId}
                      values={newMemberConfigValues}
                      onModeId={setNewMemberModeId}
                      onValues={setNewMemberConfigValues}
                    />
                  ) : null}

                  <div className="space-y-1.5">
                    <Label>{COPY.personaPromptLabel}</Label>
                    <Textarea
                      aria-label={COPY.personaPromptLabel}
                      placeholder={COPY.personaPromptLabel}
                      value={newMemberPersonaPrompt}
                      onChange={(event) =>
                        setNewMemberPersonaPrompt(event.target.value)
                      }
                      className="min-h-[64px] px-2.5 py-1.5 text-[13px]"
                    />
                  </div>
                </div>
              )}

              {createMemberError ? (
                <p className="collaboration-error">{createMemberError}</p>
              ) : null}
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  type="submit"
                  variant="primary"
                  data-dialog-primary="true"
                  disabled={
                    !newMemberName.trim() ||
                    (newMemberSource === 'role'
                      ? !newMemberRoleId
                      : newMemberSource === 'session'
                        ? !newMemberSessionId
                        : !newMemberAgentId)
                  }
                >
                  {COPY.newMemberButton}
                </Button>
              </div>
            </form>
          ) : null}
        </div>
      </div>
    );
  };

  if (!workspace) {
    return (
      <div
        className="collaboration-shell session-hub-shell"
        data-spaces="false"
        data-thread="false"
        data-preview="false"
      >
        <section
          className="collaboration-pane"
          aria-label={t('collaborationSpace.title', '协作空间')}
        >
          <div className="collaboration-pane-body collaboration-empty-stage">
            <div className="collaboration-empty-card settings-surface">
              <p className="collaboration-empty-title">
                {t(
                  'collaborationSpace.openWorkspaceFirst',
                  COPY.openWorkspaceFirst
                )}
              </p>
            </div>
          </div>
        </section>
      </div>
    );
  }

  return (
    <CollaborationMemberMentionContext.Provider
      value={memberMentionContextValue}
    >
      <CollaborationPreviewScope
        onOpenFile={openFilePreview}
        onOpenWorkspacePanel={openWorkspacePanel}
        onRunInEditorGroup={runInCollaborationEditorGroup}
      >
      <div
        className={cn(
          'collaboration-shell session-hub-shell',
          isResizingPane && 'is-resizing'
        )}
        data-spaces={showSpaces ? 'true' : 'false'}
        data-thread={hasThread ? 'true' : 'false'}
        data-preview={showPreview ? 'true' : 'false'}
        data-layout-order={orderedZones.join('-')}
        style={
          {
            gridTemplateColumns: shellGridTemplateColumns,
            ...(spacesPaneWidth !== null
              ? { '--collaboration-spaces-width': `${spacesPaneWidth}px` }
              : {}),
            ...(previewPaneWidth !== null
              ? { '--collaboration-preview-width': `${previewPaneWidth}px` }
              : {}),
          } as CSSProperties
        }
      >
        {showSpaces ? (
          <aside
            ref={spacesPaneRef}
            style={{ order: spacesOrder }}
            className="collaboration-pane"
            aria-label={t('collaborationSpace.title', '协作空间')}
          >
            <div className="collaboration-pane-body session-hub-list-body collaboration-pane-list-container">
              <div className="collaboration-top-toolbar flex w-full min-w-0 flex-nowrap items-center justify-between gap-2 overflow-hidden px-1 py-0.5">
                {isDeleteMode ? (
                  <SessionListDeleteControl
                    selectedCount={selectedDeleteCount}
                    isDeleting={isDeletingBatch}
                    selectLabel={i18n.t('panels:ui.collabPage.selectSpacesOrBots')}
                    selectedCountLabel={i18n.t('panels:ui.collabPage.selecteddeletecountSelected', { selectedDeleteCount: selectedDeleteCount })}
                    deleteLabel={i18n.t('panels:ui.collabPage.confirmDelete')}
                    deletingLabel={i18n.t('panels:ui.collabPage.deleting')}
                    cancelLabel={i18n.t('panels:ui.collabPage.cancel')}
                    onDelete={() => {
                      void confirmBatchDelete();
                    }}
                    onCancel={handleToggleDeleteMode}
                  />
                ) : (
                  <>
                    <div className="ml-auto flex min-w-0 flex-nowrap items-center justify-end gap-1">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        data-testid="collaboration-global-search-button"
                        className={SESSION_LIST_ACTION_BUTTON_CLASS}
                        aria-label={i18n.t('panels:ui.collabPage.searchSpacesOrBots')}
                        onClick={() => {
                          setSearchQuery('');
                          setSearchOpen(true);
                        }}
                      >
                        <Search className={SESSION_LIST_ACTION_ICON_CLASS} />
                      </Button>

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className={SESSION_LIST_ACTION_BUTTON_CLASS}
                            aria-label={COPY.createMenu}
                          >
                            <Plus className={SESSION_LIST_ACTION_ICON_CLASS} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          onCloseAutoFocus={(event) => event.preventDefault()}
                        >
                          <DropdownMenuItem onSelect={openCreateSpaceDialog}>
                            {COPY.newSpaceButton}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => openCreateMemberDialog()}
                          >
                            {COPY.createAssistantButton}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              void createGroup();
                            }}
                          >
                            {COPY.createContactGroupButton}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>

                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className={cn(
                              SESSION_LIST_ACTION_BUTTON_CLASS,
                              hasActiveFilter && 'bg-secondary text-foreground'
                            )}
                            aria-label={COPY.filterLabel}
                          >
                            <Filter
                              className={SESSION_LIST_ACTION_ICON_CLASS}
                            />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          align="end"
                          className={cn(PRODUCT_MENU_CONTENT_CLASS, 'w-44')}
                        >
                          {(
                            [
                              {
                                id: 'name' as const,
                                label: COPY.filterByName,
                                active: listSort === 'name',
                                onSelect: () => {
                                  setListSort('name');
                                  setTypeFilter('group');
                                },
                              },
                              {
                                id: 'type' as const,
                                label: `${COPY.filterByType} · ${
                                  typeFilter === 'group'
                                    ? COPY.filterTypeGroup
                                    : COPY.filterTypeAssistant
                                }`,
                                active: listSort === 'type',
                                onSelect: () => {
                                  const next = cycleTypeFilter(
                                    listSort,
                                    typeFilter
                                  );
                                  setListSort(next.sort);
                                  setTypeFilter(next.typeFilter);
                                },
                              },
                              {
                                id: 'activity' as const,
                                label: COPY.filterByActiveTime,
                                active: listSort === 'activity',
                                onSelect: () => {
                                  setListSort('activity');
                                  setTypeFilter('group');
                                },
                              },
                            ] as const
                          ).map((option) => (
                            <button
                              key={option.id}
                              type="button"
                              role="menuitem"
                              data-testid={`collaboration-filter-${option.id}`}
                              className={cn(
                                PRODUCT_MENU_ITEM_CLASS,
                                'w-full px-2.5 py-1.5'
                              )}
                              onClick={option.onSelect}
                            >
                              <span className="min-w-0 flex-1 text-left">
                                {option.label}
                              </span>
                              {option.active ? (
                                <Check
                                  className="size-3.5 shrink-0"
                                  aria-hidden="true"
                                />
                              ) : null}
                            </button>
                          ))}
                        </PopoverContent>
                      </Popover>

                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className={SESSION_LIST_ACTION_BUTTON_CLASS}
                        aria-label={COPY.batchDeleteLabel}
                        onClick={handleToggleDeleteMode}
                      >
                        <Trash2 className={SESSION_LIST_ACTION_ICON_CLASS} />
                      </Button>
                    </div>
                  </>
                )}
              </div>

              <div
                className="collaboration-space-list"
                onDragOver={(event) => {
                  event.preventDefault();
                  if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = 'move';
                  }
                }}
                onContextMenu={(event) => {
                  if (!sidebarAvailable || contactGroups === null) return;
                  openContactMenu(event, [newGroupMenuItem]);
                }}
              >
                {contactSections ? (
                  <ContactGroupSections
                    sections={contactSections}
                    collapsed={collapsedSections}
                    renamingId={renamingGroupId}
                    renamePlaceholder={t(
                      'collaborationSpace.contactGroupNamePlaceholder',
                      '分组名称'
                    )}
                    toggleLabel={(name) =>
                      t('collaborationSpace.contactGroupToggle', {
                        name,
                        defaultValue: '折叠或展开 {{name}}',
                      })
                    }
                    onToggle={toggleContactSection}
                    onRenameSubmit={(groupId, name) => {
                      setRenamingGroupId(null);
                      void renameGroup(groupId, name);
                    }}
                    onRenameCancel={() => setRenamingGroupId(null)}
                    onHeaderContextMenu={openSectionContactMenu}
                    dropTargetId={
                      sidebarDropTarget?.kind === 'section'
                        ? sidebarDropTarget.sectionId
                        : null
                    }
                    onDropContact={(sectionId, threadId) =>
                      void moveContactToSection(threadId, sectionId)
                    }
                    renderEntry={renderSectionEntry}
                  />
                ) : (
                  <>{visibleChatList.map(renderSectionEntry)}</>
                )}
                {hiddenChatList.length > 0 ? (
                  <section
                    className="collaboration-contact-section"
                    data-testid="collaboration-contact-section-hidden"
                  >
                    <div className="collaboration-contact-section-header">
                      <span className="collaboration-contact-section-name">
                        {i18n.t('panels:ui.collabPage.hidden')}
                      </span>
                      <span className="collaboration-contact-section-count">
                        {hiddenChatList.length}
                      </span>
                    </div>
                    <div className="collaboration-contact-section-body">
                      {hiddenChatList.map(renderSectionEntry)}
                    </div>
                  </section>
                ) : null}
                {contactMenu ? (
                  <ProductContextMenu
                    x={contactMenu.x}
                    y={contactMenu.y}
                    items={contactMenu.items}
                    onClose={() => setContactMenu(null)}
                    ariaLabel={i18n.t('panels:ui.collabPage.contactMenu')}
                  />
                ) : null}
              </div>
            </div>
            {hasThread || showPreview ? (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={i18n.t('panels:ui.collabPage.resizeSpaceList')}
                data-testid="collaboration-spaces-resizer"
                data-side={spacesResizerSide}
                className="workspace-resize-handle collaboration-pane-resizer"
                onPointerDown={handleSpacesResizePointerDown}
              />
            ) : null}
          </aside>
        ) : null}

        {hasThread ? (
          <section
            style={
              {
                order: threadOrder,
                '--collaboration-list-avatar': `${listAvatarPx / 16}rem`,
              } as CSSProperties
            }
            className="collaboration-thread"
            aria-label={
              selected?.name ??
              (isDefaultVirtualSpaceSelected
                ? virtualDefaultSpaceName
                : t('collaborationSpace.title', '协作空间'))
            }
            onPointerDownCapture={() => {
              if (selected) {
                markSpaceInReviewMembersViewed(selected.space_id);
              }
            }}
            onWheelCapture={() => {
              if (selected) {
                markSpaceInReviewMembersViewed(selected.space_id);
              }
            }}
            onKeyDownCapture={() => {
              if (selected) {
                markSpaceInReviewMembersViewed(selected.space_id);
              }
            }}
          >
            <div className="collaboration-thread-body">
              {selected && topMemberBarExpanded ? (
                <div
                  className="collaboration-top-member-bar"
                  data-testid="collaboration-top-member-bar"
                >
                  <div
                    className="collaboration-top-member-chrome"
                    data-testid="collaboration-top-member-chrome"
                  >
                    <button
                      type="button"
                      className={cn(
                        'collaboration-top-collection-btn',
                        activePreviewTabId ===
                          spaceCollectionPreviewPanelId(
                            activeDirectThreadId || selected.space_id
                          ) && 'is-active'
                      )}
                      aria-label={
                        activeDirectThreadId
                          ? COPY.assistantDetailsButton
                          : COPY.groupDetailsButton
                      }
                      title={
                        activeDirectThreadId
                          ? COPY.assistantDetailsButton
                          : COPY.groupDetailsButton
                      }
                      data-testid="collaboration-open-collection-btn"
                      onClick={() =>
                        activeDirectThreadId
                          ? openAssistantDetailsTab()
                          : openSpaceCollectionTab(
                              selected.space_id,
                              selected.name
                            )
                      }
                    >
                      <LayoutGrid
                        className="h-3.5 w-3.5 shrink-0"
                        aria-hidden="true"
                      />
                    </button>
                    <span
                      className="collaboration-top-member-collapsed-divider"
                      aria-hidden="true"
                    />
                    <button
                      type="button"
                      className="collaboration-top-member-toggle"
                      aria-label={i18n.t('panels:ui.collabPage.collapseBotList')}
                      title={i18n.t('panels:ui.collabPage.collapseBotList')}
                      onClick={() => setTopMemberBarExpanded(false)}
                    >
                      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                  <div className="collaboration-top-member-scroll">
                    {visibleRoster.map((member) => {
                      const nick = displayName(member);
                      const convId = member.conversation_id ?? '';
                      const avatar = getMemberAvatar(convId, nick);
                      const memberHoverKey =
                        member.member_id ?? (convId || nick);
                      const memberConv = convId
                        ? conversationById.get(convId)
                        : undefined;
                      const memberSessionActive = Boolean(
                        memberConv?.turn_in_flight ||
                          memberConv?.status === 'inprogress'
                      );
                      const memberScheduledMessages = scheduledMessages.filter(
                        (item) => {
                          const status = item.status ?? 'scheduled';
                          const senderConv =
                            item.caller_id ?? item.sender_conversation_id;
                          const senderNick =
                            item.nickname ?? item.sender_nickname;
                          return (
                            status === 'scheduled' &&
                            ((convId && senderConv === convId) ||
                              (nick && senderNick === nick))
                          );
                        }
                      );
                      const hasDelayedMessages =
                        memberScheduledMessages.length > 0;
                      const isDelayedPopoverOpen =
                        hasDelayedMessages &&
                        hoveredDelayedMemberKey === memberHoverKey;
                      return (
                        <Popover
                          key={memberHoverKey}
                          open={isDelayedPopoverOpen}
                        >
                          <PopoverTrigger asChild>
                            <button
                              type="button"
                              className={cn(
                                'collaboration-top-member-chip',
                                hasDelayedMessages && 'has-delayed-messages'
                              )}
                              aria-label={i18n.t('panels:ui.collabPage.openNickSession', { nick: nick })}
                              data-testid={`top-member-filter-${nick}`}
                              data-has-delayed-messages={
                                hasDelayedMessages ? 'true' : 'false'
                              }
                              onMouseEnter={() => {
                                if (hasDelayedMessages) {
                                  openDelayedMemberPopover(memberHoverKey);
                                }
                              }}
                              onMouseLeave={() => {
                                if (hasDelayedMessages) {
                                  scheduleCloseDelayedMemberPopover();
                                }
                              }}
                              onFocus={() => {
                                if (hasDelayedMessages) {
                                  openDelayedMemberPopover(memberHoverKey);
                                }
                              }}
                              onBlur={() => {
                                if (hasDelayedMessages) {
                                  scheduleCloseDelayedMemberPopover();
                                }
                              }}
                              onClick={() =>
                                selectMemberForPreview(
                                  selected.space_id,
                                  member
                                )
                              }
                            >
                              <span
                                className="collaboration-list-avatar"
                                style={listAvatarStyle}
                              >
                                <MemberBotAvatar
                                  config={avatar}
                                  sessionActive={memberSessionActive}
                                  silhouetteOutline={listAvatarOutline}
                                  className="h-full w-full"
                                />
                              </span>
                              <span
                                className="collaboration-top-member-chip-name"
                                style={{ color: avatar.color }}
                              >
                                {nick}
                              </span>
                            </button>
                          </PopoverTrigger>
                          {hasDelayedMessages ? (
                            <PopoverContent
                              align="start"
                              side="bottom"
                              sideOffset={6}
                              onMouseEnter={() =>
                                openDelayedMemberPopover(memberHoverKey)
                              }
                              onMouseLeave={scheduleCloseDelayedMemberPopover}
                              onOpenAutoFocus={(event) =>
                                event.preventDefault()
                              }
                              onCloseAutoFocus={(event) =>
                                event.preventDefault()
                              }
                              data-testid={`member-delayed-queue-${nick}`}
                              className="collaboration-member-delayed-queue-popover rounded-md border border-border/80 bg-popover p-2 text-popover-foreground shadow-lg"
                            >
                              <div className="mb-1.5 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
                                <span className="inline-flex items-center gap-1">
                                  <Clock
                                    className="h-3 w-3 text-primary"
                                    aria-hidden="true"
                                  />
                                  <span>{i18n.t('panels:ui.collabPage.scheduledMessageQueue')}</span>
                                </span>
                                <span>{memberScheduledMessages.length}</span>
                              </div>
                              <div className="collaboration-member-delayed-queue-list">
                                {memberScheduledMessages.map((item) => {
                                  const itemId =
                                    item.id ??
                                    item.delayed_input_id ??
                                    item.deliver_at;
                                  return (
                                    <div
                                      key={itemId}
                                      className="collaboration-member-delayed-queue-item"
                                      data-testid={`member-delayed-queue-item-${itemId}`}
                                    >
                                      <span
                                        className="collaboration-member-delayed-queue-content"
                                        title={item.content}
                                      >
                                        {item.content}
                                      </span>
                                      <span
                                        className="collaboration-member-delayed-queue-timer"
                                        data-testid={`member-delayed-queue-timer-${itemId}`}
                                      >
                                        <Clock
                                          className="h-2.5 w-2.5 shrink-0"
                                          aria-hidden="true"
                                        />
                                        <DelayedMessageCountdown
                                          deliverAt={item.deliver_at}
                                        />
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                            </PopoverContent>
                          ) : null}
                        </Popover>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {selected && !topMemberBarExpanded ? (
                <div
                  className="collaboration-top-member-collapsed-bar"
                  data-testid="collaboration-top-member-collapsed-bar"
                >
                  <button
                    type="button"
                    className={cn(
                      'collaboration-top-collection-btn is-collapsed-bar',
                      activePreviewTabId ===
                        spaceCollectionPreviewPanelId(
                          activeDirectThreadId || selected.space_id
                        ) && 'is-active'
                    )}
                    aria-label={
                      activeDirectThreadId
                        ? COPY.assistantDetailsButton
                        : COPY.groupDetailsButton
                    }
                    title={
                      activeDirectThreadId
                        ? COPY.assistantDetailsButton
                        : COPY.groupDetailsButton
                    }
                    data-testid="collaboration-open-collection-btn"
                    onClick={() =>
                      activeDirectThreadId
                        ? openAssistantDetailsTab()
                        : openSpaceCollectionTab(
                            selected.space_id,
                            selected.name
                          )
                    }
                  >
                    <LayoutGrid
                      className="h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                  </button>
                  <span
                    className="collaboration-top-member-collapsed-divider"
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    className="collaboration-top-member-expand-trigger"
                    aria-label={i18n.t('panels:ui.collabPage.expandBotList')}
                    title={i18n.t('panels:ui.collabPage.expandBotList')}
                    data-testid="collaboration-top-member-collapsed-stack"
                    onClick={() => setTopMemberBarExpanded(true)}
                  >
                    {visibleRoster.length > 0 ? (
                      <span
                        className="collaboration-top-member-stack"
                        data-testid="collaboration-top-member-stack"
                      >
                        {visibleRoster.slice(0, 5).map((member, idx) => {
                          const nick = displayName(member);
                          const convId = member.conversation_id ?? '';
                          return (
                            <span
                              key={member.member_id ?? convId ?? nick}
                              className="collaboration-top-member-stack-item"
                              style={{ zIndex: 10 - idx }}
                            >
                              <span
                                className="collaboration-list-avatar"
                                style={listAvatarStyle}
                              >
                                <MemberBotAvatar
                                  config={getMemberAvatar(convId, nick)}
                                  silhouetteOutline={listAvatarOutline}
                                  className="h-full w-full"
                                />
                              </span>
                            </span>
                          );
                        })}
                        {visibleRoster.length > 5 ? (
                          <span className="collaboration-top-member-stack-item collaboration-top-member-stack-more">
                            +{visibleRoster.length - 5}
                          </span>
                        ) : null}
                      </span>
                    ) : null}
                    <ChevronRight
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </button>
                </div>
              ) : null}

              <div
                ref={threadLogRef}
                className="collaboration-thread-log"
                onPointerDownCapture={() => {
                  if (selected) {
                    markSpaceInReviewMembersViewed(selected.space_id);
                  }
                }}
                onWheelCapture={() => {
                  if (selected) {
                    markSpaceInReviewMembersViewed(selected.space_id);
                  }
                }}
                onScroll={() => {
                  if (selected) {
                    markSpaceInReviewMembersViewed(selected.space_id);
                  }
                }}
                onKeyDownCapture={() => {
                  if (selected) {
                    markSpaceInReviewMembersViewed(selected.space_id);
                  }
                }}
              >
                {isDefaultVirtualSpaceSelected ? (
                  <div
                    className="collaboration-default-space-empty"
                    data-testid="collaboration-default-space-empty"
                  >
                    <div
                      className="collaboration-empty-member-pill"
                      data-testid="collaboration-empty-member-pill"
                    >
                      {i18n.t('panels:ui.collabPage.thisSpaceHasNoBots')}
                    </div>
                    <div className="collaboration-empty-member-actions">
                      <Button
                        type="button"
                        variant="primary"
                        onClick={() => openCreateMemberDialog()}
                      >
                        {i18n.t('panels:ui.collabPage.addBot')}
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        onClick={openCreateSpaceDialog}
                      >
                        {COPY.newSpaceButton}
                      </Button>
                    </div>
                  </div>
                ) : selected && filteredMessages.length > 0 ? (
                  filteredMessages.map((message, index) => {
                    if (isCollaborationLimitNotice(message)) {
                      return (
                        <div
                          key={`space-notice-${message.seq}`}
                          className="collaboration-system-notice"
                          data-testid="collaboration-limit-notice"
                        >
                          {COPY.collaborationLimitNotice}
                        </div>
                      );
                    }
                    const author = messageAuthor(message.envelope);
                    const fromYou = author === COPY.you;
                    const name = fromYou
                      ? t('collaborationSpace.you', COPY.you)
                      : author ||
                        t('collaborationSpace.unknownMember', '未知成员');
                    const authorConversationId = resolveMessageConversationId(
                      message.envelope,
                      members
                    );
                    const authorConv = authorConversationId
                      ? conversationById.get(authorConversationId)
                      : undefined;
                    const messageReceipts = resolveMessageReceipts(
                      message.envelope,
                      (message.receipts && message.receipts.length > 0
                        ? message.receipts
                        : receiptsBySeq[message.seq]) ?? EMPTY_RECEIPTS
                    );
                    const failedReceipts = messageReceipts.filter(
                      (receipt) =>
                        receipt.delivered === 'failed' ||
                        Boolean(receipt.error_code)
                    );
                    const deliveryStatus = fromYou
                      ? resolveMessageDeliveryStatus(messageReceipts)
                      : null;
                    const envelopeCrossMeta = extractEnvelopeCrossChatMeta(
                      message.envelope
                    );
                    const crossSentTargets = [
                      ...new Set(envelopeCrossMeta.sentTo),
                    ];
                    const crossReceivedSources = [
                      ...new Set(envelopeCrossMeta.receivedFrom),
                    ];
                    const messageKey = String(message.seq);
                    const cluster = messageClusters[index] ?? null;
                    const showName = showsClusterName(cluster);
                    const showAvatar = showsClusterAvatar(cluster);
                    const avatar = getMemberAvatar(authorConversationId, name);
                    const openAuthorPreview = () => {
                      const authorMember = visibleRoster.find(
                        (item) => displayName(item) === name
                      ) ??
                        members.find(
                          (item) =>
                            item.conversation_id === authorConversationId
                        ) ??
                        members.find((item) => displayName(item) === name) ?? {
                          kind: 'agent',
                          nickname: name,
                          conversation_id: authorConversationId,
                        };
                      selectMemberForPreview(selected.space_id, authorMember);
                    };
                    return (
                      <article
                        key={message.seq}
                        ref={(node) => {
                          if (node) {
                            messageItemRefs.current.set(messageKey, node);
                          } else {
                            messageItemRefs.current.delete(messageKey);
                          }
                        }}
                        className="collaboration-message"
                        data-testid={`collaboration-message-${message.seq}`}
                        data-cluster={cluster ?? undefined}
                      >
                        {!fromYou ? (
                          <div className="collaboration-message-row">
                            <div className="collaboration-message-avatar-slot">
                              {showAvatar ? (
                                <button
                                  type="button"
                                  className="collaboration-message-avatar"
                                  aria-label={i18n.t('panels:ui.collabPage.previewNameSession', { name: name })}
                                  onClick={openAuthorPreview}
                                >
                                  <MemberBotAvatar
                                    config={avatar}
                                    sessionActive={Boolean(
                                      authorConv?.turn_in_flight ||
                                        authorConv?.status === 'inprogress'
                                    )}
                                    className="h-10 w-10"
                                    lead={leadConversationIds.has(
                                      authorConversationId
                                    )}
                                    data-testid={`collaboration-message-bot-avatar-${message.seq}`}
                                  />
                                </button>
                              ) : null}
                            </div>
                            <div className="collaboration-message-main">
                              {showName ? (
                                <p
                                  className="collaboration-message-name"
                                  style={{ color: avatar.color }}
                                >
                                  {name}
                                </p>
                              ) : null}
                              <SpaceMessageBody
                                fromYou={fromYou}
                                text={bubbleText(message.envelope)}
                                workspacePath={workspacePath}
                                workspaceId={workspace || undefined}
                                deliveryStatus={deliveryStatus}
                              />
                            </div>
                          </div>
                        ) : (
                          <SpaceMessageBody
                            fromYou={fromYou}
                            text={bubbleText(message.envelope)}
                            workspacePath={workspacePath}
                            workspaceId={workspace || undefined}
                            deliveryStatus={deliveryStatus}
                          />
                        )}
                        {crossReceivedSources.length > 0 ? (
                          <div
                            className="collaboration-cross-chat-notices is-received"
                            data-testid={`collaboration-cross-chat-received-${message.seq}`}
                          >
                            {crossReceivedSources.map((srcNick) => (
                              <span
                                key={`recv-${message.seq}-${srcNick}`}
                                className="collaboration-cross-chat-notice"
                              >
                                <span>{COPY.crossChatReceivedPrefix}</span>
                                <MemberMentionChip
                                  nickname={srcNick}
                                  avatar={getMemberAvatar(undefined, srcNick)}
                                />
                                <span>{COPY.crossChatReceivedSuffix}</span>
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {crossSentTargets.length > 0 ? (
                          <div
                            className={cn(
                              'collaboration-cross-chat-notices',
                              fromYou ? 'is-from-you' : 'is-from-member'
                            )}
                            data-testid={`collaboration-cross-chat-sent-${message.seq}`}
                          >
                            {crossSentTargets.map((targetNick) => (
                              <span
                                key={`sent-${message.seq}-${targetNick}`}
                                className="collaboration-cross-chat-notice"
                              >
                                <span>{COPY.crossChatSentPrefix}</span>
                                <MemberMentionChip
                                  nickname={targetNick}
                                  avatar={getMemberAvatar(
                                    undefined,
                                    targetNick
                                  )}
                                />
                              </span>
                            ))}
                          </div>
                        ) : null}
                        {failedReceipts.length > 0 ? (
                          <ul className="collaboration-receipts">
                            {failedReceipts.map((receipt, index) => {
                              const status = receiptStatusCopy(
                                receipt,
                                receiptLabels
                              );
                              return (
                                <li
                                  key={
                                    receipt.conversation_id ??
                                    receipt.nickname ??
                                    `${message.seq}-${index}`
                                  }
                                  className="collaboration-receipt"
                                  data-status="failed"
                                >
                                  <span>
                                    {receipt.nickname
                                      ? `${receipt.nickname} ${status}`
                                      : status}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        ) : null}
                      </article>
                    );
                  })
                ) : null}
                {selected
                  ? pendingDirectMessages
                      .filter(
                        (item) =>
                          item.threadId ===
                          (activeDirectThreadId || selected.space_id)
                      )
                      .map((item) => (
                        <article
                          key={`pending-${item.operationId}`}
                          className="collaboration-message"
                          data-pending="true"
                          data-testid={`collaboration-pending-message-${item.operationId}`}
                        >
                          <SpaceMessageBody
                            fromYou
                            text={item.content}
                            workspacePath={workspacePath}
                            workspaceId={workspace || undefined}
                            deliveryStatus="sent"
                            deliveryTickTestId="collaboration-pending-tick"
                          />
                        </article>
                      ))
                  : null}
                {selected ? (
                  <CollaborationWorkingStatus members={workingMembers} />
                ) : null}
              </div>

              <ConversationSelectionToolbar
                rootRef={threadLogRef}
                onQuote={handleQuoteSelection}
                onAddToCollection={
                  selected && !isDefaultVirtualSpaceSelected
                    ? (selectedText) => {
                        void handleAddSelectionToCollection(selectedText);
                      }
                    : undefined
                }
              />

              {selected && navEntries.length > 0 ? (
                <div className="conv-message-nav-anchor">
                  <ConversationMessageNav
                    entries={navEntries}
                    activeIndex={activeNavIndex ?? navEntries.length - 1}
                    onSelect={scrollToMessage}
                  />
                </div>
              ) : null}
            </div>

            {error ? <p className="collaboration-error">{error}</p> : null}
            {selected ? (
              <div
                ref={composerContainerRef}
                className="collaboration-composer-wrap"
              >
                <MessageQueueIndicator
                  queuedMessages={spaceQueuedMessages}
                  delayedMessages={userDelayedSpaceMessages}
                  onEditQueuedMessage={handleEditSpaceQueuedMessage}
                  onDeleteQueuedMessage={(message) => {
                    void handleDeleteSpaceQueuedMessage(message);
                  }}
                  onDelayQueuedMessage={
                    // delaySeconds is not supported for private chats.
                    activeDirectThreadId
                      ? undefined
                      : (message, delaySeconds) => {
                          void handleDelaySpaceQueuedMessage(
                            message,
                            delaySeconds
                          );
                        }
                  }
                />
                <SessionComposerFrame
                  drawer={
                    <SessionComposerAttachmentDrawer
                      images={attachedImages}
                      disabled={sending}
                      taskAttemptId={workspace || undefined}
                      onRemoveImage={handleRemoveAttachedImage}
                    />
                  }
                >
                  <div className="composer-topbar flex items-center justify-between gap-2 px-1 pb-0 text-xs">
                    <div
                      className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-foreground"
                      data-testid="composer-current-space"
                    >
                      {activeDirectThreadId ? (
                        <MemberBotAvatar
                          config={
                            visibleRoster[0]
                              ? getMemberAvatar(
                                  visibleRoster[0].conversation_id ?? undefined,
                                  displayName(visibleRoster[0])
                                )
                              : deriveMemberBotAvatar(selected.name)
                          }
                          animated={false}
                          className="h-4 w-4 shrink-0"
                        />
                      ) : (
                        <GroupAvatar
                          avatars={visibleRoster.map((member) =>
                            getMemberAvatar(
                              member.conversation_id ?? undefined,
                              displayName(member)
                            )
                          )}
                          tagHue={selectedTagPreset?.hue}
                          size={18}
                        />
                      )}
                      <span className="truncate">{selected.name}</span>
                    </div>

                    {activeDirectThreadId ? null : (
                    <Popover
                      open={composerMembersMenuOpen}
                      onOpenChange={setComposerMembersMenuOpen}
                    >
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          data-testid="composer-space-stats"
                          aria-label={i18n.t('panels:ui.collabPage.spaceBotsVisibleroster', { visibleRoster: visibleRoster.length })}
                          onMouseEnter={openComposerMembersMenu}
                          onMouseLeave={scheduleCloseComposerMembersMenu}
                          className="workspace-session-group-count cursor-pointer border-0"
                        >
                          {visibleRoster.length}
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        align="end"
                        side="top"
                        sideOffset={8}
                        onMouseEnter={openComposerMembersMenu}
                        onMouseLeave={scheduleCloseComposerMembersMenu}
                        onOpenAutoFocus={(event) => event.preventDefault()}
                        onCloseAutoFocus={(event) => event.preventDefault()}
                        className="w-60 rounded-md border border-border/80 bg-popover p-2 text-popover-foreground shadow-lg"
                      >
                        <div className="mb-1.5 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
                          <span>{i18n.t('panels:ui.collabPage.spaceBots')}</span>
                          <span>{visibleRoster.length}</span>
                        </div>
                        {visibleRoster.length === 0 ? (
                          <p className="px-1 py-1.5 text-xs text-muted-foreground">
                            {COPY.noMemberSessions}
                          </p>
                        ) : (
                          <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                            {visibleRoster.map((member) => {
                              const nick = displayName(member);
                              const convId = member.conversation_id ?? '';
                              const conv = convId
                                ? conversationById.get(convId)
                                : undefined;
                              const agentId =
                                conv?.agent_id ||
                                draftMemberMetaByConvId[convId]?.agentId;
                              return (
                                <button
                                  key={member.member_id ?? convId ?? nick}
                                  type="button"
                                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted/60"
                                  onClick={() => {
                                    setComposerMembersMenuOpen(false);
                                    selectMemberForPreview(
                                      selected.space_id,
                                      member
                                    );
                                  }}
                                >
                                  <MemberBotAvatar
                                    config={getMemberAvatar(convId, nick)}
                                    className="h-3.5 w-3.5 shrink-0"
                                  />
                                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                                    {nick}
                                  </span>
                                  {agentId ? (
                                    <span className="shrink-0 text-xs text-muted-foreground">
                                      {getAgentName(agentId) || agentId}
                                    </span>
                                  ) : null}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </PopoverContent>
                    </Popover>
                    )}
                  </div>

                  <SessionComposerInput
                    value={draft}
                    disabled={sending}
                    replaceValueRef={replaceDraftRef}
                    context={{
                      sessionId: 'collaboration-space-composer',
                      workspaceId: workspace || undefined,
                      workspacePath,
                      repoId: repoIds[0],
                      repoIds,
                      spaceMembers: spaceMemberRefs,
                    }}
                    onChange={setDraft}
                    onSubmit={(value) => {
                      void send(value);
                    }}
                    onAttachImages={(files) => {
                      void handleAttachFiles(files);
                    }}
                  />
                  <div className="flex items-center gap-1 pt-1">
                    <input
                      ref={composerFileInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={handleComposerFileSelect}
                    />
                    <Button
                      type="button"
                      onClick={() => composerFileInputRef.current?.click()}
                      disabled={sending}
                      size="sm"
                      variant="ghost"
                      className="collaboration-icon-btn h-7 w-7 p-0"
                      title={i18n.t('panels:ui.collabPage.chooseFile')}
                      aria-label={i18n.t('panels:ui.collabPage.chooseFile')}
                    >
                      <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                    <ActionBarUtilityButtons
                      compactContextEnabled={false}
                      canCompactContext={false}
                      isCompactingContext={false}
                      promptEnhancementEnabled={promptEnhancementEnabled}
                      isEnhancingPrompt={isEnhancingPrompt}
                      canEnhancePrompt={Boolean(draft.trim()) && !sending}
                      onCompactContext={() => {}}
                      onEnhancePrompt={() => {
                        void handleEnhancePrompt();
                      }}
                    />
                    <Button
                      type="button"
                      onClick={handleTriggerAtMember}
                      disabled={sending}
                      size="sm"
                      variant="ghost"
                      className="collaboration-icon-btn h-7 w-7 p-0"
                      title={i18n.t('panels:ui.collabPage.bot')}
                      aria-label={i18n.t('panels:ui.collabPage.bot')}
                    >
                      <AtSign className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                    <div className="flex-1" />
                    <ComposerPrimaryActionButton
                      action="send"
                      label={t('collaborationSpace.send', '发送')}
                      pending={sending}
                      disabled={
                        (!draft.trim() && attachedImages.length === 0) ||
                        sending
                      }
                      onClick={() => {
                        void send(draft);
                      }}
                    />
                  </div>
                </SessionComposerFrame>
              </div>
            ) : null}
            {renderMessageAreaOverlay()}
          </section>
        ) : null}

        {hasMountedPreviewTabs ? (
          <aside
            ref={previewPaneRef}
            style={{ order: previewOrder }}
            hidden={!showPreview}
            className={cn(
              'collaboration-pane collaboration-preview',
              !showPreview && 'hidden'
            )}
            aria-label={t('collaborationSpace.previewTitle', '预览')}
            onPointerDownCapture={markActivePreviewMemberViewed}
            onWheelCapture={markActivePreviewMemberViewed}
            onKeyDownCapture={markActivePreviewMemberViewed}
          >
            {showPreview && hasThread ? (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label={i18n.t('panels:ui.collabPage.resizePreview')}
                data-testid="collaboration-preview-resizer"
                data-side={previewResizerSide}
                className="workspace-resize-handle collaboration-preview-resizer"
                onPointerDown={handlePreviewResizePointerDown}
              />
            ) : null}
            <div className="collaboration-preview-body">
              <DockviewReact
                components={COLLABORATION_PREVIEW_COMPONENTS}
                defaultTabComponent={CollaborationPreviewDockviewTab}
                leftHeaderActionsComponent={WorkspaceTabAddMenu}
                rightHeaderActionsComponent={CollaborationPreviewHeaderActions}
                onReady={handlePreviewDockviewReady}
                className="dockview-theme-light dockview-theme-ayu h-full w-full"
                disableFloatingGroups={true}
              />
            </div>
          </aside>
        ) : null}
        {draggingMember && pointerDragCursor ? (
          <div
            className="collaboration-member-drag-ghost"
            data-testid="collaboration-member-drag-ghost"
            style={{
              left: `${pointerDragCursor.x + 12}px`,
              top: `${pointerDragCursor.y + 12}px`,
            }}
          >
            <MemberBotAvatar
              config={getMemberAvatar(
                draggingMember.conversationId,
                draggingMember.nickname
              )}
              className="h-3.5 w-3.5 shrink-0"
            />
            <span>{draggingMember.nickname}</span>
          </div>
        ) : null}
        {draggingThreadName && pointerDragCursor ? (
          <div
            className="collaboration-member-drag-ghost"
            data-testid="collaboration-thread-drag-ghost"
            style={{
              left: `${pointerDragCursor.x + 12}px`,
              top: `${pointerDragCursor.y + 12}px`,
            }}
          >
            <span>{draggingThreadName}</span>
          </div>
        ) : null}
        {searchOpen ? (
          <CollaborationGlobalSearchModal
            query={searchQuery}
            onQueryChange={setSearchQuery}
            onClose={() => {
              setSearchOpen(false);
              setSearchQuery('');
            }}
            empty={globalSearchResults.length === 0}
          >
            {globalSearchResults.map((item) =>
              item.kind === 'member' ? (
                <button
                  key={item.key}
                  type="button"
                  data-testid={`collaboration-global-search-item-${item.name}`}
                  className="collaboration-global-search-item"
                  onClick={() => {
                    setSearchOpen(false);
                    setSearchQuery('');
                    openPrivateChat(item.spaceId, item.member, item.threadId);
                  }}
                >
                  <span className="collaboration-global-search-avatar">
                    <MemberBotAvatar
                      config={getMemberAvatar(
                        item.member.conversation_id ?? undefined,
                        item.name
                      )}
                      className="h-7 w-7"
                    />
                  </span>
                  <span className="collaboration-global-search-item-body">
                    <span className="collaboration-global-search-item-title">
                      {item.name}
                    </span>
                  </span>
                </button>
              ) : (
                <button
                  key={item.key}
                  type="button"
                  data-testid={`collaboration-global-search-item-${item.name}`}
                  className="collaboration-global-search-item"
                  onClick={() => {
                    setSearchOpen(false);
                    setSearchQuery('');
                    selectSpace(item.spaceId, true);
                  }}
                >
                  <span className="collaboration-global-search-avatar">
                    <GroupAvatar
                      avatars={item.members.map((member) =>
                        getMemberAvatar(
                          member.conversation_id ?? undefined,
                          displayName(member)
                        )
                      )}
                      size={28}
                    />
                  </span>
                  <span className="collaboration-global-search-item-body">
                    <span className="collaboration-global-search-item-title">
                      {item.name}
                    </span>
                    {item.memberNames ? (
                      <span className="collaboration-global-search-item-subtitle">
                        {item.memberNames}
                      </span>
                    ) : null}
                  </span>
                </button>
              )
            )}
          </CollaborationGlobalSearchModal>
        ) : null}
      </div>
      </CollaborationPreviewScope>
    </CollaborationMemberMentionContext.Provider>
  );
}
