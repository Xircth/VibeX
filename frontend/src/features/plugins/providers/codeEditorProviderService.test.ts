import { serviceContainer } from '@vibex/plugin-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CORE_FOUNDATION_PLUGIN_DESCRIPTORS } from '../coreFoundationCatalogData';
import {
  acceptInlineCompletionWithUndoBarrier,
  applyWithUndoStopBarrier,
  computeAdaptiveDebounceMs,
  FAST_TRIGGER_COMPLETION_DEBOUNCE_MS,
  getCodeEditorService,
  NORMAL_COMPLETION_DEBOUNCE_MS,
  PrefixCompletionCache,
  resetHostProviderServicesForTest,
  shouldYieldTabToNativeEditor,
} from './hostProviderServices';

/**
 * Stateful editor + undo stack harness that emulates Monaco's `pushUndoStop()`
 * and `executeEdits()` undo element coalescing.
 */
function createUndoableMonacoEditorHarness(initialText = '') {
  let content = initialText;
  const undoStack: string[][] = [[]];
  let currentGroupOpen = true;
  const callLog: string[] = [];

  const ensureTopGroup = () => {
    if (undoStack.length === 0) {
      undoStack.push([]);
    }
    return undoStack[undoStack.length - 1]!;
  };

  const model = {
    getValue: () => content,
    getLanguageId: () => 'typescript',
    getVersionId: () => undoStack.length,
    uri: { path: '/workspace/src/index.ts' },
    pushStackElement: vi.fn(() => {
      callLog.push('model.pushStackElement');
      if (ensureTopGroup().length > 0) {
        undoStack.push([]);
      }
      currentGroupOpen = false;
    }),
  };

  const editor = {
    getValue: () => content,
    getModel: () => model,
    getPosition: () => {
      const lines = content.split('\n');
      const lastLine = lines[lines.length - 1] ?? '';
      return { lineNumber: lines.length, column: lastLine.length + 1 };
    },
    pushUndoStop: vi.fn(() => {
      callLog.push('editor.pushUndoStop');
      if (ensureTopGroup().length > 0) {
        undoStack.push([]);
      }
      currentGroupOpen = false;
    }),
    typeUserChar: (ch: string) => {
      if (!currentGroupOpen) {
        if (ensureTopGroup().length > 0) {
          undoStack.push([]);
        }
        currentGroupOpen = true;
      }
      ensureTopGroup().push(content);
      content += ch;
    },
    executeEdits: vi.fn((source: string, edits: Array<{ text: string }>) => {
      callLog.push(`editor.executeEdits:${source}`);
      if (!currentGroupOpen && ensureTopGroup().length > 0) {
        undoStack.push([]);
      }
      currentGroupOpen = true;
      for (const edit of edits) {
        ensureTopGroup().push(content);
        content += edit.text;
      }
      return true;
    }),
    undo: () => {
      while (undoStack.length > 0) {
        const group = undoStack.pop()!;
        if (group.length > 0) {
          content = group[0]!;
          ensureTopGroup();
          return;
        }
      }
      ensureTopGroup();
    },
    callLog,
  };

  return editor;
}

