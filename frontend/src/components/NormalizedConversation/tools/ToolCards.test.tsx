import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionType, NormalizedEntry, ToolStatus } from 'shared/types';
import { ToolCallCard } from '../ToolCallCard';
import { CommandToolCard } from './CommandToolCard';
import { FileToolCard } from './FileToolCard';
import { GenericToolCard } from './GenericToolCard';
import { SearchToolCard } from './SearchToolCard';

const panelMocks = vi.hoisted(() => ({
  openFilePreview: vi.fn(),
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    openFilePreview: panelMocks.openFilePreview,
  }),
}));

vi.mock('@/components/common/RawLogText', () => ({
  default: ({ content }: { content: string }) => <pre>{content}</pre>,
}));

vi.mock('@/components/ui/wysiwyg', () => ({
  default: ({ value }: { value: string }) => (
    <div data-testid="wysiwyg">{value}</div>
  ),
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({ config: { theme: 'light' } }),
}));

function toolEntry({
  actionType,
  toolName = 'tool',
  content = '',
  status = { status: 'success' },
}: {
  actionType: ActionType;
  toolName?: string;
  content?: string;
  status?: ToolStatus;
}): NormalizedEntry {
  return {
    timestamp: null,
    content,
    entry_type: {
      type: 'tool_use',
      tool_name: toolName,
      action_type: actionType,
      status,
    },
  };
}

