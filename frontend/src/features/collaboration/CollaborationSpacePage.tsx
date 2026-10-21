import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Filter,
  Folder,
  Loader2,
  Pencil,
  Plus,
  Tag,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentSessionControlsSnapshot,
  ExecutorProfileId,
} from 'shared/types';
import { ChatMessage, ChatMessageBubble } from '@astryxdesign/core/Chat';
import { TextInput } from '@astryxdesign/core/TextInput';

import { AgentIcon } from '@/components/agents/AgentIcon';
import {
  SESSION_LIST_ACTION_BUTTON_CLASS,
  SESSION_LIST_ACTION_ICON_CLASS,
} from '@/components/kanban/session-hub/utils';
import { SessionControlsFields } from '@/components/sessions/SessionControlsFields';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { UserMessageMarkdown } from '@/components/NormalizedConversation/UserMessageMarkdown';
import { ComposerPrimaryActionButton } from '@/components/tasks/follow-up/ComposerPrimaryActionButton';
import { SessionComposerFrame } from '@/components/tasks/follow-up/SessionComposerFrame';
import { SessionComposerInput } from '@/components/tasks/follow-up/SessionComposerInput';
import { SessionListDeleteControl } from '@/components/workspace-session-list/SessionListDeleteControl';
import { SessionListSearchControl } from '@/components/workspace-session-list/SessionListSearchControl';
import {
  formatCompactSessionAge,
  workspaceSessionStatusTone,
} from '@/components/workspace-session-list/workspaceSessionListModel';
import {
  PanelActionsContext,
  useOptionalPanelActionsContext,
} from '@/contexts/PanelActionsContext';
import { loadAgentSessionControlsCatalog } from '@/features/agents/sessionControlsQuery';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { registerImagePreviewSource } from '@/lib/imagePreviewRegistry';
import { cn } from '@/lib/utils';
import {
  buildPreviewPanelParams,
  type OpenFilePreviewOptions,
  type PreviewPanelParams,
} from '@/types/panels';
import '@/styles/conversation.css';

import {
  collaborationCall,
  currentWindowLabel,
  listenCollaborationSpaceChanged,
} from './collaborationApi';
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
} from './spaceModel';
import './collaboration.css';

const SessionPreview = lazy(() =>
  import('@/components/kanban/KanbanSessionConversationView').then(
    (module) => ({
      default: module.KanbanSessionConversationView,
    })
  )
);

const FilePreviewPanel = lazy(
  () => import('@/components/panels/DockviewPreviewPanel')
);

type Space = { space_id: string; name: string };
type SpaceMessage = {
  seq: number;
  envelope: {
    actor?: string;
    attributedTo?: string;
    content?: string;
    summary?: string;
  };
};
type ConversationOption = {
  conversation_id: string;
  title?: string | null;
  agent_id?: string | null;
  status?: string | null;
  updated_at?: string | null;
  turn_in_flight?: boolean;
  team_name?: string | null;
};
type TeamOption = { id: string; name: string; summary?: string | null };
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

const EMPTY_MEMBERS: SpaceMember[] = [];
const EMPTY_RECEIPTS: DeliveryReceipt[] = [];

function bubbleText(envelope: SpaceMessage['envelope']): string {
  const content = String(envelope.content ?? '');
  const summary = String(envelope.summary ?? '');
  if (!summary || summary === content || content.startsWith(summary)) {
    return content;
  }
  return `${summary}\n\n${content}`;
}

function collaborationImagePreviewId(imageUrl: string): string {
  let hash = 5381;
  for (let index = 0; index < imageUrl.length; index += 1) {
    hash = ((hash << 5) + hash + imageUrl.charCodeAt(index)) | 0;
  }
  return `collaboration-image:${(hash >>> 0).toString(36)}`;
}

function previewMemberKey(spaceId: string, member: SpaceMember): string {
  return `${spaceId}:${member.member_id ?? member.conversation_id ?? member.nickname ?? ''}`;
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
  return (
    <SessionControlsFields
      modes={catalog.modes}
      currentModeId={catalog.current_mode ?? null}
      configOptions={catalog.config_options}
      selectedModeId={modeId || null}
      pendingConfigValues={values}
      onSelectMode={onModeId}
      onSelectConfigValue={(key, value) => {
        const next = { ...values };
        if (value) next[key] = value;
        else delete next[key];
        onValues(next);
      }}
    />
  );
}

function CollaborationPreviewScope({
  children,
  onOpenFile,
}: {
  children: ReactNode;
  onOpenFile: (params: PreviewPanelParams) => void;
}) {
  const parent = useOptionalPanelActionsContext();
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const value = useMemo(() => {
    if (!parent) return null;
    return {
      ...parent,
      openFilePreview: (filePath: string, options?: OpenFilePreviewOptions) => {
        onOpenFileRef.current(buildPreviewPanelParams(filePath, options));
        return 'opened' as const;
      },
      openDiffPreviewAtPath: (
        path: string,
        options?: OpenFilePreviewOptions & { title?: string }
      ) => {
        onOpenFileRef.current(
          buildPreviewPanelParams(path, { ...options, mode: 'diff' })
        );
      },
      openImagePreview: (
        imageUrl: string,
        options?: { title?: string | null }
      ) => {
        const imagePreviewId = collaborationImagePreviewId(imageUrl);
        registerImagePreviewSource(imagePreviewId, imageUrl);
        onOpenFileRef.current({
          ...buildPreviewPanelParams('', {
            displayPath: options?.title ?? null,
          }),
          imagePreviewId,
        });
      },
    };
  }, [parent]);

  if (!value) return children;
  return (
    <PanelActionsContext.Provider value={value}>
      {children}
    </PanelActionsContext.Provider>
  );
}

function SpaceMessageBody({
  fromYou,
  text,
  workspacePath,
}: {
  fromYou: boolean;
  text: string;
  workspacePath?: string;
}) {
  if (fromYou) {
    return (
      <ChatMessage
        sender="user"
        density="compact"
        className="vibex-user-message"
      >
        <ChatMessageBubble className="conv-user-bubble">
          <UserMessageMarkdown value={text} workspacePath={workspacePath} />
        </ChatMessageBubble>
      </ChatMessage>
    );
  }
  return (
    <div className="conv-entry-item conv-assistant-msg px-4 py-2 text-sm">
      <div className="conv-assistant-body">
        <AstryxMarkdown
          value={text}
          workspacePath={workspacePath}
          rawHtml={false}
        />
      </div>
    </div>
  );
}