describe('CodeEditorProviderService (vibex.code-editor / provider.editor.monaco)', () => {
  beforeEach(() => {
    resetHostProviderServicesForTest();
  });

  it('registers vibex.code-editor, provider.editor.monaco, and vibex.provider.code-editor in serviceContainer and vibex.core.filesystem', () => {
    const codeEditor = getCodeEditorService();
    expect(codeEditor).toBeDefined();
    expect(serviceContainer.get('vibex.code-editor')).toBe(codeEditor);
    expect(serviceContainer.get('provider.editor.monaco')).toBe(codeEditor);
    expect(serviceContainer.get('vibex.provider.code-editor')).toBe(codeEditor);

    const filesystemEntry = CORE_FOUNDATION_PLUGIN_DESCRIPTORS.find(
      (item) => item.id === 'vibex.core.filesystem'
    );
    expect(filesystemEntry?.provides).toContain('vibex.code-editor');
    expect(filesystemEntry?.provides).toContain('provider.editor.monaco');
  });

  it('tracks mounted Monaco editors, active document, focus switches, and open neighbor document snapshots', async () => {
    const service = getCodeEditorService();
    let focusEditor1: (() => void) | undefined;

    const editor1 = {
      getValue: () => 'export const a = 1;\n',
      onDidFocusEditorText: (cb: () => void) => {
        focusEditor1 = cb;
        return { dispose: vi.fn() };
      },
    };
    const editor2 = {
      getValue: () => 'import { a } from "./a";\nexport const b = a + 1;\n',
      onDidFocusEditorText: () => ({ dispose: vi.fn() }),
    };

    const activeChanges: unknown[] = [];
    const sub = service.onDidActiveEditorChange((ed) => {
      activeChanges.push(ed);
    });

    const dispose1 = service.registerEditorInstance(editor1, {
      filePath: '/workspace/src/a.ts',
      languageId: 'typescript',
    });
    expect(service.getActiveEditor()).toBe(editor1);
    expect(service.getActiveDocument()?.filePath).toBe('/workspace/src/a.ts');

    const dispose2 = service.registerEditorInstance(editor2, {
      filePath: '/workspace/src/b.ts',
      languageId: 'typescript',
    });
    expect(service.getActiveEditor()).toBe(editor2);

    const neighbors = await service.getOpenDocuments({ excludeActive: true });
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0]?.filePath).toBe('/workspace/src/a.ts');
    expect(neighbors[0]?.content).toContain('export const a = 1;');

    focusEditor1?.();
    expect(service.getActiveEditor()).toBe(editor1);

    dispose1.dispose();
    expect(service.getActiveEditor()).toBe(editor2);

    dispose2();
    expect(service.getActiveEditor()).toBeNull();
    sub.dispose();
    expect(activeChanges.length).toBeGreaterThanOrEqual(3);
  });

  it('bridges registerInlineCompletionProvider to Monaco and disposes cleanly on plugin unload', async () => {
    const service = getCodeEditorService();
    const monacoDisposeSpy = vi.fn();
    let capturedProvider: {
      provideInlineCompletions: (
        model: unknown,
        position: unknown,
        context: unknown,
        token: unknown
      ) => Promise<{ items: Array<{ insertText: string }> }>;
    } | null = null;

    const mockMonaco = {
      languages: {
        registerInlineCompletionsProvider: vi.fn((_selector, provider) => {
          capturedProvider = provider;
          return { dispose: monacoDisposeSpy };
        }),
      },
    };

    const handlerSpy = vi.fn(async (ctx) => ({
      items: [
        {
          insertText: `return ${ctx.linePrefix.trim() || 'result'};`,
        },
      ],
    }));

    const disposer = service.registerInlineCompletionHandler({
      id: 'vibex.code-completion.inline',
      pluginId: 'vibex.code-completion',
      languages: '*',
      provideInlineCompletions: handlerSpy,
    });

    // Setting Monaco after registration automatically binds previously registered handlers
    service.setMonacoInstance(mockMonaco);
    expect(
      mockMonaco.languages.registerInlineCompletionsProvider
    ).toHaveBeenCalledTimes(1);
    expect(capturedProvider).not.toBeNull();

    let cancelCallback: (() => void) | undefined;
    const result = await capturedProvider!.provideInlineCompletions(
      {
        getValue: () => 'function demo() {\n  value\n}',
        getLanguageId: () => 'typescript',
        uri: { path: '/workspace/demo.ts' },
      },
      { lineNumber: 2, column: 8 },
      { triggerKind: 1 },
      {
        isCancellationRequested: false,
        onCancellationRequested: (cb: () => void) => {
          cancelCallback = cb;
        },
      }
    );

    expect(result.items).toEqual([{ insertText: 'return value;' }]);
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    const payload = handlerSpy.mock.calls[0]?.[0];
    expect(payload?.filePath).toBe('/workspace/demo.ts');
    expect(payload?.linePrefix).toBe('  value');
    expect(payload?.signal.aborted).toBe(false);

    // Firing Monaco cancellation token aborts the AbortSignal immediately
    cancelCallback?.();
    expect(payload?.signal.aborted).toBe(true);

    // Unloading the plugin disposes both internal registry and Monaco provider
    disposer.dispose();
    expect(monacoDisposeSpy).toHaveBeenCalledTimes(1);
    expect(service.listInlineCompletionHandlers()).toHaveLength(0);
  });

  it('registers and cleans up inline edit actions across mounted editors', () => {
    const service = getCodeEditorService();
    const actionDisposeSpy = vi.fn();
    const addActionSpy = vi.fn(() => ({ dispose: actionDisposeSpy }));

    const editor = {
      getValue: () => '',
      addAction: addActionSpy,
    };

    service.registerEditorInstance(editor, {
      filePath: '/workspace/app.ts',
      languageId: 'typescript',
    });

    const runSpy = vi.fn();
    const disposeAction = service.registerInlineEditAction({
      id: 'vibex.code-completion.trigger',
      label: 'Trigger AI Inline Completion',
      keybindings: [2048 | 88],
      run: runSpy,
    });

    expect(addActionSpy).toHaveBeenCalledTimes(1);
    disposeAction();
    expect(actionDisposeSpy).toHaveBeenCalledTimes(1);
    expect(service.listInlineEditActions()).toHaveLength(0);
  });

  it('computes two-tier adaptive debounce (180ms normal typing, 60ms trigger chars, 0ms manual)', () => {
    expect(computeAdaptiveDebounceMs('const userName')).toBe(
      NORMAL_COMPLETION_DEBOUNCE_MS
    );
    expect(computeAdaptiveDebounceMs('user.')).toBe(
      FAST_TRIGGER_COMPLETION_DEBOUNCE_MS
    );
    expect(computeAdaptiveDebounceMs('fetchData(')).toBe(
      FAST_TRIGGER_COMPLETION_DEBOUNCE_MS
    );
    expect(computeAdaptiveDebounceMs('if (ready) {')).toBe(
      FAST_TRIGGER_COMPLETION_DEBOUNCE_MS
    );
    expect(computeAdaptiveDebounceMs('const items = ')).toBe(
      FAST_TRIGGER_COMPLETION_DEBOUNCE_MS
    );
    expect(computeAdaptiveDebounceMs('const fn = () =>')).toBe(
      FAST_TRIGGER_COMPLETION_DEBOUNCE_MS
    );
    expect(computeAdaptiveDebounceMs('function test() {\n  ')).toBe(
      FAST_TRIGGER_COMPLETION_DEBOUNCE_MS
    );
    expect(computeAdaptiveDebounceMs('const x', true)).toBe(0);
  });

  it('slices cached completions in 0ms when user continues typing matching prefix characters', () => {
    const cache = new PrefixCompletionCache();
    cache.store(
      '/workspace/api.ts',
      10,
      '  const data = ',
      ';',
      'await client.get("/users")'
    );

    // User types "await " matching the start of Ghost Text -> 0ms local slice
    const sliced = cache.lookup(
      '/workspace/api.ts',
      10,
      '  const data = await ',
      ';'
    );
    expect(sliced).toBe('client.get("/users")');

    // User types further "client." -> 0ms local slice
    const slicedFurther = cache.lookup(
      '/workspace/api.ts',
      10,
      '  const data = await client.',
      ';'
    );
    expect(slicedFurther).toBe('get("/users")');

    // Divergent typing misses cache cleanly
    const diverged = cache.lookup(
      '/workspace/api.ts',
      10,
      '  const data = fetch(',
      ';'
    );
    expect(diverged).toBeNull();
  });

  it('enforces Undo Stop Barrier so a single Ctrl/Cmd+Z atomically reverts the entire accepted AI completion without losing user keystrokes', () => {
    const editor = createUndoableMonacoEditorHarness('');

    // User types "const " character by character
    for (const ch of 'const ') {
      editor.typeUserChar(ch);
    }
    expect(editor.getValue()).toBe('const ');

    // User presses Tab to accept a multi-line AI completion
    const multiLineCompletion =
      'handler = async () => {\n  return await runTask();\n};';
    const accepted = acceptInlineCompletionWithUndoBarrier(
      editor,
      multiLineCompletion
    );
    expect(accepted).toBe(true);
    expect(editor.getValue()).toBe(
      'const handler = async () => {\n  return await runTask();\n};'
    );

    // Verify Undo Stop Barrier order: pushUndoStop/pushStackElement before AND after executeEdits
    expect(editor.callLog).toEqual([
      'editor.pushUndoStop',
      'model.pushStackElement',
      'editor.executeEdits:inlineCompletion.accept',
      'model.pushStackElement',
      'editor.pushUndoStop',
    ]);

    // Single Ctrl/Cmd + Z reverts the entire multi-line AI completion atomically while keeping "const "
    editor.undo();
    expect(editor.getValue()).toBe('const ');
  });

  it('supports partial word and line acceptance inside Undo Stop Barriers', () => {
    const service = getCodeEditorService();
    const editor = createUndoableMonacoEditorHarness('return ');

    const wordStep = service.acceptNextCompletionWord(
      editor,
      'await computeTotal(items);'
    );
    expect(wordStep.acceptedText).toBe('await');
    expect(wordStep.remainingText).toBe(' computeTotal(items);');
    expect(editor.getValue()).toBe('return await');

    // Single undo reverts the accepted word atomically
    editor.undo();
    expect(editor.getValue()).toBe('return ');

    // Line acceptance
    const lineStep = service.acceptNextCompletionLine(
      editor,
      'firstLine()\n  .secondLine();'
    );
    expect(lineStep.acceptedText).toBe('firstLine()\n');
    expect(lineStep.remainingText).toBe('  .secondLine();');
    expect(editor.getValue()).toBe('return firstLine()\n');

    editor.undo();
    expect(editor.getValue()).toBe('return ');

    // Direct applyWithUndoStopBarrier helper also returns callback value
    const customResult = applyWithUndoStopBarrier(editor, () => 42);
    expect(customResult).toBe(42);
  });

  it('yields Tab to native Monaco editor when Suggest Widget is open, Snippet mode is active, or cursor is in leading indentation whitespace', () => {
    const editorWithContext = (keys: Record<string, boolean>) => ({
      getContextKeyValue: (k: string) => keys[k],
    });

    // 1. Suggest Widget open -> yield Tab to native completion menu
    expect(
      shouldYieldTabToNativeEditor(
        editorWithContext({
          suggestWidgetVisible: true,
          inlineSuggestionVisible: true,
        })
      )
    ).toBe(true);

    // 2. Snippet placeholder mode active -> yield Tab to snippet navigation
    expect(
      shouldYieldTabToNativeEditor(
        editorWithContext({
          suggestWidgetVisible: false,
          inSnippetMode: true,
          inlineSuggestionVisible: true,
        })
      )
    ).toBe(true);

    // 3. Leading whitespace before existing code with no active ghost text -> yield Tab to indentation
    expect(
      shouldYieldTabToNativeEditor(editorWithContext({}), {
        linePrefix: '    ',
        lineSuffix: 'const x = 1;',
      })
    ).toBe(true);

    // 4. Ghost Text visible and neither Suggest Widget nor Snippet mode is active -> allow Tab to accept Ghost Text
    expect(
      shouldYieldTabToNativeEditor(
        editorWithContext({
          suggestWidgetVisible: false,
          inSnippetMode: false,
          inlineSuggestionVisible: true,
        }),
        {
          linePrefix: '  const x = ',
          lineSuffix: '',
        }
      )
    ).toBe(false);
  });
});
