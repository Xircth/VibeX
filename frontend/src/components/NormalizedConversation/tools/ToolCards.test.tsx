import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionType, NormalizedEntry, ToolStatus } from 'shared/types';
import { ToolCallCard } from '../ToolCallCard';
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
  useOptionalUserSystem: () => null,
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

    fireEvent.click(screen.getByRole('button', { name: /Terminal/ }));

    expect(screen.getAllByText('命令')).toHaveLength(1);
    expect(screen.getByText('Terminal')).toBeInTheDocument();
    expect(screen.getAllByText('pnpm test')).toHaveLength(2);
    expect(screen.getByText('输出')).toBeInTheDocument();
    expect(screen.getByText('all green')).toBeInTheDocument();
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
    expect(screen.getByText('命令')).toBeInTheDocument();
    expect(screen.getByText('输出')).toBeInTheDocument();
    expect(screen.getByText('all green')).toBeInTheDocument();
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
    // The Tauri shell plugin is unavailable in jsdom, so the system-browser
    // opener falls back to window.open.
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
      output_preview: '2 matches in crates/conversations/src/service.rs',
      is_error: false,
      agent_stats: null,
    };
    const entry = toolBlockToNormalizedEntry(use, result, null);

    render(<ToolCallCard entry={entry} expansionKey="search-with-details" />);

    fireEvent.click(screen.getByRole('button', { name: /搜索/ }));

    expect(screen.getByText('参数')).toBeInTheDocument();
    expect(
      screen.getByText(/"path": "crates\/conversations"/)
    ).toBeInTheDocument();
    expect(screen.getByText(/"maxResults": 20/)).toBeInTheDocument();
    expect(screen.getByText('结果')).toBeInTheDocument();
    expect(
      screen.getByText('2 matches in crates/conversations/src/service.rs')
    ).toBeInTheDocument();
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

    expect(screen.getByText('Edit')).toBeInTheDocument();
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
    expect(screen.getByText('修订提示词')).toBeInTheDocument();
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
