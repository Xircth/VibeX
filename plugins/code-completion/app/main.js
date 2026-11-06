const FAST_TRIGGER_CHARS = new Set(['.', '(', '{', '[', ':', '=', '/', '\n']);
const NORMAL_DEBOUNCE_MS = 180;
const FAST_DEBOUNCE_MS = 60;
const MAX_CACHE_ENTRIES = 32;
const ACCEPT_COMMAND_ID = 'vibex.codeCompletion.acceptInlineCompletion';

/**
 * Determine adaptive debounce delay (60ms after structural trigger chars, 180ms on normal typing, 0ms on manual trigger).
 */
export function computeAdaptiveDebounceMs(prefix = '', isManual = false) {
  if (isManual) return 0;
  const text = String(prefix || '');
  if (!text) return NORMAL_DEBOUNCE_MS;
  const lastChar = text[text.length - 1];
  const trimmedLine = text.split('\n').pop()?.trim() || '';
  if (FAST_TRIGGER_CHARS.has(lastChar) || trimmedLine.endsWith('=>')) {
    return FAST_DEBOUNCE_MS;
  }
  return NORMAL_DEBOUNCE_MS;
}

/**
 * Wait for `ms` milliseconds while respecting an optional `AbortSignal`.
 */
export function waitForDebounce(ms, signal) {
  if (ms <= 0) {
    return Promise.resolve(!signal?.aborted);
  }
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.('abort', onAbort);
      resolve(!signal?.aborted);
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Forward-Typing Prefix Cache:
 * When the user continues typing characters that match a previously returned Ghost Text completion,
 * immediately return the remaining suffix without a network round-trip.
 */
export class ForwardTypingCache {
  constructor(maxEntries = MAX_CACHE_ENTRIES) {
    this.maxEntries = maxEntries;
    this.entries = new Map();
  }

  _key(filePath, lineNumber) {
    return `${filePath || 'untitled'}::${lineNumber || 1}`;
  }

  store(filePath, lineNumber, linePrefix, suffix, insertText) {
    if (!insertText) return;
    const key = this._key(filePath, lineNumber);
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, {
      linePrefix: String(linePrefix || ''),
      suffix: String(suffix || ''),
      insertText: String(insertText),
      timestamp: Date.now(),
    });
  }

  lookup(filePath, lineNumber, currentLinePrefix, currentSuffix) {
    const key = this._key(filePath, lineNumber);
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (entry.suffix !== String(currentSuffix || '')) {
      return null;
    }

    const prefixStr = String(currentLinePrefix || '');
    if (!prefixStr.startsWith(entry.linePrefix)) {
      return null;
    }

    const typedDelta = prefixStr.slice(entry.linePrefix.length);
    if (typedDelta.length === 0) {
      return entry.insertText;
    }

    if (entry.insertText.startsWith(typedDelta)) {
      const remaining = entry.insertText.slice(typedDelta.length);
      return remaining.length > 0 ? remaining : null;
    }

    return null;
  }

  clear() {
    this.entries.clear();
  }
}

/**
 * Execute an inline completion acceptance or post-edit inside a Monaco Undo Stop Barrier
 * (`editor.pushUndoStop()` before and after) so a single `Ctrl+Z` / `Cmd+Z` reverts the entire AI block.
 */
export function applyWithUndoStopBarrier(editorInstance, callback) {
  if (editorInstance && typeof editorInstance.pushUndoStop === 'function') {
    editorInstance.pushUndoStop();
    try {
      return callback?.();
    } finally {
      editorInstance.pushUndoStop();
    }
  }
  return callback?.();
}

/**
 * Extract `{ filePath, languageId, lineNumber, column, prefix, suffix, linePrefix }`
 * from either a normalized VibeX editor context or a raw Monaco `(model, position)` pair.
 */
