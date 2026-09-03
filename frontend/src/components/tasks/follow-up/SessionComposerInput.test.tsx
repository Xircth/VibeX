import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import {
  SessionComposerAttachmentDrawer,
  SessionComposerInput,
} from './SessionComposerInput';
import { formatSessionComposerCommand } from './sessionComposerStructuredTokens';
import type { FileReferencePayload } from '@/utils/fileReferences';
import { setCurrentDraggedFileReference } from '@/utils/fileReferenceDrag';
import { tagsApi } from '@/lib/api';
import type { BackendTransport } from '@/lib/backendTransport';

const legacyStyles = readFileSync(
  resolve(process.cwd(), 'src/styles/legacy/index.css'),
  'utf8'
);
const attachmentDrawerRule =
  legacyStyles.match(
    /\.legacy-design\s+\.session-composer-attachment-drawer\s*\{[^}]+\}/u
  )?.[0] ?? '';
const composerEditableRule =
  legacyStyles.match(
    /\.legacy-design\s+\.session-composer-editor\s*>\s*\[contenteditable='true'\]\s*\{[^}]+\}/u
  )?.[0] ?? '';

function renderComposerInput(
  props: Partial<Parameters<typeof SessionComposerInput>[0]> = {}
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <SessionComposerInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        onAttachImages={vi.fn()}
        {...props}
      />
    </QueryClientProvider>
  );
}

function getEditor(): HTMLDivElement {
  const surface = screen.getByTestId('session-composer-editor');
  return surface.querySelector('[contenteditable="true"]') as HTMLDivElement;
}

