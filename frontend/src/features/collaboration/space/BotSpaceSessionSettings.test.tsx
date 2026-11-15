import { createRef } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SelectableAgent } from '@/features/agents/useSelectableAgents';
import { renderWithQueryClient as render } from '@/test/QueryClientHarness';

import type { CollaborationSpaceRuntime } from './CollaborationSpaceRuntime';
import { ComposerDock } from './ComposerDock';
import { CollaborationSpaceStoreContext } from './SpaceStoreContext';

const collaborationCallMock = vi.hoisted(() => vi.fn());
const loadCatalogMock = vi.hoisted(() => vi.fn());
const setSessionModeMock = vi.hoisted(() => vi.fn(async () => undefined));
const setSessionConfigOptionMock = vi.hoisted(() =>
  vi.fn(async () => undefined)
);
const confirmEngineHandoffMock = vi.hoisted(() =>
  vi.fn(async () => ({ conversation_id: 'conv-bot-1' }))
);
const mockSlotState = vi.hoisted(() => ({ renderMic: true }));
const mockSelectableAgents = vi.hoisted(() => ({
  rows: [] as SelectableAgent[],
}));

vi.mock('../collaborationApi', () => ({
  collaborationCall: collaborationCallMock,
}));

vi.mock('@/components/plugins/Slot', () => ({
  Slot: ({ name }: { name: string }) =>
    name === 'composer.toolbar' && mockSlotState.renderMic ? (
      <button type="button" aria-label="语音输入">
        mic
      </button>
    ) : null,
}));

vi.mock('@/features/agents/useSelectableAgents', () => ({
  useSelectableAgents: () => mockSelectableAgents.rows,
}));

vi.mock('@/features/agents/api', () => ({
  agentsApi: {
    capabilityCatalogFresh: vi.fn(async () => true),
    refreshCapabilityCatalog: vi.fn(async () => false),
  },
}));

vi.mock('@/features/agents/sessionControlsQuery', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/features/agents/sessionControlsQuery')
  >();
  return {
    ...actual,
    loadAgentSessionControlsCatalog: loadCatalogMock,
  };
});

vi.mock('@/features/conversation/conversationApi', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/features/conversation/conversationApi')
  >();
  return {
    ...actual,
    conversationApi: {
      ...actual.conversationApi,
      setSessionMode: setSessionModeMock,
      setSessionConfigOption: setSessionConfigOptionMock,
      confirmEngineHandoff: confirmEngineHandoffMock,
    },
  };
});

vi.mock('@/lib/backendTransport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/backendTransport')>();
  return {
    ...actual,
    backendListen: vi.fn(async () => () => undefined),
  };
});

function buildRuntime(
  overrides: Partial<CollaborationSpaceRuntime> = {}
): CollaborationSpaceRuntime {
  return {
    activeBotConversationId: 'conv-bot-1',
    activeBotTimeline: {
      timeline: [],
      sessionModes: { current: null, modes: [] },
      sessionConfigOptions: [],
    } as unknown as CollaborationSpaceRuntime['activeBotTimeline'],
    activeDirectThreadId: 'direct:mem-a',
    agents: [
      { agent_id: 'claude_code', name: 'Claude Code' },
      { agent_id: 'codex', name: 'Codex' },
    ],
    attachedImages: [],
    composerContainerRef: createRef<HTMLDivElement>(),
    composerFileInputRef: createRef<HTMLInputElement>(),
    conversationById: new Map([
      [
        'conv-bot-1',
        {
          conversation_id: 'conv-bot-1',
          agent_id: 'claude_code',
          title: '小A',
        },
      ],
    ]),
    draft: '你好',
    draftMemberMetaByConvId: {},
    handleAttachFiles: vi.fn(),
    handleComposerFileSelect: vi.fn(),
    handleDelaySpaceQueuedMessage: vi.fn(),
    handleDeleteSpaceQueuedMessage: vi.fn(),
    handleEditSpaceQueuedMessage: vi.fn(),
    handleEnhancePrompt: vi.fn(),
    handleRemoveAttachedImage: vi.fn(),
    handleTriggerAtMember: vi.fn(),
    identityMemberIdByConversation: new Map([['conv-bot-1', 'mem-a']]),
    isBotSessionLoading: false,
    isEnhancingPrompt: false,
    isPrivateChatActive: true,
    loadRolesAndAgents: vi.fn(async () => ({ roles: [], agents: [] })),
    promptEnhancementEnabled: true,
    refreshSidebar: vi.fn(async () => undefined),
    replaceDraftRef: { current: null },
    replyingTo: null,
    repoIds: [],
    selected: {
      space_id: 'direct:mem-a',
      name: '小A',
    } as CollaborationSpaceRuntime['selected'],
    send: vi.fn(),
    sending: false,
    setDraft: vi.fn(),
    setReplyingTo: vi.fn(),
    sidebarItems: [
      {
        kind: 'dm',
        thread_id: 'direct:mem-a',
        space_id: 'unassigned:ws-1',
        name: '小A',
        unread_count: 0,
        member: {
          member_id: 'mem-a',
          name: '小A',
          agent: 'claude_code',
          conversation_id: 'conv-bot-1',
        },
      },
    ] as CollaborationSpaceRuntime['sidebarItems'],
    spaceMemberRefs: [],
    spaceQueuedMessages: [],
    t: ((_key: string, fallback?: string) =>
      fallback ?? _key) as CollaborationSpaceRuntime['t'],
    userDelayedSpaceMessages: [],
    visibleRoster: [
      {
        member_id: 'mem-a',
        nickname: '小A',
        kind: 'agent',
        agent: 'claude_code',
        conversation_id: 'conv-bot-1',
        visible_to_agents: 1,
      },
    ],
    workspace: 'ws-1',
    workspacePath: '/repo',
    ...overrides,
  } as CollaborationSpaceRuntime;
}