export function CollaborationSpacePage({
  workspaceId,
}: {
  workspaceId: string | null;
}) {
  const { t } = useTranslation('panels');
  const workspace = workspaceId ?? '';
  const unassignedId = workspace ? unassignedSpaceId(workspace) : '';
  const { repos } = useAttemptRepo(workspace || undefined);
  const workspacePath = repos[0]?.path;

  const [spaces, setSpaces] = useState<Space[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [membersBySpace, setMembersBySpace] = useState<
    Record<string, SpaceMember[]>
  >({});
  const [messages, setMessages] = useState<SpaceMessage[]>([]);
  const [receiptsBySeq, setReceiptsBySeq] = useState<
    Record<number, DeliveryReceipt[]>
  >({});
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [spaceTags, setSpaceTags] = useState<Record<string, SpaceTagConfig>>(
    () => readSpaceTags()
  );

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

  // Create Space overlay state
  const [createOpen, setCreateOpen] = useState(false);
  const [spaceName, setSpaceName] = useState('');
  const [spaceTagColorId, setSpaceTagColorId] = useState('');
  const [spaceTagCustomLabel, setSpaceTagCustomLabel] = useState('');
  const [selectedSpaceMemberConvIds, setSelectedSpaceMemberConvIds] = useState<
    Set<string>
  >(() => new Set());
  const [createError, setCreateError] = useState('');

  // Unified Create Member overlay state (role / session / custom)
  const [createMemberOpen, setCreateMemberOpen] = useState(false);
  const [createMemberSpaceId, setCreateMemberSpaceId] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
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
  const [newMemberTeamId, setNewMemberTeamId] = useState('');
  const [createMemberError, setCreateMemberError] = useState('');

  // Rename Member overlay state
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameSpaceId, setRenameSpaceId] = useState('');
  const [renameConversationId, setRenameConversationId] = useState('');
  const [renameNickname, setRenameNickname] = useState('');
  const [renameOperationId, setRenameOperationId] = useState(() =>
    crypto.randomUUID()
  );
  const [renameError, setRenameError] = useState('');

  // Drag-and-drop state
  const [draggingMember, setDraggingMember] = useState<{
    fromSpaceId: string;
    conversationId: string;
    nickname: string;
  } | null>(null);
  const [dropTargetSpaceId, setDropTargetSpaceId] = useState('');

  // Composer & preview state
  const [draft, setDraft] = useState('');
  const replaceDraftRef = useRef<((next: string) => void) | null>(null);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const messagesRef = useRef<SpaceMessage[]>([]);
  messagesRef.current = messages;
  const [selectedMemberKey, setSelectedMemberKey] = useState('');
  const [previewConversationId, setPreviewConversationId] = useState('');
  const [previewNotice, setPreviewNotice] = useState('');
  const [previewFile, setPreviewFile] = useState<PreviewPanelParams | null>(
    null
  );

  const phone = useMediaQuery('(max-width: 768px)');
  const [spacesPinned, setSpacesPinned] = useState<boolean | null>(null);
  const [previewPinned, setPreviewPinned] = useState<boolean | null>(null);
  const [threadOpen, setThreadOpen] = useState(true);

  const selected =
    spaces.find((space) => space.space_id === selectedId) ?? null;
  const hasActiveOverlay = createOpen || createMemberOpen || renameOpen;
  // Requirement 1: Always show left space list and middle message area by default (and whenever an overlay is open);
  // hide right preview area until a member or file preview is active.
  const hasThread = threadOpen || Boolean(selected) || hasActiveOverlay;
  const hasActivePreviewContent = Boolean(
    previewFile || previewConversationId || previewNotice
  );
  const showSpaces = spacesPinned ?? (!phone || !hasActiveOverlay);
  const showPreview = previewPinned ?? hasActivePreviewContent;

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
    const seen = new Map<string, { conversationId: string; nickname: string }>();
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

  const loadConversations = useCallback(async () => {
    if (!workspace) return;
    try {
      const page = await collaborationCall<{
        conversations?: ConversationOption[];
      }>('collaboration', 'space.listConversations', {
        workspaceId: workspace,
      });
      setConversations(page.conversations ?? []);
    } catch {
      // Ignore background metadata fetch errors if collaboration is disabled
    }
  }, [workspace]);

  const loadRolesTeamsAgents = useCallback(async () => {
    try {
      const [teamPage, rolePage, agentPage] = await Promise.all([
        collaborationCall<{ teams?: TeamOption[] }>('collaboration', 'team.list'),
        collaborationCall<{ roles?: RoleOption[] }>('collaboration', 'role.list'),
        collaborationCall<{ agents?: AgentOption[] }>(
          'collaboration',
          'role.agents'
        ),
      ]);
      const nextTeams = teamPage.teams ?? [];
      const nextRoles = rolePage.roles ?? [];
      const nextAgents = agentPage.agents ?? [];
      setTeams(nextTeams);
      setRoles(nextRoles);
      setAgents(nextAgents);
      setNewMemberRoleId((current) => current || nextRoles[0]?.id || '');
      setNewMemberAgentId((current) => current || nextAgents[0]?.agent_id || '');
    } catch {
      // Handled by form submit if capability is disabled
    }
  }, []);

  useEffect(() => {
    setExpanded({});
    setMembersBySpace({});
    setPreviewFile(null);
    setSelectedMemberKey('');
    setPreviewConversationId('');
    setPreviewNotice('');
    setIsDeleteMode(false);
    setSelectedDeleteSpaceIds(new Set());
    setSelectedDeleteMemberKeys(new Set());
  }, [workspace]);

  useEffect(() => {
    if (!workspace) {
      setSpaces([]);
      setSelectedId('');
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
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(surfaceErrorCopy(cause));
      });
    void loadConversations();
    void loadRolesTeamsAgents();
    return () => {
      cancelled = true;
    };
  }, [loadConversations, loadRolesTeamsAgents, workspace]);

  useEffect(() => {
    if (!workspace) return;
    const ids = openSpaceKey ? openSpaceKey.split('\n').filter(Boolean) : [];
    const allSpaceIds = spaces.map((space) => space.space_id);
    const memberIds = Array.from(
      new Set([
        ...ids,
        ...allSpaceIds,
        ...(selectedId ? [selectedId] : []),
        ...(unassignedId ? [unassignedId] : []),
      ])
    );
    if (memberIds.length === 0) return;
    let cancelled = false;
    const load = async () => {
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
      setMembersBySpace((current) => {
        const next = { ...current };
        for (const [spaceId, nextMembers] of memberPages) {
          next[spaceId] = nextMembers;
        }
        return next;
      });
      if (!selectedId) return;
      const messagePage = await collaborationCall<{
        messages?: SpaceMessage[];
      }>('collaboration', 'space.listMessages', {
        spaceId: selectedId,
        latest: true,
        limit: 200,
      });
      if (cancelled) return;
      setMessages(messagePage.messages ?? []);
    };
    void load().catch((cause: unknown) => {
      if (!cancelled) setError(surfaceErrorCopy(cause));
    });
    return () => {
      cancelled = true;
    };
  }, [openSpaceKey, selectedId, spaces, unassignedId, workspace]);

  useEffect(() => {
    if (!workspace) return;
    const ids = openSpaceKey ? openSpaceKey.split('\n').filter(Boolean) : [];
    const activeSpaceIds = new Set([
      ...ids,
      ...spaces.map((space) => space.space_id),
      ...(selectedId ? [selectedId] : []),
      ...(unassignedId ? [unassignedId] : []),
    ]);
    let cancelled = false;
    let unlisten: (() => void) | undefined;

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
      const page = await collaborationCall<{ messages?: SpaceMessage[] }>(
        'collaboration',
        'space.listMessages',
        sinceSeq > 0
          ? { spaceId, sinceSeq }
          : { spaceId, latest: true, limit: 200 }
      );
      if (cancelled) return;
      const incoming = page.messages ?? [];
      setMessages((current) =>
        sinceSeq > 0 ? mergeSpaceMessages(current, incoming) : incoming
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
      if (event.seq !== undefined && event.spaceId === selectedId) {
        void syncIncrementalMessages(selectedId).catch((cause: unknown) => {
          if (!cancelled) setError(surfaceErrorCopy(cause));
        });
      }
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
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
      if (selectedId) {
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
      window.removeEventListener('online', handleReconnect);
      window.removeEventListener('vibex:host-client-changed', handleReconnect);
    };
  }, [loadConversations, openSpaceKey, selectedId, spaces, unassignedId, workspace]);

  useEffect(() => {
    setMessages([]);
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
    if (createMemberOpen) {
      void loadRolesTeamsAgents();
    }
    return () => {
      cancelled = true;
    };
  }, [createMemberOpen, createOpen, loadRolesTeamsAgents, workspace]);

  const closeAllOverlays = useCallback(() => {
    setCreateOpen(false);
    setCreateError('');
    setCreateMemberOpen(false);
    setCreateMemberError('');
    setRenameOpen(false);
    setRenameError('');
  }, []);

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
    setThreadOpen(true);
    if (phone) {
      setSpacesPinned(false);
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
      writeSpaceTags(next);
      return next;
    });
  };

  const openFilePreview = (params: PreviewPanelParams) => {
    setPreviewFile(params);
    setPreviewNotice('');
    setPreviewPinned(true);
  };

  const closePreview = () => {
    setPreviewFile(null);
    setSelectedMemberKey('');
    setPreviewConversationId('');
    setPreviewNotice('');
    setPreviewPinned(false);
  };

  const openCreateSpaceDialog = () => {
    closeAllOverlays();
    ensureMessageAreaOpenForOverlay();
    setSpaceName('');
    setSpaceTagColorId('');
    setSpaceTagCustomLabel('');
    setSelectedSpaceMemberConvIds(new Set());
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
      spaceId ?? (selectedId || (spaces[0]?.space_id ?? unassignedId));
    if (spaceId && spaces.some((item) => item.space_id === spaceId)) {
      setSelectedId(spaceId);
    }
    setCreateMemberSpaceId(resolvedSpaceId);
    setNewMemberName('');
    setNewMemberSessionId('');
    setNewMemberPersonaPrompt('');
    setNewMemberTeamId('');
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

  const selectSpace = (spaceId: string) => {
    setSelectedId(spaceId);
    setThreadOpen(true);
    setExpanded((current) => ({ ...current, [spaceId]: true }));
    setPreviewFile(null);
  };

  const selectMemberForPreview = (spaceId: string, member: SpaceMember) => {
    if (spaces.some((item) => item.space_id === spaceId)) {
      setSelectedId(spaceId);
    }
    const conversationId = member.conversation_id ?? '';
    const memberKey = previewMemberKey(spaceId, member);
    setSelectedMemberKey(memberKey);
    setPreviewFile(null);
    if (conversationId) {
      setPreviewConversationId(conversationId);
      setPreviewNotice('');
    } else {
      setPreviewConversationId('');
      setPreviewNotice(t('collaborationSpace.noSession', COPY.noSession));
    }
    setPreviewPinned(true);
  };

  const toggleSpaceMemberConvSelection = (conversationId: string) => {
    setSelectedSpaceMemberConvIds((current) => {
      const next = new Set(current);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      return next;
    });
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
      const unassignedList = membersBySpace[unassignedId] ?? [];
      for (const convId of selectedSpaceMemberConvIds) {
        const existingNick = memberNicknameByConversationId.get(convId);
        const nick = existingNick || randomEnglishNickname(usedNames);
        usedNames.add(nick);
        const isUnassigned = unassignedList.some(
          (item) => item.conversation_id === convId
        );
        if (isUnassigned && unassignedId) {
          await collaborationCall('collaboration', 'space.moveMember', {
            fromSpaceId: unassignedId,
            toSpaceId: createdSpaceId,
            conversationId: convId,
            nickname: nick,
            operationId: crypto.randomUUID(),
          });
        } else {
          await collaborationCall('collaboration', 'space.addMember', {
            spaceId: createdSpaceId,
            conversationId: convId,
            nickname: nick,
            operationId: crypto.randomUUID(),
          });
        }
      }
    }

    setSpaceName('');
    setSpaceTagColorId('');
    setSpaceTagCustomLabel('');
    setSelectedSpaceMemberConvIds(new Set());
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
      const memberPage = await collaborationCall<{ members?: SpaceMember[] }>(
        'collaboration',
        'space.listMembers',
        { spaceId: createdSpaceId }
      );
      setMembersBySpace((current) => ({
        ...current,
        [createdSpaceId]: memberPage.members ?? [],
      }));
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
          : selectedId || unassignedId;
      if (!targetSpaceId || !newMemberSessionId) return;
      await collaborationCall('collaboration', 'space.addMember', {
        spaceId: targetSpaceId,
        conversationId: newMemberSessionId,
        nickname: trimmedNickname,
        ...(newMemberTeamId ? { teamId: newMemberTeamId } : {}),
        operationId: crypto.randomUUID(),
      });
      setNewMemberName('');
      setNewMemberSessionId('');
      setNewMemberTeamId('');
      setCreateMemberError('');
      setCreateMemberOpen(false);
      await loadConversations();
      const memberPage = await collaborationCall<{ members?: SpaceMember[] }>(
        'collaboration',
        'space.listMembers',
        { spaceId: targetSpaceId }
      );
      setMembersBySpace((current) => ({
        ...current,
        [targetSpaceId]: memberPage.members ?? [],
      }));
      setExpanded((current) => ({ ...current, [targetSpaceId]: true }));
      return;
    }

    if (newMemberSource === 'role' && !newMemberRoleId) return;
    if (newMemberSource === 'custom' && !newMemberAgentId) return;

    const targetSpaceId =
      createMemberSpaceId &&
      spaces.some((space) => space.space_id === createMemberSpaceId)
        ? createMemberSpaceId
        : '';

    const created = await collaborationCall<{
      space_id?: string;
      member_id?: string;
      conversation_id?: string;
      nickname?: string;
    }>('collaboration', 'space.createMember', {
      workspaceId: workspace,
      spaceId: targetSpaceId,
      nickname: trimmedNickname,
      source: newMemberSource,
      ...(newMemberSource === 'role'
        ? { roleId: newMemberRoleId }
        : {
            agentId: newMemberAgentId,
            modeId: newMemberModeId,
            configValues: newMemberConfigValues,
            personaPrompt: newMemberPersonaPrompt,
          }),
      teamId: newMemberTeamId,
      operationId: crypto.randomUUID(),
    });

    const effectiveSpaceId = created?.space_id || targetSpaceId || unassignedId;
    setNewMemberName('');
    setNewMemberPersonaPrompt('');
    setCreateMemberError('');
    setCreateMemberOpen(false);

    await loadConversations();
    if (effectiveSpaceId) {
      const memberPage = await collaborationCall<{ members?: SpaceMember[] }>(
        'collaboration',
        'space.listMembers',
        { spaceId: effectiveSpaceId }
      );
      setMembersBySpace((current) => ({
        ...current,
        [effectiveSpaceId]: memberPage.members ?? [],
      }));
      setExpanded((current) => ({ ...current, [effectiveSpaceId]: true }));
    }
    if (created?.conversation_id) {
      setPreviewConversationId(created.conversation_id);
      setPreviewNotice('');
      setPreviewFile(null);
      setPreviewPinned(true);
    }
  };

  const moveMemberBetweenSpaces = async (
    fromSpaceId: string,
    toSpaceId: string,
    conversationId: string,
    fallbackNickname?: string
  ) => {
    if (!fromSpaceId || !toSpaceId || !conversationId) return;
    if (fromSpaceId === toSpaceId) return;

    setMembersBySpace((current) => {
      const sourceList = current[fromSpaceId] ?? [];
      const targetList = current[toSpaceId] ?? [];
      const moving = sourceList.find(
        (item) => item.conversation_id === conversationId
      );
      if (!moving) return current;
      return {
        ...current,
        [fromSpaceId]: sourceList.filter(
          (item) => item.conversation_id !== conversationId
        ),
        [toSpaceId]: targetList.some(
          (item) => item.conversation_id === conversationId
        )
          ? targetList
          : [...targetList, moving],
      };
    });
    setExpanded((current) => ({ ...current, [toSpaceId]: true }));

    try {
      await collaborationCall('collaboration', 'space.moveMember', {
        fromSpaceId,
        toSpaceId,
        conversationId,
        ...(fallbackNickname ? { nickname: fallbackNickname } : {}),
        operationId: crypto.randomUUID(),
      });
      const [fromPage, toPage] = await Promise.all([
        collaborationCall<{ members?: SpaceMember[] }>(
          'collaboration',
          'space.listMembers',
          { spaceId: fromSpaceId }
        ),
        collaborationCall<{ members?: SpaceMember[] }>(
          'collaboration',
          'space.listMembers',
          { spaceId: toSpaceId }
        ),
      ]);
      setMembersBySpace((current) => ({
        ...current,
        [fromSpaceId]: fromPage.members ?? [],
        [toSpaceId]: toPage.members ?? [],
      }));
    } catch (cause) {
      setError(surfaceErrorCopy(cause));
    }
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
    setRenameNickname('');
    setRenameError('');
    setRenameOpen(false);
    setRenameOperationId(crypto.randomUUID());
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

  const send = async (rawText: string) => {
    const content = rawText.trim();
    if (!selected || !content || sending) return;
    if (strayMentions(content, members).length > 0) {
      restoreDraft(rawText);
      setError(COPY.nicknameMissing);
      return;
    }
    setSending(true);
    try {
      const posted = await collaborationCall<{
        seq?: number;
        receipts?: DeliveryReceipt[];
      }>('collaboration', 'space.post', {
        spaceId: selected.space_id,
        content,
        to: postRecipients(content, members),
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
      setError('');
      setOperationId(crypto.randomUUID());
      const sinceSeq = latestMessageSeq(messagesRef.current);
      const messagePage = await collaborationCall<{
        messages?: SpaceMessage[];
      }>(
        'collaboration',
        'space.listMessages',
        sinceSeq > 0
          ? { spaceId: selected.space_id, sinceSeq }
          : { spaceId: selected.space_id, latest: true, limit: 200 }
      );
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

  const focus = async (conversationId: string) => {
    if (!conversationId) return;
    const windowLabel = await currentWindowLabel();
    if (!windowLabel) {
      setError(COPY.controlsUnavailable);
      return;
    }
    await collaborationCall('workspace', 'focusConversation', {
      conversationId,
      windowLabel,
    });
  };

  const sessionPreviewProps = useMemo(
    () =>
      workspace && previewConversationId && !previewFile
        ? {
            workspaceId: workspace,
            sessionId: previewConversationId,
            interactive: true,
            showSessionSelector: false,
            markViewed: false,
            embedded: true,
            className: 'h-full',
            imagePreviewPresentation: 'dialog' as const,
            conversationWidthMode: 'workspace' as const,
          }
        : null,
    [previewConversationId, previewFile, workspace]
  );

  const receiptLabels = useMemo(
    () => ({
      queued: t('collaborationSpace.receiptQueued', COPY.receiptQueued),
      claimed: t('collaborationSpace.receiptClaimed', COPY.receiptClaimed),
      failed: t('collaborationSpace.receiptFailed', COPY.receiptFailed),
    }),
    [t]
  );

  const countActiveMembers = useCallback(
    (spaceMembers: SpaceMember[]): number => {
      let activeCount = 0;
      for (const member of agentRoster(spaceMembers)) {
        const convId = member.conversation_id;
        if (!convId) continue;
        const conv = conversationById.get(convId);
        if (conv?.turn_in_flight || conv?.status === 'inprogress') {
          activeCount += 1;
        }
      }
      return activeCount;
    },
    [conversationById]
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
    return (membersBySpace[unassignedId] ?? EMPTY_MEMBERS).filter((member) => {
      if (!member || member.kind === 'user') return false;
      const key =
        member.conversation_id || member.member_id || member.nickname;
      return !key || !assignedKeys.has(String(key));
    });
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
        const anyMemberMatches = spaceMembers.some((member) =>
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
          return (
            String(conv?.agent_id ?? '').toLowerCase() === targetAgent
          );
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

  const renderMemberRow = (spaceId: string, member: SpaceMember) => {
    const conversationId = member.conversation_id ?? '';
    const memberKey = previewMemberKey(spaceId, member);
    const active =
      !previewFile &&
      (selectedMemberKey === memberKey ||
        (conversationId !== '' && conversationId === previewConversationId));
    const name = displayName(member);
    const conv = conversationId
      ? conversationById.get(conversationId)
      : undefined;
    const isRunning = Boolean(conv?.turn_in_flight);
    const tone = workspaceSessionStatusTone({
      status: conv?.status ?? 'todo',
      isRunning,
    });
    const compactAge = conv?.updated_at
      ? formatCompactSessionAge(conv.updated_at)
      : '';
    const sessionTitle =
      conv?.title && conv.title !== name ? conv.title : '';
    const canDrag =
      !isDeleteMode && member.kind === 'agent' && Boolean(conversationId);
    const isMemberCheckedForDelete =
      Boolean(conversationId) &&
      selectedDeleteMemberKeys.has(deleteMemberKey(spaceId, conversationId));

    return (
      <div
        key={member.member_id ?? member.nickname ?? conversationId}
        className={cn(
          'workspace-session-row',
          active && 'is-selected',
          draggingMember?.conversationId === conversationId &&
            draggingMember?.fromSpaceId === spaceId &&
            'is-dragging'
        )}
        draggable={canDrag}
        onDragStart={(event) => {
          if (!canDrag) return;
          const payload = {
            fromSpaceId: spaceId,
            conversationId,
            nickname: String(member.nickname ?? name),
          };
          setDraggingMember(payload);
          event.dataTransfer?.setData(
            'application/x-vibex-space-member',
            JSON.stringify(payload)
          );
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
          }
        }}
        onDragEnd={() => {
          setDraggingMember(null);
          setDropTargetSpaceId('');
        }}
      >
        <span
          className="workspace-session-row-marker bg-muted-foreground/35"
          aria-hidden="true"
        />
        {isDeleteMode && member.kind === 'agent' && conversationId ? (
          <Checkbox
            aria-label={`选择成员 ${name}`}
            checked={isMemberCheckedForDelete}
            onCheckedChange={() =>
              handleToggleMemberDelete(spaceId, conversationId)
            }
          />
        ) : null}
        <button
          type="button"
          className="workspace-session-row-main"
          aria-label={name}
          onClick={() => {
            if (isDeleteMode && member.kind === 'agent' && conversationId) {
              handleToggleMemberDelete(spaceId, conversationId);
              return;
            }
            selectMemberForPreview(spaceId, member);
          }}
        >
          {member.kind === 'agent' ? (
            <span className="workspace-session-icon" aria-hidden="true">
              {conv?.agent_id ? (
                <AgentIcon
                  agent={conv.agent_id as ExecutorProfileId['executor']}
                  className="h-4 w-4"
                />
              ) : (
                <Bot className="h-4 w-4 text-muted-foreground" />
              )}
              <span
                className={cn(
                  'workspace-session-status',
                  `workspace-session-status--${tone}`
                )}
              />
            </span>
          ) : (
            <span className="collaboration-avatar" aria-hidden="true">
              {name.slice(0, 1)}
            </span>
          )}
          <span className="collaboration-member-title-group">
            <span className="workspace-session-title is-cjk">{name}</span>
            {sessionTitle ? (
              <span className="collaboration-member-subtitle">
                {sessionTitle}
              </span>
            ) : null}
          </span>
          {conv?.team_name ? (
            <span className="collaboration-team-pill">{conv.team_name}</span>
          ) : null}
          <span className="workspace-session-meta-idle">
            {isRunning ? (
              <Loader2
                className="h-3.5 w-3.5 animate-spin text-[hsl(var(--warning))]"
                aria-hidden="true"
              />
            ) : compactAge ? (
              <span className="workspace-session-age">{compactAge}</span>
            ) : null}
          </span>
        </button>
        {!isDeleteMode && member.kind === 'agent' && conversationId ? (
          <Button
            type="button"
            variant="icon"
            size="icon"
            className="collaboration-expand"
            aria-label={t('collaborationSpace.renameMemberAria', {
              name,
              defaultValue: `${COPY.renameMember} ${name}`,
            })}
            onClick={() => {
              closeAllOverlays();
              ensureMessageAreaOpenForOverlay();
              setRenameSpaceId(spaceId);
              setRenameConversationId(conversationId);
              setRenameNickname(String(member.nickname ?? ''));
              setRenameOperationId(crypto.randomUUID());
              setRenameError('');
              setRenameOpen(true);
            }}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    );
  };

  const renderSpaceGroup = (
    space: Space,
    options: { isUnassigned?: boolean; isVirtualDefault?: boolean } = {}
  ) => {
    const { isUnassigned = false, isVirtualDefault = false } = options;
    const open =
      space.space_id in expanded
        ? expanded[space.space_id]
        : isVirtualDefault || isUnassigned || space.space_id === selectedId;
    const rawSpaceMembers = isUnassigned
      ? unassignedMembers
      : (membersBySpace[space.space_id] ?? EMPTY_MEMBERS);
    const queryLower = searchQuery.trim().toLowerCase();
    const spaceNameMatches =
      !queryLower || space.name.toLowerCase().includes(queryLower);
    const spaceMembers =
      queryLower && !spaceNameMatches
        ? rawSpaceMembers.filter((member) =>
            doesMemberMatchQuery(member, queryLower)
          )
        : rawSpaceMembers;
    const visibleAgentCount = agentRoster(rawSpaceMembers).length;
    const activeCount = countActiveMembers(rawSpaceMembers);
    const tagConfig = spaceTags[space.space_id];
    const tagPreset = tagConfig
      ? SPACE_TAG_PRESETS.find((preset) => preset.id === tagConfig.colorId)
      : undefined;
    const isDropTarget = dropTargetSpaceId === space.space_id;
    const isSpaceCheckedForDelete =
      !isUnassigned &&
      !isVirtualDefault &&
      selectedDeleteSpaceIds.has(space.space_id);

    return (
      <div
        key={space.space_id}
        data-testid={`collaboration-space-group-${space.space_id}`}
        className={cn(
          'collaboration-space',
          isDropTarget && 'is-drop-target'
        )}
        onDragOver={(event) => {
          if (isVirtualDefault) return;
          event.preventDefault();
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
          if (isVirtualDefault) return;
          event.preventDefault();
          setDropTargetSpaceId('');
          let payload = draggingMember;
          const raw = event.dataTransfer?.getData(
            'application/x-vibex-space-member'
          );
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
          if (payload && payload.fromSpaceId !== space.space_id) {
            void moveMemberBetweenSpaces(
              payload.fromSpaceId,
              space.space_id,
              payload.conversationId,
              payload.nickname
            );
          }
        }}
      >
        <div
          className={cn(
            'workspace-session-row',
            !isUnassigned &&
              !isVirtualDefault &&
              space.space_id === selectedId &&
              'is-selected'
          )}
        >
          {isDeleteMode && !isUnassigned && !isVirtualDefault ? (
            <Checkbox
              aria-label={`选择空间 ${space.name}`}
              checked={isSpaceCheckedForDelete}
              onCheckedChange={() =>
                handleToggleSpaceDelete(space.space_id, rawSpaceMembers)
              }
            />
          ) : null}
          <Button
            type="button"
            variant="icon"
            size="icon"
            className="collaboration-expand"
            aria-expanded={open}
            aria-label={
              open
                ? t('collaborationSpace.collapseSpace', {
                    name: space.name,
                    defaultValue: `收起 ${space.name}`,
                  })
                : t('collaborationSpace.expandSpace', {
                    name: space.name,
                    defaultValue: `展开 ${space.name}`,
                  })
            }
            onClick={() =>
              setExpanded((current) => ({
                ...current,
                [space.space_id]: !open,
              }))
            }
          >
            {open ? (
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
          <button
            type="button"
            className="workspace-session-row-main collaboration-space-header-main"
            aria-label={space.name}
            onClick={() => {
              if (!isUnassigned && !isVirtualDefault) {
                selectSpace(space.space_id);
              } else {
                setExpanded((current) => ({
                  ...current,
                  [space.space_id]: !open,
                }));
              }
            }}
          >
            <Folder
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="workspace-session-title is-cjk">{space.name}</span>
            {tagPreset ? (
              <span
                className="collaboration-space-tag"
                style={{
                  borderColor: `hsl(${tagPreset.hue} / 0.45)`,
                  backgroundColor: `hsl(${tagPreset.hue} / 0.14)`,
                  color: `hsl(${tagPreset.hue})`,
                }}
              >
                <span
                  className="collaboration-space-tag-dot"
                  style={{ backgroundColor: `hsl(${tagPreset.hue})` }}
                />
                {tagConfig?.label || tagPreset.label}
              </span>
            ) : null}
            <span className="collaboration-space-meta">
              <span className="workspace-session-group-count">
                {visibleAgentCount}
              </span>
              <span className="collaboration-space-active">
                {activeCount}个成员在活跃
              </span>
            </span>
          </button>
          {!isDeleteMode && !isUnassigned && !isVirtualDefault ? (
            <>
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
                        const selectedTag = tagConfig?.colorId === preset.id;
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
                              style={{ backgroundColor: `hsl(${preset.hue})` }}
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
                className="collaboration-expand"
                aria-label={t('collaborationSpace.addMemberToSpace', {
                  name: space.name,
                  defaultValue: `${COPY.addMember} ${space.name}`,
                })}
                onClick={() => openCreateMemberDialog(space.space_id, 'session')}
              >
                <UserPlus className="h-4 w-4" aria-hidden="true" />
              </Button>
            </>
          ) : null}
        </div>
        {open ? (
          <div className="collaboration-member-list">
            {spaceMembers.length === 0 ? (
              <div className="collaboration-member-empty">
                <span>
                  {t('collaborationSpace.emptyMembers', '还没有成员')}
                </span>
                {!isVirtualDefault ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      openCreateMemberDialog(space.space_id, 'session')
                    }
                  >
                    {t('collaborationSpace.addMember', COPY.addMember)}
                  </Button>
                ) : null}
              </div>
            ) : (
              spaceMembers.map((member) =>
                renderMemberRow(space.space_id, member)
              )
            )}
          </div>
        ) : null}
      </div>
    );
  };

  const renderMessageAreaOverlay = () => {
    if (!hasActiveOverlay) return null;

    const overlayTitle = createOpen
      ? t('collaborationSpace.newSpace', COPY.newSpace)
      : createMemberOpen
        ? COPY.newMemberButton
        : t('collaborationSpace.renameMember', COPY.renameMember);

    return (
      <div
        className="collaboration-thread-overlay absolute inset-0 z-10 flex items-center justify-center bg-background/70 p-6 backdrop-blur-md"
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
          className="dialog-surface relative flex max-h-full w-full max-w-[400px] flex-col overflow-y-auto rounded-xl border border-border/70 bg-background/95 p-4 shadow-xl"
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              {overlayTitle}
            </h3>
            <button
              type="button"
              onClick={closeAllOverlays}
              aria-label="Close"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>

          {createOpen ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void createSpace().catch((cause: unknown) =>
                  setCreateError(surfaceErrorCopy(cause))
                );
              }}
            >
              <div className="space-y-1.5">
                <Label>{t('collaborationSpace.spaceName', '空间名称')}</Label>
                <TextInput
                  label={t('collaborationSpace.spaceName', '空间名称')}
                  isLabelHidden
                  value={spaceName}
                  onChange={setSpaceName}
                  placeholder={t('collaborationSpace.spaceName', '空间名称')}
                  width="100%"
                  hasAutoFocus
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
                  <TextInput
                    label="标签文字（可选）"
                    isLabelHidden
                    value={spaceTagCustomLabel}
                    onChange={setSpaceTagCustomLabel}
                    placeholder="自定义标签名（可选）"
                    width="100%"
                  />
                ) : null}
              </div>

              <div className="space-y-1.5">
                <Label>{COPY.spaceMembersLabel}</Label>
                <div className="collaboration-dialog-member-picker">
                  {sortedConversationsForPicker.sorted.length === 0 ? (
                    <p className="collaboration-picker-empty">
                      {COPY.noMemberSessions}
                    </p>
                  ) : (
                    <>
                      {sortedConversationsForPicker.memberConversations.length >
                      0 ? (
                        <div className="collaboration-picker-section">
                          <p className="collaboration-picker-heading">
                            {COPY.memberSessionsGroup}
                          </p>
                          {sortedConversationsForPicker.memberConversations.map(
                            (conv) => {
                              const checked = selectedSpaceMemberConvIds.has(
                                conv.conversation_id
                              );
                              const existingNick =
                                memberNicknameByConversationId.get(
                                  conv.conversation_id
                                );
                              return (
                                <label
                                  key={conv.conversation_id}
                                  className="collaboration-picker-row"
                                >
                                  <Checkbox
                                    checked={checked}
                                    onCheckedChange={() =>
                                      toggleSpaceMemberConvSelection(
                                        conv.conversation_id
                                      )
                                    }
                                  />
                                  <span className="collaboration-picker-name">
                                    {existingNick ? `[${existingNick}] ` : ''}
                                    {conv.title ||
                                      conv.agent_id ||
                                      conv.conversation_id}
                                  </span>
                                </label>
                              );
                            }
                          )}
                        </div>
                      ) : null}
                      {sortedConversationsForPicker.nonMemberConversations
                        .length > 0 ? (
                        <div className="collaboration-picker-section">
                          <p className="collaboration-picker-heading">
                            {COPY.otherSessionsGroup}
                          </p>
                          {sortedConversationsForPicker.nonMemberConversations.map(
                            (conv) => {
                              const checked = selectedSpaceMemberConvIds.has(
                                conv.conversation_id
                              );
                              return (
                                <label
                                  key={conv.conversation_id}
                                  className="collaboration-picker-row"
                                >
                                  <Checkbox
                                    checked={checked}
                                    onCheckedChange={() =>
                                      toggleSpaceMemberConvSelection(
                                        conv.conversation_id
                                      )
                                    }
                                  />
                                  <span className="collaboration-picker-name">
                                    {conv.title ||
                                      conv.agent_id ||
                                      conv.conversation_id}
                                  </span>
                                </label>
                              );
                            }
                          )}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>

              {createError ? (
                <p className="collaboration-error">{createError}</p>
              ) : null}
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  type="submit"
                  data-dialog-primary="true"
                  disabled={!spaceName.trim()}
                >
                  {t('collaborationSpace.newSpace', COPY.newSpace)}
                </Button>
              </div>
            </form>
          ) : null}

          {createMemberOpen ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void createNewMember().catch((cause: unknown) =>
                  setCreateMemberError(surfaceErrorCopy(cause))
                );
              }}
            >
              <div className="space-y-1.5">
                <Label>{COPY.memberNameLabel}</Label>
                <TextInput
                  label={COPY.memberNameLabel}
                  isLabelHidden
                  value={newMemberName}
                  onChange={setNewMemberName}
                  placeholder={COPY.memberNameLabel}
                  width="100%"
                  hasAutoFocus
                />
              </div>

              <div className="space-y-1.5">
                <Label>{COPY.memberSourceLabel}</Label>
                <select
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-[var(--text-strong)]"
                  aria-label={COPY.memberSourceLabel}
                  value={newMemberSource}
                  onChange={(event) =>
                    setNewMemberSource(
                      event.target.value as MemberSourceOption
                    )
                  }
                >
                  <option value="role">{COPY.memberSourceRole}</option>
                  <option value="session">{COPY.memberSourceSession}</option>
                  <option value="custom">{COPY.memberSourceCustom}</option>
                </select>
              </div>

              {newMemberSource === 'role' ? (
                <div className="space-y-1.5">
                  <Label>{COPY.chooseRole}</Label>
                  <select
                    className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-[var(--text-strong)]"
                    aria-label={COPY.chooseRole}
                    value={newMemberRoleId}
                    onChange={(event) => setNewMemberRoleId(event.target.value)}
                  >
                    <option value="">{COPY.chooseRole}</option>
                    {roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name} ({role.agent_id})
                      </option>
                    ))}
                  </select>
                </div>
              ) : newMemberSource === 'session' ? (
                <div className="space-y-1.5">
                  <Label>
                    {t(
                      'collaborationSpace.chooseConversation',
                      COPY.chooseConversation
                    )}
                  </Label>
                  <select
                    className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-[var(--text-strong)]"
                    aria-label={t(
                      'collaborationSpace.chooseConversation',
                      COPY.chooseConversation
                    )}
                    value={newMemberSessionId}
                    onChange={(event) =>
                      setNewMemberSessionId(event.target.value)
                    }
                  >
                    <option value="">
                      {t(
                        'collaborationSpace.chooseConversation',
                        COPY.chooseConversation
                      )}
                    </option>
                    {conversations.map((conversation) => (
                      <option
                        key={conversation.conversation_id}
                        value={conversation.conversation_id}
                      >
                        {conversation.title ||
                          conversation.agent_id ||
                          conversation.conversation_id}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>{COPY.chooseAgent}</Label>
                    <select
                      className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-[var(--text-strong)]"
                      aria-label={COPY.chooseAgent}
                      value={newMemberAgentId}
                      onChange={(event) => {
                        setNewMemberAgentId(event.target.value);
                        setNewMemberModeId('');
                        setNewMemberConfigValues({});
                      }}
                    >
                      <option value="">{COPY.chooseAgent}</option>
                      {agents.map((agent) => (
                        <option key={agent.agent_id} value={agent.agent_id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
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
                    />
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label>{COPY.teamLabel}</Label>
                <select
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-[var(--text-strong)]"
                  aria-label={COPY.teamLabel}
                  value={newMemberTeamId}
                  onChange={(event) => setNewMemberTeamId(event.target.value)}
                >
                  <option value="">{COPY.noTeam}</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </div>

              {createMemberError ? (
                <p className="collaboration-error">{createMemberError}</p>
              ) : null}
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  type="submit"
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

          {renameOpen ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                void renameMember().catch((cause: unknown) =>
                  setRenameError(surfaceErrorCopy(cause))
                );
              }}
            >
              <TextInput
                label={t('collaborationSpace.nickname', '昵称')}
                isLabelHidden
                value={renameNickname}
                onChange={(value) => {
                  setRenameNickname(value);
                  setRenameOperationId(crypto.randomUUID());
                }}
                placeholder={t('collaborationSpace.nickname', '昵称')}
                width="100%"
                hasAutoFocus
              />
              {renameError ? (
                <p className="collaboration-error">{renameError}</p>
              ) : null}
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  type="submit"
                  data-dialog-primary="true"
                  disabled={!renameNickname.trim()}
                >
                  {t('collaborationSpace.renameMember', COPY.renameMember)}
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
    <CollaborationPreviewScope onOpenFile={openFilePreview}>
      <div
        className="collaboration-shell session-hub-shell"
        data-spaces={showSpaces ? 'true' : 'false'}
        data-thread={hasThread ? 'true' : 'false'}
        data-preview={showPreview ? 'true' : 'false'}
      >
        {showSpaces ? (
          <aside
            className="collaboration-pane"
            aria-label={t('collaborationSpace.title', '协作空间')}
          >
            <div className="collaboration-pane-body session-hub-list-body collaboration-pane-list-container">
              <div className="workspace-session-list-toolbar">
                {isDeleteMode ? (
                  <SessionListDeleteControl
                    selectedCount={selectedDeleteCount}
                    isDeleting={isDeletingBatch}
                    selectLabel="选择协作空间或成员"
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
                    <SessionListSearchControl
                      searchQuery={searchQuery}
                      isExpanded={searchOpen}
                      searchLabel="搜索协作空间或成员"
                      placeholder={COPY.searchPlaceholder}
                      onSearchQueryChange={setSearchQuery}
                      onExpandedChange={setSearchOpen}
                    />
                    <div className="workspace-session-list-toolbar-actions">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className={SESSION_LIST_ACTION_BUTTON_CLASS}
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
                            variant="ghost"
                            size="xs"
                            className={cn(
                              SESSION_LIST_ACTION_BUTTON_CLASS,
                              hasActiveFilter && 'bg-secondary text-foreground'
                            )}
                            aria-label={COPY.filterLabel}
                          >
                            <Filter className={SESSION_LIST_ACTION_ICON_CLASS} />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-60 p-3">
                          <div className="flex flex-col gap-2.5">
                            <div className="space-y-1">
                              <Label className="text-xs">
                                {COPY.filterByAgent}
                              </Label>
                              <select
                                className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-[var(--text-strong)]"
                                aria-label={COPY.filterByAgent}
                                value={filterAgentId}
                                onChange={(event) =>
                                  setFilterAgentId(event.target.value)
                                }
                              >
                                <option value="">{COPY.filterAllAgents}</option>
                                {availableFilterAgents.map((agent) => (
                                  <option
                                    key={agent.agent_id}
                                    value={agent.agent_id}
                                  >
                                    {agent.name}
                                  </option>
                                ))}
                              </select>
                            </div>

                            <div className="space-y-1">
                              <Label className="text-xs">
                                {COPY.filterByActiveTime}
                              </Label>
                              <select
                                className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-[var(--text-strong)]"
                                aria-label={COPY.filterByActiveTime}
                                value={filterActiveWindow}
                                onChange={(event) =>
                                  setFilterActiveWindow(
                                    event.target.value as ActiveTimeFilterWindow
                                  )
                                }
                              >
                                <option value="all">
                                  {COPY.filterAllTimes}
                                </option>
                                <option value="active">
                                  {COPY.filterTimeActiveNow}
                                </option>
                                <option value="24h">{COPY.filterTime24h}</option>
                                <option value="7d">{COPY.filterTime7d}</option>
                              </select>
                            </div>

                            <div className="space-y-1">
                              <Label className="text-xs">
                                {COPY.filterByMember}
                              </Label>
                              <select
                                className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-[var(--text-strong)]"
                                aria-label={COPY.filterByMember}
                                value={filterMemberConvId}
                                onChange={(event) =>
                                  setFilterMemberConvId(event.target.value)
                                }
                              >
                                <option value="">
                                  {COPY.filterAllMembers}
                                </option>
                                {allUniqueMembers.map((member) => (
                                  <option
                                    key={member.conversationId}
                                    value={member.conversationId}
                                  >
                                    {member.nickname}
                                  </option>
                                ))}
                              </select>
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

                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className={cn(
                          SESSION_LIST_ACTION_BUTTON_CLASS,
                          isDeleteMode && 'bg-secondary text-foreground'
                        )}
                        aria-label={COPY.batchDeleteLabel}
                        aria-pressed={isDeleteMode}
                        onClick={handleToggleDeleteMode}
                      >
                        <Trash2 className={SESSION_LIST_ACTION_ICON_CLASS} />
                      </Button>
                    </div>
                  </>
                )}
              </div>

              <div className="workspace-session-list collaboration-space-list">
                {spaces.length === 0
                  ? renderSpaceGroup(
                      {
                        space_id: VIRTUAL_DEFAULT_SPACE_ID,
                        name: COPY.defaultSpaceName,
                      },
                      { isVirtualDefault: true }
                    )
                  : visibleSpaces.map((space) => renderSpaceGroup(space))}

                {(spaces.length > 0 || unassignedMembers.length > 0) &&
                unassignedId
                  ? renderSpaceGroup(
                      {
                        space_id: unassignedId,
                        name: COPY.unassignedSpaceName,
                      },
                      { isUnassigned: true }
                    )
                  : null}
              </div>

              {spaces.length === 0 ? (
                <div className="collaboration-empty-actions">
                  <Button type="button" onClick={openCreateSpaceDialog}>
                    {COPY.newSpaceButton}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => openCreateMemberDialog()}
                  >
                    {COPY.newMemberButton}
                  </Button>
                </div>
              ) : null}
            </div>
          </aside>
        ) : null}

        {hasThread ? (
          <section
            className="collaboration-thread"
            aria-label={selected?.name || COPY.defaultSpaceName}
          >
            <div className="collaboration-thread-log">
              {messages.length === 0 ? (
                <div className="collaboration-empty-stage">
                  <div className="collaboration-empty-card settings-surface">
                    <p className="collaboration-empty-title">
                      {t('collaborationSpace.emptyMessages', COPY.emptyMessages)}
                    </p>
                  </div>
                </div>
              ) : (
                messages.map((message) => {
                  const fromYou = String(message.envelope.actor ?? '').endsWith(
                    '/user'
                  );
                  const name =
                    messageAuthor(message.envelope) ||
                    t('collaborationSpace.memberFallback', '成员');
                  const authorConversationId = resolveMessageConversationId(
                    message.envelope,
                    members
                  );
                  const authorConv = authorConversationId
                    ? conversationById.get(authorConversationId)
                    : undefined;
                  const messageReceipts =
                    receiptsBySeq[message.seq] ?? EMPTY_RECEIPTS;
                  return (
                    <article
                      key={message.seq}
                      className="collaboration-message"
                    >
                      <div className="collaboration-message-header">
                        <button
                          type="button"
                          className="collaboration-avatar collaboration-message-avatar"
                          aria-label={`预览 ${name} 会话`}
                          onClick={() => {
                            setPreviewFile(null);
                            if (authorConversationId) {
                              setPreviewConversationId(authorConversationId);
                              setPreviewNotice('');
                            } else {
                              setPreviewConversationId('');
                              setPreviewNotice(
                                t(
                                  'collaborationSpace.noSession',
                                  COPY.noSession
                                )
                              );
                            }
                            setPreviewPinned(true);
                          }}
                        >
                          {!fromYou && authorConv?.agent_id ? (
                            <AgentIcon
                              agent={
                                authorConv.agent_id as ExecutorProfileId['executor']
                              }
                              className="h-3.5 w-3.5"
                            />
                          ) : (
                            name.slice(0, 1)
                          )}
                        </button>
                        <p className="collaboration-message-name">{name}</p>
                      </div>
                      <SpaceMessageBody
                        fromYou={fromYou}
                        text={bubbleText(message.envelope)}
                        workspacePath={workspacePath}
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
                                {receipt.nickname
                                  ? `${receipt.nickname} · ${status}`
                                  : status}
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </article>
                  );
                })
              )}
            </div>
            {error ? <p className="collaboration-error">{error}</p> : null}
            <div className="collaboration-composer-wrap">
              <SessionComposerFrame>
                <SessionComposerInput
                  value={draft}
                  disabled={!selected || sending}
                  replaceValueRef={replaceDraftRef}
                  context={{
                    workspaceId: workspace || undefined,
                    workspacePath,
                    spaceMembers: spaceMemberRefs,
                  }}
                  onChange={setDraft}
                  onSubmit={(value) => {
                    void send(value);
                  }}
                  onAttachImages={() =>
                    setError(
                      t(
                        'collaborationSpace.attachmentsUnsupported',
                        COPY.attachmentsUnsupported
                      )
                    )
                  }
                />
                <div className="flex items-center gap-1 pt-1">
                  <div className="flex-1" />
                  <ComposerPrimaryActionButton
                    action="send"
                    label={t('collaborationSpace.send', '发送')}
                    pending={sending}
                    disabled={!selected || !draft.trim() || sending}
                    onClick={() => {
                      void send(draft);
                    }}
                  />
                </div>
              </SessionComposerFrame>
            </div>
            {renderMessageAreaOverlay()}
          </section>
        ) : null}

        {showPreview ? (
          <aside
            className="collaboration-pane collaboration-preview"
            aria-label={t('collaborationSpace.previewTitle', '预览')}
          >
            <div className="collaboration-preview-actions">
              {previewFile && previewConversationId ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => setPreviewFile(null)}
                >
                  {t('collaborationSpace.backToSession', COPY.backToSession)}
                </Button>
              ) : null}
              {previewConversationId && !previewFile ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    void focus(previewConversationId).catch((cause: unknown) =>
                      setError(surfaceErrorCopy(cause))
                    )
                  }
                >
                  {t('collaborationSpace.openWorkspace', COPY.openWorkspace)}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={closePreview}
              >
                {t('collaborationSpace.closePane', '关闭')}
              </Button>
            </div>
            <div className="collaboration-preview-body">
              <div className="collaboration-preview-frame">
                {previewFile ? (
                  <Suspense
                    fallback={
                      <p className="collaboration-preview-empty">
                        {t('collaborationSpace.loading', '加载中')}
                      </p>
                    }
                  >
                    <FilePreviewPanel
                      {...({
                        params: previewFile,
                      } as IDockviewPanelProps)}
                    />
                  </Suspense>
                ) : sessionPreviewProps ? (
                  <Suspense
                    fallback={
                      <p className="collaboration-preview-empty">
                        {t('collaborationSpace.loading', '加载中')}
                      </p>
                    }
                  >
                    <SessionPreview {...sessionPreviewProps} />
                  </Suspense>
                ) : (
                  <div className="collaboration-empty-stage">
                    <div className="collaboration-empty-card settings-surface">
                      <p className="collaboration-empty-title">
                        {previewNotice ||
                          t(
                            'collaborationSpace.noMemberSessions',
                            COPY.noMemberSessions
                          )}
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </aside>
        ) : null}
      </div>
    </CollaborationPreviewScope>
  );
}
