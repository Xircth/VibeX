import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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
          onChange={setMessage}
          onSubmit={vi.fn()}
          onAttachImages={vi.fn()}
        />
        <output aria-label="Serialized composer value">{message}</output>
      </AgentMentionProvider>
    </QueryClientProvider>
  );
}

function codexTransport(): BackendTransport {
  return {
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
            delegation_mcp_delivered: true,
          },
        };
      }
      if (command === 'plugin_control_catalog') {
        return {
          plugins: [{ id: 'vibex.multi-agent', enabled: true }],
          runtimes: [],
        };
      }
      return null;
    }),
  };
}

function getEditor(): HTMLDivElement {
  const surface = screen.getByTestId('session-composer-editor');
  return surface.querySelector('[contenteditable="true"]') as HTMLDivElement;
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
              delegation_mcp_delivered: true,
            },
          };
        }
        if (command === 'plugin_control_catalog') {
          return {
            plugins: [{ id: 'vibex.multi-agent', enabled: true }],
            runtimes: [],
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
    };
    const user = userEvent.setup();

    render(<ComposerHarness transport={transport} />);
    const editor = getEditor();
    await user.click(editor);
    await user.type(editor, 'Ask &Co');
    await user.click(await screen.findByRole('option', { name: /Codex/ }));

    expect(screen.getByLabelText('Serialized composer value').textContent).toBe(
      'Ask [&Codex](vibex://agent/codex)\u00A0'
    );
    expect(calls).toContain('agent_management_bar');
  });

  it('selects a mention with the keyboard', async () => {
    const transport = codexTransport();
    const user = userEvent.setup();

    render(<ComposerHarness transport={transport} />);
    const editor = getEditor();
    await user.click(editor);
    await user.type(editor, '&Co');
    await screen.findByRole('option', { name: /Codex/ });
    await user.keyboard('{Enter}');

    expect(screen.getByLabelText('Serialized composer value').textContent).toBe(
      '[&Codex](vibex://agent/codex)\u00A0'
    );
  });

  it('does not trigger when & is not at a word boundary', async () => {
    const transport = codexTransport();
    const user = userEvent.setup();

    render(<ComposerHarness transport={transport} />);
    const editor = getEditor();
    await user.click(editor);
    // `A&B` keeps `&` mid-word — no menu should open.
    await user.type(editor, 'A&B');

    expect(screen.queryByRole('option', { name: /Codex/ })).toBeNull();
  });

  it('deletes a whole mention with one Backspace', async () => {
    const transport = codexTransport();
    const user = userEvent.setup();

    render(<ComposerHarness transport={transport} />);
    const editor = getEditor();
    await user.click(editor);
    await user.type(editor, '&Co');
    await user.click(await screen.findByRole('option', { name: /Codex/ }));

    // jsdom does not keep the caret Astryx placed after the token's trailing
    // NBSP; restore it so the built-in Backspace handling runs.
    const tokenSpan = editor.querySelector('[data-astryx-token]');
    const nbsp = tokenSpan?.nextSibling;
    if (nbsp) {
      const range = document.createRange();
      range.setStart(nbsp, 1);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    await user.keyboard('{Backspace}');

    await waitFor(() =>
      expect(
        screen.getByLabelText('Serialized composer value').textContent
      ).toBe('')
    );
  });

  it('does not offer mentions when the collaboration plugin is off', async () => {
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
          return { active_binding: { delegation_mcp_delivered: true } };
        }
        if (command === 'plugin_control_catalog') {
          return {
            plugins: [{ id: 'vibex.multi-agent', enabled: false }],
            runtimes: [],
          };
        }
        return null;
      }),
    };
    const user = userEvent.setup();
    render(<ComposerHarness transport={transport} />);
    const editor = getEditor();
    await user.click(editor);
    await user.type(editor, '&Co');
    expect(screen.queryByRole('option', { name: /Codex/ })).toBeNull();
  });

  it('does not offer mentions until this conversation has been delivered', async () => {
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
          return { active_binding: { delegation_mcp_delivered: false } };
        }
        if (command === 'plugin_control_catalog') {
          return {
            plugins: [{ id: 'vibex.multi-agent', enabled: true }],
            runtimes: [],
          };
        }
        return null;
      }),
    };
    const user = userEvent.setup();
    render(<ComposerHarness transport={transport} />);
    const editor = getEditor();
    await user.click(editor);
    await user.type(editor, '&Co');
    expect(screen.queryByRole('option', { name: /Codex/ })).toBeNull();
  });
});