function renderComposerDock(
  overrides: Partial<CollaborationSpaceRuntime> = {}
) {
  const runtime = buildRuntime(overrides);
  const store = {
    getSnapshot: () => runtime,
    subscribe: () => () => undefined,
  };
  return render(
    <CollaborationSpaceStoreContext.Provider value={store}>
      <ComposerDock />
    </CollaborationSpaceStoreContext.Provider>
  );
}

describe('ComposerDock BotSpace session settings', () => {
  beforeEach(() => {
    mockSlotState.renderMic = true;
    mockSelectableAgents.rows = [
      {
        agentId: 'claude_code',
        displayName: 'Claude Code',
        iconLight: null,
        iconDark: null,
        iconSvg: null,
        enabled: true,
        lifecycle: 'ready',
        runnable: true,
        settingsFeatures: [],
      },
      {
        agentId: 'codex',
        displayName: 'Codex',
        iconLight: null,
        iconDark: null,
        iconSvg: null,
        enabled: true,
        lifecycle: 'ready',
        runnable: true,
        settingsFeatures: [],
      },
    ];
    collaborationCallMock.mockReset();
    loadCatalogMock.mockReset();
    setSessionModeMock.mockClear();
    setSessionConfigOptionMock.mockClear();
    confirmEngineHandoffMock.mockClear();

    collaborationCallMock.mockImplementation(
      async (_cap: string, method: string) => {
        if (method === 'member.config.get') {
          return {
            memberId: 'mem-a',
            config: {
              agent_id: 'claude_code',
              mode_id: 'plan',
              config_values: { model: 'sonnet-4' },
              persona_prompt: '你是架构师小A',
            },
          };
        }
        return {};
      }
    );

    loadCatalogMock.mockImplementation(async (agentId: string) => ({
      agent_id: agentId,
      current_mode: 'plan',
      modes: [
        { id: 'plan', label: 'Plan' },
        { id: 'bypass', label: 'Bypass' },
      ],
      config_options: [
        {
          key: 'model',
          label: 'Model',
          category: 'model',
          value: agentId === 'codex' ? 'gpt-5-codex' : 'sonnet-4',
          choices:
            agentId === 'codex'
              ? [{ value: 'gpt-5-codex', label: 'GPT-5 Codex' }]
              : [
                  { value: 'sonnet-4', label: 'Sonnet 4' },
                  { value: 'opus-4', label: 'Opus 4' },
                ],
        },
      ],
    }));
  });

  it('omits topbar and session settings in GroupSpace while keeping utility buttons bottom-left and mic/send bottom-right', () => {
    renderComposerDock({
      isPrivateChatActive: false,
      activeDirectThreadId: null,
      selected: {
        space_id: 'space-1',
        name: '设计群',
      } as CollaborationSpaceRuntime['selected'],
    });

    expect(document.querySelector('.composer-topbar')).toBeNull();
    expect(screen.queryByTestId('composer-current-space')).toBeNull();
    expect(screen.queryByTestId('session-settings-summary')).toBeNull();

    const buttons = screen.getAllByRole('button');
    expect(buttons.map((btn) => btn.getAttribute('aria-label'))).toEqual([
      '选择文件',
      '提示词优化',
      '@助手',
      '语音输入',
      '发送',
    ]);
  });

  it('shows borderless session settings left of microphone and send in BotSpace and supports adjusting config and switching Agent', async () => {
    const user = userEvent.setup();
    renderComposerDock();

    const trigger = await screen.findByTestId('session-settings-summary');
    expect(trigger).toHaveClass('border-0');
    expect(trigger).not.toHaveClass('raised-control');
    await waitFor(() => {
      expect(trigger).toHaveTextContent('Sonnet 4');
    });

    const buttons = screen.getAllByRole('button');
    expect(buttons.map((btn) => btn.getAttribute('aria-label'))).toEqual([
      '选择文件',
      '提示词优化',
      '@助手',
      '本次会话: Plan · Sonnet 4',
      '语音输入',
      '发送',
    ]);

    // Update model config directly from BotSpace composer
    await user.click(trigger);
    await user.click(screen.getByText('Model'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Opus 4' }));

    await waitFor(() => {
      expect(collaborationCallMock).toHaveBeenCalledWith(
        'collaboration',
        'member.config.update',
        {
          memberId: 'mem-a',
          modeId: 'plan',
          configValues: { model: 'opus-4' },
          personaPrompt: '你是架构师小A',
        }
      );
    });
    expect(setSessionConfigOptionMock).toHaveBeenCalledWith({
      conversationId: 'conv-bot-1',
      key: 'model',
      value: 'opus-4',
    });

    // Switch Bot session Agent directly from BotSpace composer
    await user.click(screen.getByTestId('session-settings-summary'));
    const rail = screen.getByRole('radiogroup');
    await user.click(within(rail).getByRole('radio', { name: 'Codex' }));

    await waitFor(() => {
      expect(confirmEngineHandoffMock).toHaveBeenCalledWith({
        conversationId: 'conv-bot-1',
        targetEngine: 'codex',
      });
    });
  });
});
