import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveMemberBotAvatar } from './MemberBotAvatar';
import { AssistantDetailsCustomizeTab } from './AssistantDetailsCustomizeTab';

const collaborationCall = vi.hoisted(() => vi.fn());

vi.mock('./collaborationApi', () => ({
  collaborationCall,
}));

vi.mock('@/features/agents/sessionControlsQuery', () => ({
  loadAgentSessionControlsCatalog: vi.fn(async () => ({
    current_mode: 'default',
    modes: [],
    config_options: [],
  })),
}));

describe('AssistantDetailsCustomizeTab', () => {
  beforeEach(() => {
    collaborationCall.mockReset();
    collaborationCall.mockImplementation(
      async (_cap: string, method: string) => {
        if (method === 'member.config.get') {
          return {
            memberId: 'mem-a',
            config: {
              agent_id: 'CLAUDE_CODE',
              mode_id: 'default',
              config_values: { model: 'grok-4.6' },
              persona_prompt: '你是小A',
            },
          };
        }
        return {};
      }
    );
  });

  it('loads the bot config and saves name, session config, and persona without changing Agent', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <AssistantDetailsCustomizeTab
        memberId="mem-a"
        conversationId="conv-1"
        initialName="小A"
        initialAvatar={deriveMemberBotAvatar('小A')}
        onSaved={onSaved}
      />
    );

    expect(
      await screen.findByRole('textbox', { name: '助手名称' })
    ).toHaveValue('小A');
    const agentReadonly = screen.getByTestId(
      'collaboration-assistant-agent-readonly'
    );
    expect(agentReadonly).toHaveTextContent('Claude Code');
    expect(agentReadonly.parentElement).toHaveTextContent('Agent');
    expect(screen.queryByRole('combobox', { name: '选择 Agent' })).toBeNull();
    await user.click(agentReadonly);
    expect(agentReadonly).toHaveClass('is-shaking');
    expect(screen.getByLabelText('人设（可选）')).toHaveValue('你是小A');

    await user.clear(screen.getByRole('textbox', { name: '助手名称' }));
    await user.type(screen.getByRole('textbox', { name: '助手名称' }), '小A改');
    await user.clear(screen.getByLabelText('人设（可选）'));
    await user.type(screen.getByLabelText('人设（可选）'), '新的人设');
    await user.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(collaborationCall).toHaveBeenCalledWith(
        'collaboration',
        'member.update',
        expect.objectContaining({ memberId: 'mem-a', name: '小A改' })
      );
    });
    expect(collaborationCall).toHaveBeenCalledWith(
      'collaboration',
      'member.config.update',
      expect.objectContaining({
        memberId: 'mem-a',
        personaPrompt: '新的人设',
      })
    );
    const configUpdate = collaborationCall.mock.calls.find(
      (call) => call[1] === 'member.config.update'
    );
    expect(configUpdate?.[2]).not.toHaveProperty('agentId');
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({ name: '小A改' })
    );
  });
});
