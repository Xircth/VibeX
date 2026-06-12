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
});
