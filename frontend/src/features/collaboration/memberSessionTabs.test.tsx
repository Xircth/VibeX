import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render as rtlRender, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import {
  CollaborationWorkspaceView,
  type CollaborationWorkspaceViewProps,
} from './CollaborationWorkspaceView';
import { deriveMemberBotAvatar } from './MemberBotAvatar';
import {
  buildMemberSessionTab,
  closeMemberSessionTab,
  memberSessionTabKey,
  MemberSessionTabsPanel,
  sessionTabTitle,
  upsertMemberSessionTab,
} from './memberSessionTabs';
import type { ThreadListItem, ThreadMember } from './threadModel';

const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
  );

const idle = { state: 'idle' as const, line: null, busyThreads: [], queued: 0 };
const avatarFor = (id: string) => deriveMemberBotAvatar(id);
const DIRECT = 'undecided-space';
const members: ThreadMember[] = [
  {
    memberId: 'm-alex',
    nickname: 'Alex',
    seats: [
      { threadId: DIRECT, threadName: '', conversationId: 'c-direct', direct: true },
      { threadId: 'g1', threadName: '登录', conversationId: 'c-g1', direct: false },
    ],
  },
  {
    memberId: 'm-blair',
    nickname: 'Blair',
    seats: [
      { threadId: 'g1', threadName: '登录', conversationId: 'c-b', direct: false },
    ],
  },
];
const groups = [{ spaceId: 'g1', name: '登录', memberIds: ['m-alex', 'm-blair'] }];
const items: ThreadListItem[] = [
  ...members.map((member) => ({
    kind: 'member' as const,
    key: `member:${member.memberId}`,
    member,
    presence: idle,
    attention: 0,
    pinned: false,
    activity: {},
  })),
  {
    kind: 'group',
    key: 'group:g1',
    group: groups[0],
    pinned: false,
    activity: {},
    attention: 0,
  },
];

function viewProps(
  overrides: Partial<CollaborationWorkspaceViewProps> = {}
): CollaborationWorkspaceViewProps {
  return {
    items,
    members,
    selectedKey: null,
    query: '',
    avatarFor,
    directTurns: [],
    directReceipts: {},
    groupSeats: members.map((m) => ({
      memberId: m.memberId,
      nickname: m.nickname,
      conversationId: null,
      avatar: avatarFor(m.memberId),
      presence: idle,
      busyElsewhere: null,
    })),
    groupMessages: [],
    cards: [],
    cardStatus: {},
    profileOpen: false,
    profile: null,
    threadNames: new Map(),
    roles: [],
    agents: [],
    dialogs: { newGroup: false, newMember: false },
    onQueryChange: vi.fn(),
    onSelect: vi.fn(),
    onTogglePin: vi.fn(),
    onDialogChange: vi.fn(),
    onCreateGroup: vi.fn(),
    onCreateMember: vi.fn(),
    onSendDirect: vi.fn(),
    onSendGroup: vi.fn(),
    onPreviewWake: vi.fn(async () => ({ willWake: 0, asleep: 0 })),
    onResolveCard: vi.fn(),
    onToggleProfile: vi.fn(),
    onOpenMemberSession: vi.fn(),
    onUpdateFact: vi.fn(),
    onDeleteFact: vi.fn(),
    onSetWriteAccess: vi.fn(),
    ...overrides,
  };
}

const tab = (memberId: string, threadId: string) =>
  buildMemberSessionTab({
    memberId,
    threadId,
    conversationId: `c-${memberId}-${threadId}`,
    members,
    groups,
    avatarFor,
  });