export function extractCompletionDocumentState(modelOrRequest, positionOrContext) {
  // Normalized request object passed by `vibex.code-editor` host service
  if (
    modelOrRequest &&
    typeof modelOrRequest === 'object' &&
    typeof modelOrRequest.prefix === 'string' &&
    typeof modelOrRequest.getValue !== 'function'
  ) {
    const prefix = modelOrRequest.prefix;
    const suffix = String(modelOrRequest.suffix || '');
    const prefixLines = prefix.split('\n');
    const linePrefix = prefixLines[prefixLines.length - 1] || '';
    const lineNumber = modelOrRequest.position?.lineNumber ?? prefixLines.length;
    const column = modelOrRequest.position?.column ?? linePrefix.length + 1;
    return {
      filePath: String(modelOrRequest.filePath || modelOrRequest.uri || 'untitled'),
      languageId: String(modelOrRequest.languageId || 'typescript'),
      lineNumber,
      column,
      prefix,
      suffix,
      linePrefix,
      manual: Boolean(modelOrRequest.manual || modelOrRequest.triggerKind === 0),
    };
  }

  // Raw Monaco `ITextModel` + `Position`
  const model = modelOrRequest;
  const position = positionOrContext || { lineNumber: 1, column: 1 };
  const fullText = typeof model?.getValue === 'function' ? model.getValue() : '';
  const lineNumber = Number(position.lineNumber || 1);
  const column = Number(position.column || 1);

  let prefix = '';
  let suffix = '';
  if (typeof model?.getOffsetAt === 'function') {
    const offset = model.getOffsetAt({ lineNumber, column });
    prefix = fullText.slice(0, offset);
    suffix = fullText.slice(offset);
  } else {
    const lines = fullText.split('\n');
    const beforeLines = lines.slice(0, Math.max(0, lineNumber - 1));
    const currentLine = lines[lineNumber - 1] || '';
    const afterLines = lines.slice(lineNumber);
    prefix = [...beforeLines, currentLine.slice(0, Math.max(0, column - 1))].join('\n');
    suffix = [currentLine.slice(Math.max(0, column - 1)), ...afterLines].join('\n');
  }

  const linePrefix = prefix.split('\n').pop() || '';
  const rawUriPath =
    model?.filePath ||
    model?.uri?.fsPath ||
    model?.uri?.path ||
    model?.uri?.toString?.() ||
    'untitled';
  const filePath = String(rawUriPath);
  const languageId = String(
    (typeof model?.getLanguageId === 'function' && model.getLanguageId()) ||
      model?.languageId ||
      'typescript',
  );

  return {
    filePath,
    languageId,
    lineNumber,
    column,
    prefix,
    suffix,
    linePrefix,
    manual: false,
  };
}

