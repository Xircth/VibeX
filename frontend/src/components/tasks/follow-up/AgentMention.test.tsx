import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import type { BackendTransport } from '@/lib/backendTransport';
import { AgentMentionProvider } from './AgentMention';
import { SessionComposerInput } from './SessionComposerInput';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function ComposerHarness({
  transport,
  initialMessage = '',
  conversationId = 'parent-1',
}: {
  transport: BackendTransport;
  initialMessage?: string;
  conversationId?: string;
}) {
  const [message, setMessage] = useState(initialMessage);

  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <AgentMentionProvider
        transport={transport}
        conversationId={conversationId}
      >
        <SessionComposerInput
          value={message}
          images={[]}
          onChange={setMessage}
          onSubmit={vi.fn()}
          onAttachImages={vi.fn()}
          onRemoveImage={vi.fn()}
        />
        <output aria-label="Serialized composer value">{message}</output>
      </AgentMentionProvider>
    </QueryClientProvider>
  );
}

describe('AgentMention', () => {
  it('selects an agent at a token boundary and inserts its stable URI', async () => {
    const calls: string[] = [];
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async (command) => {
        calls.push(command);
        if (command === 'agent_management_bar') {
          return [
            {
              agent_id: 'codex',
              display_name: 'Codex',
              enabled: true,
              lifecycle: 'ready',
              active_operation: null,
            },
          ];
        }
        if (command === 'conversation_detail') {
          return {
            active_binding: {
              capabilities: { mcp_servers: true },
            },
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
    };
    const user = userEvent.setup();

    render(<ComposerHarness transport={transport} />);
    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.type(editor, 'Ask &Co');
    await user.click(await screen.findByRole('option', { name: /Codex/ }));

    expect(screen.getByTestId('session-composer-token-chip')).toHaveTextContent(
      '&Codex'
    );
    expect(screen.getByLabelText('Serialized composer value').textContent).toBe(
      'Ask [&Codex](vibex://agent/codex) '
    );
    expect(calls).toContain('agent_management_bar');
    expect(screen.queryByText('运行中')).toBeNull();
  });

  it.each([
    ['ordinary text', 'A&B'],
    ['a URL', 'https://example.test/?a&Co'],
    ['escaped text', String.raw`\&Co`],
    ['inline code', '`delegate &Co`'],
    ['a fenced code block', '```\n&Co'],
    ['an indented code block', '    &Co'],
    ['fence-like content inside a code block', '```\n``` still code &Co'],
  ])('does not trigger inside %s', async (_case, text) => {
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async (command) => {
        if (command === 'agent_management_bar') {
          return [
            {
              agent_id: 'codex',
              display_name: 'Codex',
              enabled: true,
              lifecycle: 'ready',
              active_operation: null,
            },
          ];
        }
        return null;
      }),
    };
    const user = userEvent.setup();

    render(<ComposerHarness transport={transport} />);
    await waitFor(() =>
      expect(transport.call).toHaveBeenCalledWith('agent_management_bar')
    );
    await user.click(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), text);

    expect(screen.queryByRole('option', { name: /Codex/ })).toBeNull();
  });

  it('copies a selected mention as its stable URI', async () => {
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async () => []),
    };
    render(
      <ComposerHarness
        transport={transport}
        initialMessage="[&Old Codex Name](vibex://agent/codex)"
      />
    );
    await waitFor(() =>
      expect(transport.call).toHaveBeenCalledWith('agent_management_bar')
    );
    const editor = screen.getByRole('textbox');
    const chip = screen.getByTestId('session-composer-token-chip');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNode(chip);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const setData = vi.fn();

    fireEvent.copy(editor, {
      clipboardData: { setData },
    });

    expect(setData).toHaveBeenCalledWith(
      'text/plain',
      '[&Old Codex Name](vibex://agent/codex)'
    );
  });

  it('keeps the stable agent kind when its display name changes', async () => {
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async () => [
        {
          agent_id: 'codex',
          display_name: 'Codex Next',
          enabled: true,
          lifecycle: 'ready',
          active_operation: null,
        },
      ]),
    };

    render(
      <ComposerHarness
        transport={transport}
        initialMessage="[&Former Name](vibex://agent/codex)"
      />
    );

    await waitFor(() =>
      expect(
        screen.getByTestId('session-composer-token-chip')
      ).toHaveTextContent('&Codex Next')
    );
    expect(screen.getByLabelText('Serialized composer value').textContent).toBe(
      '[&Former Name](vibex://agent/codex)'
    );
  });

  it('explains when the parent agent cannot run the companion', async () => {
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async (command) => {
        if (command === 'agent_management_bar') {
          return [
            {
              agent_id: 'codex',
              display_name: 'Codex',
              enabled: true,
              lifecycle: 'ready',
              active_operation: null,
            },
          ];
        }
        if (command === 'conversation_detail') {
          return {
            active_binding: {
              capabilities: { mcp_servers: false },
            },
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
    };
    const user = userEvent.setup();

    render(<ComposerHarness transport={transport} />);
    await user.click(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), '&');

    expect(
      await screen.findByRole('status', {
        name: '当前父 Agent 不支持 VibeX companion，Mention 不会启动委派。',
      })
    ).toBeVisible();
    expect(transport.call).toHaveBeenCalledWith('conversation_detail', {
      sessionId: 'parent-1',
    });
    expect(screen.getByRole('option', { name: /Codex/ })).toBeVisible();
  });

  it('localizes the companion capability hint in English', async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async (command) => {
        if (command === 'agent_management_bar') {
          return [
            {
              agent_id: 'codex',
              display_name: 'Codex',
              enabled: true,
              lifecycle: 'ready',
              active_operation: null,
            },
          ];
        }
        if (command === 'conversation_detail') {
          return {
            active_binding: {
              capabilities: { mcp_servers: false },
            },
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
    };
    const user = userEvent.setup();

    render(<ComposerHarness transport={transport} />);
    await user.click(screen.getByRole('textbox', { name: 'Message' }));
    await user.type(screen.getByRole('textbox', { name: 'Message' }), '&');

    expect(
      await screen.findByRole('status', {
        name: 'The current parent agent does not support the VibeX companion, so this mention will not start a delegation.',
      })
    ).toBeVisible();

    await act(async () => {
      await i18n.changeLanguage('zh-CN');
    });
  });

  it('does not reuse a previous parent capability for a new conversation', async () => {
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async (command, args) => {
        if (command === 'agent_management_bar') {
          return [
            {
              agent_id: 'codex',
              display_name: 'Codex',
              enabled: true,
              lifecycle: 'ready',
              active_operation: null,
            },
          ];
        }
        if (command === 'conversation_detail') {
          return args?.sessionId === 'parent-1'
            ? {
                active_binding: {
                  capabilities: { mcp_servers: false },
                },
              }
            : { active_binding: null };
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
    };
    const user = userEvent.setup();
    const view = render(
      <ComposerHarness transport={transport} conversationId="parent-1" />
    );

    await user.click(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), '&');
    const capabilityName =
      '当前父 Agent 不支持 VibeX companion，Mention 不会启动委派。';
    expect(
      await screen.findByRole('status', { name: capabilityName })
    ).toBeVisible();

    view.rerender(
      <ComposerHarness transport={transport} conversationId="parent-2" />
    );
    await waitFor(() =>
      expect(transport.call).toHaveBeenCalledWith('conversation_detail', {
        sessionId: 'parent-2',
      })
    );
    expect(
      screen.queryByRole('status', { name: capabilityName })
    ).not.toBeInTheDocument();
  });

  it('selects a mention with the keyboard', async () => {
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async (command) =>
        command === 'agent_management_bar'
          ? [
              {
                agent_id: 'codex',
                display_name: 'Codex',
                enabled: true,
                lifecycle: 'ready',
                active_operation: null,
              },
            ]
          : null
      ),
    };
    const user = userEvent.setup();

    render(<ComposerHarness transport={transport} />);
    const editor = screen.getByRole('textbox');
    await user.click(editor);
    await user.type(editor, '&Co');
    await screen.findByRole('option', { name: /Codex/ });
    await user.keyboard('{Enter}');

    expect(screen.getByTestId('session-composer-token-chip')).toHaveTextContent(
      '&Codex'
    );
  });

  it('restores a pasted stable mention as an atomic chip', async () => {
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async () => []),
    };

    render(<ComposerHarness transport={transport} />);
    const editor = screen.getByRole('textbox');
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        types: ['text/plain'],
        getData: (type: string) =>
          type === 'text/plain' ? '[&Codex](vibex://agent/codex)' : '',
      },
    });

    expect(
      await screen.findByTestId('session-composer-token-chip')
    ).toHaveTextContent('&Codex');
  });

  it('keeps a stable mention URI as text when pasted inside code', async () => {
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async () => []),
    };

    render(<ComposerHarness transport={transport} />);
    const editor = screen.getByRole('textbox');
    fireEvent.paste(editor, {
      clipboardData: {
        files: [],
        types: ['text/plain'],
        getData: (type: string) =>
          type === 'text/plain'
            ? '```\n[&Codex](vibex://agent/codex)\n```'
            : '',
      },
    });

    await waitFor(() =>
      expect(
        screen.getByLabelText('Serialized composer value').textContent
      ).toBe('```\n[&Codex](vibex://agent/codex)\n```')
    );
    expect(
      screen.queryByTestId('session-composer-token-chip')
    ).not.toBeInTheDocument();
  });

  it('deletes a whole mention with one Backspace', async () => {
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async () => []),
    };

    render(
      <ComposerHarness
        transport={transport}
        initialMessage="[&Codex](vibex://agent/codex)"
      />
    );
    const editor = screen.getByRole('textbox');
    const chip = screen.getByTestId('session-composer-token-chip');
    const range = document.createRange();
    range.setStartAfter(chip);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.keyDown(editor, { key: 'Backspace' });

    await waitFor(() =>
      expect(
        screen.queryByTestId('session-composer-token-chip')
      ).not.toBeInTheDocument()
    );
    expect(
      screen.getByLabelText('Serialized composer value')
    ).toBeEmptyDOMElement();
  });
});
