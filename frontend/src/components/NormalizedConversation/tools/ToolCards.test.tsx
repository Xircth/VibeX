import {
  fireEvent,
  render as renderUI,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fileTreeApi } from '@/lib/api';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ActionType,
  ContentBlock,
  MessageTurn,
  NormalizedEntry,
  ToolStatus,
} from 'shared/types';
import { MessageTurnView } from '../MessageTurnView';
import { ToolCallCard } from '../ToolCallCard';
import DisplayConversationEntry from '../DisplayConversationEntry';
import type { ToolResultBlock, ToolUseBlock } from '../messageTurnBlocks';
import { toolBlockToNormalizedEntry } from '../messageTurnTool';
import { CommandToolCard } from './CommandToolCard';
import { FileToolCard } from './FileToolCard';
import { GenericToolCard } from './GenericToolCard';
import { SearchToolCard } from './SearchToolCard';
import { UnifiedDiffPreview } from './UnifiedDiffPreview';
import { getToolChatStatus, ToolCallResultDetail } from './ToolCardShell';

const panelMocks = vi.hoisted(() => ({
  openFilePreview: vi.fn(),
}));

const imageMocks = vi.hoisted(() => ({
  showPreview: vi.fn(),
  useImageMetadata: vi.fn(),
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    openFilePreview: panelMocks.openFilePreview,
  }),
  useOptionalPanelActionsContext: () => null,
}));

vi.mock('@/components/common/RawLogText', () => ({
  default: ({ content }: { content: string }) => <pre>{content}</pre>,
}));

vi.mock('@/components/NormalizedConversation/AstryxMarkdown', () => ({
  AstryxMarkdown: ({ value }: { value: string }) => (
    <div data-testid="wysiwyg">{value}</div>
  ),
}));

vi.mock('@/components/ConfigProvider', () => ({
  useUserSystem: () => ({ config: { theme: 'light' } }),
  useOptionalUserSystem: () => ({
    config: { theme: 'light', hide_model_thinking: false },
  }),
}));

vi.mock('@/components/dialogs/wysiwyg/ImagePreviewDialog', () => ({
  ImagePreviewDialog: { show: imageMocks.showPreview },
}));

