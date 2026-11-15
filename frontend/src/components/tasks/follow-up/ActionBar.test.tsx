import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SelectableAgent } from '@/features/agents/useSelectableAgents';
import { ActionBar } from './ActionBar';

const mockSlotState = vi.hoisted(() => ({
  renderMic: false,
}));

const mockSelectableAgents = vi.hoisted(
  () => ({ rows: [] as SelectableAgent[] })
);

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

function renderActionBar(props: Partial<Parameters<typeof ActionBar>[0]> = {}) {
  return render(
    <ActionBar
      profiles={null}
      effectiveExecutorProfile={null}
      onChangeExecutorProfile={vi.fn()}
      showProfileControls={false}
      isEditable={true}
      isAttemptRunning={false}
      compactContextEnabled={false}
      canCompactContext={false}
      isCompactingContext={false}
      isStopping={false}
      isSendingFollowUp={false}
      canSendFollowUp={true}
      promptEnhancementEnabled={false}
      isEnhancingPrompt={false}
      canEnhancePrompt={false}
      conflictResolutionInstructions={null}
      comments={[]}
      onCompactContext={vi.fn()}
      onStopExecution={vi.fn()}
      onSendFollowUp={vi.fn()}
      onEnhancePrompt={vi.fn()}
      onClearComments={vi.fn()}
      onAttachImages={vi.fn()}
      {...props}
    />
  );
}

describe('ActionBar', () => {
  beforeEach(() => {
    mockSlotState.renderMic = false;
    mockSelectableAgents.rows = [];
  });

  it('does not keep a hidden duplicate todo trigger', () => {
    renderActionBar();

    expect(
      screen.queryByTitle('\u67e5\u770b\u5f85\u529e\u4e8b\u9879')
    ).not.toBeInTheDocument();
  });

  it('shows an arrow action that sends while the conversation is idle', () => {
    const onSendFollowUp = vi.fn();
    renderActionBar({ onSendFollowUp });

    const sendButton = screen.getByRole('button', { name: '\u53d1\u9001' });
    expect(sendButton.querySelector('.lucide-arrow-up')).toBeInTheDocument();
    expect(sendButton).not.toHaveTextContent('\u53d1\u9001');

    fireEvent.click(sendButton);

    expect(onSendFollowUp).toHaveBeenCalledTimes(1);
  });

  it('replaces the arrow with a square action that stops a running turn', () => {
    const onStopExecution = vi.fn();
    renderActionBar({ isAttemptRunning: true, onStopExecution });

    const stopButton = screen.getByRole('button', { name: '\u505c\u6b62' });
    expect(stopButton.querySelector('.lucide-square')).toBeInTheDocument();
    expect(stopButton).not.toHaveTextContent('\u505c\u6b62');

    fireEvent.click(stopButton);

    expect(onStopExecution).toHaveBeenCalledTimes(1);
  });

  it('groups attachment and utility actions on the bottom-left and places session settings left of microphone and send', () => {
    mockSlotState.renderMic = true;

    renderActionBar({
      compactContextEnabled: true,
      promptEnhancementEnabled: true,
      sessionConfigOptions: [
        {
          key: 'model',
          label: 'Model',
          category: 'model',
          value: 'terra',
          choices: [
            { value: 'terra', label: '5.6 Terra' },
            { value: 'sol', label: '5.6 Sol' },
          ],
        },
      ],
      onSelectConfigOption: vi.fn(),
    });

    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      '附加文件',
      '压缩上下文',
      '提示词优化',
      '本次会话: 5.6 Terra',
      '语音输入',
      '发送',
    ]);
    expect(screen.getByTestId('session-settings-summary')).not.toHaveClass(
      'raised-control'
    );
  });

  it('keeps Agent switching available on Bot sessions when profile controls are enabled', async () => {
    const user = userEvent.setup();
    const onChangeExecutorProfile = vi.fn();
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

    renderActionBar({
      showProfileControls: true,
      profiles: {},
      effectiveExecutorProfile: {
        executor: 'claude_code',
        variant: null,
      },
      onChangeExecutorProfile,
      persona: {
        name: '小A',
        agentName: 'claude_code',
      },
    });

    await user.click(screen.getByTestId('session-settings-summary'));
    const rail = screen.getByRole('radiogroup');
    await user.click(within(rail).getByRole('radio', { name: 'Codex' }));

    expect(onChangeExecutorProfile).toHaveBeenCalledWith({
      executor: 'codex',
      variant: null,
    });
  });

  it('omits compact context when the optional setting is off', () => {
    renderActionBar({ promptEnhancementEnabled: true });

    expect(
      screen.queryByRole('button', { name: '压缩上下文' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '提示词优化' })
    ).toBeInTheDocument();
  });

  it('does not show a queue action while a turn is running', () => {
    renderActionBar({
      isAttemptRunning: true,
      canSendFollowUp: false,
    });

    expect(
      screen.queryByRole('button', { name: '\u961f\u5217' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '\u505c\u6b62' })
    ).toBeInTheDocument();
  });
});
