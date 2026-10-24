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
  LayoutGrid,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  Tag,
  Trash2,
  FolderPlus,
  UserPlus,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentSessionControlsSnapshot,
  ExecutorProfileId,
} from 'shared/types';
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
import {
  advertisedSessionConfigValues,
  presentableSessionConfigOptions,
  sanitizeDependentConfigValues,
  selectConfigOptionValue,
  visibleSessionConfigOptions,
} from '@/components/tasks/follow-up/SessionConfigOptionSelectors';
import { SessionComposerFrame } from '@/components/tasks/follow-up/SessionComposerFrame';
import {
  SessionComposerAttachmentDrawer,
  SessionComposerInput,
} from '@/components/tasks/follow-up/SessionComposerInput';
import { SessionSettingsSummary } from '@/components/tasks/follow-up/SessionSettingsSummary';
import { useSessionComposerPromptEnhancement } from '@/components/tasks/follow-up/useSessionComposerPromptEnhancement';
import { toast } from '@/components/ui/toast';
import { SessionListDeleteControl } from '@/components/workspace-session-list/SessionListDeleteControl';
import { SessionListSearchControl } from '@/components/workspace-session-list/SessionListSearchControl';
import {
  formatCompactSessionAge,
  workspaceSessionStatusTone,
} from '@/components/workspace-session-list/workspaceSessionListModel';
import { useOptionalProject } from '@/contexts/ProjectContext';
import { loadAgentSessionControlsCatalog } from '@/features/agents/sessionControlsQuery';
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
import { useCollaborationLayoutStore } from './collaborationLayoutStore';
import {
  loadSidebarItems,
  loadDirectMessages,
  markThreadRead,
  postDirectMessage,
  resolveMemberSession,
  updateThreadTagColor,
} from './threadApi';
import {
  buildContactSections,
  createContactGroup,
  deleteContactGroup,
  listContactGroups,
  readCollapsedSections,
  renameContactGroup,
  setThreadGroup,
  sortContactGroups,
  UNGROUPED_SECTION_ID,
  withThreadGroup,
  writeCollapsedSections,
  type ContactGroup,
  type ContactSection,
} from './contactGroups';
import {
  ContactContextMenu,
  ContactGroupNameInput,
  ContactGroupSections,
  contactMenuIcons,
  type ContactMenuItem,
  type ContactMenuState,
} from './ContactGroupSections';
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
import {
  CollaborationSpaceIcon,
  spaceCollectionPreviewPanelId,
} from './CollaborationSpaceCollectionPanel';
import {
  COPY,
  SPACE_TAG_PRESETS,
  VIRTUAL_DEFAULT_SPACE_ID,
  agentRoster,
  deliveryFailureCopy,
  displayName,
  isWithinActiveWindow,
  latestMessageSeq,
  memberSelectionKey as deleteMemberKey,
  mergeSpaceMessages,
  messageAuthor,
  parseMemberSelectionKey,
  parseSpaceChangedEvent,
  postRecipients,
  randomEnglishNickname,
  readSpaceTags,
  receiptStatusCopy,
  resolveMessageConversationId,
  resolveMessageReceipts,
  sortConversationsForSpaceMemberPicker,
  strayMentions,
  surfaceErrorCopy,
  toggleMemberDeleteSelection,
  toggleSpaceDeleteSelection,
  unassignedSpaceId,
  writeSpaceTags,
  type ActiveTimeFilterWindow,
  type DeliveryReceipt,
  type SpaceMember,
  type SpaceTagConfig,
  buildChatList,
  resolvePrivateChatTarget,
  type ChatListEntry,
  type SidebarItem,
  directThreadIdFor,
  reconcilePendingDirectMessages,
  type PendingDirectMessage,
  isPrivateChatKind,
  memberTabTitle,
} from './spaceModel';
import {
  MemberBotAvatar,
  MemberBotAvatarPicker,
  deriveMemberBotAvatar,
  randomMemberBotAvatar,
  readMemberBotAvatars,
  writeMemberBotAvatars,
  type MemberBotAvatarConfig,
} from './MemberBotAvatar';
import { GroupAvatar } from './GroupAvatar';
import {
  SpaceMessageBody,
  bubbleText,
  messagePreviewText,
} from './SpaceMessageBody';
import './collaboration.css';

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