export default {
  async activate(context) {
    const cache = new ForwardTypingCache();
    let activeAbortController = null;
    let inFlightWorkerRequestId = null;
    let activeEditorInstance = null;
    let enabled = true;
    let statusState = 'idle'; // 'idle' | 'Generating...' | 'disabled' | 'error'
    let lastErrorMessage = null;

    const invokeWorker = async (method, params = {}) => {
      if (typeof context?.invokeWorker === 'function') {
        return await context.invokeWorker(method, params);
      }
      if (typeof context?.worker?.invoke === 'function') {
        return await context.worker.invoke(method, params);
      }
      if (typeof context?.services?.call === 'function') {
        return await context.services.call('worker', method, params);
      }
      return null;
    };

    const getEditorBridge = () => {
      if (typeof context?.services?.get === 'function') {
        return (
          context.services.get('vibex.code-editor') ||
          context.services.get('provider.editor.monaco') ||
          null
        );
      }
      return context?.editorBridge || null;
    };

    const cancelActiveCompletion = (requestId = null) => {
      if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
      }
      const targetRequestId = requestId || inFlightWorkerRequestId;
      if (targetRequestId && inFlightWorkerRequestId === targetRequestId) {
        inFlightWorkerRequestId = null;
        void invokeWorker('completion.cancel', { requestId: targetRequestId }).catch(() => {});
      }
    };

    const provideInlineCompletions = async (modelOrRequest, position, completionContext, token) => {
      if (!enabled) {
        return { items: [] };
      }

      // Cancel any previous in-flight completion or pending debounce immediately
      cancelActiveCompletion();

      const docState = extractCompletionDocumentState(modelOrRequest, position);
      const editorBridge = getEditorBridge();
      if (
        (!docState.filePath ||
          docState.filePath === 'untitled' ||
          docState.filePath.startsWith('inmemory:') ||
          /^\/?model\/\d+$/.test(docState.filePath)) &&
        editorBridge &&
        typeof editorBridge.getActiveDocument === 'function'
      ) {
        try {
          const activeDoc = editorBridge.getActiveDocument();
          if (activeDoc?.filePath) {
            docState.filePath = String(activeDoc.filePath);
          }
          if (
            (!docState.languageId || docState.languageId === 'plaintext') &&
            activeDoc?.languageId
          ) {
            docState.languageId = String(activeDoc.languageId);
          }
        } catch {
          // ignore
        }
      }
      const isManual =
        docState.manual ||
        completionContext?.triggerKind === 0 ||
        completionContext?.manual === true;

      // 1. Check forward-typing prefix cache before waiting or hitting the network
      const cachedInsertText = cache.lookup(
        docState.filePath,
        docState.lineNumber,
        docState.linePrefix,
        docState.suffix,
      );
      if (cachedInsertText) {
        return {
          items: [
            {
              insertText: cachedInsertText,
              range: {
                startLineNumber: docState.lineNumber,
                startColumn: docState.column,
                endLineNumber: docState.lineNumber,
                endColumn: docState.column,
              },
              command: {
                id: ACCEPT_COMMAND_ID,
                title: 'Accept AI Inline Completion',
              },
            },
          ],
        };
      }

      // 2. Wire cancellation token / AbortSignal
      const abortController = new AbortController();
      activeAbortController = abortController;
      const requestId = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

      if (token) {
        if (token.isCancellationRequested || token.aborted) {
          cancelActiveCompletion(requestId);
          return { items: [] };
        }
        if (typeof token.onCancellationRequested === 'function') {
          token.onCancellationRequested(() => {
            cancelActiveCompletion(requestId);
          });
        } else if (typeof token.addEventListener === 'function') {
          token.addEventListener(
            'abort',
            () => {
              cancelActiveCompletion(requestId);
            },
            { once: true },
          );
        }
      }

      // 3. Adaptive debounce (60ms for structural trigger chars, 180ms for normal typing)
      const debounceMs = computeAdaptiveDebounceMs(docState.prefix, isManual);
      const shouldContinue = await waitForDebounce(debounceMs, abortController.signal);
      if (!shouldContinue || abortController.signal.aborted) {
        return { items: [] };
      }

      // 4. Collect open neighbor tabs from host editor bridge if available
      const latestEditorBridge = editorBridge || getEditorBridge();
      let neighbors = [];
      if (latestEditorBridge && typeof latestEditorBridge.getOpenDocuments === 'function') {
        try {
          neighbors = (await latestEditorBridge.getOpenDocuments()) || [];
        } catch {
          neighbors = [];
        }
      } else if (Array.isArray(modelOrRequest?.neighbors)) {
        neighbors = modelOrRequest.neighbors;
      }

      statusState = 'loading';
      inFlightWorkerRequestId = requestId;
      try {
        const result = await invokeWorker('completion.complete', {
          requestId,
          filePath: docState.filePath,
          languageId: docState.languageId,
          prefix: docState.prefix,
          suffix: docState.suffix,
          neighbors,
          manual: isManual,
          range: {
            startLineNumber: docState.lineNumber,
            startColumn: docState.column,
            endLineNumber: docState.lineNumber,
            endColumn: docState.column,
          },
        });

        if (abortController.signal.aborted || !result || !Array.isArray(result.items)) {
          statusState = enabled ? 'idle' : 'disabled';
          return { items: [] };
        }

        statusState = enabled ? 'idle' : 'disabled';
        lastErrorMessage = null;

        const items = result.items
          .filter((item) => item && typeof item.insertText === 'string' && item.insertText.length > 0)
          .map((item) => {
            cache.store(
              docState.filePath,
              docState.lineNumber,
              docState.linePrefix,
              docState.suffix,
              item.insertText,
            );
            return {
              insertText: item.insertText,
              range: item.range || {
                startLineNumber: docState.lineNumber,
                startColumn: docState.column,
                endLineNumber: docState.lineNumber,
                endColumn: docState.column,
              },
              command: {
                id: ACCEPT_COMMAND_ID,
                title: 'Accept AI Inline Completion',
              },
            };
          });

        return { items };
      } catch (error) {
        statusState = 'error';
        lastErrorMessage = String(error?.message || error);
        return { items: [] };
      } finally {
        if (inFlightWorkerRequestId === requestId) {
          inFlightWorkerRequestId = null;
        }
        if (activeAbortController === abortController) {
          activeAbortController = null;
        }
      }
    };

    let providerDisposable = null;
    let serviceWatchCleanup = null;

    const attachToEditorBridge = (editorBridge) => {
      if (!editorBridge || providerDisposable) return;

      if (typeof editorBridge.onDidActiveEditorChange === 'function') {
        editorBridge.onDidActiveEditorChange((editor) => {
          activeEditorInstance = editor;
        });
      }

      const inlineProvider = {
        provideInlineCompletions,
        freeInlineCompletions() {},
        handleItemDidShow() {},
      };

      if (typeof editorBridge.registerInlineCompletionProvider === 'function') {
        providerDisposable = editorBridge.registerInlineCompletionProvider('*', inlineProvider);
      } else if (typeof editorBridge.registerInlineCompletionsProvider === 'function') {
        providerDisposable = editorBridge.registerInlineCompletionsProvider('*', inlineProvider);
      }
    };

    attachToEditorBridge(getEditorBridge());
    if (!providerDisposable && typeof context?.services?.onChange === 'function') {
      serviceWatchCleanup = context.services.onChange('vibex.code-editor', (bridge) => {
        attachToEditorBridge(bridge || getEditorBridge());
      });
    } else if (!providerDisposable && typeof context?.services?.subscribe === 'function') {
      serviceWatchCleanup = context.services.subscribe(() => {
        attachToEditorBridge(getEditorBridge());
      });
    }

    const registerHandler = (name, fn) => {
      if (typeof context?.registerHandler === 'function') {
        context.registerHandler(name, fn);
      }
      if (typeof context?.commands?.register === 'function') {
        context.commands.register(name, fn);
      }
    };

    // Undo Stop Barrier handler invoked when accepting an inline completion
    registerHandler(ACCEPT_COMMAND_ID, (editorArg) => {
      const targetEditor = editorArg || activeEditorInstance || getEditorBridge()?.getActiveEditor?.();
      applyWithUndoStopBarrier(targetEditor, () => {});
      return { accepted: true };
    });

    registerHandler('completion.status', async () => {
      const workerStatus = (await invokeWorker('completion.status', {}).catch(() => null)) || {};
      return {
        ...workerStatus,
        enabled,
        state: enabled ? statusState : 'disabled',
        lastError: lastErrorMessage || workerStatus.metrics?.lastError || null,
      };
    });

    registerHandler('completion.toggle', async (params) => {
      const nextEnabled =
        typeof params?.enabled === 'boolean' ? params.enabled : !enabled;
      enabled = nextEnabled;
      statusState = enabled ? 'idle' : 'disabled';
      if (!enabled) {
        cancelActiveCompletion();
        cache.clear();
      }
      const workerStatus =
        (await invokeWorker('completion.toggle', { enabled }).catch(() => null)) || {};
      return {
        ...workerStatus,
        enabled,
        state: statusState,
      };
    });

    registerHandler('completion.trigger', async (params) => {
      const editorBridge = getEditorBridge();
      if (editorBridge && typeof editorBridge.triggerInlineCompletion === 'function') {
        await editorBridge.triggerInlineCompletion();
        return { triggered: true, via: 'editor-bridge' };
      }
      if (params && typeof params.prefix === 'string') {
        return await provideInlineCompletions({ ...params, manual: true }, params.position, {
          triggerKind: 0,
          manual: true,
        });
      }
      return { triggered: false };
    });

    return {
      provideInlineCompletions,
      cancelActiveCompletion,
      cache,
      dispose() {
        cancelActiveCompletion();
        cache.clear();
        if (typeof serviceWatchCleanup === 'function') {
          serviceWatchCleanup();
          serviceWatchCleanup = null;
        }
        if (typeof providerDisposable === 'function') {
          providerDisposable();
        } else if (providerDisposable && typeof providerDisposable.dispose === 'function') {
          providerDisposable.dispose();
        }
      },
    };
  },
};