describe('SessionComposerInput (Astryx)', () => {
  it('keeps wrapper padding below rather than above the caret', () => {
    renderComposerInput();

    expect(screen.getByTestId('session-composer-input-surface')).toHaveClass(
      'pt-0',
      'pb-1'
    );
    expect(screen.getByTestId('session-composer-editor')).toHaveClass(
      'pt-0',
      'pb-1'
    );
  });

  it('clears the controlled editor in the same Enter submission frame', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    function ControlledComposer() {
      const [value, setValue] = useState('');
      return (
        <SessionComposerInput
          value={value}
          onChange={setValue}
          onSubmit={onSubmit}
          onAttachImages={vi.fn()}
        />
      );
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ControlledComposer />
      </QueryClientProvider>
    );
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'send now');
    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(editor).toBeEmptyDOMElement();
  });

  it('clears the controlled draft and visible editor when submission is accepted', async () => {
    const user = userEvent.setup();

    function ControlledComposer() {
      const [value, setValue] = useState('');
      return (
        <>
          <SessionComposerInput
            value={value}
            onChange={setValue}
            onSubmit={() => setValue('')}
            onAttachImages={vi.fn()}
          />
          <output aria-label="Controlled draft">{value}</output>
        </>
      );
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <ControlledComposer />
      </QueryClientProvider>
    );
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'send now');
    await user.keyboard('{Enter}');

    expect(
      screen.getByRole('status', { name: 'Controlled draft' })
    ).toBeEmptyDOMElement();
    expect(editor).toBeEmptyDOMElement();
  });

  it('gives the actual editable surface a two-to-seven-line height range', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <div className="legacy-design">
        <style>{composerEditableRule}</style>
        <QueryClientProvider client={queryClient}>
          <SessionComposerInput
            value=""
            onChange={vi.fn()}
            onSubmit={vi.fn()}
            onAttachImages={vi.fn()}
          />
        </QueryClientProvider>
      </div>
    );

    const editor = getEditor();

    expect(getComputedStyle(editor).minHeight).toBe('3.25rem');
    expect(editor.style.maxHeight).toBe('154px');
    expect(getComputedStyle(editor).overflowY).toBe('auto');
  });

  it('renders image attachments in the Astryx composer drawer', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SessionComposerAttachmentDrawer
          images={[
            {
              id: 'image-1',
              name: 'reference.png',
              path: '.vibe-images/reference.png',
              previewUrl: 'blob:reference',
            },
          ]}
          onRemoveImage={vi.fn()}
        />
      </QueryClientProvider>
    );

    expect(
      screen.getByTestId('session-composer-attachment-drawer')
    ).toHaveTextContent('1');
  });

  it('separates the attachment drawer with a hairline and narrow shadow', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const resolvedDrawerRule = attachmentDrawerRule
      .replace('var(--border-strong)', 'red')
      .replace('var(--shadow-control)', '0 1px 2px red');
    render(
      <div className="legacy-design">
        <style>{resolvedDrawerRule}</style>
        <QueryClientProvider client={queryClient}>
          <SessionComposerAttachmentDrawer
            images={[
              {
                id: 'image-1',
                name: 'reference.png',
                path: '.vibe-images/reference.png',
                previewUrl: 'blob:reference',
              },
            ]}
            onRemoveImage={vi.fn()}
          />
        </QueryClientProvider>
      </div>
    );

    const drawer = screen.getByTestId('session-composer-attachment-drawer');
    const styles = getComputedStyle(drawer);

    expect(styles.borderWidth).toBe('1px');
    expect(styles.borderStyle).toBe('solid');
    expect(styles.borderColor).toContain('rgb(255, 0, 0)');
    expect(styles.boxShadow).toBe('0 1px 2px red');
  });

  it('constrains the trigger menu to the composer width', async () => {
    const user = userEvent.setup();
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        bottom: 180,
        height: 40,
        left: 24,
        right: 444,
        top: 140,
        width: 420,
        x: 24,
        y: 140,
        toJSON: () => ({}),
      });

    renderComposerInput();
    const editor = getEditor();
    await user.click(editor);
    await user.type(editor, '/');

    const menu = await screen.findByRole('listbox');
    expect(menu.closest('[popover]')).toHaveStyle({ width: '420px' });

    rectSpy.mockRestore();
  });

  it('shows agent-advertised commands in slash search', async () => {
    const user = userEvent.setup();
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async (command: string) => {
        if (command === 'plugin_action_catalog') return { actions: [] };
        if (command === 'plugin_control_catalog') {
          return { plugins: [], runtimes: [] };
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
    };
    renderComposerInput({
      context: {
        executorProfile: { executor: 'codex' },
        transport,
        availableCommands: [
          {
            name: 'imagegen',
            description: 'Generate or edit raster images',
          },
        ],
      },
    });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '/imageg');

    expect(
      await screen.findByRole('option', { name: /imagegen/i })
    ).toBeVisible();
  });

  it('keeps slash search on the live catalog instead of the disk skill list', async () => {
    const user = userEvent.setup();
    const call = vi.fn(async (command: string) => {
      if (command === 'plugin_action_catalog') return { actions: [] };
      if (command === 'plugin_control_catalog') {
        return { plugins: [], runtimes: [] };
      }
      if (command === 'list_agent_skills') {
        return {
          supported: true,
          global_supported: true,
          project_supported: true,
          locations: [],
          skills: [
            {
              id: 'project-review',
              scope: 'project',
              path: '/workspace/.agents/skills/project-review',
              description: 'Review this project',
              read_only: false,
            },
          ],
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const transport: BackendTransport = { environment: 'desktop', call };
    renderComposerInput({
      context: {
        executorProfile: { executor: 'codex' },
        transport,
        workspacePath: '/workspace',
        availableCommands: [
          { name: 'compact', description: 'Compact context' },
        ],
      },
    });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '/project');

    expect(
      screen.queryByRole('option', { name: /project-review/i })
    ).not.toBeInTheDocument();
    await user.clear(editor);
    await user.type(editor, '/compact');
    expect(
      await screen.findByRole('option', { name: /compact/i })
    ).toBeVisible();
  });

  it('shows only the short skill command after selecting a slash token', async () => {
    const user = userEvent.setup();
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async (command: string) => {
        if (command === 'plugin_action_catalog') return { actions: [] };
        if (command === 'plugin_control_catalog') {
          return { plugins: [], runtimes: [] };
        }
        if (command === 'list_agent_skills') {
          return {
            supported: true,
            global_supported: true,
            project_supported: true,
            locations: [],
            skills: [
              {
                id: 'drawio',
                scope: 'global',
                path: '/Users/mac/.codex/skills/drawio/drawio',
                description: 'Create Drawio diagrams',
                read_only: true,
              },
            ],
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
    };
    renderComposerInput({
      context: {
        executorProfile: { executor: 'codex' },
        transport,
        availableCommands: [
          { name: 'drawio', description: 'Create Drawio diagrams' },
        ],
      },
    });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '/draw');
    await user.click(await screen.findByRole('option', { name: /drawio/i }));

    const token = editor.querySelector<HTMLElement>('[data-astryx-token]');
    expect(token).toHaveTextContent('/drawio');
    expect(token).not.toHaveTextContent('/Users/mac');
  });

  it('inserts a Codex ACP $skill from slash search as $name', async () => {
    const user = userEvent.setup();
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async (command: string) => {
        if (command === 'plugin_action_catalog') return { actions: [] };
        if (command === 'plugin_control_catalog') {
          return { plugins: [], runtimes: [] };
        }
        if (command === 'list_agent_skills') {
          return {
            supported: true,
            global_supported: true,
            project_supported: true,
            locations: [],
            skills: [],
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
    };
    renderComposerInput({
      context: {
        executorProfile: { executor: 'codex' },
        transport,
        availableCommands: [
          { name: '$deploy', description: 'Deploy the current change' },
        ],
      },
    });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '/deploy');
    await user.click(await screen.findByRole('option', { name: /\$deploy/i }));

    const token = editor.querySelector<HTMLElement>('[data-astryx-token]');
    expect(token).toHaveTextContent('$deploy');
    expect(token).not.toHaveTextContent('/$deploy');
  });

  it('shows Codex disk skills in dollar search', async () => {
    const user = userEvent.setup();
    const transport: BackendTransport = {
      environment: 'desktop',
      call: vi.fn(async (command: string) => {
        if (command === 'plugin_action_catalog') return { actions: [] };
        if (command === 'plugin_control_catalog') {
          return { plugins: [], runtimes: [] };
        }
        if (command === 'list_agent_skills') {
          return {
            supported: true,
            global_supported: true,
            project_supported: true,
            locations: [],
            skills: [
              {
                id: 'project-review',
                scope: 'project',
                path: '/workspace/.claude/skills/project-review',
                description: 'Review this project',
                read_only: false,
              },
            ],
          };
        }
        throw new Error(`Unexpected command: ${command}`);
      }),
    };
    renderComposerInput({
      context: {
        executorProfile: { executor: 'codex' },
        transport,
        workspacePath: '/workspace',
      },
    });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '$project');

    expect(
      await screen.findByRole('option', { name: /project-review/i })
    ).toBeVisible();
  });

  it('renders compact, semantically identified trigger rows', async () => {
    const user = userEvent.setup();
    renderComposerInput();
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '$');

    const option = (await screen.findAllByRole('option'))[0];
    const row = option.querySelector('[data-composer-trigger-kind="dollar"]');
    expect(row).toBeInTheDocument();
    expect(row?.querySelector('[data-composer-trigger-label]')).toHaveClass(
      'composer-trigger-label'
    );
    expect(
      row?.querySelector('[data-composer-trigger-description]')
    ).toHaveClass('composer-trigger-description');
  });

  it('switches @ reference tabs with arrow keys', async () => {
    const user = userEvent.setup();
    vi.spyOn(tagsApi, 'list').mockResolvedValue([]);
    renderComposerInput();
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '@');
    await screen.findByTestId('composer-at-reference-menu');

    const selectedTab = () =>
      screen.getByRole('tab', { selected: true }).textContent ?? '';
    const before = selectedTab();

    await user.keyboard('{ArrowRight}');
    const afterRight = selectedTab();
    expect(afterRight).not.toBe(before);

    await user.keyboard('{ArrowLeft}');
    expect(selectedTab()).toBe(before);
  });

  it('moves the highlighted @ reference with arrow keys', async () => {
    const user = userEvent.setup();
    vi.spyOn(tagsApi, 'list').mockResolvedValue([
      {
        id: 'tag-a',
        tag_name: 'alpha',
        content: 'first',
        created_at: '',
        updated_at: '',
      },
      {
        id: 'tag-b',
        tag_name: 'beta',
        content: 'second',
        created_at: '',
        updated_at: '',
      },
      {
        id: 'tag-c',
        tag_name: 'gamma',
        content: 'third',
        created_at: '',
        updated_at: '',
      },
    ]);
    renderComposerInput();
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '@');
    const options = await screen.findAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowDown}');
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('does not flash a loading state when switching @ tabs with the keyboard', async () => {
    const user = userEvent.setup();
    vi.spyOn(tagsApi, 'list').mockResolvedValue([]);
    renderComposerInput();
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '@');
    await screen.findByTestId('composer-at-reference-menu');
    await screen.findAllByRole('option');

    await user.keyboard('{ArrowRight}');
    expect(screen.queryByText('正在搜索…')).not.toBeInTheDocument();
    expect(screen.getByTestId('composer-at-reference-menu')).toBeVisible();
  });

  it('renders a selected instruction token from the @ reference panel', async () => {
    const user = userEvent.setup();
    vi.spyOn(tagsApi, 'list').mockResolvedValue([]);
    renderComposerInput();
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '@');

    const instructionTab = await screen.findByRole('tab', { name: /指令/ });
    await user.click(instructionTab);
    const option = (await screen.findAllByRole('option'))[0];
    await user.click(option);

    const token = editor.querySelector<HTMLElement>('[data-astryx-token]');
    expect(token).not.toBeNull();
    expect(token?.textContent?.startsWith('@')).toBe(true);
    expect(token?.textContent?.match(/@/g)).toHaveLength(1);
  });

  it('restores serialized structured tokens as token chips', async () => {
    renderComposerInput({
      value: 'Review [@:App.tsx](src/App.tsx) before sending',
    });

    const editor = getEditor();
    await waitFor(() => {
      const token = editor.querySelector('[data-astryx-token]');
      expect(token).toHaveAttribute(
        'data-astryx-token-value',
        '[@:App.tsx](src/App.tsx)'
      );
      expect(token).toHaveTextContent('@App.tsx');
    });
  });

  it('shows Web Preview element details when its token is hovered', async () => {
    const elementContext = [
      'From preview click:',
      '- DOM: button#save.primary@button',
      '- Selector: `button#save`',
      '- Selected start: SaveButton (`src/App.tsx:12:3`)',
      '- Element source:',
      '```html',
      '<button id="save" class="primary">Save</button>',
      '```',
    ].join('\n');
    const elementToken = formatSessionComposerCommand({
      type: '@',
      key: 'SaveButton',
      value: elementContext,
    });
    renderComposerInput({ value: `Fix ${elementToken}` });

    const editor = getEditor();
    const token = await waitFor(() => {
      const restoredToken = editor.querySelector<HTMLElement>(
        '[data-token-kind="element"]'
      );
      expect(restoredToken).not.toBeNull();
      return restoredToken!;
    });

    fireEvent.pointerOver(token);

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('SaveButton');
    expect(tooltip).toHaveTextContent('button#save.primary@button');
    expect(tooltip).toHaveTextContent('src/App.tsx:12:3');
    expect(tooltip).toHaveTextContent('button#save');
    expect(tooltip).toHaveTextContent(
      '<button id="save" class="primary">Save</button>'
    );

    fireEvent.pointerOut(token);
    await waitFor(() => {
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    await act(async () => {
      token.focus();
    });
    expect(token).toHaveFocus();
    expect(token).toHaveAttribute('tabindex', '0');
    expect(await screen.findByRole('tooltip')).toHaveTextContent('SaveButton');
  });

  it('reports contenteditable text changes as Text content', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderComposerInput({ onChange });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'hello');

    expect(onChange).toHaveBeenLastCalledWith('hello');
  });

  it('submits on Enter with the Astryx default behavior', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderComposerInput({ onSubmit });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'run tests');
    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledWith('run tests');
  });

  it('submits a token-only message on Enter', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderComposerInput({ onSubmit });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '$');
    const option = (await screen.findAllByRole('option'))[0];
    await user.click(option);
    const serializedToken = editor.querySelector<HTMLElement>(
      '[data-astryx-token]'
    )?.dataset.astryxTokenValue;
    expect(serializedToken).toMatch(/^\[\$:[^\]]+\]\([^)]*\)$/);

    await user.keyboard('{Enter}');

    expect(onSubmit).toHaveBeenCalledWith(serializedToken);
  });

  it('does not submit on the Enter that commits an IME composition', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderComposerInput({ onSubmit });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '你好');
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('uses the Astryx default submit behavior for Ctrl+Enter', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderComposerInput({ onSubmit });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'run tests');
    await user.keyboard('{Control>}{Enter}{/Control}');

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('uses the Astryx default Shift+Enter newline behavior', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderComposerInput({ onChange });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'line1');
    await user.keyboard('{Shift>}{Enter}{/Shift}');

    expect(onChange).toHaveBeenLastCalledWith('line1\n');
  });

  it('opens the dollar trigger menu and inserts a structured token on select', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderComposerInput({ onChange });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'Use $');

    const options = await screen.findAllByRole('option');
    await user.click(options[0]);

    const [inserted] = onChange.mock.calls.at(-1) as [string];
    expect(inserted).toMatch(/^Use \[\$:[^\]]+\]\([^)]*\)/);
  });

  it('deletes a whole structured token with Backspace', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderComposerInput({ onChange });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'Use $');

    const options = await screen.findAllByRole('option');
    await user.click(options[0]);

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

    // Caret lands after the inserted token; Backspace removes it atomically.
    await user.keyboard('{Backspace}');

    const [afterBackspace] = onChange.mock.calls.at(-1) as [string];
    expect(afterBackspace).toBe('Use ');
  });

  it('deletes a token in one Backspace when the caret is at the following text node boundary', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderComposerInput({ onChange });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'Use $');
    const options = await screen.findAllByRole('option');
    await user.click(options[0]);

    const tokenSpan = editor.querySelector('[data-astryx-token]');
    const followingText = tokenSpan?.nextSibling;
    expect(followingText?.nodeType).toBe(Node.TEXT_NODE);
    if (!followingText) throw new Error('Expected text after token');

    const range = document.createRange();
    range.setStart(followingText, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    await user.keyboard('{Backspace}');

    expect(editor.querySelector('[data-astryx-token]')).not.toBeInTheDocument();
    const [afterBackspace] = onChange.mock.calls.at(-1) as [string];
    expect(afterBackspace).toBe('Use ');
  });

  it('deletes a token in one Backspace when the caret is after its spacer node', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderComposerInput({ onChange });
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, '$');
    const options = await screen.findAllByRole('option');
    await user.click(options[0]);

    const tokenSpan = editor.querySelector('[data-astryx-token]');
    expect(tokenSpan?.nextSibling?.textContent).toBe('\u00A0');

    // WebKit can represent the caret after an atomic contenteditable token as
    // a parent boundary after Astryx's trailing NBSP instead of inside it.
    const range = document.createRange();
    range.setStart(editor, editor.childNodes.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    await user.keyboard('{Backspace}');

    expect(editor.querySelector('[data-astryx-token]')).not.toBeInTheDocument();
    const [afterBackspace] = onChange.mock.calls.at(-1) as [string];
    expect(afterBackspace).toBe('');
  });

  it('uses distinct token tones instead of rendering every token neutral', async () => {
    const user = userEvent.setup();
    renderComposerInput();
    const editor = getEditor();

    await user.click(editor);
    await user.type(editor, 'Use $');
    const options = await screen.findAllByRole('option');
    await user.click(options[0]);

    expect(editor.querySelector('.astryx-badge')).toHaveAttribute(
      'data-variant',
      'green'
    );
  });

  it('accepts file-tree custom drops and inserts an @ command token', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const payload: FileReferencePayload = {
      relativePath: 'src/lib/utils.ts',
      fileName: 'utils.ts',
      kind: 'file',
    };
    setCurrentDraggedFileReference(payload);
    renderComposerInput({ onChange });
    const editor = getEditor();

    await user.click(editor);
    const dataTransfer = {
      types: [] as string[],
      files: [] as File[],
      getData: () => '',
    };
    // fireEvent.drop with the custom drag state read from the module store.
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.drop(editor, { dataTransfer });

    await waitFor(() => {
      const [dropped] = onChange.mock.calls.at(-1) as [string];
      // Astryx keeps a trailing NBSP after inserted tokens so the caret can
      // keep typing; it serializes into the value string.
      expect(dropped.replace(/\u00A0$/, '')).toBe(
        '[@:utils.ts](src/lib/utils.ts)'
      );
    });
  });
});