describe('collaboration click routing', () => {
  it('sidebar clicks only select the chat; no session is opened', async () => {
    const user = userEvent.setup();
    const props = viewProps();
    render(<CollaborationWorkspaceView {...props} />);
    await user.click(screen.getByText('Alex'));
    await user.click(
      screen.getAllByRole('button', { name: /登录/ })[0]
    );
    expect(props.onSelect).toHaveBeenCalledWith('member:m-alex');
    expect(props.onSelect).toHaveBeenCalledWith('group:g1');
    expect(props.onOpenMemberSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId('collab-session-panel')).toBeNull();
  });

  it('direct chat avatar opens the member session for the direct thread', async () => {
    const user = userEvent.setup();
    const props = viewProps({ selectedKey: 'member:m-alex' });
    render(<CollaborationWorkspaceView {...props} />);
    await user.click(screen.getByTestId('collab-direct-avatar'));
    expect(props.onOpenMemberSession).toHaveBeenCalledWith('m-alex', DIRECT);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('folded agent steps open the per-thread member session like the avatar', async () => {
    const user = userEvent.setup();
    const props = viewProps({
      selectedKey: 'member:m-alex',
      directTurns: [
        {
          key: 't1',
          turn: {
            role: 'assistant',
            blocks: [{ type: 'tool_use' }, { type: 'text', text: 'done' }],
          } as unknown as CollaborationWorkspaceViewProps['directTurns'][number]['turn'],
        },
      ],
    });
    render(<CollaborationWorkspaceView {...props} />);
    expect(screen.getByTestId('collab-process')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /在会话标签中打开/ }));
    expect(props.onOpenMemberSession).toHaveBeenCalledWith('m-alex', DIRECT);
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('group chat avatar opens that member session for this group', async () => {
    const user = userEvent.setup();
    const props = viewProps({
      selectedKey: 'group:g1',
      groupMessages: [
        {
          seq: 1,
          // Non-agent origin so it is not folded as agent-to-agent.
          origin: 'reply',
          envelope: { actor: 'vibex://space/g1/member/Blair', content: '好的' },
        },
      ] as never,
    });
    render(<CollaborationWorkspaceView {...props} />);
    const chat = screen.getByTestId('collab-group-chat');
    await user.click(within(chat).getByRole('button', { name: 'Blair' }));
    expect(props.onOpenMemberSession).toHaveBeenCalledWith('m-blair', 'g1');
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('shows the session panel when tabs exist', () => {
    render(
      <CollaborationWorkspaceView
        {...viewProps({
          sessionTabs: [tab('m-alex', 'g1')],
          activeSessionTabKey: memberSessionTabKey('m-alex', 'g1'),
        })}
      />
    );
    expect(screen.getByTestId('collab-session-panel')).toBeTruthy();
    expect(screen.getByTestId('collab-workspace').dataset.profile).toBe('open');
  });
});

describe('member session tabs', () => {
  it('dedupes one tab per (member, thread)', () => {
    let tabs = upsertMemberSessionTab([], tab('m-alex', 'g1'));
    tabs = upsertMemberSessionTab(tabs, tab('m-alex', 'g1'));
    tabs = upsertMemberSessionTab(tabs, tab('m-alex', DIRECT));
    tabs = upsertMemberSessionTab(tabs, tab('m-blair', 'g1'));
    expect(tabs.map((t) => t.key)).toEqual([
      'm-alex:g1',
      `m-alex:${DIRECT}`,
      'm-blair:g1',
    ]);
  });

  it('closing the active tab activates a neighbour', () => {
    const tabs = [tab('m-alex', 'g1'), tab('m-blair', 'g1')];
    expect(closeMemberSessionTab(tabs, 'm-alex:g1', 'm-alex:g1')).toEqual({
      tabs: [tabs[1]],
      activeKey: 'm-blair:g1',
    });
    expect(closeMemberSessionTab(tabs, 'm-alex:g1', 'm-blair:g1').activeKey).toBe(
      'm-alex:g1'
    );
  });

  it('titles direct tabs with the member and group tabs with group ? member', () => {
    expect(sessionTabTitle(tab('m-alex', DIRECT))).toEqual({
      icon: 'member',
      text: 'Alex',
    });
    expect(sessionTabTitle(tab('m-alex', 'g1'))).toEqual({
      icon: 'group-with-member',
      text: '登录 · Alex',
    });
    expect(sessionTabTitle(tab('m-alex', 'g1'), false)).toEqual({
      icon: 'group',
      text: '登录',
    });
  });

  it('renders the member badge on group tabs only and switches on click', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(
      <MemberSessionTabsPanel
        tabs={[tab('m-alex', DIRECT), tab('m-alex', 'g1')]}
        activeKey="m-alex:g1"
        onActivate={onActivate}
        onClose={vi.fn()}
        renderSession={(t) => <p>session {t.conversationId}</p>}
      />
    );
    expect(screen.getAllByTestId('collab-session-tab-badge')).toHaveLength(1);
    expect(screen.getByText('session c-m-alex-g1')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Alex' }));
    expect(onActivate).toHaveBeenCalledWith(`m-alex:${DIRECT}`);
  });
});
