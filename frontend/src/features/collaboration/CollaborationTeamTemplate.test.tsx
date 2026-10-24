import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HotkeysProvider } from 'react-hotkeys-hook';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithQueryClient as render } from '@/test/QueryClientHarness';

import { CollaborationWorkspace } from './CollaborationWorkspace';

const collaborationCall = vi.hoisted(() => vi.fn());

vi.mock('@/lib/backendTransport', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/backendTransport')>();
  return { ...actual, backendListen: vi.fn(async () => () => undefined) };
});

vi.mock('./collaborationApi', () => ({
  COLLABORATION_SPACE_CHANGED_EVENT: 'vibex://collaboration-space-changed',
  collaborationCall,
  currentWindowLabel: vi.fn(async () => 'main'),
  listenCollaborationSpaceChanged: vi.fn(async () => () => undefined),
}));

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

type Call = [string, string, Record<string, unknown> | undefined];

function callsOf(method: string) {
  return (collaborationCall.mock.calls as Call[])
    .filter(([, m]) => m === method)
    .map(([, , input]) => input ?? {});
}

function mockHost(
  overrides: Record<string, (input: Record<string, unknown>) => unknown> = {}
) {
  let created = 0;
  collaborationCall.mockImplementation(
    async (_cap: string, method: string, input: Record<string, unknown> = {}) => {
      if (overrides[method]) return overrides[method](input);
      switch (method) {
        case 'space.list':
          return { spaces: [] };
        case 'space.listMembers':
          return { members: [] };
        case 'space.listConversations':
          return { conversations: [] };
        case 'card.list':
          return { cards: [] };
        case 'role.list':
          return {
            roles: [
              { id: 'role-fe', name: 'Frontend Engineer', agent_id: 'CODEX' },
              { id: 'role-arch', name: '架构师', agent_id: 'CLAUDE_CODE' },
            ],
          };
        case 'space.createMember':
          created += 1;
          return {
            member_id: `m${created}`,
            conversation_id: `conv-${created}`,
            nickname: input.nickname,
          };
        case 'space.create':
          return { space_id: 'space-team', name: input.name };
        default:
          return {};
      }
    }
  );
}

function renderWorkspace() {
  return render(
    <HotkeysProvider initiallyActiveScopes={['dialog']}>
      <MemoryRouter>
        <CollaborationWorkspace workspaceId={WORKSPACE} />
      </MemoryRouter>
    </HotkeysProvider>
  );
}

describe('one-click team template', () => {
  beforeEach(() => {
    collaborationCall.mockReset();
    localStorage.clear();
  });

  it('creates the template members, then a group chat seating them', async () => {
    mockHost();
    const user = userEvent.setup();
    renderWorkspace();
    await screen.findByTestId('collab-team-empty');
    // wait for roles so role matching is deterministic
    await waitFor(() => expect(callsOf('role.list')).toHaveLength(1));

    // default template is 全栈小队: 前端 / 后端 / 测试
    expect(
      screen.getByRole('button', { name: /全栈小队/ }).getAttribute('aria-pressed')
    ).toBe('true');
    await user.click(screen.getByRole('button', { name: '创建小队' }));

    await waitFor(() => expect(callsOf('space.addMember')).toHaveLength(3));
    const members = callsOf('space.createMember');
    expect(members).toHaveLength(3);
    // 'frontend' hint matches the Frontend Engineer role by name
    expect(members[0]).toMatchObject({
      workspaceId: WORKSPACE,
      nickname: '前端',
      roleId: 'role-fe',
    });
    expect(members[0]).not.toHaveProperty('agentId');
    // unmatched hints fall back to the first role's agent with a persona
    expect(members[1]).toMatchObject({
      workspaceId: WORKSPACE,
      nickname: '后端',
      agentId: 'CODEX',
      personaPrompt: 'backend',
    });
    expect(members[1]).not.toHaveProperty('roleId');
    expect(members[2]).toMatchObject({
      nickname: '测试',
      agentId: 'CODEX',
      personaPrompt: 'qa',
    });
    for (const input of members) {
      expect(typeof input.operationId).toBe('string');
    }
    expect(new Set(members.map((m) => m.operationId)).size).toBe(3);

    expect(callsOf('space.create')).toEqual([
      expect.objectContaining({ workspaceId: WORKSPACE, name: '全栈小队' }),
    ]);
    expect(callsOf('space.addMember')).toEqual([
      expect.objectContaining({ spaceId: 'space-team', conversationId: 'conv-1', nickname: '前端' }),
      expect.objectContaining({ spaceId: 'space-team', conversationId: 'conv-2', nickname: '后端' }),
      expect.objectContaining({ spaceId: 'space-team', conversationId: 'conv-3', nickname: '测试' }),
    ]);
    // members are all created before the group chat
    const order = (collaborationCall.mock.calls as Call[])
      .map(([, m]) => m)
      .filter((m) => ['space.createMember', 'space.create', 'space.addMember'].includes(m));
    expect(order.slice(0, 4)).toEqual([
      'space.createMember',
      'space.createMember',
      'space.createMember',
      'space.create',
    ]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('uses the picked template', async () => {
    mockHost();
    const user = userEvent.setup();
    renderWorkspace();
    await screen.findByTestId('collab-team-empty');
    await waitFor(() => expect(callsOf('role.list')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: /修 Bug 二人组/ }));
    await user.click(screen.getByRole('button', { name: '创建小队' }));

    await waitFor(() => expect(callsOf('space.addMember')).toHaveLength(2));
    expect(callsOf('space.createMember').map((m) => m.nickname)).toEqual([
      '排查',
      '复核',
    ]);
    expect(callsOf('space.create')[0]).toMatchObject({ name: '修 Bug 二人组' });
  });

  it('surfaces a host error and does not create the group chat', async () => {
    mockHost({
      'space.createMember': () => {
        throw new Error('agent unavailable');
      },
    });
    const user = userEvent.setup();
    renderWorkspace();
    await screen.findByTestId('collab-team-empty');
    await user.click(screen.getByRole('button', { name: '创建小队' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(callsOf('space.createMember')).toHaveLength(1);
    expect(callsOf('space.create')).toHaveLength(0);
    expect(callsOf('space.addMember')).toHaveLength(0);
    // the button is usable again after the failure
    expect(
      (screen.getByRole('button', { name: '创建小队' }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });
});
