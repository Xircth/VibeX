import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentBlock } from 'shared/types';
import i18n from '@/i18n';
import { TurnActivity } from './TurnActivity';
import { planTurnBlocks } from './messageTurnBlocks';

vi.mock('@/contexts/PanelActionsContext', () => ({
  useOptionalPanelActionsContext: () => null,
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({ config: { theme: 'light' } }),
  useOptionalUserSystem: () => ({ config: { theme: 'light' } }),
}));

vi.mock('@/components/common/RawLogText', () => ({
  default: ({ content }: { content: string }) => <pre>{content}</pre>,
}));

vi.mock('./AstryxMarkdown', () => ({
  AstryxMarkdown: ({ value }: { value: string }) => <pre>{value}</pre>,
}));

const INITIAL_LANGUAGE = i18n.language;

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage(INITIAL_LANGUAGE);
});

function renderCommand({
  id,
  status = 'failed',
  code,
  backgrounded = false,
  outputPreview,
}: {
  id: string;
  status?: 'failed' | 'completed' | 'in_progress' | 'denied' | 'timed_out';
  code?: number;
  backgrounded?: boolean;
  outputPreview?: string;
}) {
  const blocks: ContentBlock[] = [
    {
      type: 'tool_use',
      tool_use_id: id,
      tool_name: 'exec_command',
      kind: 'execute',
      status,
      input_preview: JSON.stringify({ cmd: 'powershell.exe -Command test' }),
      meta: backgrounded ? { asyncTasks: { backgrounded: true } } : null,
    },
  ];
  if (status !== 'in_progress') {
    blocks.push({
      type: 'tool_result',
      tool_use_id: id,
      is_error:
        status === 'failed' || status === 'denied' || status === 'timed_out',
      output_preview:
        outputPreview ??
        JSON.stringify({
          stdout: 'original stdout',
          stderr: 'original stderr',
          ...(code !== undefined ? { exit_code: code } : {}),
        }),
    });
  }
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TurnActivity
        turnId={id}
        timestamp="2026-11-18T00:00:00.000Z"
        items={planTurnBlocks(blocks).map((item, index) => ({ item, index }))}
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    </QueryClientProvider>
  );
  if (!screen.queryByTestId('turn-tool-chip-row')) {
    fireEvent.click(
      screen.getByRole('button', { name: /运行 1 个命令|Ran 1 command/ })
    );
  }
  return view;
}

describe('terminal failure summaries in the timeline', () => {
  it('shows a reported nonzero exit code while collapsed and preserves output on expansion', () => {
    renderCommand({ id: 'exit-23', code: 23 });
    expect(screen.getByText('命令退出码 23')).toBeVisible();
    expect(screen.queryByText('工具调用失败')).not.toBeInTheDocument();
    const row = screen.getByTestId('turn-tool-chip-row');
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('turn-tool-chip-item')).toHaveAttribute(
      'data-tool-status',
      'error'
    );
    fireEvent.click(row);
    expect(screen.getByText(/original stdout/)).toBeVisible();
    expect(screen.getByText(/original stderr/)).toBeVisible();
    expect(screen.getByText('exit 23')).toBeVisible();
  });

  it('uses the command result when the transport reports completion', () => {
    renderCommand({ id: 'completed-exit-1', status: 'completed', code: 1 });
    expect(screen.getByText('命令退出码 1')).toBeVisible();
    expect(screen.getByTestId('turn-tool-chip-item')).toHaveAttribute(
      'data-tool-status',
      'error'
    );
  });

  it('shows timeout summary when collapsed even if killed with an exit code, and preserves output on expansion', async () => {
    renderCommand({ id: 'timeout-124', status: 'timed_out', code: 124 });
    expect(screen.getByText('执行超时')).toBeVisible();
    expect(screen.queryByText('工具调用失败')).not.toBeInTheDocument();
    const row = screen.getByTestId('turn-tool-chip-row');
    expect(screen.getByTestId('turn-tool-chip-item')).toHaveAttribute(
      'data-tool-status',
      'error'
    );
    fireEvent.click(row);
    expect(screen.getByText(/original stdout/)).toBeVisible();
    expect(screen.getByText('exit 124')).toBeVisible();

    cleanup();
    await i18n.changeLanguage('en');
    renderCommand({
      id: 'timeout-en',
      status: 'failed',
      outputPreview: JSON.stringify({ timedOut: true, stdout: 'partial' }),
    });
    expect(screen.getByText('Timed out')).toBeVisible();
  });

  it('shows permission denied summary when collapsed and localizes in English', async () => {
    renderCommand({ id: 'denied-zh', status: 'denied' });
    expect(screen.getByText('权限被拒绝')).toBeVisible();
    expect(screen.queryByText('工具调用失败')).not.toBeInTheDocument();
    const row = screen.getByTestId('turn-tool-chip-row');
    expect(screen.getByTestId('turn-tool-chip-item')).toHaveAttribute(
      'data-tool-status',
      'error'
    );
    fireEvent.click(row);
    expect(screen.getByText(/original stdout/)).toBeVisible();

    cleanup();
    await i18n.changeLanguage('en');
    renderCommand({
      id: 'denied-en',
      status: 'failed',
      outputPreview: JSON.stringify({ status: 'declined', stdout: 'declined' }),
    });
    expect(screen.getByText('Permission denied')).toBeVisible();
  });

  it.each([
    ['successful', 'completed', 0, false, 'complete'],
    ['running', 'in_progress', undefined, false, 'running'],
    ['background', 'failed', 23, true, 'complete'],
  ] as const)(
    'does not invent a failure for %s commands',
    (id, status, code, backgrounded, expected) => {
      renderCommand({ id, status, code, backgrounded });
      expect(screen.getByTestId('turn-tool-chip-item')).toHaveAttribute(
        'data-tool-status',
        expected
      );
      expect(
        screen.queryByText(/命令退出码|工具调用失败|执行超时|权限被拒绝/)
      ).not.toBeInTheDocument();
    }
  );

  it('keeps an unknown failure generic instead of guessing from prose output or inventing an exit code', () => {
    renderCommand({
      id: 'unknown-failure',
      outputPreview: 'Permission denied',
    });
    expect(screen.getByText('工具调用失败')).toBeVisible();
    expect(screen.queryByText(/命令退出码|权限被拒绝|执行超时/)).not.toBeInTheDocument();
  });

  it('localizes the reported exit code in English', async () => {
    await i18n.changeLanguage('en');
    renderCommand({ id: 'english-exit', code: 7 });
    expect(screen.getByText('Command exited with code 7')).toBeVisible();
  });
});