describe('conversation tool cards', () => {
  const clipboardWrite = vi.fn();

  beforeEach(() => {
    panelMocks.openFilePreview.mockReset();
    clipboardWrite.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    vi.restoreAllMocks();
  });

  it('renders command output inside an expandable command card', () => {
    render(
      <CommandToolCard
        entry={toolEntry({
          toolName: 'shell',
          content: 'pnpm test',
          actionType: {
            action: 'command_run',
            command: 'pnpm test',
            result: {
              exit_status: { type: 'exit_code', code: 0 },
              output: 'all green',
            },
          },
        })}
        expansionKey="command"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /终端/ }));

    expect(screen.getAllByText('命令')).toHaveLength(1);
    expect(screen.getByText('终端')).toBeInTheDocument();
    expect(screen.getAllByText('pnpm test')).toHaveLength(2);
    expect(screen.getByText('输出')).toBeInTheDocument();
    expect(screen.getByText('all green')).toBeInTheDocument();
  });

  it('styles a failed command from its exit status even when the tool call completed', () => {
    const { container } = render(
      <CommandToolCard
        entry={toolEntry({
          toolName: 'shell',
          content: 'pnpm test',
          status: { status: 'success' },
          actionType: {
            action: 'command_run',
            command: 'pnpm test',
            result: {
              exit_status: { type: 'exit_code', code: 1 },
              output: 'failed',
            },
          },
        })}
        expansionKey="failed-command"
      />
    );

    expect(container.querySelector('.conv-tool-card-error')).toBeTruthy();
  });

  it('shows a running command with pending styling', () => {
    const { container } = render(
      <CommandToolCard
        entry={toolEntry({
          toolName: 'shell',
          content: 'pnpm build',
          status: { status: 'created' },
          actionType: {
            action: 'command_run',
            command: 'pnpm build',
            result: null,
          },
        })}
        expansionKey="running-command"
      />
    );

    expect(container.querySelector('.conv-tool-card-pending')).toBeTruthy();
    expect(container.querySelector('.conv-tool-dot-pending')).toBeTruthy();
  });

  it('keeps install script command output expanded by default', () => {
    render(
      <ToolCallCard
        entry={toolEntry({
          toolName: 'Tool Install Script',
          content: 'pnpm install',
          actionType: {
            action: 'command_run',
            command: 'pnpm install',
            result: {
              exit_status: { type: 'exit_code', code: 0 },
              output: 'installed https://example.com/package',
            },
          },
        })}
        expansionKey="install-command"
      />
    );

    expect(screen.getByText('输出')).toBeInTheDocument();
    expect(
      screen.getByText('installed https://example.com/package')
    ).toBeInTheDocument();
  });

  it('opens file reads in the preview panel with a resolved workspace path', () => {
    render(
      <FileToolCard
        entry={toolEntry({
          toolName: 'Read',
          content: 'src/App.tsx',
          actionType: { action: 'file_read', path: 'src/App.tsx' },
        })}
        expansionKey="file"
        containerRef={'C:\\workspace\\project'}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '打开预览' }));

    expect(panelMocks.openFilePreview).toHaveBeenCalledWith(
      'C:\\workspace\\project\\src\\App.tsx',
      {
        displayPath: 'src/App.tsx',
        title: 'src/App.tsx',
      }
    );
  });

  it('opens and copies web fetch targets without expanding the card', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    render(
      <SearchToolCard
        entry={toolEntry({
          toolName: 'fetch',
          content: 'https://example.com/docs',
          actionType: {
            action: 'web_fetch',
            url: 'https://example.com/docs',
          },
        })}
        expansionKey="web"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '打开链接' }));
    fireEvent.click(screen.getByRole('button', { name: '复制 URL' }));

    expect(openSpy).toHaveBeenCalledWith(
      'https://example.com/docs',
      '_blank',
      'noopener,noreferrer'
    );
    await waitFor(() =>
      expect(clipboardWrite).toHaveBeenCalledWith('https://example.com/docs')
    );
    expect(screen.queryByText('URL')).not.toBeInTheDocument();
  });

  it('keeps generic tool arguments and result inspectable', () => {
    render(
      <GenericToolCard
        entry={toolEntry({
          toolName: 'github_search',
          content: 'github_search',
          actionType: {
            action: 'tool',
            tool_name: 'github_search',
            arguments: { query: 'streamdown' },
            result: {
              type: { type: 'json' },
              value: { total: 3 },
            },
          },
        })}
        expansionKey="generic"
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /github_search/ }));

    expect(screen.getByText('参数')).toBeInTheDocument();
    expect(screen.getByText(/"query": "streamdown"/)).toBeInTheDocument();
    expect(screen.getByText('结果')).toBeInTheDocument();
    expect(screen.getByText(/"total": 3/)).toBeInTheDocument();
  });

  it('routes web fetch entries through the lookup card path', () => {
    render(
      <ToolCallCard
        entry={toolEntry({
          toolName: 'fetch',
          content: 'https://example.com',
          actionType: { action: 'web_fetch', url: 'https://example.com' },
        })}
        expansionKey="router-web"
      />
    );

    expect(
      screen.getByRole('button', { name: /网页抓取 https:\/\/example\.com/ })
    ).toBeInTheDocument();
  });

  it('does not apply success styling to every completed non-command tool', () => {
    const { container } = render(
      <FileToolCard
        entry={toolEntry({
          toolName: 'Read',
          content: 'src/App.tsx',
          actionType: { action: 'file_read', path: 'src/App.tsx' },
        })}
        expansionKey="file-success"
      />
    );

    expect(container.querySelector('.conv-tool-card-success')).toBeNull();
    expect(container.querySelector('.conv-tool-dot-success')).toBeNull();
  });

  it('routes plan updates to a status-aware plan card', () => {
    const { container } = render(
      <ToolCallCard
        entry={toolEntry({
          toolName: 'plan',
          status: { status: 'created' },
          actionType: {
            action: 'plan_presentation',
            plan: [
              '1. [completed | high] Baseline fixed',
              '2. [in_progress | high] Ship rendering',
            ].join('\n'),
          },
        })}
        expansionKey="plan-card"
      />
    );

    expect(container.querySelector('.conv-tool-card-pending')).toBeTruthy();
    expect(screen.getByText('Ship rendering')).toBeInTheDocument();
    expect(screen.getAllByText('high')).toHaveLength(2);
  });

  it('routes file edits to an inline unified diff preview', () => {
    render(
      <ToolCallCard
        entry={toolEntry({
          toolName: 'edit',
          actionType: {
            action: 'file_edit',
            path: 'src/App.tsx',
            changes: [
              {
                action: 'edit',
                unified_diff: [
                  'diff --git a/src/App.tsx b/src/App.tsx',
                  '--- a/src/App.tsx',
                  '+++ b/src/App.tsx',
                  '@@ -1,3 +1,3 @@',
                  '-old line',
                  '+new line',
                ].join('\n'),
                has_line_numbers: true,
              },
            ],
          },
        })}
        expansionKey="inline-diff"
      />
    );

    expect(screen.getByText('src/App.tsx')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('-1')).toBeInTheDocument();
  });

  it('routes question tool results to a question card', () => {
    render(
      <ToolCallCard
        entry={toolEntry({
          toolName: 'request_user_input',
          actionType: {
            action: 'tool',
            tool_name: 'request_user_input',
            arguments: {
              question: 'Deploy now?',
              options: ['yes', 'no'],
            },
            result: {
              type: { type: 'json' },
              value: { answer: 'yes' },
            },
          },
        })}
        expansionKey="question"
      />
    );

    expect(screen.getAllByText('Deploy now?')[0]).toBeInTheDocument();
    expect(screen.getByText(/"answer": "yes"/)).toBeInTheDocument();
  });

  it('routes feedback check results to a feedback card', () => {
    render(
      <ToolCallCard
        entry={toolEntry({
          toolName: 'feedback_check',
          actionType: {
            action: 'tool',
            tool_name: 'feedback_check',
            arguments: { check: 'visual polish' },
            result: {
              type: { type: 'json' },
              value: { summary: 'No blocking issues' },
            },
          },
        })}
        expansionKey="feedback"
      />
    );

    expect(screen.getAllByText('No blocking issues')[0]).toBeInTheDocument();
    expect(screen.getByText(/"check": "visual polish"/)).toBeInTheDocument();
  });

  it('routes goal tool calls to a goal card', () => {
    render(
      <ToolCallCard
        entry={toolEntry({
          toolName: 'create_goal',
          actionType: {
            action: 'tool',
            tool_name: 'create_goal',
            arguments: { objective: 'Finish Phase 2' },
            result: {
              type: { type: 'json' },
              value: { status: 'active', objective: 'Finish Phase 2' },
            },
          },
        })}
        expansionKey="goal"
      />
    );

    expect(screen.getAllByText('Finish Phase 2')[0]).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('routes generated images to an image result card', () => {
    render(
      <ToolCallCard
        entry={toolEntry({
          toolName: 'generate_image',
          actionType: {
            action: 'tool',
            tool_name: 'generate_image',
            arguments: { prompt: 'Dashboard preview' },
            result: {
              type: { type: 'json' },
              value: {
                status: 'ready',
                image_url: 'data:image/png;base64,abc123',
                revised_prompt: 'Compact dashboard preview',
              },
            },
          },
        })}
        expansionKey="generated-image"
      />
    );

    expect(
      screen.getByRole('img', { name: 'Compact dashboard preview' })
    ).toHaveAttribute('src', 'data:image/png;base64,abc123');
    expect(screen.getAllByText('Dashboard preview')[0]).toBeInTheDocument();
  });
});
