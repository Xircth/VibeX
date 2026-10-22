import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import {
  AtSign,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Columns2,
  FileDiff,
  FileText,
  Filter,
  GitCompare,
  Globe,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Paperclip,
  Pencil,
  Plus,
  Rows2,
  SquareTerminal,
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
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@astryxdesign/core/SegmentedControl';

import FileIcon from '@/components/FileIcon';
import { useCollaborationArrangement } from '@/lib/layoutArrangement';
import { AgentIcon, getAgentName } from '@/components/agents/AgentIcon';
import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { useAppContextMenu } from '@/components/context-menu';
import { ConversationMessageNav } from '@/components/conversation-thread/ConversationMessageNav';
import type { ConversationMessageNavEntry } from '@/components/conversation-thread/messageNavEntries';
import {
  SESSION_LIST_ACTION_BUTTON_CLASS,
  SESSION_LIST_ACTION_ICON_CLASS,
} from '@/components/kanban/session-hub/utils';
import {
  PLUGIN_PANEL_COMPONENT,
  panelComponents,
} from '@/components/layout/panels/PanelRegistry';
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
import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { UserMessageMarkdown } from '@/components/NormalizedConversation/UserMessageMarkdown';
import { ActionBarUtilityButtons } from '@/components/tasks/follow-up/ActionBarUtilityButtons';
import { ComposerPrimaryActionButton } from '@/components/tasks/follow-up/ComposerPrimaryActionButton';
import { relativePathInsideRoot } from '@/components/tasks/follow-up/composerHostFileDrop';
import {
  MessageQueueIndicator,
  formatCountdownTimer,
} from '@/components/tasks/follow-up/MessageQueueIndicator';
import type { QueuedMessage } from '@/components/tasks/follow-up/sessionComposerQueue';
import {
  advertisedSessionConfigValues,
  presentableSessionConfigOptions,
  sanitizeDependentConfigValues,
  selectConfigOptionValue,
  visibleSessionConfigOptions,
} from '@/components/tasks/follow-up/SessionConfigOptionSelectors';
import { SessionComposerFrame } from '@/components/tasks/follow-up/SessionComposerFrame';
import { SessionComposerInput } from '@/components/tasks/follow-up/SessionComposerInput';
import { SessionSettingsSummary } from '@/components/tasks/follow-up/SessionSettingsSummary';
import { useSessionComposerPromptEnhancement } from '@/components/tasks/follow-up/useSessionComposerPromptEnhancement';
import { SessionListDeleteControl } from '@/components/workspace-session-list/SessionListDeleteControl';
import { SessionListSearchControl } from '@/components/workspace-session-list/SessionListSearchControl';
import {
  formatCompactSessionAge,
  workspaceSessionStatusTone,
} from '@/components/workspace-session-list/workspaceSessionListModel';
import {
  PanelActionsContext,
  useOptionalPanelActionsContext,
  type PanelActions,
} from '@/contexts/PanelActionsContext';
import { useOptionalProject } from '@/contexts/ProjectContext';
import { loadAgentSessionControlsCatalog } from '@/features/agents/sessionControlsQuery';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { registerImagePreviewSource } from '@/lib/imagePreviewRegistry';
import { cn } from '@/lib/utils';
import { PANEL_IDS } from '@/stores/useLayoutStore';
import {
  buildPreviewPanelParams,
  type OpenFilePreviewOptions,
  type PreviewPanelParams,
} from '@/types/panels';
import '@/styles/conversation.css';
import '@/styles/dockview-ayu.css';

import {
  collaborationCall,
  listenCollaborationSpaceChanged,
} from './collaborationApi';
import { useCollaborationLayoutStore } from './collaborationLayoutStore';
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

type MemberSessionPanelParams = {
  workspaceId: string;
  conversationId: string;
  nickname: string;
  agentId?: string;
};

type PreviewTabItem =
  | {
      id: string;
      kind: 'member';
      title: string;
      workspaceId: string;
      conversationId: string;
      agentId?: string;
      spaceId: string;
    }
  | {
      id: string;
      kind: 'file';
      title: string;
      fileParams: PreviewPanelParams;
    }
  | {
      id: string;
      kind: 'workspace-panel';
      component: string;
      title: string;
      params?: Record<string, unknown>;
    };

const EMPTY_MEMBERS: SpaceMember[] = [];
const EMPTY_MESSAGES: SpaceMessage[] = [];
const EMPTY_RECEIPTS: DeliveryReceipt[] = [];

function CollaborationSpaceIcon({
  avatars,
  tagPreset,
  className,
}: {
  avatars: readonly MemberBotAvatarConfig[];
  tagPreset?: (typeof SPACE_TAG_PRESETS)[number];
  className?: string;
}) {
  const isSingle = avatars.length === 1;
  const gridCols = avatars.length > 4 ? 3 : 2;
  const cellCount = gridCols * gridCols;

  return (
    <span
      className={cn(
        'collaboration-space-icon',
        isSingle
          ? 'collaboration-space-icon--single'
          : 'collaboration-space-icon--grid',
        className
      )}
      data-testid="collaboration-space-icon"
      data-tag-color={tagPreset?.id}
      data-grid-size={isSingle ? 1 : cellCount}
      style={
        tagPreset
          ? ({
              '--space-icon-bg': `hsl(${tagPreset.hue})`,
              backgroundColor: `hsl(${tagPreset.hue})`,
            } as CSSProperties)
          : undefined
      }
      aria-hidden="true"
    >
      {isSingle ? (
        <MemberBotAvatar
          config={avatars[0]}
          animated={false}
          className="collaboration-space-icon-single-avatar"
        />
      ) : (
        <span
          className={cn(
            'collaboration-space-icon-grid',
            gridCols === 3
              ? 'collaboration-space-icon-grid--3x3'
              : 'collaboration-space-icon-grid--2x2'
          )}
        >
          {Array.from({ length: cellCount }, (_, index) => {
            const avatar = avatars[index];
            return (
              <span
                key={index}
                className="collaboration-space-icon-cell"
                data-testid="collaboration-space-icon-cell"
              >
                {avatar ? (
                  <MemberBotAvatar
                    config={avatar}
                    animated={false}
                    className="collaboration-space-icon-cell-avatar"
                  />
                ) : null}
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}

function memberPreviewPanelId(conversationId: string): string {
  return `member:${conversationId}`;
}

function filePreviewPanelId(params: PreviewPanelParams): string {
  if (params.imagePreviewId) {
    return `image:${params.imagePreviewId}`;
  }
  const normalizedPath = String(params.filePath ?? '').replace(/\\/g, '/');
  return `${params.mode === 'diff' ? 'diff' : 'file'}:${normalizedPath}`;
}

function filePreviewTitle(params: PreviewPanelParams): string {
  const display = params.displayPath?.trim();
  if (display) return display;
  const rawPath = String(params.filePath ?? '').replace(/\\/g, '/');
  const baseName = rawPath.split('/').filter(Boolean).pop();
  return baseName || '预览';
}

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

function CollaborationMemberSessionDockviewPanel(
  props: IDockviewPanelProps<MemberSessionPanelParams>
) {
  const { workspaceId, conversationId } = props.params;
  const sessionPreviewProps = useMemo(
    () => ({
      workspaceId,
      sessionId: conversationId,
      interactive: true,
      showSessionSelector: false,
      markViewed: false,
      embedded: true,
      className: 'h-full',
      imagePreviewPresentation: 'dialog' as const,
      conversationWidthMode: 'workspace' as const,
    }),
    [conversationId, workspaceId]
  );

  return (
    <div className="collaboration-preview-frame h-full w-full">
      <Suspense fallback={<p className="collaboration-preview-empty">加载中</p>}>
        <SessionPreview {...sessionPreviewProps} />
      </Suspense>
    </div>
  );
}

function CollaborationFileDockviewPanel(
  props: IDockviewPanelProps<PreviewPanelParams>
) {
  return (
    <div className="collaboration-preview-frame h-full w-full">
      <Suspense fallback={<p className="collaboration-preview-empty">加载中</p>}>
        <FilePreviewPanel {...props} />
      </Suspense>
    </div>
  );
}

const COLLABORATION_PREVIEW_COMPONENTS = {
  ...panelComponents,
  'member-session': CollaborationMemberSessionDockviewPanel,
  'file-preview': CollaborationFileDockviewPanel,
};

function CollaborationPreviewDockviewTab(props: IDockviewPanelHeaderProps) {
  const { api, containerApi, params } = props;
  const { openSurfaceMenu } = useAppContextMenu();
  const [title, setTitle] = useState(api.title ?? '');
  const [tabParams, setTabParams] = useState<Record<string, unknown>>(
    (params as Record<string, unknown> | undefined) ?? {}
  );
  const isMiddleMouseButton = useRef(false);

  useEffect(() => {
    const disposable = api.onDidTitleChange((event) => {
      setTitle(event.title ?? '');
    });
    if (title !== (api.title ?? '')) {
      setTitle(api.title ?? '');
    }
    return () => disposable.dispose();
  }, [api, title]);

  useEffect(() => {
    const disposable = api.onDidParametersChange((nextParams) => {
      setTabParams((nextParams as Record<string, unknown>) ?? {});
    });
    return () => disposable.dispose();
  }, [api]);

  const closeTab = useCallback(
    (event?: ReactPointerEvent | ReactMouseEvent) => {
      event?.preventDefault();
      event?.stopPropagation();
      api.close();
    },
    [api]
  );

  const splitTab = useCallback(
    (direction: 'below' | 'left' | 'right') => {
      const currentGroup = api.group;
      if (!currentGroup) return;
      const panel = containerApi.getPanel(api.id);
      if (!panel) return;
      const nextGroup = containerApi.addGroup({
        referenceGroup: currentGroup,
        direction,
      });
      panel.api.moveTo({ group: nextGroup });
      panel.api.setActive();
    },
    [api.group, api.id, containerApi]
  );

  const agentId =
    typeof tabParams.agentId === 'string' ? tabParams.agentId : '';
  const filePath =
    typeof tabParams.filePath === 'string' ? tabParams.filePath : '';
  const imagePreviewId =
    typeof tabParams.imagePreviewId === 'string'
      ? tabParams.imagePreviewId
      : '';
  const mode = typeof tabParams.mode === 'string' ? tabParams.mode : '';

  return (
    <div
      data-testid="dockview-dv-default-tab"
      title={title}
      className="dv-default-tab workspace-tab-surface"
      onContextMenu={(event) => {
        const group = api.group;
        const panels = group?.panels ?? [];
        const index = panels.findIndex((panel) => panel.id === api.id);
        openSurfaceMenu(event.nativeEvent, [
          {
            type: 'submenu',
            id: 'close',
            label: '关闭',
            children: [
              {
                id: 'close-current',
                label: '关闭当前标签页',
                onSelect: () => closeTab(),
              },
              {
                id: 'close-others',
                label: '关闭其他标签页',
                disabled: panels.length <= 1,
                onSelect: () => {
                  panels
                    .filter((panel) => panel.id !== api.id)
                    .forEach((panel) => panel.api.close());
                },
              },
              {
                id: 'close-right',
                label: '关闭右侧标签页',
                disabled: index < 0 || index >= panels.length - 1,
                onSelect: () => {
                  panels.slice(index + 1).forEach((panel) => panel.api.close());
                },
              },
            ],
          },
          {
            type: 'submenu',
            id: 'split',
            label: '拆分',
            children: [
              {
                id: 'split-right',
                label: '向右拆分',
                onSelect: () => splitTab('right'),
              },
              {
                id: 'split-down',
                label: '向下拆分',
                onSelect: () => splitTab('below'),
              },
              {
                id: 'split-left',
                label: '向左拆分',
                onSelect: () => splitTab('left'),
              },
            ],
          },
        ]);
      }}
      onPointerDown={(event) => {
        isMiddleMouseButton.current = event.button === 1;
      }}
      onPointerUp={(event) => {
        if (isMiddleMouseButton.current && event.button === 1) {
          isMiddleMouseButton.current = false;
          closeTab(event);
        }
      }}
      onPointerLeave={() => {
        isMiddleMouseButton.current = false;
      }}
    >
      {api.component === 'member-session' ? (
        <span
          className="workspace-tab-icon"
          data-tab-icon="member"
          data-testid="workspace-tab-icon"
        >
          {agentId ? (
            <AgentIcon
              agent={agentId as ExecutorProfileId['executor']}
              className="h-3.5 w-3.5"
            />
          ) : (
            <MessageSquare className="h-3.5 w-3.5" />
          )}
        </span>
      ) : filePath ? (
        mode === 'diff' ? (
          <FileDiff
            aria-hidden="true"
            className="workspace-tab-icon"
            data-tab-icon="diff"
            data-testid="workspace-tab-icon"
          />
        ) : (
          <span
            className="workspace-tab-icon"
            data-tab-icon="file"
            data-testid="workspace-tab-icon"
          >
            <FileIcon filePath={filePath} />
          </span>
        )
      ) : imagePreviewId ? (
        <ImageIcon
          aria-hidden="true"
          className="workspace-tab-icon"
          data-tab-icon="image"
          data-testid="workspace-tab-icon"
        />
      ) : api.component === PANEL_IDS.DIFFS ? (
        <GitCompare
          aria-hidden="true"
          className="workspace-tab-icon"
          data-tab-icon="diffs"
          data-testid="workspace-tab-icon"
        />
      ) : api.component === PANEL_IDS.NOTES ? (
        <FileText
          aria-hidden="true"
          className="workspace-tab-icon"
          data-tab-icon="notes"
          data-testid="workspace-tab-icon"
        />
      ) : api.component === PANEL_IDS.TERMINAL ? (
        <SquareTerminal
          aria-hidden="true"
          className="workspace-tab-icon"
          data-tab-icon="terminal"
          data-testid="workspace-tab-icon"
        />
      ) : api.component === PLUGIN_PANEL_COMPONENT ? (
        <Globe
          aria-hidden="true"
          className="workspace-tab-icon"
          data-tab-icon="browser"
          data-testid="workspace-tab-icon"
        />
      ) : (
        <MessageSquare
          aria-hidden="true"
          className="workspace-tab-icon"
          data-tab-icon="chat"
          data-testid="workspace-tab-icon"
        />
      )}
      <span className="dv-default-tab-content">{title}</span>
      <div
        className="dv-default-tab-action rounded-full"
        onPointerDown={(event) => event.preventDefault()}
        onClick={closeTab}
        aria-label={`Close ${title}`}
        role="button"
      >
        <X className="h-3 w-3" />
      </div>
    </div>
  );
}

function CollaborationPreviewHeaderActions(props: IDockviewHeaderActionsProps) {
  const { containerApi, group } = props;
  const activePanel = group.activePanel;

  const handleSplit = (direction: 'right' | 'below') => {
    const targetPanel = group.activePanel;
    if (!targetPanel) return;
    const panel = containerApi.getPanel(targetPanel.id);
    if (!panel) return;
    const nextGroup = containerApi.addGroup({
      referenceGroup: group,
      direction,
    });
    panel.api.moveTo({ group: nextGroup });
    panel.api.setActive();
  };

  if (!activePanel) return null;

  return (
    <div className="flex h-full items-center gap-0.5 pr-1.5">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
        aria-label="向右拆分"
        title="向右拆分"
        onClick={() => handleSplit('right')}
      >
        <Columns2 className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
        aria-label="向下拆分"
        title="向下拆分"
        onClick={() => handleSplit('below')}
      >
        <Rows2 className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
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

function CollaborationPreviewScope({
  children,
  onOpenFile,
  onOpenWorkspacePanel,
  onRunInEditorGroup,
}: {
  children: ReactNode;
  onOpenFile: (params: PreviewPanelParams) => void;
  onOpenWorkspacePanel: (item: {
    id: string;
    component: string;
    title: string;
    params?: Record<string, unknown>;
  }) => void;
  onRunInEditorGroup: (groupId: string, action: () => void) => void;
}) {
  const parent = useOptionalPanelActionsContext();
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;
  const onOpenWorkspacePanelRef = useRef(onOpenWorkspacePanel);
  onOpenWorkspacePanelRef.current = onOpenWorkspacePanel;
  const onRunInEditorGroupRef = useRef(onRunInEditorGroup);
  onRunInEditorGroupRef.current = onRunInEditorGroup;
  const value = useMemo<PanelActions>(() => {
    const noop = () => {};
    const noopFalse = () => false;
    const base: PanelActions = parent ?? {
      openOrFocusPanel: noop,
      openFilePreview: () => 'opened' as const,
      renameFilePreviews: noop,
      openImagePreview: noop,
      openWebPreview: noop,
      revealInFileTree: noop,
      openDiffPreview: noop,
      openDiffPreviewAtPath: noop,
      openMergePanel: noop,
      openCommitDiff: noop,
      openNewTerminal: noop,
      openTerminalEditorTab: noop,
      showTerminal: noop,
      toggleEditorArea: noop,
      runInEditorGroup: (_groupId, action) => action(),
      splitEditorPanel: noopFalse,
      sortEditorGroupByName: noop,
      openPanelInNewEditorGroup: noopFalse,
      canOpenPanelInNewEditorGroup: noopFalse,
      splitActiveEditor: noopFalse,
      canSplitActiveEditor: noopFalse,
      closePanel: noop,
      toggleFileTree: noop,
      showFileTree: noop,
      toggleGitPanel: noop,
      toggleSearchPanel: noop,
      toggleSessionList: noop,
      placeLeftDockPanel: noop,
      measureLeftDock: () => null,
      isLeftDockSplit: noopFalse,
      unsplitLeftDock: noop,
      isPanelOpen: noopFalse,
      focusKanban: noop,
      openLogs: noop,
      openNotes: noop,
      openPluginPanel: noop,
      setDockviewApi: noop,
    };
    return {
      ...base,
      openFilePreview: (filePath: string, options?: OpenFilePreviewOptions) => {
        onOpenFileRef.current(buildPreviewPanelParams(filePath, options));
        return 'opened' as const;
      },
      openDiffPreview: () => {
        onOpenWorkspacePanelRef.current({
          id: PANEL_IDS.DIFFS,
          component: PANEL_IDS.DIFFS,
          title: '变更',
        });
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
      openNotes: () => {
        onOpenWorkspacePanelRef.current({
          id: PANEL_IDS.NOTES,
          component: PANEL_IDS.NOTES,
          title: '笔记',
        });
      },
      openTerminalEditorTab: (shell?: string) => {
        const suffix = Date.now().toString(36);
        onOpenWorkspacePanelRef.current({
          id: `${PANEL_IDS.TERMINAL}-editor-${suffix}`,
          component: PANEL_IDS.TERMINAL,
          title: '终端',
          params: {
            surface: 'editor',
            tabId: suffix,
            ...(shell ? { shell } : {}),
          },
        });
      },
      openNewTerminal: () => {
        const suffix = Date.now().toString(36);
        onOpenWorkspacePanelRef.current({
          id: `${PANEL_IDS.TERMINAL}-editor-${suffix}`,
          component: PANEL_IDS.TERMINAL,
          title: '终端',
          params: {
            surface: 'editor',
            tabId: suffix,
          },
        });
      },
      openPluginPanel: (options) => {
        const id =
          options.panelId ||
          `plugin:${options.pluginId}:${options.contributionId}`;
        onOpenWorkspacePanelRef.current({
          id,
          component: PLUGIN_PANEL_COMPONENT,
          title: options.title || '插件',
          params: options as unknown as Record<string, unknown>,
        });
      },
      openWebPreview: (url?: string | null) => {
        onOpenWorkspacePanelRef.current({
          id: 'plugin:vibex.browser:browser',
          component: PLUGIN_PANEL_COMPONENT,
          title: 'Browser',
          params: {
            pluginId: 'vibex.browser',
            contributionId: 'browser',
            title: 'Browser',
            requestedUrl: url ?? null,
          },
        });
      },
      runInEditorGroup: (groupId: string, action: () => void) => {
        onRunInEditorGroupRef.current(groupId, action);
      },
    };
  }, [parent]);

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
  const [newMemberAvatar, setNewMemberAvatar] =
    useState<MemberBotAvatarConfig>(() => randomMemberBotAvatar());
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
  const [virtualDefaultSpaceName, setVirtualDefaultSpaceName] = useState<string>(
    COPY.defaultSpaceName
  );
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
  const [delayedTickNow, setDelayedTickNow] = useState(() => Date.now());
  const messagesRef = useRef<SpaceMessage[]>([]);
  messagesRef.current = messages;
  const [selectedMemberKey, setSelectedMemberKey] = useState('');
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

  const selected =
    spaces.find((space) => space.space_id === selectedId) ?? null;
  const isDefaultVirtualSpaceSelected =
    spaces.length === 0 && selectedId === VIRTUAL_DEFAULT_SPACE_ID;
  const hasOpenedSpaceThread = Boolean(selected) || isDefaultVirtualSpaceSelected;
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
      const api = previewDockviewApiRef.current;
      if (api) {
        addOrFocusDockviewTab(api, item, true);
      }
    },
    [addOrFocusDockviewTab, setPreviewVisible]
  );

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

  const loadRolesAndAgents = useCallback(async () => {
    try {
      const [rolePage, agentPage] = await Promise.all([
        collaborationCall<{ roles?: RoleOption[] }>('collaboration', 'role.list'),
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
      setNewMemberAgentId((current) => current || nextAgents[0]?.agent_id || '');
      setInlineMemberRoleId((current) => current || nextRoles[0]?.id || '');
      setInlineMemberAgentId(
        (current) => current || nextAgents[0]?.agent_id || ''
      );
    } catch {
      // Handled by form submit if capability is disabled
    }
  }, []);

  useEffect(() => {
    overlayOpenedByUserRef.current = false;
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
        ...ids,
        ...allSpaceIds,
        ...(selectedId && selectedId !== VIRTUAL_DEFAULT_SPACE_ID
          ? [selectedId]
          : []),
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
      if (!selectedId || selectedId === VIRTUAL_DEFAULT_SPACE_ID) return;
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
  }, [openSpaceKey, selectedId, spaces, unassignedId, workspace]);

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
      if (
        event.seq !== undefined &&
        selectedId &&
        selectedId !== VIRTUAL_DEFAULT_SPACE_ID &&
        event.spaceId === selectedId
      ) {
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
      window.removeEventListener('online', handleReconnect);
      window.removeEventListener('vibex:host-client-changed', handleReconnect);
    };
  }, [loadConversations, openSpaceKey, selectedId, spaces, unassignedId, workspace]);

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
    if (scheduledMessages.length === 0) return;
    setDelayedTickNow(Date.now());
    const intervalId = window.setInterval(() => {
      setDelayedTickNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [scheduledMessages.length]);

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
      writeSpaceTags(next);
      return next;
    });
  };

  const updateMemberAvatar = useCallback(
    (keys: ReadonlyArray<string | undefined>, config: MemberBotAvatarConfig) => {
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
    setSelectedId(spaceId);
    setThreadVisible(true);
    setExpanded((current) => ({ ...current, [spaceId]: nextExpanded }));
  };

  const selectMemberForPreview = (spaceId: string, member: SpaceMember) => {
    if (spaces.some((item) => item.space_id === spaceId)) {
      setSelectedId(spaceId);
    }
    const conversationId = member.conversation_id ?? '';
    if (!conversationId) return;
    const memberKey = previewMemberKey(spaceId, member);
    setSelectedMemberKey(memberKey);
    const conv = conversationById.get(conversationId);
    const agentId =
      conv?.agent_id || draftMemberMetaByConvId[conversationId]?.agentId;
    openPreviewItem({
      id: memberPreviewPanelId(conversationId),
      kind: 'member',
      title: displayName(member),
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
      const created = await collaborationCall<{
        space_id?: string;
        member_id?: string;
        conversation_id?: string;
        nickname?: string;
      }>('collaboration', 'space.createMember', {
        workspaceId: workspace,
        spaceId: '',
        nickname: trimmedNickname,
        source: inlineMemberSource,
        ...(inlineMemberSource === 'role'
          ? { roleId: inlineMemberRoleId }
          : {
              agentId: inlineMemberAgentId,
              modeId: inlineMemberModeId,
              configValues: inlineMemberConfigValues,
              personaPrompt: inlineMemberPersonaPrompt,
            }),
        operationId: crypto.randomUUID(),
      });

      const createdConvId =
        created?.conversation_id ||
        created?.member_id ||
        `draft-member-${crypto.randomUUID()}`;
      const resolvedAgentId =
        inlineMemberSource === 'role'
          ? roles.find((item) => item.id === inlineMemberRoleId)?.agent_id
          : inlineMemberAgentId;

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
        const memberPage = await collaborationCall<{
          members?: SpaceMember[];
        }>('collaboration', 'space.listMembers', { spaceId: unassignedId });
        setMembersBySpace((current) => ({
          ...current,
          [unassignedId]: memberPage.members ?? [],
        }));
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
      const unassignedList = membersBySpace[unassignedId] ?? [];
      for (const convId of selectedSpaceMemberConvIds) {
        const draftMeta = draftMemberMetaByConvId[convId];
        const existingNick =
          draftMeta?.nickname || memberNicknameByConversationId.get(convId);
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
      operationId: crypto.randomUUID(),
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
      const resolvedAgentId =
        newMemberSource === 'role'
          ? roles.find((item) => item.id === newMemberRoleId)?.agent_id
          : newMemberAgentId;
      openPreviewItem({
        id: memberPreviewPanelId(created.conversation_id),
        kind: 'member',
        title: created.nickname || trimmedNickname,
        workspaceId: workspace,
        conversationId: created.conversation_id,
        ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
        spaceId: effectiveSpaceId,
      });
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

      await collaborationCall('collaboration', 'space.moveMember', {
        fromSpaceId: effectiveFromSpaceId,
        toSpaceId: effectiveToSpaceId,
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
    setPreviewTabs((current) =>
      current.map((item) =>
        item.id === tabId ? { ...item, title: nextNickname } : item
      )
    );
    previewDockviewApiRef.current?.getPanel(tabId)?.api.setTitle(nextNickname);
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

  const handleComposerFileSelect = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = '';
      if (files.length === 0) return;

      const tokens = files
        .map((file) => {
          const nativePath = (
            file as File & { path?: string; webkitRelativePath?: string }
          ).path;
          const relative = nativePath
            ? (relativePathInsideRoot(nativePath, workspacePath) ?? nativePath)
            : file.webkitRelativePath || file.name;
          return relative ? `@${relative.replace(/\\/g, '/')}` : '';
        })
        .filter(Boolean);
      if (tokens.length === 0) return;

      const joined = `${tokens.join(' ')} `;
      const next =
        draft.length > 0 && !/\s$/.test(draft)
          ? `${draft} ${joined}`
          : `${draft}${joined}`;
      restoreDraft(next);
    },
    [draft, workspacePath]
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
    const content = rawText.trim();
    if (!selected || !content || sending) return;
    if (strayMentions(content, members).length > 0) {
      restoreDraft(rawText);
      setError(COPY.nicknameMissing);
      return;
    }
    setSending(true);
    try {
      const recipients = postRecipients(content, members);
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
      setError('');
      setOperationId(crypto.randomUUID());
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

  const handleEditSpaceQueuedMessage = useCallback(
    (message: QueuedMessage) => {
      setEditingSpaceMessageId(message.id);
      restoreDraft(message.data.message);
    },
    []
  );

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
    ? SPACE_TAG_PRESETS.find((preset) => preset.id === selectedTagConfig.colorId)
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
      const key =
        member.conversation_id || member.member_id || member.nickname;
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
        icon: (
          <MessageSquare className="h-3 w-3 shrink-0" aria-hidden="true" />
        ),
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
          return bubbleText(msg.envelope).replace(/\s+/g, ' ').trim();
        }
      }
      return '';
    },
    [membersBySpace, messages, messagesBySpace, selectedId]
  );

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
          aria-label={`选择成员 ${name}`}
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
            onClick={() => togglePendingSpaceMemberConvSelection(conversationId)}
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

  const renderMemberRow = (spaceId: string, member: SpaceMember) => {
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
            aria-label={`选择成员 ${name}`}
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
          const startX = event.clientX;
          const startY = event.clientY;
          const payload = {
            fromSpaceId: spaceId,
            conversationId,
            nickname: String(member.nickname ?? name),
          };
          let activeDrag = false;
          let currentTargetSpace = '';

          const resolveSpaceIdAtPoint = (
            clientX: number,
            clientY: number
          ): string => {
            if (typeof document.elementsFromPoint === 'function') {
              const els = document.elementsFromPoint(clientX, clientY);
              for (const el of els) {
                const spaceEl = (el as HTMLElement).closest?.(
                  '[data-space-id]'
                ) as HTMLElement | null;
                if (spaceEl?.dataset.spaceId) {
                  return spaceEl.dataset.spaceId;
                }
              }
            }
            const allSpaceEls =
              document.querySelectorAll<HTMLElement>('[data-space-id]');
            for (const spaceEl of allSpaceEls) {
              const rect = spaceEl.getBoundingClientRect();
              if (
                clientX >= rect.left &&
                clientX <= rect.right &&
                clientY >= rect.top &&
                clientY <= rect.bottom
              ) {
                return spaceEl.dataset.spaceId ?? '';
              }
            }
            return '';
          };

          const handlePointerMove = (moveEvent: PointerEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            if (!activeDrag && Math.hypot(dx, dy) < 5) {
              return;
            }
            if (!activeDrag) {
              activeDrag = true;
              suppressNextMemberClickRef.current = true;
              setDraggingMember(payload);
              document.body.classList.add('is-dragging-collaboration-member');
            }
            setPointerDragCursor({
              x: moveEvent.clientX,
              y: moveEvent.clientY,
            });
            const hoveredSpaceId = resolveSpaceIdAtPoint(
              moveEvent.clientX,
              moveEvent.clientY
            );
            currentTargetSpace = hoveredSpaceId;
            setDropTargetSpaceId(hoveredSpaceId);
          };

          const cleanup = () => {
            window.removeEventListener('pointermove', handlePointerMove);
            window.removeEventListener('pointerup', handlePointerUp);
            window.removeEventListener('pointercancel', handlePointerCancel);
            document.body.classList.remove('is-dragging-collaboration-member');
            setPointerDragCursor(null);
            setDraggingMember(null);
            setDropTargetSpaceId('');
          };

          const handlePointerUp = (upEvent: PointerEvent) => {
            const finalSpaceId =
              resolveSpaceIdAtPoint(upEvent.clientX, upEvent.clientY) ||
              currentTargetSpace;
            const wasDragging = activeDrag;
            cleanup();
            if (wasDragging) {
              window.setTimeout(() => {
                suppressNextMemberClickRef.current = false;
              }, 0);
              if (finalSpaceId && finalSpaceId !== payload.fromSpaceId) {
                void moveMemberBetweenSpaces(
                  payload.fromSpaceId,
                  finalSpaceId,
                  payload.conversationId,
                  payload.nickname
                );
              }
            }
          };

          const handlePointerCancel = () => {
            cleanup();
            suppressNextMemberClickRef.current = false;
          };

          window.addEventListener('pointermove', handlePointerMove);
          window.addEventListener('pointerup', handlePointerUp);
          window.addEventListener('pointercancel', handlePointerCancel);
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
                aria-hidden="true"
              >
                <MemberBotAvatar
                  config={renameAvatar}
                  sessionActive={Boolean(
                    isRunning || conv?.status === 'inprogress'
                  )}
                  className="h-7 w-7"
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
                    className="workspace-session-row-main"
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
                      selectMemberForPreview(spaceId, member);
                    }}
                  >
                    <span
                      className="workspace-session-icon"
                      aria-hidden="true"
                    >
                      <MemberBotAvatar
                        config={getMemberAvatar(conversationId, name)}
                        sessionActive={Boolean(
                          isRunning || conv?.status === 'inprogress'
                        )}
                        className="h-7 w-7"
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
                      <span className="collaboration-member-name">{name}</span>
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
                          <div className="session-card-hover-label">工作区</div>
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

  const renderSpaceGroup = (
    space: Space,
    options: { isUnassigned?: boolean; isVirtualDefault?: boolean } = {}
  ) => {
    const { isUnassigned = false, isVirtualDefault = false } = options;
    const open =
      space.space_id in expanded
        ? expanded[space.space_id]
        : isVirtualDefault || isUnassigned || space.space_id === selectedId;
    // Requirement 1: User ('你') is an invisible member and never appears in the member list
    const rawSpaceMembers = agentRoster(
      isUnassigned
        ? unassignedMembers
        : (membersBySpace[space.space_id] ?? EMPTY_MEMBERS)
    );
    const queryLower = searchQuery.trim().toLowerCase();
    const spaceNameMatches =
      !queryLower || space.name.toLowerCase().includes(queryLower);
    const spaceMembers =
      queryLower && !spaceNameMatches
        ? rawSpaceMembers.filter((member) =>
            doesMemberMatchQuery(member, queryLower)
          )
        : rawSpaceMembers;
    const visibleAgentCount = rawSpaceMembers.length;
    const spaceMemberAvatars = rawSpaceMembers.map((member) =>
      getMemberAvatar(
        member.conversation_id ?? undefined,
        displayName(member)
      )
    );
    const tagConfig = spaceTags[space.space_id];
    const tagPreset = tagConfig
      ? SPACE_TAG_PRESETS.find((preset) => preset.id === tagConfig.colorId)
      : undefined;
    const isDropTarget = dropTargetSpaceId === space.space_id;
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
          isDropTarget && 'is-drop-target'
        )}
        onDragOver={(event) => {
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
            void moveMemberBetweenSpaces(
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
              !isUnassigned &&
                space.space_id === selectedId &&
                'is-selected'
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
              <CollaborationSpaceIcon
                avatars={spaceMemberAvatars}
                tagPreset={tagPreset}
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
                className="workspace-session-row-main collaboration-space-header-main"
                aria-label={space.name}
                aria-expanded={open}
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
                <CollaborationSpaceIcon
                  avatars={spaceMemberAvatars}
                  tagPreset={tagPreset}
                />
                <span className="workspace-session-title is-cjk">
                  {space.name}
                </span>
                {!open && spaceMemberAvatars.length > 0 ? (
                  <span
                    className="collaboration-space-collapsed-member-stack"
                    data-testid={`collaboration-space-collapsed-stack-${space.space_id}`}
                    aria-hidden="true"
                  >
                    {spaceMemberAvatars.map((avatar, index) => (
                      <span
                        key={index}
                        className="collaboration-space-collapsed-stack-item"
                        style={{ zIndex: spaceMemberAvatars.length - index }}
                      >
                        <MemberBotAvatar
                          config={avatar}
                          animated={false}
                          className="h-3.5 w-3.5"
                        />
                      </span>
                    ))}
                  </span>
                ) : null}
                <span
                  className={cn(
                    'collaboration-space-meta',
                    hasSpaceHoverActions &&
                      'collaboration-space-meta--hide-on-hover'
                  )}
                >
                  <span className="workspace-session-group-count">
                    {visibleAgentCount}
                  </span>
                </span>
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
        {open ? (
          <div className="collaboration-member-list">
            {spaceMembers.length === 0 ? (
              <div className="collaboration-member-empty">
                <span>
                  {t('collaborationSpace.emptyMembers', COPY.noMemberSessions)}
                </span>
                {!isUnassigned && !isVirtualDefault ? (
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
      ? spaceAddMemberOpen
        ? '添加成员'
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
                          aria-label={`移除成员 ${memberName}`}
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
                    aria-label="添加或新建协作空间成员"
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
                  variant={spaceAddMemberTab === 'select' ? 'default' : 'outline'}
                  onClick={() => setSpaceAddMemberTab('select')}
                  className="h-8 text-xs"
                >
                  选择成员
                </Button>
                <Button
                  type="button"
                  variant={spaceAddMemberTab === 'create' ? 'default' : 'outline'}
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
                      添加成员
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
                    <span className="shrink-0 text-[12px] font-semibold leading-none text-foreground">
                      {t('collaborationSpace.title', '协作空间')}
                    </span>
                    <div
                      className={cn(
                        'ml-auto flex min-w-0 flex-nowrap items-center justify-end gap-1',
                        searchOpen && 'flex-1'
                      )}
                    >
                      <SessionListSearchControl
                        searchQuery={searchQuery}
                        isExpanded={searchOpen}
                        searchLabel="搜索协作空间或成员"
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
                            <Filter className={SESSION_LIST_ACTION_ICON_CLASS} />
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
              >
                {spaces.length === 0 ? (
                  <>
                    {renderSpaceGroup(
                      {
                        space_id: VIRTUAL_DEFAULT_SPACE_ID,
                        name: virtualDefaultSpaceName,
                      },
                      { isVirtualDefault: true }
                    )}
                    {unassignedId && unassignedMembers.length > 0
                      ? renderSpaceGroup(
                          {
                            space_id: unassignedId,
                            name: COPY.unassignedSpaceName,
                          },
                          { isUnassigned: true }
                        )
                      : null}
                  </>
                ) : (
                  <>
                    {visibleSpaces.map((space) => renderSpaceGroup(space))}
                    {unassignedId
                      ? renderSpaceGroup(
                          {
                            space_id: unassignedId,
                            name: COPY.unassignedSpaceName,
                          },
                          { isUnassigned: true }
                        )
                      : null}
                  </>
                )}
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
          >
            {selected && topMemberBarExpanded ? (
              <div
                className="collaboration-top-member-bar"
                data-testid="collaboration-top-member-bar"
              >
                <Button
                  type="button"
                  variant="icon"
                  size="icon"
                  className="collaboration-expand"
                  aria-label="收起成员列表"
                  title="收起成员列表"
                  onClick={() => setTopMemberBarExpanded(false)}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                </Button>
                <div className="collaboration-top-member-scroll">
                  {visibleRoster.map((member) => {
                    const nick = displayName(member);
                    const convId = member.conversation_id ?? '';
                    const memberHoverKey =
                      member.member_id ?? (convId || nick);
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
                      <Popover
                        key={memberHoverKey}
                        open={isDelayedPopoverOpen}
                      >
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className={cn(
                              'collaboration-top-member-chip',
                              isSelectedChip && 'is-selected',
                              hasDelayedMessages && 'has-delayed-messages'
                            )}
                            aria-label={`筛选成员 ${nick}`}
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
                                      <span>
                                        {formatCountdownTimer(
                                          item.deliver_at,
                                          delayedTickNow
                                        )}
                                      </span>
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
                <button
                  type="button"
                  className="collaboration-top-member-expand-trigger"
                  aria-label="展开成员列表"
                  title="展开成员列表"
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
              ) : null}

              <div ref={threadLogRef} className="collaboration-thread-log">
                {isDefaultVirtualSpaceSelected ? (
                  <div
                    className="collaboration-default-space-empty"
                    data-testid="collaboration-default-space-empty"
                  >
                    <div
                      className="collaboration-empty-member-pill"
                      data-testid="collaboration-empty-member-pill"
                    >
                      当前协作空间暂无成员，请先添加成员
                    </div>
                    <div className="collaboration-empty-member-actions">
                      <Button
                        type="button"
                        variant="primary"
                        onClick={() => openCreateMemberDialog()}
                      >
                        添加成员
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
                ) : selected && filteredMessages.length > 0
                  ? filteredMessages.map((message) => {
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
                                    title: name,
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
                              <p className="collaboration-message-name">
                                {name}
                              </p>
                            </div>
                          ) : null}
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
                  : null}
              </div>

              {selected && navEntries.length > 0 ? (
                <div className="conv-message-nav-anchor">
                  <ConversationMessageNav
                    entries={navEntries}
                    activeIndex={
                      activeNavIndex ?? navEntries.length - 1
                    }
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
                  onDelayQueuedMessage={(message, delaySeconds) => {
                    void handleDelaySpaceQueuedMessage(message, delaySeconds);
                  }}
                />
                <SessionComposerFrame>
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
                          aria-label={`空间成员数量 ${visibleRoster.length}`}
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
                          <span>空间成员</span>
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
                      title="@成员"
                      aria-label="@成员"
                    >
                      <AtSign className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                    <div className="flex-1" />
                    <ComposerPrimaryActionButton
                      action="send"
                      label={t('collaborationSpace.send', '发送')}
                      pending={sending}
                      disabled={!draft.trim() || sending}
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
      </div>
    </CollaborationPreviewScope>
  );
}