vi.mock('@/hooks/useImageMetadata', () => ({
  useImageMetadata: imageMocks.useImageMetadata,
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

function render(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderUI(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

describe('conversation tool cards', () => {
  const clipboardWrite = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    // restoreAllMocks clears the setup's matchMedia vi.fn() implementation —
    // reinstall it so Astryx useMediaQuery (Spinner/theme) keeps working.
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    panelMocks.openFilePreview.mockReset();
    clipboardWrite.mockReset();
    imageMocks.showPreview.mockReset();
    imageMocks.useImageMetadata.mockReset();
    imageMocks.useImageMetadata.mockReturnValue({
      data: null,
      isLoading: false,
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({
        font: '',
        measureText: (text: string) => ({ width: text.length * 7 }),
        beginPath: () => {},
        arc: () => {},
        stroke: () => {},
      }),
    });
  });

  it.each([
    [{ status: 'created' }, 'running'],
    [{ status: 'pending_approval' }, 'pending'],
    [{ status: 'success' }, 'complete'],
    [{ status: 'failed' }, 'error'],
    [{ status: 'denied' }, 'error'],
    [{ status: 'timed_out' }, 'error'],
  ] as const)('maps tool status %o to Astryx status %s', (status, expected) => {
    expect(getToolChatStatus(status as ToolStatus)).toBe(expected);
  });

  it('keeps failed calls in their activity batch when status updates and prose arrives', () => {
    const commands: ContentBlock[] = Array.from({ length: 5 }, (_, index) => ({
      type: 'tool_use',
      tool_use_id: `failed-batch-${index}`,
      tool_name: 'bash',
      input_preview: JSON.stringify({ command: `batch-command-${index}` }),
      status: 'in_progress',
    }));
    const turn: MessageTurn = {
      id: 'failed-batch:assistant',
      role: 'assistant',
      blocks: commands.flatMap((block, index) =>
        block.type === 'tool_use' && index < 3
          ? [
              block,
              {
                type: 'tool_result',
                tool_use_id: block.tool_use_id,
                output_preview: `Partial output ${index}`,
                is_error: false,
              },
            ]
          : [block]
      ),
      timestamp: '2026-10-10T00:00:00.000Z',
    };
    const props = {
      attempt: { id: 'attempt-1', container_ref: null } as never,
      task: null,
      collapseProcess: false,
      phase: 'streaming' as const,
    };
    const { rerender } = render(<MessageTurnView {...props} turn={turn} />);
    const disclosure = screen.getByRole('button', { name: '运行 3 个命令' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');

    const failedCommands: ContentBlock[] = commands.flatMap((block, index) =>
      block.type === 'tool_use' && index < 3
        ? [
            { ...block, status: 'failed' },
            {
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              output_preview: index === 0 ? 'Permission denied' : null,
              is_error: true,
            },
          ]
        : [block]
    );
    rerender(
      <MessageTurnView {...props} turn={{ ...turn, blocks: failedCommands }} />
    );
    const updatedDisclosure = screen.getByRole('button', {
      name: '运行 3 个命令',
    });
    expect(updatedDisclosure).toHaveAttribute('aria-expanded', 'false');
    const group = updatedDisclosure.parentElement!;
    for (let index = 0; index < 3; index += 1) {
      const call = screen.getByRole('button', {
        name: new RegExp(`Error:.*batch-command-${index}`),
      });
      expect(group).toContainElement(call);
    }
    expect(group).not.toContainElement(screen.getByText('batch-command-3'));

    rerender(
      <MessageTurnView
        {...props}
        turn={{
          ...turn,
          blocks: [
            ...failedCommands,
            { type: 'text', text: 'Retrying safely' },
          ],
        }}
      />
    );
    const finalBatch = screen.getByRole('button', { name: '运行 5 个命令' });
    expect(finalBatch).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Retrying safely')).toBeInTheDocument();
    fireEvent.click(finalBatch);
    fireEvent.click(
      screen.getByRole('button', { name: /Error:.*batch-command-0/ })
    );
    expect(screen.getByText('Permission denied')).toBeInTheDocument();
  });

  it('aggregates failed file calls with thinking and folds them after the final answer', () => {
    const turn: MessageTurn = {
      id: 'failed-mixed-batch:assistant',
      role: 'assistant',
      timestamp: '2026-10-10T00:00:00.000Z',
      blocks: [
        {
          type: 'tool_use',
          tool_use_id: 'failed-read',
          tool_name: 'Running view_file',
          kind: 'read',
          status: 'failed',
          input_preview: JSON.stringify({ AbsolutePath: '/repo/denied.ts' }),
        },
        { type: 'thinking', text: 'Checking the denied file' },
        {
          type: 'tool_use',
          tool_use_id: 'failed-edit',
          tool_name: 'Edit',
          status: 'failed',
          input_preview: JSON.stringify({
            file_path: '/repo/locked.ts',
            old_string: 'before',
            new_string: 'after',
          }),
        },
        {
          type: 'tool_result',
          tool_use_id: 'failed-edit',
          output_preview: 'File is locked',
          is_error: true,
        },
        {
          type: 'tool_use',
          tool_use_id: 'later-read',
          tool_name: 'Read',
          status: 'completed',
          input_preview: JSON.stringify({ file_path: '/repo/available.ts' }),
        },
        {
          type: 'tool_use',
          tool_use_id: 'later-command',
          tool_name: 'bash',
          input_preview: JSON.stringify({ command: 'next-check' }),
        },
      ],
    };
    const props = {
      attempt: { id: 'attempt-1', container_ref: null } as never,
      task: null,
      phase: 'streaming' as const,
    };
    const { rerender } = render(<MessageTurnView {...props} turn={turn} />);
    const foldToggle = () =>
      screen
        .getAllByRole('button')
        .filter((button) =>
          button.classList.contains('conv-collapsed-process-toggle')
        )[0];
    const batch = foldToggle();
    expect(batch).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('denied.ts')).not.toBeInTheDocument();
    expect(screen.queryByText('locked.ts')).not.toBeInTheDocument();
    expect(screen.getByText('available.ts')).toBeInTheDocument();
    expect(screen.getByText('next-check')).toBeInTheDocument();

    const answeredTurn: MessageTurn = {
      ...turn,
      blocks: [...turn.blocks, { type: 'text', text: 'Final answer' }],
    };
    rerender(<MessageTurnView {...props} turn={answeredTurn} />);
    const process = foldToggle();
    expect(process).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Final answer')).toBeInTheDocument();
    expect(screen.queryByText('available.ts')).not.toBeInTheDocument();
    expect(screen.queryByText('next-check')).not.toBeInTheDocument();

    rerender(
      <MessageTurnView {...props} turn={answeredTurn} phase="settled" />
    );
    fireEvent.click(foldToggle());
    expect(
      screen.getByRole('button', {
        name: '运行 1 个命令、已读 2 个文件、已改 1 个文件',
      })
    ).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: /已读 2 个文件/ }));
    expect(
      screen.getByRole('button', { name: /Error:.*denied.ts/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Error:.*locked.ts/ })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开思考' }));
    expect(screen.getByText('Checking the denied file')).toBeInTheDocument();
  });

  it('displays tool description directly on the tool call row and omits description in expanded details', () => {
    const turn: MessageTurn = {
      id: 'tool-with-description:assistant',
      role: 'assistant',
      timestamp: '2026-10-10T00:00:00.000Z',
      blocks: [
        {
          type: 'tool_use',
          tool_use_id: 'described-cmd',
          tool_name: 'bash',
          input_preview: JSON.stringify({
            command: 'git status --short',
            description: '检查 Git 工作区状态',
            timeout: 5000,
          }),
          status: 'completed',
        },
        {
          type: 'tool_result',
          tool_use_id: 'described-cmd',
          output_preview: 'M frontend/src/App.tsx',
          is_error: false,
        },
      ],
    };

    render(
      <MessageTurnView
        turn={turn}
        phase="streaming"
        attempt={{ id: 'attempt-1', container_ref: null } as never}
        task={null}
      />
    );

    const row = screen.getByRole('button', { name: '检查 Git 工作区状态' });
    expect(row).toBeInTheDocument();
    expect(screen.queryByText('终端')).not.toBeInTheDocument();
    expect(screen.queryByText('git status --short')).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(screen.getByText('git status --short')).toBeInTheDocument();
    expect(screen.getByText('M frontend/src/App.tsx')).toBeInTheDocument();
    expect(screen.getByText('timeout')).toBeInTheDocument();
    expect(screen.getByText('5000')).toBeInTheDocument();
    expect(screen.queryByText('description')).not.toBeInTheDocument();
    expect(screen.getAllByText('检查 Git 工作区状态')).toHaveLength(1);
  });

  it('renders command output inside an expandable command card', () => {
    render(
      <CommandToolCard
        entry={toolEntry({
          toolName: 'shell',
          content: 'pnpm test',
          actionType: {
            action: 'command_run',
            category: 'other',
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

    expect(screen.getByText('终端')).toBeInTheDocument();
    expect(screen.getAllByText('pnpm test').length).toBeGreaterThan(0);
    expect(screen.getByText('exit 0')).toBeInTheDocument();
    expect(screen.getByText('all green')).toBeInTheDocument();
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
    expect(screen.queryByText('输出')).not.toBeInTheDocument();
  });

  it('renders only rich detail when hosted by an Astryx aggregate row', () => {
    render(
      <ToolCallResultDetail>
        <CommandToolCard
          entry={toolEntry({
            toolName: 'shell',
            content: 'pnpm test',
            actionType: {
              action: 'command_run',
              category: 'other',
              command: 'pnpm test',
              result: {
                exit_status: { type: 'exit_code', code: 0 },
                output: 'all green',
              },
            },
          })}
          expansionKey="aggregate-command-detail"
        />
      </ToolCallResultDetail>
    );

    expect(screen.queryByText('Terminal')).not.toBeInTheDocument();
    expect(screen.queryByText('终端')).not.toBeInTheDocument();
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
    expect(screen.getByText('exit 0')).toBeInTheDocument();
    expect(screen.getByText('all green')).toBeInTheDocument();
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
    expect(screen.queryByText('输出')).not.toBeInTheDocument();
  });

  it('omits the repeated terminal name inside an expanded terminal group', () => {
    render(
      <CommandToolCard
        entry={toolEntry({
          toolName: 'shell',
          content: 'pnpm test',
          actionType: {
            action: 'command_run',
            category: 'other',
            command: 'pnpm test',
            result: null,
          },
        })}
        expansionKey="grouped-command"
        hideLabel
      />
    );

    expect(screen.queryByText('Terminal')).not.toBeInTheDocument();
    expect(screen.queryByText('终端')).not.toBeInTheDocument();
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
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
            category: 'other',
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
            category: 'other',
            command: 'pnpm build',
            result: null,
          },
        })}
        expansionKey="running-command"
      />
    );

    expect(container.querySelector('.conv-tool-card-pending')).toBeTruthy();
    expect(container.querySelector('.conv-tool-dot-pending')).toBeTruthy();
    expect(
      container.querySelector('[data-tool-status="running"]')
    ).toBeTruthy();
  });

  it('keeps install script command output expanded by default', () => {
    render(
      <ToolCallCard
        entry={toolEntry({
          toolName: 'Tool Install Script',
          content: 'pnpm install',
          actionType: {
            action: 'command_run',
            category: 'other',
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

    expect(
      screen.getByText('installed https://example.com/package')
    ).toBeInTheDocument();
    expect(screen.queryByText('输出')).not.toBeInTheDocument();
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
        location: null,
      }
    );
  });

  it('shows the read range and returned file content with a directly clickable path', () => {
    render(
      <FileToolCard
        entry={toolEntry({
          toolName: 'Read',
          content: 'src/App.tsx',
          actionType: {
            action: 'file_read',
            path: 'src/App.tsx',
            line_start: 81,
            line_end: 120,
            content: 'export function App() {\n  return null;\n}',
          },
        })}
        expansionKey="file-range"
        containerRef="/workspace/project"
        forceExpanded
      />
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'src/App.tsx' })[0]);

    expect(panelMocks.openFilePreview).toHaveBeenCalledWith(
      '/workspace/project/src/App.tsx',
      {
        displayPath: 'src/App.tsx',
        title: 'src/App.tsx',
        location: { line: 81, column: 1, endLine: 120 },
      }
    );
    expect(screen.getByText('第 81–120 行')).toBeInTheDocument();
    expect(screen.getByText('81')).toBeInTheDocument();
    expect(screen.getByText(/export function App/)).toBeInTheDocument();
  });

  it('shows only the file name on the tool row and still opens the full path', () => {
    render(
      <FileToolCard
        entry={toolEntry({
          toolName: 'Read',
          content: '/Users/mac/Projects/foo/live_host.mjs',
          actionType: {
            action: 'file_read',
            path: '/Users/mac/Projects/foo/live_host.mjs',
          },
        })}
        expansionKey="file-name-only"
        containerRef="/workspace/project"
      />
    );

    expect(screen.getByText('live_host.mjs')).toBeInTheDocument();
    expect(
      screen.queryByText('/Users/mac/Projects/foo/live_host.mjs')
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', {
        name: '/Users/mac/Projects/foo/live_host.mjs',
      })
    );
    expect(panelMocks.openFilePreview).toHaveBeenCalledWith(
      '/Users/mac/Projects/foo/live_host.mjs',
      expect.objectContaining({ location: null })
    );
  });

  it('opens and copies web fetch targets without expanding the card', async () => {
    const { open } = await import('@tauri-apps/plugin-shell');
    vi.mocked(open).mockRejectedValueOnce(new Error('shell unavailable'));
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

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        'https://example.com/docs',
        '_blank',
        'noopener,noreferrer'
      )
    );
    await waitFor(() =>
      expect(clipboardWrite).toHaveBeenCalledWith('https://example.com/docs')
    );
    expect(screen.queryByText('URL')).not.toBeInTheDocument();
  });

  it('lists directory entries instead of raw list_dir arguments', () => {
    render(
      <ToolCallCard
        entry={toolEntry({
          toolName: 'list_dir',
          content: '/Users/mac/Projects/VibeX/frontend',
          actionType: {
            action: 'tool',
            tool_name: 'list_dir',
            arguments: { path: '/Users/mac/Projects/VibeX/frontend' },
            result: {
              type: { type: 'json' },
              value: 'src/\npackage.json\nREADME.md',
            },
          },
        })}
        expansionKey="list-dir"
      />
    );

    expect(screen.getByText('查看目录')).toBeInTheDocument();
    expect(screen.getByText('frontend')).toBeInTheDocument();
    expect(screen.queryByText(/target_directory/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /查看目录/ }));
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('keeps search parameters and the result summary inspectable', () => {
    const use: ToolUseBlock = {
      type: 'tool_use',
      tool_use_id: 'search-1',
      tool_name: 'search',
      kind: 'search',
      input_preview: JSON.stringify({
        query: 'session cancel',
        path: 'crates/conversations',
        maxResults: 20,
      }),
      meta: null,
    };
    const result: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: 'search-1',
      output_preview: [
        'crates/conversations/src/service.rs:41: cancel_session()',
        'crates/conversations/src/runtime.rs:88: session.cancel()',
      ].join('\n'),
      is_error: false,
      agent_stats: null,
    };
    const entry = toolBlockToNormalizedEntry(use, result, null);

    render(<ToolCallCard entry={entry} expansionKey="search-with-details" />);

    fireEvent.click(screen.getByRole('button', { name: /搜索/ }));

    expect(screen.queryByText('参数')).not.toBeInTheDocument();
    expect(screen.getByText('maxResults')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: '搜索结果' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(
      screen.getByText('crates/conversations/src/service.rs')
    ).toBeInTheDocument();
    expect(screen.getByText('cancel_session()')).toBeInTheDocument();
  });

  it('shows the search query and a URL list instead of the raw payload', () => {
    const payload = {
      action: {
        type: 'search',
        query: 'site:github.com vibex workflow creator plugin',
        sources: [
          { type: 'url', url: '' },
          {
            type: 'url',
            url: 'https://github.com/jfmaes/awesome-ai-workflow',
          },
        ],
      },
      status: 'completed',
    };
    render(
      <SearchToolCard
        entry={toolEntry({
          toolName: '搜索',
          actionType: {
            action: 'search',
            query: 'site:github.com vibex workflow creator plugin',
            result: {
              type: { type: 'json' },
              value: payload,
            },
          },
        })}
        expansionKey="web-search-payload"
        forceExpanded
      />
    );

    expect(
      screen.getByText('site:github.com vibex workflow creator plugin')
    ).toBeInTheDocument();
    expect(
      screen.getByText('https://github.com/jfmaes/awesome-ai-workflow')
    ).toBeInTheDocument();
    expect(screen.queryByText(/"status": "completed"/)).not.toBeInTheDocument();
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

    expect(screen.getByText('streamdown')).toBeInTheDocument();
    expect(screen.queryByText('参数')).not.toBeInTheDocument();
    expect(screen.queryByText(/"total": 3/)).not.toBeInTheDocument();
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

    expect(
      container.querySelector('[data-testid="conversation-plan-card"]')
    ).toBeTruthy();
    expect(screen.getByText('Ship rendering')).toBeInTheDocument();
    expect(screen.getByText('1 / 2 已完成')).toBeInTheDocument();
  });

  it('keeps a pending plan approval expanded with a confirmation banner', () => {
    render(
      <ToolCallCard
        entry={toolEntry({
          toolName: 'plan',
          status: {
            status: 'pending_approval',
            approval_id: 'approval-1',
            requested_at: '2026-08-21T00:00:00Z',
            timeout_at: '2026-08-21T00:05:00Z',
          },
          actionType: {
            action: 'plan_presentation',
            plan: '1. [in_progress] Review the proposed plan',
          },
        })}
        expansionKey="plan-approval"
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent('等待确认');
    expect(screen.getByText('Review the proposed plan')).toBeInTheDocument();
  });

  it('renders file edits as an inline unified diff preview', () => {
    render(
      <UnifiedDiffPreview
        path="src/App.tsx"
        change={{
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
        }}
        expansionKey="inline-diff"
        containerRef="/workspace/project"
      />
    );

    expect(screen.getByText('修改')).toBeInTheDocument();
    expect(screen.getByText('src/App.tsx')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('-1')).toBeInTheDocument();

    fireEvent.click(screen.getByText('src/App.tsx'));
    expect(panelMocks.openFilePreview).toHaveBeenCalledWith(
      '/workspace/project/src/App.tsx',
      {
        mode: 'diff',
        diffViewMode: 'inline',
        displayPath: 'src/App.tsx',
        title: 'src/App.tsx',
      }
    );
  });

  it('shows fetched page content instead of only repeating its URL', () => {
    const entry = toolBlockToNormalizedEntry(
      {
        type: 'tool_use',
        tool_use_id: 'fetch-page',
        tool_name: 'web_fetch',
        kind: 'fetch',
        meta: null,
        input_preview: JSON.stringify({ url: 'https://example.com/docs' }),
      },
      {
        type: 'tool_result',
        tool_use_id: 'fetch-page',
        is_error: false,
        agent_stats: null,
        output_preview: 'Fetched documentation body',
      },
      null
    );
    render(
      <ToolCallResultDetail>
        <ToolCallCard entry={entry} expansionKey="fetch-page" />
      </ToolCallResultDetail>
    );
    expect(screen.getByText('Fetched documentation body')).toBeInTheDocument();
  });

  it('formats unknown tool arguments and structured results in expanded details', () => {
    render(
      <ToolCallResultDetail>
        <GenericToolCard
          entry={toolEntry({
            toolName: 'custom_inspect',
            actionType: {
              action: 'tool',
              tool_name: 'custom_inspect',
              arguments: { scope: 'workspace' },
              result: {
                type: { type: 'json' },
                value: { matched: 3, duration_ms: 12 },
              },
            },
          })}
          expansionKey="generic-fields"
        />
      </ToolCallResultDetail>
    );
    expect(screen.getByText('scope')).toBeInTheDocument();
    expect(screen.getByText('workspace')).toBeInTheDocument();
    expect(screen.getByText('matched')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('duration_ms')).toBeInTheDocument();
  });

  it('shows browser code and formatted output when its aggregate detail is opened', () => {
    render(
      <ToolCallResultDetail>
        <ToolCallCard
          entry={toolEntry({
            toolName: 'browser_eval',
            actionType: {
              action: 'tool',
              tool_name: 'browser_eval',
              arguments: { tabId: 'tab-1', code: 'document.title' },
              result: { type: { type: 'json' }, value: { title: 'VibeX' } },
            },
          })}
          expansionKey="browser-detail"
        />
      </ToolCallResultDetail>
    );
    expect(screen.getByText('document.title')).toBeInTheDocument();
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByText('VibeX')).toBeInTheDocument();
  });

  it('preserves both terminal streams and the reported exit code in timeline details', () => {
    const entry = toolBlockToNormalizedEntry(
      {
        type: 'tool_use',
        tool_use_id: 'shell-output',
        tool_name: 'exec_command',
        kind: 'execute',
        meta: null,
        input_preview: JSON.stringify({ cmd: 'pnpm test' }),
      },
      {
        type: 'tool_result',
        tool_use_id: 'shell-output',
        is_error: true,
        agent_stats: null,
        output_preview: JSON.stringify({
          stdout: 'running tests',
          stderr: 'assertion failed',
          exit_code: 23,
        }),
      },
      null
    );
    render(
      <ToolCallResultDetail>
        <CommandToolCard entry={entry} expansionKey="terminal-streams" />
      </ToolCallResultDetail>
    );
    expect(screen.getByText(/running tests/)).toBeInTheDocument();
    expect(screen.getByText(/assertion failed/)).toBeInTheDocument();
    expect(screen.getByText('exit 23')).toBeInTheDocument();
  });

  it('highlights the inspected file range and shows matching surrounding lines', async () => {
    vi.spyOn(fileTreeApi, 'readFileWithTruncation').mockResolvedValue({
      content: 'before\ninspected\nafter',
      truncated: false,
    });
    const { container } = render(
      <ToolCallResultDetail>
        <FileToolCard
          entry={toolEntry({
            toolName: 'Read',
            actionType: {
              action: 'file_read',
              path: 'src/read.ts',
              line_start: 2,
              line_end: 2,
              content: 'inspected',
            },
          })}
          expansionKey="read-context"
          containerRef={'C:\\workspace'}
        />
      </ToolCallResultDetail>
    );

    await waitFor(() => expect(container).toHaveTextContent('before'));
    expect(container).toHaveTextContent('after');
    expect(screen.getByText('inspected').closest('[role="row"]')).toHaveClass(
      'is-inspected'
    );
    expect(screen.getByText('before').closest('[role="row"]')).not.toHaveClass(
      'is-inspected'
    );
    expect(fileTreeApi.readFileWithTruncation).toHaveBeenCalledWith(
      'C:\\workspace\\src\\read.ts',
      256_000
    );
  });

  it('uses the resolved workspace root for read details without an attempt directory', async () => {
    vi.spyOn(fileTreeApi, 'readFileWithTruncation').mockResolvedValue({
      content: 'before\ninspected\nafter',
      truncated: false,
    });
    const { container } = render(
      <ToolCallResultDetail>
        <DisplayConversationEntry
          entry={toolEntry({
            actionType: {
              action: 'file_read',
              path: 'src/read.ts',
              content: 'inspected',
              line_start: 2,
            },
          })}
          expansionKey="resolved-read"
          workspacePath="C:/workspace"
          toolDetailOnly
        />
      </ToolCallResultDetail>
    );
    await waitFor(() => expect(container).toHaveTextContent('before'));
    expect(fileTreeApi.readFileWithTruncation).toHaveBeenCalledWith(
      'C:/workspace/src/read.ts',
      256_000
    );
  });

  it('renders Antigravity view_file with its path, range and inspected content', async () => {
    const entry = toolBlockToNormalizedEntry(
      {
        type: 'tool_use',
        tool_use_id: 'antigravity-view',
        tool_name: 'Running view_file',
        kind: 'other',
        meta: null,
        input_preview: JSON.stringify({
          AbsolutePath: 'C:/workspace/src/read.ts',
          StartLine: 12,
          EndLine: 13,
        }),
      },
      {
        type: 'tool_result',
        tool_use_id: 'antigravity-view',
        output_preview: '12: const enabled = true;\n13: export { enabled };',
        is_error: false,
      },
      null
    );
    const { container } = render(
      <DisplayConversationEntry entry={entry} expansionKey="antigravity-view" />
    );
    fireEvent.click(screen.getByRole('button', { name: /查看/ }));
    expect(container).toHaveTextContent('C:/workspace/src/read.ts');
    await waitFor(() =>
      expect(container).toHaveTextContent('const enabled = true;')
    );
    expect(container.querySelectorAll('.is-inspected')).toHaveLength(2);
    expect(screen.queryByText('Running view_file')).toBeNull();
  });

  it.each([
    ['in_progress', 'partial output', 'running'],
    ['completed', null, 'complete'],
    ['failed', null, 'error'],
  ])(
    'uses reported ACP status %s independently of tool output',
    (status, output, expected) => {
      const use = {
        type: 'tool_use' as const,
        tool_use_id: 'status-read',
        tool_name: 'Running view_file',
        status,
        input_preview: JSON.stringify({ AbsolutePath: 'src/read.ts' }),
      };
      const entry = toolBlockToNormalizedEntry(
        use,
        output
          ? {
              type: 'tool_result',
              tool_use_id: 'status-read',
              output_preview: output,
              is_error: false,
            }
          : null,
        null
      );
      const { container } = render(
        <DisplayConversationEntry
          entry={entry}
          expansionKey={`status-${status}`}
        />
      );
      expect(container.querySelector('[data-tool-status]')).toHaveAttribute(
        'data-tool-status',
        expected
      );
    }
  );

  it('renders timeline replacements as a diff instead of raw patch text', () => {
    const entry = toolBlockToNormalizedEntry(
      {
        type: 'tool_use',
        tool_use_id: 'replacement',
        tool_name: 'Edit',
        kind: 'edit',
        meta: null,
        input_preview: JSON.stringify({
          file_path: 'src/config.ts',
          old_string: 'const enabled = false;',
          new_string: 'const enabled = true;',
        }),
      },
      {
        type: 'tool_result',
        tool_use_id: 'replacement',
        output_preview: 'File updated',
        is_error: false,
        agent_stats: null,
      },
      null
    );
    if (
      entry.entry_type.type !== 'tool_use' ||
      entry.entry_type.action_type.action !== 'file_edit'
    ) {
      throw new Error('Expected a file edit');
    }
    const { path, changes } = entry.entry_type.action_type;
    const { container } = render(
      <ToolCallResultDetail>
        <UnifiedDiffPreview
          path={path}
          change={changes[0]}
          expansionKey="timeline-replacement"
        />
      </ToolCallResultDetail>
    );

    expect(container.querySelector('.conv-tool-diff-fallback')).toBeNull();
    expect(container.querySelector('table')).toBeInTheDocument();
    expect(container).toHaveTextContent('const enabled = false;');
    expect(container).toHaveTextContent('const enabled = true;');
  });

  it('shows a file edit snippet immediately inside an aggregate row', () => {
    const { container } = render(
      <ToolCallResultDetail>
        <UnifiedDiffPreview
          path="frontend/src/styles/legacy/index.css"
          change={{
            action: 'edit',
            unified_diff: '+  display: flex;',
            has_line_numbers: true,
          }}
          expansionKey="aggregate-diff"
        />
      </ToolCallResultDetail>
    );

    expect(screen.queryByText('修改')).not.toBeInTheDocument();
    expect(container.querySelector('.conv-tool-artifact-body')).toBeTruthy();
    expect(screen.getByText(/\+\s+display: flex;/)).toBeInTheDocument();
  });

  it('renders apply_patch fragments as a highlighted diff', () => {
    const entry = toolBlockToNormalizedEntry(
      {
        type: 'tool_use',
        tool_use_id: 'patch',
        tool_name: 'apply_patch',
        kind: 'edit',
        meta: null,
        input_preview: JSON.stringify({
          patch: [
            '*** Begin Patch',
            '*** Update File: src/theme.css',
            '@@',
            '-color: red;',
            '+color: blue;',
            '*** End Patch',
          ].join('\n'),
        }),
      },
      null,
      null
    );
    if (
      entry.entry_type.type !== 'tool_use' ||
      entry.entry_type.action_type.action !== 'file_edit'
    ) {
      throw new Error('Expected a file edit');
    }
    const action = entry.entry_type.action_type;
    const { container } = render(
      <ToolCallResultDetail>
        <UnifiedDiffPreview
          path={action.path}
          change={action.changes[0]}
          expansionKey="patch-fragment"
        />
      </ToolCallResultDetail>
    );
    expect(container.querySelector('.conv-tool-diff-fallback')).toBeNull();
    expect(container.querySelector('table')).toBeInTheDocument();
    expect(container).toHaveTextContent('color: red;');
    expect(container).toHaveTextContent('color: blue;');
  });

  it('shows every replacement from a MultiEdit call in the actual detail renderer', () => {
    const entry = toolBlockToNormalizedEntry(
      {
        type: 'tool_use',
        tool_use_id: 'multi-edit',
        tool_name: 'MultiEdit',
        kind: 'edit',
        meta: null,
        input_preview: JSON.stringify({
          file_path: 'src/config.ts',
          edits: [
            { old_string: 'const first = 1;', new_string: 'const first = 2;' },
            {
              old_string: 'const second = 3;',
              new_string: 'const second = 4;',
            },
          ],
        }),
      },
      null,
      null
    );
    const { container } = render(
      <ToolCallResultDetail>
        <DisplayConversationEntry
          entry={entry}
          expansionKey="multi-edit"
          toolDetailOnly
        />
      </ToolCallResultDetail>
    );
    expect(container).toHaveTextContent('const first = 2;');
    expect(container).toHaveTextContent('const second = 4;');
    expect(container.querySelectorAll('table')).toHaveLength(2);
  });

  it('keeps file identities and all hunks in a patch touching several files', () => {
    const entry = toolBlockToNormalizedEntry(
      {
        type: 'tool_use',
        tool_use_id: 'files-patch',
        tool_name: 'apply_patch',
        kind: 'edit',
        meta: null,
        input_preview: JSON.stringify(
          [
            '*** Begin Patch',
            '*** Update File: src/first.ts',
            '@@',
            '-firstOld',
            '+firstNew',
            '@@ function other',
            '-secondOld',
            '+secondNew',
            '*** Add File: src/second.ts',
            '+created',
            '*** End Patch',
          ].join('\n')
        ),
      },
      null,
      null
    );
    const { container } = render(
      <ToolCallResultDetail>
        <DisplayConversationEntry
          entry={entry}
          expansionKey="files-patch"
          toolDetailOnly
        />
      </ToolCallResultDetail>
    );
    expect(container).toHaveTextContent('src/first.ts');
    expect(container).toHaveTextContent('src/second.ts');
    expect(container).toHaveTextContent('firstNew');
    expect(container).toHaveTextContent('secondNew');
    expect(container).toHaveTextContent('created');
    expect(container.querySelector('.conv-tool-diff-fallback')).toBeNull();
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

    expect(screen.getByText('Deploy now?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看详情' }));
    expect(screen.getByText('yes').closest('label')).toHaveClass('is-answered');
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
    expect(screen.getAllByText('visual polish')[0]).toBeInTheDocument();
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

  it('routes structured timeline goal results to the existing goal component', () => {
    const entry = toolBlockToNormalizedEntry(
      {
        type: 'tool_use',
        tool_use_id: 'goal-result',
        tool_name: 'get_goal',
        kind: 'other',
        meta: null,
        input_preview: '{}',
      },
      {
        type: 'tool_result',
        tool_use_id: 'goal-result',
        is_error: false,
        agent_stats: null,
        output_preview: JSON.stringify({
          objective: 'Ship rich details',
          status: 'active',
          elapsed_seconds: 12,
        }),
      },
      null
    );
    render(
      <ToolCallResultDetail>
        <ToolCallCard entry={entry} expansionKey="goal-result" />
      </ToolCallResultDetail>
    );
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText('elapsed_seconds')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('routes generated images to an image result card', () => {
    const { container } = render(
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

    expect(screen.getByText('完成')).toBeInTheDocument();
    expect(
      screen.getAllByText('Compact dashboard preview').length
    ).toBeGreaterThan(0);
    expect(
      screen.getByRole('img', { name: 'Compact dashboard preview' })
    ).toHaveAttribute('src', 'data:image/png;base64,abc123');
    expect(screen.getAllByText('Dashboard preview')[0]).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '预览生成图片' }));

    expect(imageMocks.showPreview).toHaveBeenCalledWith({
      imageUrl: 'data:image/png;base64,abc123',
      altText: 'Compact dashboard preview',
      fileName: 'Compact dashboard preview',
      format: undefined,
      sizeBytes: undefined,
    });
    expect(container.querySelector('.conv-generated-image-preview'))
      .toMatchInlineSnapshot(`
        <button
          aria-label="预览生成图片"
          class="conv-generated-image-preview"
          title="预览生成图片"
          type="button"
        >
          <img
            alt="Compact dashboard preview"
            class="max-h-64 max-w-full rounded-md border border-border object-contain"
            src="data:image/png;base64,abc123"
          />
        </button>
      `);
  });

  it('shows generated image failures and metadata-backed local images', () => {
    const failedEntry = toolEntry({
      toolName: 'generate_image',
      actionType: {
        action: 'tool',
        tool_name: 'generate_image',
        arguments: { prompt: 'Dashboard preview' },
        result: {
          type: { type: 'json' },
          value: {
            status: 'failed',
            error: 'quota exceeded',
          },
        },
      },
      status: { status: 'failed' },
    });

    const { rerender } = render(
      <ToolCallCard entry={failedEntry} expansionKey="generated-image-failed" />
    );

    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getAllByText('quota exceeded')[0]).toBeInTheDocument();

    imageMocks.useImageMetadata.mockReturnValue({
      data: {
        exists: true,
        file_name: 'generated.png',
        path: '.vibe-images/generated.png',
        size_bytes: 456n,
        format: 'png',
        proxy_url: 'asset://generated.png',
      },
      isLoading: false,
    });

    rerender(
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
                image: '.vibe-images/generated.png',
              },
            },
          },
        })}
        expansionKey="generated-image-local"
        taskAttemptId="attempt-1"
      />
    );

    expect(imageMocks.useImageMetadata).toHaveBeenLastCalledWith(
      'attempt-1',
      '.vibe-images/generated.png'
    );
    expect(
      screen.getByRole('img', { name: 'Dashboard preview' })
    ).toHaveAttribute('src', 'asset://generated.png');
  });
});