type Space = { space_id: string; name: string; kind?: string };
type SpaceMessage = {
  seq: number;
  envelope: {
    actor?: string;
    attributedTo?: string;
    content?: string;
    summary?: string;
    to?: string[];
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
type SpaceAddMemberTab = 'select' | 'create';
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

function CustomAgentControls({
  agentId,
  modeId,
  values,
  onModeId,
  onValues,
}: {
  agentId: string;
  modeId: string;
  values: Record<string, string>;
  onModeId: (modeId: string) => void;
  onValues: (values: Record<string, string>) => void;
}) {
  const [catalog, setCatalog] = useState<AgentSessionControlsSnapshot | null>(
    null
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!agentId) {
      setFailed(true);
      return;
    }
    let active = true;
    setFailed(false);
    setCatalog(null);
    void loadAgentSessionControlsCatalog(agentId)
      .then((next) => {
        if (active) setCatalog(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [agentId]);

  if (!agentId || failed) {
    return (
      <p className="settings-row__description">{COPY.controlsUnavailable}</p>
    );
  }
  if (!catalog) return null;

  const visibleConfigOptions = visibleSessionConfigOptions(
    catalog.config_options ?? []
  );
  const presentableConfigOptions = presentableSessionConfigOptions(
    visibleConfigOptions,
    catalog.modes ?? []
  );
  const advertisedConfigValues =
    advertisedSessionConfigValues(visibleConfigOptions);
  const sanitizedConfigValues = sanitizeDependentConfigValues(
    visibleConfigOptions,
    {
      ...advertisedConfigValues,
      ...values,
    }
  );
  const presentableConfigKeys = new Set(
    presentableConfigOptions.map((option) => option.key)
  );
  const configOverrides = Object.fromEntries(
    Object.entries(sanitizedConfigValues).filter(([key]) =>
      presentableConfigKeys.has(key)
    )
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SessionSettingsSummary
        sessionModes={{
          current: catalog.current_mode ?? null,
          modes: catalog.modes,
        }}
        options={visibleConfigOptions}
        selectedMode={modeId || catalog.current_mode || null}
        pending={configOverrides}
        onSelectMode={onModeId}
        onSelectConfigOption={(key, value) => {
          onValues(
            selectConfigOptionValue(visibleConfigOptions, values, key, value)
          );
        }}
      />
    </div>
  );
}

/** Contact-list avatar edge (px), shared by DM member and group-chat rows. */
const CONTACT_AVATAR_PX = 72;

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
  const promptEnhancementEnabled =
    userSystem?.config?.prompt_enhancement_enabled === true;
  const composerFileInputRef = useRef<HTMLInputElement | null>(null);
  const composerContainerRef = useRef<HTMLDivElement | null>(null);
  const threadLogRef = useRef<HTMLDivElement | null>(null);
  const messageItemRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [activeNavIndex, setActiveNavIndex] = useState<number | null>(null);
  const [topMemberBarExpanded, setTopMemberBarExpanded] = useState(true);
  const [selectedFilterMemberNicknames, setSelectedFilterMemberNicknames] =
    useState<Set<string>>(() => new Set());
  const [composerMembersMenuOpen, setComposerMembersMenuOpen] = useState(false);
  const composerMembersCloseTimeoutRef = useRef<number | null>(null);

  const [spaces, setSpaces] = useState<Space[]>([]);
  const [selectedId, setSelectedId] = useState('');
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
  const [filterAgentId, setFilterAgentId] = useState('');
  const [filterActiveWindow, setFilterActiveWindow] =
    useState<ActiveTimeFilterWindow>('all');
  const [filterMemberConvId, setFilterMemberConvId] = useState('');

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
  const [pendingSpaceMemberConvIds, setPendingSpaceMemberConvIds] = useState<
    Set<string>
  >(() => new Set());
  const [draftMemberMetaByConvId, setDraftMemberMetaByConvId] = useState<
    Record<string, DraftSpaceMemberMeta>
  >({});
  const [spaceAddMemberOpen, setSpaceAddMemberOpen] = useState(false);
  const [spaceAddMemberTab, setSpaceAddMemberTab] =
    useState<SpaceAddMemberTab>('select');
  const [pickerExpandedSpaces, setPickerExpandedSpaces] = useState<
    Record<string, boolean>
  >({});
  const [inlineMemberName, setInlineMemberName] = useState('');
  const [inlineMemberSource, setInlineMemberSource] =
    useState<MemberSourceOption>('role');
  const [inlineMemberRoleId, setInlineMemberRoleId] = useState('');
  const [inlineMemberSessionId, setInlineMemberSessionId] = useState('');
  const [inlineMemberAgentId, setInlineMemberAgentId] = useState('');
  const [inlineMemberModeId, setInlineMemberModeId] = useState('');
  const [inlineMemberConfigValues, setInlineMemberConfigValues] = useState<
    Record<string, string>
  >({});
  const [inlineMemberPersonaPrompt, setInlineMemberPersonaPrompt] =
    useState('');
  const [inlineMemberAvatar, setInlineMemberAvatar] =
    useState<MemberBotAvatarConfig>(() => randomMemberBotAvatar());
  const [inlineMemberError, setInlineMemberError] = useState('');
  const [inlineMemberSubmitting, setInlineMemberSubmitting] = useState(false);
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
      const startWidth = spacesPaneWidth ?? (measured > 0 ? measured : 296);
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
  const refreshSidebar = useCallback(async () => {
    if (!workspace) return;
    const items = await loadSidebarItems(collaborationCall, workspace);
    setSidebarItems(items);
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
  }, [workspace]);
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
  const [creatingContactGroup, setCreatingContactGroup] = useState(false);
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [contactMenu, setContactMenu] = useState<ContactMenuState>(null);
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
  const createGroup = useCallback(
    async (name: string) => {
      if (!workspace) return;
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
      } catch {
        contactGroupFailed();
      }
    },
    [workspace, contactGroupFailed]
  );
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
  } | null>(null);
  const [pendingDirectMessages, setPendingDirectMessages] = useState<
    PendingDirectMessage[]
  >([]);
  const activeDirectThreadId =
    sidebarAvailable &&
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
        const next = merge ? mergeSpaceMessages(current, incoming) : incoming;
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
    resetCollaborationLayout,
  } = useCollaborationLayoutStore();

  const listedSelected =
    spaces.find((space) => space.space_id === selectedId) ?? null;
  // A private chat's space (e.g. the unassigned space) may not be listed by
  // space.list; give its message area a synthetic space so it still renders.
  const selected = useMemo<Space | null>(
    () =>
      listedSelected ??
      (activeDirectThreadId && selectedId
        ? { space_id: selectedId, name: '', kind: 'direct' }
        : null),
    [listedSelected, activeDirectThreadId, selectedId]
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
          return 'var(--collaboration-spaces-width, 18.5rem)';
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

  const allUniqueMembers = useMemo(() => {
    const seen = new Map<
      string,
      { conversationId: string; nickname: string }
    >();
    for (const group of Object.values(membersBySpace)) {
      for (const member of agentRoster(group)) {
        const convId = String(member.conversation_id ?? '').trim();
        const nick = String(member.nickname ?? '').trim();
        if (convId && nick && !seen.has(convId)) {
          seen.set(convId, { conversationId: convId, nickname: nick });
        }
      }
    }
    return [...seen.values()];
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

  const sortedConversationsForPicker = useMemo(
    () =>
      sortConversationsForSpaceMemberPicker(
        conversations,
        memberNicknameByConversationId
      ),
    [conversations, memberNicknameByConversationId]
  );

  const spaceMemberRefs = useMemo(
    () =>
      agentRoster(members)
        .map((member) => {
          const nick = String(member.nickname ?? '').trim();
          if (!nick) return null;
          const conv = member.conversation_id
            ? conversationById.get(member.conversation_id)
            : undefined;
          return {
            id: member.member_id ?? member.conversation_id ?? nick,
            nickname: nick,
            detail: conv?.title || member.conversation_id || undefined,
          };
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item)),
    [conversationById, members]
  );

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
    if (!spaceId) return;
    const memberPage = await collaborationCall<{ members?: SpaceMember[] }>(
      'collaboration',
      'space.listMembers',
      { spaceId }
    );
    setMembersBySpace((current) => ({
      ...current,
      [spaceId]: memberPage.members ?? [],
    }));
  }, []);

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
        const memberName = displayName(member).trim();
        if (
          trimmedSpaceId === selectedId &&
          selectedFilterMemberNicknames.size > 0 &&
          !selectedFilterMemberNicknames.has(memberName)
        ) {
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
      selectedFilterMemberNicknames,
      selectedId,
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

  const loadRolesAndAgents = useCallback(async () => {
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
      const nextRoles = rolePage.roles ?? [];
      const nextAgents = agentPage.agents ?? [];
      setRoles(nextRoles);
      setAgents(nextAgents);
      setNewMemberRoleId((current) => current || nextRoles[0]?.id || '');
      setNewMemberAgentId(
        (current) => current || nextAgents[0]?.agent_id || ''
      );
      setInlineMemberRoleId((current) => current || nextRoles[0]?.id || '');
      setInlineMemberAgentId(
        (current) => current || nextAgents[0]?.agent_id || ''
      );
    } catch {
      // Handled by form submit if capability is disabled
    }
  }, []);

  const loadedMemberSpaceKeyRef = useRef('');
  useEffect(() => {
    overlayOpenedByUserRef.current = false;
    loadedMemberSpaceKeyRef.current = '';
    inFlightConversationsRef.current = null;
    setExpanded({});
    setMembersBySpace({});
    setMessagesBySpace({});
    setPickerExpandedSpaces({});
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
      .then((page) => {
        if (cancelled) return;
        const next = page.spaces ?? [];
        setSpaces(next);
        setSelectedId((current) => current || next[0]?.space_id || '');
        if (next.length === 0 && !overlayOpenedByUserRef.current) {
          setCreateOpen(true);
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
  }, [loadConversations, loadRolesAndAgents, workspace]);

  useEffect(() => {
    if (!workspace) return;
    const ids = openSpaceKey ? openSpaceKey.split('\n').filter(Boolean) : [];
    const allSpaceIds = spaces.map((space) => space.space_id);
    const memberIds = Array.from(
      new Set([
        ...allSpaceIds,
        ...ids,
        ...(selectedId && selectedId !== VIRTUAL_DEFAULT_SPACE_ID
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
            next[spaceId] = nextMembers;
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
        // Older backend without direct threads: fall back to the space log.
      }
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
      const page = await collaborationCall<{ members?: SpaceMember[] }>(
        'collaboration',
        'space.listMembers',
        { spaceId }
      );
      if (cancelled) return;
      setMembersBySpace((current) => ({
        ...current,
        [spaceId]: page.members ?? [],
      }));
    };

    const syncIncrementalMessages = async (spaceId: string) => {
      const sinceSeq = latestMessageSeq(messagesRef.current);
      const directThreadId = directThreadRef.current;
      if (directThreadId) {
        const direct = await loadDirectMessages<SpaceMessage>(
          collaborationCall,
          directThreadId,
          sinceSeq
        );
        if (cancelled) return;
        if (direct) {
          applyDirectMessages(directThreadId, direct.messages, sinceSeq > 0);
          return;
        }
      }
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
    setSelectedFilterMemberNicknames(new Set());
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
    setSpaceAddMemberOpen(false);
    setInlineMemberError('');
    setCreateMemberOpen(false);
    setCreateMemberError('');
    setRenameOpen(false);
    setRenameError('');
    setRenameSpaceOpen(false);
    setRenameSpaceError('');
    if (spaces.length === 0) {
      setSelectedId((current) => current || VIRTUAL_DEFAULT_SPACE_ID);
      setThreadVisible(true);
    }
  }, [setThreadVisible, spaces.length]);

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
    (conversationId?: string, nickname?: string): MemberBotAvatarConfig => {
      const convKey = conversationId?.trim() ?? '';
      const nickKey = nickname?.trim() ?? '';
      if (convKey && draftMemberMetaByConvId[convKey]?.avatar) {
        return draftMemberMetaByConvId[convKey].avatar;
      }
      if (convKey && memberAvatars[convKey]) {
        return memberAvatars[convKey];
      }
      if (nickKey && memberAvatars[nickKey]) {
        return memberAvatars[nickKey];
      }
      return deriveMemberBotAvatar(convKey || nickKey || 'bot');
    },
    [draftMemberMetaByConvId, memberAvatars]
  );

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
    setPendingSpaceMemberConvIds(new Set());
    setDraftMemberMetaByConvId({});
    setSpaceAddMemberOpen(false);
    setSpaceAddMemberTab('select');
    setInlineMemberError('');
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

  const selectSpace = (spaceId: string, nextExpanded = true) => {
    closeAllOverlays();
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
    if (sidebarItems) {
      const id = directThreadId || threadId || spaceId;
      const lastSeq = sidebarItems.find((item) => item.thread_id === id)
        ?.last_message?.seq;
      void markThreadRead(
        collaborationCall,
        id,
        typeof lastSeq === 'number' ? lastSeq : undefined
      );
    }
    setActiveDirect(
      directThreadId
        ? {
            spaceId,
            memberKey: previewMemberKey(spaceId, member),
            threadId: directThreadId,
          }
        : null
    );
    if (member.conversation_id) {
      markMemberConversationViewed(member.conversation_id);
    }
    closeAllOverlays();
    pendingViewedSpaceIdRef.current = spaceId;
    setSelectedId(spaceId);
    setSelectedMemberKey(previewMemberKey(spaceId, member));
    setThreadVisible(true);
  };

  const selectMemberForPreview = (spaceId: string, member: SpaceMember) => {
    if (spaces.some((item) => item.space_id === spaceId)) {
      setSelectedId(spaceId);
    }
    const memberKey = previewMemberKey(spaceId, member);
    if (member.member_id && sidebarItems) {
      // Thread-scoped member session; fall back to the member's own one.
      const threadId =
        chatListRef.current.find(
          (entry) => entry.type === 'group' && entry.spaceId === spaceId
        )?.threadId ?? spaceId;
      void resolveMemberSession(
        collaborationCall,
        member.member_id,
        threadId
      ).then((resolved) => {
        const conversationId = resolved || member.conversation_id || '';
        if (!conversationId) return;
        setSelectedMemberKey(memberKey);
        openMemberPreview(spaceId, member, conversationId);
      });
      return;
    }
    const conversationId = member.conversation_id ?? '';
    if (!conversationId) return;
    setSelectedMemberKey(memberKey);
    openMemberPreview(spaceId, member, conversationId);
  };

  // The chat a member tab is opened from: its `kind` decides the tab title.
  const memberTabThread = (
    spaceId: string | undefined
  ): { kind?: string | null; name?: string | null } | undefined => {
    if (!spaceId) return undefined;
    if (activeDirectThreadId) {
      const direct = sidebarItems?.find(
        (item) => item.thread_id === activeDirectThreadId
      );
      return direct ?? { kind: 'direct' };
    }
    const item = sidebarItems?.find(
      (candidate) =>
        candidate.thread_id === spaceId ||
        (candidate.kind === 'group' && candidate.space_id === spaceId)
    );
    if (item) return item;
    return spaces.find((space) => space.space_id === spaceId);
  };
  const memberTabTitleFor = (spaceId: string | undefined, name: string) =>
    memberTabTitle(name, memberTabThread(spaceId));

  const openMemberPreview = (
    spaceId: string,
    member: SpaceMember,
    conversationId: string
  ) => {
    const conv = conversationById.get(conversationId);
    const agentId =
      conv?.agent_id || draftMemberMetaByConvId[conversationId]?.agentId;
    openPreviewItem({
      id: memberPreviewPanelId(conversationId),
      kind: 'member',
      title: memberTabTitleFor(spaceId, displayName(member)),
      workspaceId: workspace,
      conversationId,
      ...(agentId ? { agentId: String(agentId) } : {}),
      spaceId,
    });
  };

  const togglePendingSpaceMemberConvSelection = (conversationId: string) => {
    setPendingSpaceMemberConvIds((current) => {
      const next = new Set(current);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      return next;
    });
  };

  const confirmSelectSpaceMembers = () => {
    const usedNames = new Set(allExistingNicknames);
    for (const meta of Object.values(draftMemberMetaByConvId)) {
      if (meta.nickname) usedNames.add(meta.nickname);
    }
    const nextDraftMeta = { ...draftMemberMetaByConvId };
    for (const convId of pendingSpaceMemberConvIds) {
      const existingNick =
        nextDraftMeta[convId]?.nickname ||
        memberNicknameByConversationId.get(convId);
      const nick = existingNick || randomEnglishNickname(usedNames);
      usedNames.add(nick);
      const conv = conversationById.get(convId);
      nextDraftMeta[convId] = {
        ...nextDraftMeta[convId],
        nickname: nick,
        agentId:
          nextDraftMeta[convId]?.agentId ||
          (conv?.agent_id ? String(conv.agent_id) : undefined),
      };
    }
    setDraftMemberMetaByConvId(nextDraftMeta);
    setSelectedSpaceMemberConvIds(new Set(pendingSpaceMemberConvIds));
    setSpaceAddMemberOpen(false);
  };

  const removeDraftSpaceMember = (conversationId: string) => {
    setSelectedSpaceMemberConvIds((current) => {
      const next = new Set(current);
      next.delete(conversationId);
      return next;
    });
    setPendingSpaceMemberConvIds((current) => {
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
  }) => {
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

  const submitInlineCreateMember = async () => {
    const trimmedNickname = inlineMemberName.trim();
    if (!trimmedNickname || !workspace || inlineMemberSubmitting) return;
    setInlineMemberError('');

    if (inlineMemberSource === 'session') {
      if (!inlineMemberSessionId) return;
      const conv = conversationById.get(inlineMemberSessionId);
      updateMemberAvatar(
        [inlineMemberSessionId, trimmedNickname],
        inlineMemberAvatar
      );
      setDraftMemberMetaByConvId((current) => ({
        ...current,
        [inlineMemberSessionId]: {
          nickname: trimmedNickname,
          agentId: conv?.agent_id ? String(conv.agent_id) : undefined,
          avatar: inlineMemberAvatar,
        },
      }));
      setSelectedSpaceMemberConvIds((current) => {
        const next = new Set(current);
        next.add(inlineMemberSessionId);
        return next;
      });
      setInlineMemberName('');
      setInlineMemberAvatar(randomMemberBotAvatar());
      setInlineMemberSessionId('');
      setSpaceAddMemberOpen(false);
      return;
    }

    if (inlineMemberSource === 'role' && !inlineMemberRoleId) return;
    if (inlineMemberSource === 'custom' && !inlineMemberAgentId) return;

    setInlineMemberSubmitting(true);
    try {
      const { created, resolvedAgentId } = await requestCreateMemberSession({
        spaceId: '',
        nickname: trimmedNickname,
        source: inlineMemberSource,
        roleId: inlineMemberRoleId,
        agentId: inlineMemberAgentId,
        modeId: inlineMemberModeId,
        configValues: inlineMemberConfigValues,
        personaPrompt: inlineMemberPersonaPrompt,
      });

      const createdConvId =
        created?.conversation_id ||
        created?.member_id ||
        `draft-member-${crypto.randomUUID()}`;

      const finalInlineNickname = created?.nickname || trimmedNickname;
      updateMemberAvatar(
        [createdConvId, created?.member_id, finalInlineNickname],
        inlineMemberAvatar
      );
      setDraftMemberMetaByConvId((current) => ({
        ...current,
        [createdConvId]: {
          nickname: finalInlineNickname,
          agentId: resolvedAgentId,
          avatar: inlineMemberAvatar,
        },
      }));
      setSelectedSpaceMemberConvIds((current) => {
        const next = new Set(current);
        next.add(createdConvId);
        return next;
      });
      setInlineMemberName('');
      setInlineMemberAvatar(randomMemberBotAvatar());
      setInlineMemberPersonaPrompt('');
      setSpaceAddMemberOpen(false);

      await loadConversations();
      if (unassignedId) {
        await reloadSpaceMembers(unassignedId);
      }
    } catch (cause) {
      setInlineMemberError(surfaceErrorCopy(cause));
    } finally {
      setInlineMemberSubmitting(false);
    }
  };

  const createSpace = async () => {
    const trimmedName = spaceName.trim();
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
    setPendingSpaceMemberConvIds(new Set());
    setDraftMemberMetaByConvId({});
    setSpaceAddMemberOpen(false);
    setInlineMemberError('');
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
      const target = resolvePrivateChatTarget({
        created: { conversation_id: newMemberSessionId },
        fallbackNickname: trimmedNickname,
        directSpaceId: unassignedId || targetSpaceId,
        chatList: chatListRef.current,
      });
      void refreshSidebar();
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

    const { created } = await requestCreateMemberSession({
      spaceId: targetSpaceId,
      nickname: trimmedNickname,
      source: newMemberSource,
      roleId: newMemberRoleId,
      agentId: newMemberAgentId,
      modeId: newMemberModeId,
      configValues: newMemberConfigValues,
      personaPrompt: newMemberPersonaPrompt,
    });

    const effectiveSpaceId = created?.space_id || targetSpaceId || unassignedId;
    updateMemberAvatar(
      [
        created?.conversation_id,
        created?.member_id,
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
    if (effectiveSpaceId) {
      await reloadSpaceMembers(effectiveSpaceId);
    }
    if (unassignedId && unassignedId !== effectiveSpaceId) {
      await reloadSpaceMembers(unassignedId);
    }
    if (created?.conversation_id) {
      // A member is a session family: land on its private chat, not a session.
      const target = resolvePrivateChatTarget({
        created,
        fallbackNickname: trimmedNickname,
        directSpaceId: unassignedId || effectiveSpaceId,
        chatList: chatListRef.current,
      });
      void refreshSidebar();
      openPrivateChat(target.spaceId, target.member, target.threadId);
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
      if (isSpaceMember(toSpaceId, conversationId, memberId)) return true;
      if (membersBySpace[toSpaceId] || toSpaceId === VIRTUAL_DEFAULT_SPACE_ID)
        return false;
      try {
        const page = await collaborationCall<{ members?: SpaceMember[] }>(
          'collaboration',
          'space.listMembers',
          { spaceId: toSpaceId }
        );
        return (page?.members ?? []).some(
          (m) =>
            m.conversation_id === conversationId ||
            (Boolean(memberId) && m.member_id === memberId)
        );
      } catch {
        return false;
      }
    };
    if (await alreadyInGroup()) {
      toast.error(
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
          ? { [effectiveFromSpaceId]: fromPage.members }
          : {}),
        ...(Array.isArray(toPage.members)
          ? { [effectiveToSpaceId]: toPage.members }
          : {}),
      }));
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
      if (nextSpaces.length === 0) {
        setCreateOpen(true);
      }
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
        title: '群收藏',
        params: {
          spaceId,
          spaceName: name ?? '协作空间',
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
        toast.success('已添加到群收藏');
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
    const textPart = rawText.trim();
    const attachmentMarkdown = attachedImages
      .map((img) => `![${img.name}](${img.path})`)
      .join('\n');
    const content = [textPart, attachmentMarkdown].filter(Boolean).join('\n\n');
    if (!selected || !content || sending) return;
    if (textPart && strayMentions(textPart, members).length > 0) {
      restoreDraft(rawText);
      setError(COPY.nicknameMissing);
      return;
    }
    setSending(true);
    try {
      const directThreadId = directThreadRef.current;
      if (directThreadId) {
        // Busy members queue the turn, so the message is not listed until it
        // starts: show it optimistically and reconcile on operationId/content.
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
        setDraft('');
        replaceDraftRef.current?.('');
        setAttachedImages((prev) => {
          clearComposerImageAttachments(prev);
          return [];
        });
        setError('');
        setOperationId(crypto.randomUUID());
        void loadConversations();
        void refreshSidebar();
        const sinceSeq = latestMessageSeq(messagesRef.current);
        const page = await loadDirectMessages<SpaceMessage>(
          collaborationCall,
          directThreadId,
          sinceSeq
        );
        if (page)
          applyDirectMessages(directThreadId, page.messages, sinceSeq > 0);
        return;
      }
      const recipients = postRecipients(textPart || content, members);
      const posted = await collaborationCall<{
        seq?: number;
        receipts?: DeliveryReceipt[];
      }>('collaboration', 'space.post', {
        spaceId: selected.space_id,
        content,
        to: recipients,
        operationId,
      });
      const nextSeq =
        typeof posted.seq === 'number' && Number.isInteger(posted.seq)
          ? posted.seq
          : latestMessageSeq(messagesRef.current) + 1;
      const optimisticMessage: SpaceMessage = {
        seq: nextSeq,
        envelope: {
          actor: `vibex://space/${selected.space_id}/user`,
          content,
          ...(recipients.length > 0
            ? {
                to: recipients.map(
                  (nick) =>
                    `vibex://space/${selected.space_id}/member/${encodeURIComponent(nick)}`
                ),
              }
            : {}),
        },
      };
      setMessages((current) =>
        mergeSpaceMessages(current, [optimisticMessage])
      );
      if (Array.isArray(posted.receipts) && posted.receipts.length > 0) {
        setReceiptsBySeq((current) => ({
          ...current,
          [nextSeq]: posted.receipts ?? [],
        }));
      }
      const failure = deliveryFailureCopy(posted.receipts);
      if (failure) {
        restoreDraft(rawText);
        setError(failure);
        return;
      }
      setDraft('');
      replaceDraftRef.current?.('');
      setAttachedImages((prev) => {
        clearComposerImageAttachments(prev);
        return [];
      });
      setError('');
      setOperationId(crypto.randomUUID());
      void loadConversations();
      const sinceSeq = latestMessageSeq(messagesRef.current);
      const messagePage = await collaborationCall<{
        messages?: SpaceMessage[];
        scheduled?: ScheduledSpaceMessage[];
      }>(
        'collaboration',
        'space.listMessages',
        sinceSeq > 0
          ? { spaceId: selected.space_id, sinceSeq }
          : { spaceId: selected.space_id, latest: true, limit: 200 }
      );
      if (Array.isArray(messagePage.scheduled)) {
        setScheduledMessages(messagePage.scheduled);
      }
      const incoming = messagePage.messages ?? [];
      setMessages((current) =>
        sinceSeq > 0
          ? mergeSpaceMessages(current, incoming)
          : mergeSpaceMessages([optimisticMessage], incoming)
      );
    } catch (cause) {
      restoreDraft(rawText);
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

  const visibleRoster = useMemo(() => agentRoster(members), [members]);

  const toggleTopFilterMemberNickname = useCallback((nickname: string) => {
    const trimmed = nickname.trim();
    if (!trimmed) return;
    setSelectedFilterMemberNicknames((current) => {
      const next = new Set(current);
      if (next.has(trimmed)) {
        next.delete(trimmed);
      } else {
        next.add(trimmed);
      }
      return next;
    });
  }, []);

  const filteredMessages = useMemo(() => {
    if (selectedFilterMemberNicknames.size === 0) return messages;
    return messages.filter((message) => {
      const author = messageAuthor(message.envelope);
      if (author === COPY.you) return true;
      return selectedFilterMemberNicknames.has(author);
    });
  }, [messages, selectedFilterMemberNicknames]);

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

  const selectedTagConfig = selected ? spaceTags[selected.space_id] : undefined;
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

  const hasActiveFilter =
    Boolean(filterAgentId) ||
    filterActiveWindow !== 'all' ||
    Boolean(filterMemberConvId);

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

  const doesSpaceMatchFilter = useCallback(
    (space: Space, spaceMembers: SpaceMember[]): boolean => {
      const queryLower = searchQuery.trim().toLowerCase();
      const tagConfig = spaceTags[space.space_id];
      const roster = agentRoster(spaceMembers);

      if (queryLower) {
        const spaceNameMatches =
          space.name.toLowerCase().includes(queryLower) ||
          Boolean(
            tagConfig?.label &&
              tagConfig.label.toLowerCase().includes(queryLower)
          );
        const anyMemberMatches = roster.some((member) =>
          doesMemberMatchQuery(member, queryLower)
        );
        if (!spaceNameMatches && !anyMemberMatches) {
          return false;
        }
      }

      if (filterAgentId) {
        const targetAgent = filterAgentId.toLowerCase();
        const matchesAgent = roster.some((member) => {
          const conv = member.conversation_id
            ? conversationById.get(member.conversation_id)
            : undefined;
          return String(conv?.agent_id ?? '').toLowerCase() === targetAgent;
        });
        if (!matchesAgent) return false;
      }

      if (filterMemberConvId) {
        const containsMember = roster.some(
          (member) => member.conversation_id === filterMemberConvId
        );
        if (!containsMember) return false;
      }

      if (filterActiveWindow !== 'all') {
        const matchesWindow = roster.some((member) => {
          const conv = member.conversation_id
            ? conversationById.get(member.conversation_id)
            : undefined;
          const activeNow = Boolean(
            conv?.turn_in_flight || conv?.status === 'inprogress'
          );
          return isWithinActiveWindow(
            filterActiveWindow,
            activeNow,
            conv?.updated_at
          );
        });
        if (!matchesWindow) return false;
      }

      return true;
    },
    [
      conversationById,
      doesMemberMatchQuery,
      filterActiveWindow,
      filterAgentId,
      filterMemberConvId,
      searchQuery,
      spaceTags,
    ]
  );

  const visibleSpaces = useMemo(
    () =>
      spaces.filter((space) =>
        doesSpaceMatchFilter(
          space,
          membersBySpace[space.space_id] ?? EMPTY_MEMBERS
        )
      ),
    [doesSpaceMatchFilter, membersBySpace, spaces]
  );

  const availableFilterAgents = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) {
      if (agent.agent_id) {
        map.set(agent.agent_id, agent.name || agent.agent_id);
      }
    }
    for (const conv of conversations) {
      if (conv.agent_id && !map.has(conv.agent_id)) {
        map.set(conv.agent_id, conv.agent_id);
      }
    }
    return [...map.entries()].map(([agent_id, name]) => ({ agent_id, name }));
  }, [agents, conversations]);

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

  const filterAgentSelectOptions = useMemo<
    readonly CollaborationSelectOption[]
  >(
    () => [
      { value: '', label: COPY.filterAllAgents },
      ...availableFilterAgents.map((agent) => ({
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
    [availableFilterAgents]
  );

  const filterActiveWindowSelectOptions = useMemo<
    readonly CollaborationSelectOption<ActiveTimeFilterWindow>[]
  >(
    () => [
      { value: 'all', label: COPY.filterAllTimes },
      { value: 'active', label: COPY.filterTimeActiveNow },
      { value: '24h', label: COPY.filterTime24h },
      { value: '7d', label: COPY.filterTime7d },
    ],
    []
  );

  const filterMemberSelectOptions = useMemo<
    readonly CollaborationSelectOption[]
  >(
    () => [
      { value: '', label: COPY.filterAllMembers },
      ...allUniqueMembers.map((member) => ({
        value: member.conversationId,
        label: member.nickname,
      })),
    ],
    [allUniqueMembers]
  );

  const defaultWorkspaceName = useMemo(() => {
    const pathName = workspacePath
      ?.replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .pop();
    return pathName || projectContext?.project?.name || workspace;
  }, [projectContext?.project?.name, workspace, workspacePath]);

  const pickerSpaceGroups = useMemo(() => {
    const groups: Array<{ space: Space; members: SpaceMember[] }> = [];
    const seenConvIds = new Set<string>();

    for (const space of spaces) {
      const spaceMembers = agentRoster(
        membersBySpace[space.space_id] ?? EMPTY_MEMBERS
      ).filter((member) => Boolean(member.conversation_id));
      for (const member of spaceMembers) {
        if (member.conversation_id) {
          seenConvIds.add(String(member.conversation_id));
        }
      }
      if (spaceMembers.length > 0) {
        groups.push({ space, members: spaceMembers });
      }
    }

    const unassignedSpaceMembers: SpaceMember[] = [];
    for (const member of unassignedMembers) {
      const convId = String(member.conversation_id ?? '').trim();
      if (convId && !seenConvIds.has(convId)) {
        seenConvIds.add(convId);
        unassignedSpaceMembers.push(member);
      }
    }
    for (const conv of sortedConversationsForPicker.sorted) {
      const convId = String(conv.conversation_id ?? '').trim();
      if (convId && !seenConvIds.has(convId)) {
        seenConvIds.add(convId);
        unassignedSpaceMembers.push({
          member_id: convId,
          conversation_id: convId,
          nickname:
            memberNicknameByConversationId.get(convId) ||
            conv.title ||
            conv.agent_id ||
            convId,
          kind: 'agent',
          visible_to_agents: 1,
        });
      }
    }

    if (unassignedSpaceMembers.length > 0) {
      groups.push({
        space: {
          space_id: unassignedId || 'unassigned',
          name: COPY.unassignedSpaceName,
        },
        members: unassignedSpaceMembers,
      });
    }

    return groups;
  }, [
    memberNicknameByConversationId,
    membersBySpace,
    sortedConversationsForPicker.sorted,
    spaces,
    unassignedId,
    unassignedMembers,
  ]);

  const renderPickerMemberRow = (spaceId: string, member: SpaceMember) => {
    const conversationId = String(member.conversation_id ?? '').trim();
    const checked = pendingSpaceMemberConvIds.has(conversationId);
    const name = displayName(member);
    const conv = conversationId
      ? conversationById.get(conversationId)
      : undefined;
    const resolvedAgentId =
      conv?.agent_id || draftMemberMetaByConvId[conversationId]?.agentId;
    const isRunning = Boolean(conv?.turn_in_flight);
    const tone = workspaceSessionStatusTone({
      status: conv?.status ?? 'todo',
      isRunning,
    });
    const compactAge = conv?.updated_at
      ? formatCompactSessionAge(conv.updated_at)
      : '刚刚';
    const lastMessageText = getMemberLastMessageInSpace(spaceId, member);

    return (
      <div
        key={`${spaceId}:${conversationId || name}`}
        className="collaboration-member-row-outer"
      >
        <Checkbox
          className="collaboration-delete-checkbox"
          aria-label={`选择助手 ${name}`}
          checked={checked}
          onCheckedChange={() =>
            togglePendingSpaceMemberConvSelection(conversationId)
          }
        />
        <div
          className={cn(
            'workspace-session-row collaboration-member-row flex-1 min-w-0',
            checked && 'is-selected'
          )}
        >
          <button
            type="button"
            className="workspace-session-row-main"
            aria-label={name}
            onClick={() =>
              togglePendingSpaceMemberConvSelection(conversationId)
            }
          >
            <span className="workspace-session-icon" aria-hidden="true">
              <MemberBotAvatar
                config={getMemberAvatar(conversationId, name)}
                sessionActive={Boolean(
                  isRunning || conv?.status === 'inprogress'
                )}
                className="h-7 w-7"
              />
              <span
                className={cn(
                  'workspace-session-status',
                  `workspace-session-status--${tone}`
                )}
              />
            </span>
            <span className="collaboration-member-title-group">
              <span className="collaboration-member-name">{name}</span>
              {lastMessageText ? (
                <span className="collaboration-member-subtitle collaboration-member-last-message">
                  {lastMessageText}
                </span>
              ) : null}
            </span>
            <span className="workspace-session-meta-idle gap-1.5">
              {isRunning ? (
                <Loader2
                  className="h-3.5 w-3.5 shrink-0 animate-spin text-[hsl(var(--warning))]"
                  aria-hidden="true"
                />
              ) : null}
              {compactAge ? (
                <span className="workspace-session-age">{compactAge}</span>
              ) : null}
              <span className="inline-flex shrink-0 items-center">
                {resolvedAgentId ? (
                  <AgentIcon
                    agent={resolvedAgentId as ExecutorProfileId['executor']}
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
          </button>
        </div>
      </div>
    );
  };

  // Is this member already in the group chat? Uses the full space member list
  // when loaded, plus the sidebar's members_preview.
  const isSpaceMember = (
    spaceId: string,
    conversationId: string,
    memberId?: string
  ): boolean => {
    const item = sidebarItems?.find(
      (candidate) =>
        candidate.kind === 'group' &&
        (candidate.space_id === spaceId || candidate.thread_id === spaceId)
    );
    const matches = (m: {
      conversation_id?: string | null;
      member_id?: string | null;
    }) =>
      (Boolean(conversationId) && m.conversation_id === conversationId) ||
      (Boolean(memberId) && m.member_id === memberId);
    return (
      (membersBySpace[spaceId] ?? []).some(matches) ||
      (item?.members_preview ?? []).some(matches)
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
          if (Array.isArray(members))
            setMembersBySpace((current) =>
              current[spaceId] ? current : { ...current, [spaceId]: members }
            );
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
      return isSpaceMember(spaceId, payload.conversationId, payload.memberId)
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
    const active =
      selectedMemberKey === memberKey ||
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
      : '刚刚';
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
    const lastMessageText = getMemberLastMessageInSpace(spaceId, member);

    return (
      <div
        key={member.member_id ?? member.nickname ?? conversationId}
        className="collaboration-member-row-outer"
      >
        {isDeleteMode && member.kind === 'agent' && conversationId ? (
          <Checkbox
            className="collaboration-delete-checkbox"
            aria-label={`选择助手 ${name}`}
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
                  aria-label="取消修改昵称"
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
                        selectMemberForPreview(spaceId, member);
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
                        />
                      </span>
                      <span className="collaboration-member-title-group">
                        <span className="collaboration-member-name">
                          {name}
                        </span>
                        {lastMessageText && !chatEntry?.lastPreview ? (
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
                              工作区
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
                              所属团队
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

  const chatList = buildChatList({
    sidebarItems,
    spaces: visibleSpaces,
    membersBySpace,
    unassignedSpaceId: unassignedId || undefined,
    // Every agent's direct (1:1) chat lives in the unassigned space, even when
    // it also holds a seat in a group, so list the full direct roster.
    unassignedMembers: unassignedId
      ? (membersBySpace[unassignedId] ?? EMPTY_MEMBERS)
      : EMPTY_MEMBERS,
  });
  chatListRef.current = chatList;
  const contactSections = sidebarAvailable
    ? buildContactSections(
        chatList,
        contactGroups,
        t('collaborationSpace.contactGroupUngrouped', '未分组')
      )
    : null;
  const newGroupMenuItem: ContactMenuItem = {
    kind: 'item',
    label: t('collaborationSpace.contactGroupNew', '新建分组'),
    icon: <FolderPlus className="size-3.5 opacity-70" />,
    testId: 'collaboration-contact-menu-new-group',
    onSelect: () => setCreatingContactGroup(true),
  };
  const openContactMenu = (
    event: React.MouseEvent,
    items: ContactMenuItem[]
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setContactMenu({ x: event.clientX, y: event.clientY, items });
  };
  const openRowContactMenu = (
    event: React.MouseEvent,
    entry: ChatListEntry
  ) => {
    if (!contactSections || !entry.threadId) return;
    const threadId = entry.threadId;
    const current = entry.groupId ?? UNGROUPED_SECTION_ID;
    const known = contactSections.some((section) => section.id === current)
      ? current
      : UNGROUPED_SECTION_ID;
    openContactMenu(event, [
      {
        kind: 'submenu',
        label: t('collaborationSpace.contactGroupMoveTo', '移动到分组'),
        icon: contactMenuIcons.move,
        testId: 'collaboration-contact-menu-move',
        items: contactSections
          .filter((section) => section.id !== known)
          .map((section) => ({
            label: section.name,
            testId: `collaboration-contact-menu-move-${section.id}`,
            onSelect: () => void moveContactToSection(threadId, section.id),
          })),
      },
      { kind: 'separator' },
      newGroupMenuItem,
    ]);
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
              kind: 'item',
              label: t('collaborationSpace.contactGroupRename', '重命名分组'),
              icon: contactMenuIcons.rename,
              testId: 'collaboration-contact-menu-rename',
              onSelect: () => setRenamingGroupId(section.id),
            },
            {
              kind: 'item',
              label: t('collaborationSpace.contactGroupDelete', '删除分组'),
              icon: contactMenuIcons.remove,
              destructive: true,
              testId: 'collaboration-contact-menu-delete',
              onSelect: () => void deleteGroup(section.id),
            },
            { kind: 'separator' },
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

  // Last-message preview + unread badge; renders nothing when absent.
  const renderChatMeta = (entry: ChatListEntry) =>
    entry.lastPreview || entry.unreadCount ? (
      <span
        className="collaboration-chat-meta"
        data-testid={`collaboration-chat-meta-${entry.key}`}
      >
        {entry.lastPreview ? (
          <span className="collaboration-chat-preview">
            {entry.lastPreview}
          </span>
        ) : null}
        {entry.unreadCount ? (
          <span className="collaboration-chat-unread">{entry.unreadCount}</span>
        ) : null}
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
        isSpaceMember(space.space_id, draggingMember.conversationId)
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
            if (isSpaceMember(space.space_id, payload.conversationId)) {
              toast.error(
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
              aria-label={`选择空间 ${space.name}`}
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
                  aria-label="修改空间名称输入框"
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
                  aria-label="取消修改空间名称"
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
                  aria-label="确认修改空间名称"
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
                          aria-label={`标签 ${space.name}`}
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
                      aria-label={`修改名称 ${space.name}`}
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
                    <Button
                      type="button"
                      variant="icon"
                      size="icon"
                      className="collaboration-expand"
                      aria-label={t('collaborationSpace.addMemberAria', {
                        name: space.name,
                        defaultValue: `${COPY.addMember} ${space.name}`,
                      })}
                      onClick={() =>
                        openCreateMemberDialog(space.space_id, 'session')
                      }
                    >
                      <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
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
      ? spaceAddMemberOpen
        ? '添加助手'
        : t('collaborationSpace.newSpace', COPY.newSpace)
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
              aria-label="Close"
              onClick={closeAllOverlays}
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>

          {createOpen && !spaceAddMemberOpen ? (
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
                <Label>{t('collaborationSpace.spaceName', '空间名称')}</Label>
                <Input
                  aria-label={t('collaborationSpace.spaceName', '空间名称')}
                  value={spaceName}
                  onChange={(event) => setSpaceName(event.target.value)}
                  placeholder={t('collaborationSpace.spaceName', '空间名称')}
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
                    aria-label="标签名称"
                    value={spaceTagCustomLabel}
                    onChange={(event) =>
                      setSpaceTagCustomLabel(event.target.value)
                    }
                    placeholder="标签名称（可选）"
                    className="h-8 px-2.5 text-[13px]"
                  />
                ) : null}
              </div>

              <div className="space-y-1.5">
                <Label>{COPY.spaceMembersLabel}</Label>
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
                          aria-label={`移除助手 ${memberName}`}
                          onClick={() => removeDraftSpaceMember(convId)}
                        >
                          <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                      </span>
                    );
                  })}

                  <button
                    type="button"
                    className="collaboration-member-dashed-add"
                    aria-label="添加或新建协作空间助手"
                    onClick={() => {
                      setPendingSpaceMemberConvIds(
                        new Set(selectedSpaceMemberConvIds)
                      );
                      setSpaceAddMemberTab('select');
                      setInlineMemberError('');
                      setSpaceAddMemberOpen(true);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
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
                  disabled={!spaceName.trim()}
                >
                  {t('collaborationSpace.newSpace', COPY.newSpace)}
                </Button>
              </div>
            </form>
          ) : null}

          {createOpen && spaceAddMemberOpen ? (
            <div className="flex flex-col gap-3.5">
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={
                    spaceAddMemberTab === 'select' ? 'default' : 'outline'
                  }
                  onClick={() => setSpaceAddMemberTab('select')}
                  className="h-8 text-xs"
                >
                  选择助手
                </Button>
                <Button
                  type="button"
                  variant={
                    spaceAddMemberTab === 'create' ? 'default' : 'outline'
                  }
                  onClick={() => {
                    if (!inlineMemberRoleId && roles[0]?.id) {
                      setInlineMemberRoleId(roles[0].id);
                    }
                    if (!inlineMemberAgentId && agents[0]?.agent_id) {
                      setInlineMemberAgentId(agents[0].agent_id);
                    }
                    setInlineMemberAvatar(randomMemberBotAvatar());
                    setSpaceAddMemberTab('create');
                  }}
                  className="h-8 text-xs"
                >
                  {COPY.newMemberButton}
                </Button>
              </div>

              {spaceAddMemberTab === 'select' ? (
                <>
                  <div className="collaboration-dialog-member-picker">
                    <p className="collaboration-picker-heading">
                      {COPY.memberSessionsGroup}
                    </p>
                    {pickerSpaceGroups.length === 0 ? (
                      <p className="collaboration-picker-empty">
                        {COPY.noMemberSessions}
                      </p>
                    ) : (
                      <div className="collaboration-space-list">
                        {pickerSpaceGroups.map(
                          ({ space: groupSpace, members: groupMembers }) => {
                            const groupOpen =
                              pickerExpandedSpaces[groupSpace.space_id] ?? true;
                            const groupTagConfig =
                              spaceTags[groupSpace.space_id];
                            const groupTagPreset = groupTagConfig
                              ? SPACE_TAG_PRESETS.find(
                                  (preset) =>
                                    preset.id === groupTagConfig.colorId
                                )
                              : undefined;
                            const groupAvatars = groupMembers.map((member) =>
                              getMemberAvatar(
                                member.conversation_id ?? undefined,
                                displayName(member)
                              )
                            );
                            return (
                              <div
                                key={groupSpace.space_id}
                                className="collaboration-space"
                                data-testid={`collaboration-picker-space-${groupSpace.space_id}`}
                              >
                                <div className="workspace-session-row collaboration-space-row">
                                  <button
                                    type="button"
                                    className="workspace-session-row-main collaboration-space-header-main"
                                    aria-label={groupSpace.name}
                                    aria-expanded={groupOpen}
                                    onClick={() =>
                                      setPickerExpandedSpaces((current) => ({
                                        ...current,
                                        [groupSpace.space_id]: !groupOpen,
                                      }))
                                    }
                                  >
                                    <CollaborationSpaceIcon
                                      avatars={groupAvatars}
                                      tagPreset={groupTagPreset}
                                    />
                                    <span className="workspace-session-title is-cjk">
                                      {groupSpace.name}
                                    </span>
                                    <span className="collaboration-space-meta">
                                      <span className="workspace-session-group-count">
                                        {groupMembers.length}
                                      </span>
                                    </span>
                                  </button>
                                </div>
                                {groupOpen ? (
                                  <div className="collaboration-member-list">
                                    {groupMembers.map((member) =>
                                      renderPickerMemberRow(
                                        groupSpace.space_id,
                                        member
                                      )
                                    )}
                                  </div>
                                ) : null}
                              </div>
                            );
                          }
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setSpaceAddMemberOpen(false)}
                    >
                      返回
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      size="xs"
                      onClick={confirmSelectSpaceMembers}
                    >
                      完成
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <Label>{COPY.memberNameLabel}</Label>
                    <Input
                      aria-label={COPY.memberNameLabel}
                      value={inlineMemberName}
                      onChange={(event) =>
                        setInlineMemberName(event.target.value)
                      }
                      placeholder={COPY.memberNameLabel}
                      className="h-8 px-2.5 text-[13px]"
                      autoFocus
                    />
                  </div>

                  <MemberBotAvatarPicker
                    value={inlineMemberAvatar}
                    onChange={setInlineMemberAvatar}
                  />

                  <div className="flex items-center justify-between gap-3">
                    <Label className="shrink-0">{COPY.memberSourceLabel}</Label>
                    <SegmentedControl
                      label={COPY.memberSourceLabel}
                      size="sm"
                      layout="hug"
                      className="collaboration-compact-segmented"
                      value={inlineMemberSource}
                      onChange={(nextValue) =>
                        setInlineMemberSource(nextValue as MemberSourceOption)
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

                  {inlineMemberSource === 'role' ? (
                    <div className="space-y-1.5">
                      <Label>{COPY.chooseRole}</Label>
                      <CollaborationOptionSelect
                        ariaLabel={COPY.chooseRole}
                        value={inlineMemberRoleId}
                        placeholder={COPY.chooseRole}
                        options={roleSelectOptions}
                        onChange={setInlineMemberRoleId}
                      />
                    </div>
                  ) : inlineMemberSource === 'session' ? (
                    <div className="space-y-1.5">
                      <Label>{chooseConversationLabel}</Label>
                      <CollaborationOptionSelect
                        ariaLabel={chooseConversationLabel}
                        value={inlineMemberSessionId}
                        placeholder={chooseConversationLabel}
                        options={conversationSelectOptions}
                        onChange={setInlineMemberSessionId}
                      />
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <Label>{COPY.chooseAgent}</Label>
                        <CollaborationOptionSelect
                          ariaLabel={COPY.chooseAgent}
                          value={inlineMemberAgentId}
                          placeholder={COPY.chooseAgent}
                          options={agentSelectOptions}
                          onChange={(nextAgentId) => {
                            setInlineMemberAgentId(nextAgentId);
                            setInlineMemberModeId('');
                            setInlineMemberConfigValues({});
                          }}
                        />
                      </div>

                      {inlineMemberAgentId ? (
                        <CustomAgentControls
                          agentId={inlineMemberAgentId}
                          modeId={inlineMemberModeId}
                          values={inlineMemberConfigValues}
                          onModeId={setInlineMemberModeId}
                          onValues={setInlineMemberConfigValues}
                        />
                      ) : null}

                      <div className="space-y-1.5">
                        <Label>{COPY.personaPromptLabel}</Label>
                        <Textarea
                          aria-label={COPY.personaPromptLabel}
                          placeholder={COPY.personaPromptLabel}
                          value={inlineMemberPersonaPrompt}
                          onChange={(event) =>
                            setInlineMemberPersonaPrompt(event.target.value)
                          }
                          className="min-h-[64px] px-2.5 py-1.5 text-[13px]"
                        />
                      </div>
                    </div>
                  )}

                  {inlineMemberError ? (
                    <p className="collaboration-error">{inlineMemberError}</p>
                  ) : null}

                  <div className="flex justify-end gap-2 pt-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setSpaceAddMemberOpen(false)}
                    >
                      返回
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      size="xs"
                      data-dialog-primary="true"
                      disabled={
                        inlineMemberSubmitting ||
                        !inlineMemberName.trim() ||
                        (inlineMemberSource === 'role'
                          ? !inlineMemberRoleId
                          : inlineMemberSource === 'session'
                            ? !inlineMemberSessionId
                            : !inlineMemberAgentId)
                      }
                      onClick={() => {
                        void submitInlineCreateMember();
                      }}
                    >
                      添加助手
                    </Button>
                  </div>
                </>
              )}
            </div>
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
                    <CustomAgentControls
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
                    selectLabel="选择协作空间或助手"
                    selectedCountLabel={`已选择 ${selectedDeleteCount} 项`}
                    deleteLabel="确认删除"
                    deletingLabel="删除中..."
                    cancelLabel="取消"
                    onDelete={() => {
                      void confirmBatchDelete();
                    }}
                    onCancel={handleToggleDeleteMode}
                  />
                ) : (
                  <>
                    <div
                      className={cn(
                        'ml-auto flex min-w-0 flex-nowrap items-center justify-end gap-1',
                        searchOpen && 'flex-1'
                      )}
                    >
                      <SessionListSearchControl
                        searchQuery={searchQuery}
                        isExpanded={searchOpen}
                        searchLabel="搜索协作空间或助手"
                        placeholder={COPY.searchPlaceholder}
                        onSearchQueryChange={setSearchQuery}
                        onExpandedChange={setSearchOpen}
                      />

                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            hidden={searchOpen}
                            className={cn(
                              SESSION_LIST_ACTION_BUTTON_CLASS,
                              searchOpen && 'hidden'
                            )}
                            aria-label={t(
                              'collaborationSpace.newSpace',
                              COPY.newSpace
                            )}
                          >
                            <Plus className={SESSION_LIST_ACTION_ICON_CLASS} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={openCreateSpaceDialog}>
                            {COPY.newSpaceButton}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => openCreateMemberDialog()}
                          >
                            {COPY.newMemberButton}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>

                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            hidden={searchOpen}
                            className={cn(
                              SESSION_LIST_ACTION_BUTTON_CLASS,
                              hasActiveFilter && 'bg-secondary text-foreground',
                              searchOpen && 'hidden'
                            )}
                            aria-label={COPY.filterLabel}
                          >
                            <Filter
                              className={SESSION_LIST_ACTION_ICON_CLASS}
                            />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-60 p-3">
                          <div className="flex flex-col gap-2.5">
                            <div className="space-y-1">
                              <Label className="text-xs">
                                {COPY.filterByAgent}
                              </Label>
                              <CollaborationOptionSelect
                                ariaLabel={COPY.filterByAgent}
                                value={filterAgentId}
                                options={filterAgentSelectOptions}
                                onChange={setFilterAgentId}
                                size="compact"
                              />
                            </div>

                            <div className="space-y-1">
                              <Label className="text-xs">
                                {COPY.filterByActiveTime}
                              </Label>
                              <CollaborationOptionSelect
                                ariaLabel={COPY.filterByActiveTime}
                                value={filterActiveWindow}
                                options={filterActiveWindowSelectOptions}
                                onChange={setFilterActiveWindow}
                                size="compact"
                              />
                            </div>

                            <div className="space-y-1">
                              <Label className="text-xs">
                                {COPY.filterByMember}
                              </Label>
                              <CollaborationOptionSelect
                                ariaLabel={COPY.filterByMember}
                                value={filterMemberConvId}
                                options={filterMemberSelectOptions}
                                onChange={setFilterMemberConvId}
                                size="compact"
                              />
                            </div>

                            {hasActiveFilter ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                onClick={() => {
                                  setFilterAgentId('');
                                  setFilterActiveWindow('all');
                                  setFilterMemberConvId('');
                                }}
                              >
                                {COPY.filterReset}
                              </Button>
                            ) : null}
                          </div>
                        </PopoverContent>
                      </Popover>

                      {sidebarAvailable && contactGroups !== null ? (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          hidden={searchOpen}
                          className={cn(
                            SESSION_LIST_ACTION_BUTTON_CLASS,
                            searchOpen && 'hidden'
                          )}
                          aria-label={t(
                            'collaborationSpace.contactGroupNew',
                            '新建分组'
                          )}
                          data-testid="collaboration-new-contact-group"
                          onClick={() => setCreatingContactGroup(true)}
                        >
                          <FolderPlus
                            className={SESSION_LIST_ACTION_ICON_CLASS}
                          />
                        </Button>
                      ) : null}

                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        hidden={searchOpen}
                        className={cn(
                          SESSION_LIST_ACTION_BUTTON_CLASS,
                          searchOpen && 'hidden'
                        )}
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
                {creatingContactGroup ? (
                  <ContactGroupNameInput
                    placeholder={t(
                      'collaborationSpace.contactGroupNamePlaceholder',
                      '分组名称'
                    )}
                    testId="collaboration-new-contact-group-input"
                    onSubmit={(name) => {
                      setCreatingContactGroup(false);
                      void createGroup(name);
                    }}
                    onCancel={() => setCreatingContactGroup(false)}
                  />
                ) : null}
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
                ) : spaces.length === 0 ? (
                  <>
                    {renderSpaceGroup(
                      {
                        space_id: VIRTUAL_DEFAULT_SPACE_ID,
                        name: virtualDefaultSpaceName,
                      },
                      { isVirtualDefault: true }
                    )}
                    {chatList.map((entry) =>
                      entry.type === 'direct'
                        ? renderDirectChatRow(entry)
                        : null
                    )}
                  </>
                ) : (
                  <>{chatList.map(renderChatEntry)}</>
                )}
                <ContactContextMenu
                  menu={contactMenu}
                  onClose={() => setContactMenu(null)}
                />
              </div>
            </div>
            {hasThread || showPreview ? (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="调整协作空间列表宽度"
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
            style={{ order: threadOrder }}
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
            {selected && topMemberBarExpanded ? (
              <div
                className="collaboration-top-member-bar"
                data-testid="collaboration-top-member-bar"
              >
                <button
                  type="button"
                  className={cn(
                    'collaboration-top-collection-btn',
                    activePreviewTabId ===
                      spaceCollectionPreviewPanelId(selected.space_id) &&
                      'is-active'
                  )}
                  aria-label="群收藏"
                  title="群收藏"
                  data-testid="collaboration-open-collection-btn"
                  onClick={() =>
                    openSpaceCollectionTab(selected.space_id, selected.name)
                  }
                >
                  <LayoutGrid
                    className="h-3.5 w-3.5 shrink-0"
                    aria-hidden="true"
                  />
                </button>
                <Button
                  type="button"
                  variant="icon"
                  size="icon"
                  className="collaboration-expand"
                  aria-label="收起助手列表"
                  title="收起助手列表"
                  onClick={() => setTopMemberBarExpanded(false)}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </Button>
                <div className="collaboration-top-member-scroll">
                  {visibleRoster.map((member) => {
                    const nick = displayName(member);
                    const convId = member.conversation_id ?? '';
                    const memberHoverKey = member.member_id ?? (convId || nick);
                    const memberConv = convId
                      ? conversationById.get(convId)
                      : undefined;
                    const memberSessionActive = Boolean(
                      memberConv?.turn_in_flight ||
                        memberConv?.status === 'inprogress'
                    );
                    const isSelectedChip =
                      selectedFilterMemberNicknames.has(nick);
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
                      <Popover key={memberHoverKey} open={isDelayedPopoverOpen}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className={cn(
                              'collaboration-top-member-chip',
                              isSelectedChip && 'is-selected',
                              hasDelayedMessages && 'has-delayed-messages'
                            )}
                            aria-label={`筛选助手 ${nick}`}
                            aria-pressed={isSelectedChip}
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
                            onClick={() => toggleTopFilterMemberNickname(nick)}
                          >
                            <MemberBotAvatar
                              config={getMemberAvatar(convId, nick)}
                              sessionActive={memberSessionActive}
                              className="h-3.5 w-3.5 shrink-0"
                            />
                            <span>{nick}</span>
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
                            onOpenAutoFocus={(event) => event.preventDefault()}
                            onCloseAutoFocus={(event) => event.preventDefault()}
                            data-testid={`member-delayed-queue-${nick}`}
                            className="collaboration-member-delayed-queue-popover rounded-md border border-border/80 bg-popover p-2 text-popover-foreground shadow-lg"
                          >
                            <div className="mb-1.5 flex items-center justify-between px-1 text-[11px] font-medium text-muted-foreground">
                              <span className="inline-flex items-center gap-1">
                                <Clock
                                  className="h-3 w-3 text-blue-500"
                                  aria-hidden="true"
                                />
                                <span>定时消息队列</span>
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

            <div className="collaboration-thread-body">
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
                        spaceCollectionPreviewPanelId(selected.space_id) &&
                        'is-active'
                    )}
                    aria-label="群收藏"
                    title="群收藏"
                    data-testid="collaboration-open-collection-btn"
                    onClick={() =>
                      openSpaceCollectionTab(selected.space_id, selected.name)
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
                    aria-label="展开助手列表"
                    title="展开助手列表"
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
                              <MemberBotAvatar
                                config={getMemberAvatar(convId, nick)}
                                className="h-3.5 w-3.5 shrink-0"
                              />
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
                      当前协作空间暂无助手，请先添加助手
                    </div>
                    <div className="collaboration-empty-member-actions">
                      <Button
                        type="button"
                        variant="primary"
                        onClick={() => openCreateMemberDialog()}
                      >
                        添加助手
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        onClick={openCreateSpaceDialog}
                      >
                        新建协作空间
                      </Button>
                    </div>
                  </div>
                ) : selected && filteredMessages.length > 0 ? (
                  filteredMessages.map((message) => {
                    const author = messageAuthor(message.envelope);
                    const fromYou = author === COPY.you;
                    const name = fromYou
                      ? t('collaborationSpace.you', COPY.you)
                      : author || COPY.you;
                    const authorConversationId = resolveMessageConversationId(
                      message.envelope,
                      members
                    );
                    const authorConv = authorConversationId
                      ? conversationById.get(authorConversationId)
                      : undefined;
                    const messageReceipts = resolveMessageReceipts(
                      message.envelope,
                      receiptsBySeq[message.seq] ?? EMPTY_RECEIPTS
                    );
                    const messageKey = String(message.seq);
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
                      >
                        {!fromYou ? (
                          <div className="collaboration-message-header">
                            <button
                              type="button"
                              className="collaboration-message-avatar"
                              aria-label={`预览 ${name} 会话`}
                              onClick={() => {
                                if (!authorConversationId) return;
                                const agentId = authorConv?.agent_id
                                  ? String(authorConv.agent_id)
                                  : undefined;
                                openPreviewItem({
                                  id: memberPreviewPanelId(
                                    authorConversationId
                                  ),
                                  kind: 'member',
                                  title: memberTabTitleFor(
                                    selected.space_id,
                                    name
                                  ),
                                  workspaceId: workspace,
                                  conversationId: authorConversationId,
                                  ...(agentId ? { agentId } : {}),
                                  spaceId: selected.space_id,
                                });
                              }}
                            >
                              <MemberBotAvatar
                                config={getMemberAvatar(
                                  authorConversationId,
                                  name
                                )}
                                sessionActive={Boolean(
                                  authorConv?.turn_in_flight ||
                                    authorConv?.status === 'inprogress'
                                )}
                                className="h-5 w-5"
                                data-testid={`collaboration-message-bot-avatar-${message.seq}`}
                              />
                            </button>
                            <p className="collaboration-message-name">{name}</p>
                          </div>
                        ) : null}
                        <SpaceMessageBody
                          fromYou={fromYou}
                          text={bubbleText(message.envelope)}
                          workspacePath={workspacePath}
                          workspaceId={workspace || undefined}
                        />
                        {messageReceipts.length > 0 ? (
                          <ul className="collaboration-receipts">
                            {messageReceipts.map((receipt, index) => {
                              const status = receiptStatusCopy(
                                receipt,
                                receiptLabels
                              );
                              const failed =
                                receipt.delivered === 'failed' ||
                                Boolean(receipt.error_code);
                              return (
                                <li
                                  key={
                                    receipt.conversation_id ??
                                    receipt.nickname ??
                                    `${message.seq}-${index}`
                                  }
                                  className="collaboration-receipt"
                                  data-status={
                                    failed
                                      ? 'failed'
                                      : (receipt.delivered ?? 'queued')
                                  }
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
                {selected && activeDirectThreadId
                  ? pendingDirectMessages
                      .filter((item) => item.threadId === activeDirectThreadId)
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
                          />
                          <ul className="collaboration-receipts">
                            <li
                              className="collaboration-receipt"
                              data-status="queued"
                            >
                              <span className="inline-flex items-center gap-1">
                                <Check
                                  className="h-3 w-3"
                                  aria-hidden="true"
                                  data-testid="collaboration-pending-tick"
                                />
                                {COPY.receiptQueued}
                              </span>
                            </li>
                          </ul>
                        </article>
                      ))
                  : null}
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
                      <CollaborationSpaceIcon
                        className="collaboration-space-icon--sm"
                        avatars={visibleRoster.map((member) =>
                          getMemberAvatar(
                            member.conversation_id ?? undefined,
                            displayName(member)
                          )
                        )}
                        tagPreset={selectedTagPreset}
                      />
                      <span className="truncate">{selected.name}</span>
                    </div>

                    <Popover
                      open={composerMembersMenuOpen}
                      onOpenChange={setComposerMembersMenuOpen}
                    >
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          data-testid="composer-space-stats"
                          aria-label={`空间助手数量 ${visibleRoster.length}`}
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
                        <div className="mb-1.5 flex items-center justify-between px-1 text-[11px] font-medium text-muted-foreground">
                          <span>空间助手</span>
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
                                    <span className="shrink-0 text-[11px] text-muted-foreground">
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
                      title="选择文件"
                      aria-label="选择文件"
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
                      title="@助手"
                      aria-label="@助手"
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
                aria-label="调整预览区宽度"
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
      </div>
    </CollaborationPreviewScope>
  );
}
