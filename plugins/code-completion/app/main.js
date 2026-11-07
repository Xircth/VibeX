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
    const lineSuffix =
      typeof modelOrRequest.lineSuffix === 'string'
        ? modelOrRequest.lineSuffix
        : suffix.split('\n')[0] || '';
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
      lineSuffix,
      manual: Boolean(
        modelOrRequest.manual ||
          modelOrRequest.triggerKind === 1 ||
          modelOrRequest.triggerKind === 'explicit',
      ),
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
  const lineSuffix = suffix.split('\n')[0] || '';
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
    lineSuffix,
    manual: false,
  };
}

/**
 * Normalize completion `insertText` and Monaco `range` so that:
 * 1. Single-line constraint is enforced when non-closing tokens exist to the right on the current line.
 * 2. Next-line indented completions at the end of a non-empty line (or after comments / block headers) start with `\n`.
 * 3. Suffix overlap on the current line is deduplicated.
 * 4. Multi-line completions on a line where `lineSuffix` is non-empty cover `lineSuffix` in `range.endColumn`
 *    so Monaco's `computeGhostText` renders them at any position in code.
 */
export function resolveInlineCompletionRangeAndText(rawInsertText, docState) {
  let insertText = String(rawInsertText || '');
  const lineNumber = Number(docState?.lineNumber || 1);
  const column = Number(docState?.column || 1);
  const linePrefix = String(docState?.linePrefix || '');
  const lineSuffix = String(docState?.lineSuffix || '');
  const trimmedLinePrefix = linePrefix.trim();
  const trimmedLineSuffix = lineSuffix.trim();

  const isOnlyClosingDelimitersOnRight =
    /^[}\]);,:\s]*$/.test(trimmedLineSuffix) && !trimmedLineSuffix.startsWith(',');
  const forceSingleLine = trimmedLineSuffix.length > 0 && !isOnlyClosingDelimitersOnRight;

  if (forceSingleLine && insertText.includes('\n')) {
    insertText =
      insertText
        .split('\n')
        .find((line) => line.trim().length > 0) || '';
  }

  // Deduplicate exact overlap with linePrefix if the worker echoed the current line
  if (linePrefix.length > 0 && !insertText.startsWith('\n')) {
    if (insertText.startsWith(linePrefix)) {
      insertText = insertText.slice(linePrefix.length);
    } else if (trimmedLinePrefix.length > 0 && insertText.startsWith(trimmedLinePrefix)) {
      insertText = insertText.slice(trimmedLinePrefix.length);
    }
  }

  // Ensure next-line completions after non-empty lines begin with `\n`
  if (trimmedLinePrefix.length > 0 && !forceSingleLine && !insertText.startsWith('\n') && insertText.trim().length > 0) {
    const isCommentLine =
      trimmedLinePrefix.startsWith('#') || trimmedLinePrefix.startsWith('//');
    const startsWithNextLineIndent = /^(?:  +|\t+)/.test(insertText);
    if (isCommentLine || startsWithNextLineIndent) {
      insertText = `\n${insertText}`;
    }
  }

  // Normalize indentation when cursor is on a whitespace-only line (`trimmedLinePrefix.length === 0 && linePrefix.length > 0`)
  if (
    trimmedLinePrefix.length === 0 &&
    linePrefix.length > 0 &&
    !forceSingleLine &&
    !insertText.startsWith('\n') &&
    insertText.trim().length > 0
  ) {
    const lines = insertText.split('\n');
    const firstLine = lines[0] || '';
    const firstLineIndent = (firstLine.match(/^[ \t]*/)?.[0] || '').length;
    const isTopLevelDeclAtZero =
      firstLineIndent === 0 &&
      /^(def |class |async def |@\w+|function |export |pub fn |fn )/.test(firstLine.trim());

    if (
      (firstLineIndent > 0 && firstLineIndent < linePrefix.length) ||
      isTopLevelDeclAtZero
    ) {
      insertText = `\n${insertText}`;
    } else if (firstLineIndent === 0 && lines.length > 1) {
      const firstNonEmptyRestIdx = lines.findIndex(
        (line, idx) => idx > 0 && line.trim().length > 0,
      );
      if (firstNonEmptyRestIdx !== -1) {
        const secondLineIndent = (lines[firstNonEmptyRestIdx].match(/^[ \t]*/)?.[0] || '').length;
        const firstLineTrimmed = firstLine.trim();
        const firstLineOpensBlock =
          firstLineTrimmed.endsWith(':') || firstLineTrimmed.endsWith('{');
        const expectedMinSecondIndent = firstLineOpensBlock
          ? linePrefix.length + 2
          : linePrefix.length;
        if (secondLineIndent < expectedMinSecondIndent) {
          insertText = lines
            .map((line, idx) => (idx === 0 || line.trim().length === 0 ? line : `${linePrefix}${line}`))
            .join('\n');
        }
      }
    }
  }

  // Deduplicate single-line suffix overlap with `lineSuffix`
  if (!insertText.includes('\n') && lineSuffix.length > 0) {
    if (insertText.endsWith(lineSuffix)) {
      insertText = insertText.slice(0, insertText.length - lineSuffix.length);
    }
  }

  let endColumn = column;
  if (insertText.includes('\n') && lineSuffix.length > 0) {
    endColumn = column + lineSuffix.length;
    if (trimmedLineSuffix.length > 0) {
      if (insertText.startsWith('\n')) {
        insertText = `${lineSuffix}${insertText}`;
      } else {
        const firstLine = insertText.split('\n')[0] || '';
        if (!firstLine.trimEnd().endsWith(trimmedLineSuffix)) {
          const lines = insertText.split('\n');
          lines[0] = `${lines[0]}${lineSuffix}`;
          insertText = lines.join('\n');
        }
      }
    }
  }

  return {
    insertText,
    range: {
      startLineNumber: lineNumber,
      startColumn: column,
      endLineNumber: lineNumber,
      endColumn,
    },
  };
}

const CODE_TO_KEY_MAP = Object.freeze({
  Backslash: '\\',
  IntlBackslash: '\\',
  Slash: '/',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Space: 'space',
});

/**
 * Normalize a key token from a shortcut string or KeyboardEvent.
 */
export function normalizeShortcutKeyToken(rawToken) {
  const raw = String(rawToken ?? '').trim();
  if (!raw) return '';
  if (raw === ' ' || /^space(bar)?$/i.test(raw)) return 'space';
  if (/^(intl)?backslash$/i.test(raw)) return '\\';
  if (/^slash$/i.test(raw)) return '/';
  if (/^esc$/i.test(raw)) return 'escape';
  if (/^return$/i.test(raw)) return 'enter';
  if (/^Key([A-Z])$/.test(raw)) return raw.slice(3).toLowerCase();
  if (/^Digit([0-9])$/.test(raw)) return raw.slice(5);
  if (CODE_TO_KEY_MAP[raw]) return CODE_TO_KEY_MAP[raw];
  return raw.toLowerCase();
}

/**
 * Parse a shortcut string such as `"Alt+\\"` or `"Ctrl+Shift+Space"` into modifiers + key.
 */
export function parseShortcutDescriptor(shortcutString) {
  const raw = String(shortcutString || '').trim();
  if (!raw) return null;
  const parts = raw
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  let key = '';

  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') {
      ctrl = true;
    } else if (lower === 'alt' || lower === 'option' || lower === 'opt') {
      alt = true;
    } else if (lower === 'shift') {
      shift = true;
    } else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'win' || lower === 'super') {
      meta = true;
    } else {
      key = normalizeShortcutKeyToken(part);
    }
  }

  if (!key) return null;
  return { ctrl, alt, shift, meta, key };
}

/**
 * Test whether a DOM `KeyboardEvent` matches the configured shortcut string.
 */
export function doesEventMatchShortcut(event, shortcutString) {
  if (!event || typeof event !== 'object') return false;
  const parsed = parseShortcutDescriptor(shortcutString);
  if (!parsed) return false;

  if (
    Boolean(event.ctrlKey) !== parsed.ctrl ||
    Boolean(event.altKey) !== parsed.alt ||
    Boolean(event.shiftKey) !== parsed.shift ||
    Boolean(event.metaKey) !== parsed.meta
  ) {
    return false;
  }

  const eventKey = normalizeShortcutKeyToken(event.key);
  const eventCode = normalizeShortcutKeyToken(event.code);
  return eventKey === parsed.key || (Boolean(eventCode) && eventCode === parsed.key);
}

const SHORTCUT_STORAGE_KEY = 'vibex:code-completion:manualShortcut';

export default {
  async activate(context) {
    const cache = new ForwardTypingCache();
    let activeAbortController = null;
    let activeRequestId = null;
    let inFlightWorkerRequestId = null;
    let inFlightStartedAt = 0;
    let activeEditorInstance = null;
    let cursorIdleTimer = null;
    let lastAutoCursorKey = '';
    let lastKnownVersionId = -1;
    let hasVisibleInlineSuggestion = false;
    let enabled = true;
    let triggerMode = 'auto';
    let manualShortcut = 'Alt+\\';
    let pendingManualTriggerUntil = 0;
    let pendingAutoTriggerUntil = 0;
    let statusState = 'idle'; // 'idle' | 'loading' | 'disabled' | 'error'
    let lastErrorMessage = null;

    try {
      const savedShortcut =
        typeof localStorage !== 'undefined' ? localStorage.getItem(SHORTCUT_STORAGE_KEY) : null;
      if (savedShortcut && savedShortcut.trim()) {
        manualShortcut = savedShortcut.trim();
      }
    } catch {
      // ignore storage errors
    }

    const applyRuntimeConfig = (cfg) => {
      if (!cfg || typeof cfg !== 'object') return;
      if (typeof cfg.enabled === 'boolean') {
        enabled = cfg.enabled;
        statusState = enabled ? 'idle' : 'disabled';
      }
      if (cfg.triggerMode === 'auto' || cfg.triggerMode === 'manual') {
        triggerMode = cfg.triggerMode;
      }
      if (typeof cfg.manualShortcut === 'string' && cfg.manualShortcut.trim()) {
        manualShortcut = cfg.manualShortcut.trim();
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.setItem(SHORTCUT_STORAGE_KEY, manualShortcut);
          }
        } catch {
          // ignore
        }
      }
    };

    const initialContextConfig =
      (typeof context?.config?.get === 'function' ? context.config.get() : context?.config) || null;
    if (initialContextConfig && typeof initialContextConfig === 'object') {
      applyRuntimeConfig(initialContextConfig);
    }

    const invokeWorker = async (method, params = {}) => {
      const callOnce = async () => {
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
      try {
        return await callOnce();
      } catch {
        return await callOnce();
      }
    };

    // Hydrate runtime config from worker status asynchronously on startup
    void invokeWorker('completion.status', {})
      .then((status) => {
        if (status && typeof status === 'object') {
          applyRuntimeConfig(status);
        }
      })
      .catch(() => {});

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

    const cancelActiveCompletion = (requestId = null, notifyWorker = false) => {
      if (!requestId || activeRequestId === requestId) {
        if (activeAbortController) {
          activeAbortController.abort();
          activeAbortController = null;
        }
        activeRequestId = null;
      }
      const targetRequestId = requestId || inFlightWorkerRequestId;
      if (targetRequestId && inFlightWorkerRequestId === targetRequestId) {
        inFlightWorkerRequestId = null;
        inFlightStartedAt = 0;
        if (notifyWorker) {
          void invokeWorker('completion.cancel', { requestId: targetRequestId }).catch(() => {});
        }
      }
    };

    const provideInlineCompletions = async (modelOrRequest, position, completionContext, token) => {
      if (!enabled) {
        return { items: [] };
      }

      if (cursorIdleTimer !== null) {
        clearTimeout(cursorIdleTimer);
        cursorIdleTimer = null;
      }

      // Cancel any previous pending debounce or local signal
      cancelActiveCompletion(null, false);

      const docState = extractCompletionDocumentState(modelOrRequest, position);
      let currentCursorKey = '';
      if (modelOrRequest && typeof modelOrRequest.getVersionId === 'function') {
        const vId = modelOrRequest.getVersionId();
        lastKnownVersionId = vId;
        currentCursorKey = `${vId}:${docState.lineNumber}:${docState.column}`;
      }
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

      const now = Date.now();
      const isPendingManual = now < pendingManualTriggerUntil;
      if (isPendingManual) {
        pendingManualTriggerUntil = 0;
      }
      const isPendingAuto = !isPendingManual && now < pendingAutoTriggerUntil;
      if (isPendingAuto) {
        pendingAutoTriggerUntil = 0;
      }

      // Note: In Monaco, InlineCompletionTriggerKind.Automatic === 0 and Explicit === 1.
      // When auto-triggered by our cursor-idle watcher (`isPendingAuto`), treat as automatic (`isManual = false`).
      const isManual = isPendingAuto
        ? false
        : Boolean(
            isPendingManual ||
              docState.manual ||
              completionContext?.manual === true ||
              completionContext?.triggerKind === 1 ||
              completionContext?.triggerKind === 'explicit',
          );

      if (!isManual && triggerMode === 'manual') {
        return { items: [] };
      }

      // 1. Check forward-typing prefix cache before waiting or hitting the network
      const cachedInsertText = cache.lookup(
        docState.filePath,
        docState.lineNumber,
        docState.linePrefix,
        docState.suffix,
      );
      if (cachedInsertText) {
        const normalizedCached = resolveInlineCompletionRangeAndText(cachedInsertText, docState);
        if (currentCursorKey) {
          lastAutoCursorKey = currentCursorKey;
        }
        return {
          items: [
            {
              insertText: normalizedCached.insertText,
              range: normalizedCached.range,
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
      const requestId = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      activeAbortController = abortController;
      activeRequestId = requestId;

      if (token) {
        if (token.isCancellationRequested || token.aborted) {
          abortController.abort();
          cancelActiveCompletion(requestId, false);
          return { items: [] };
        }
        if (typeof token.onCancellationRequested === 'function') {
          token.onCancellationRequested(() => {
            abortController.abort();
            cancelActiveCompletion(requestId, false);
          });
        } else if (typeof token.addEventListener === 'function') {
          token.addEventListener(
            'abort',
            () => {
              abortController.abort();
              cancelActiveCompletion(requestId, false);
            },
            { once: true },
          );
        }
      }

      // 3. Adaptive debounce (60ms for structural trigger chars, 180ms for normal typing, 0ms for manual or cursor-idle auto)
      const debounceMs = isPendingAuto
        ? 0
        : computeAdaptiveDebounceMs(docState.prefix, isManual);
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
      inFlightStartedAt = Date.now();
      try {
        const trimmedLineSuffix = String(docState.lineSuffix || '').trim();
        const workerSuffix =
          trimmedLineSuffix.length > 0 && !String(docState.suffix || '').startsWith('\n')
            ? `\n${docState.suffix}`
            : docState.suffix;

        const result = await invokeWorker('completion.complete', {
          requestId,
          filePath: docState.filePath,
          languageId: docState.languageId,
          prefix: docState.prefix,
          suffix: workerSuffix,
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
            const normalized = resolveInlineCompletionRangeAndText(item.insertText, docState);
            cache.store(
              docState.filePath,
              docState.lineNumber,
              docState.linePrefix,
              docState.suffix,
              normalized.insertText,
            );
            return {
              insertText: normalized.insertText,
              range: normalized.range,
              command: {
                id: ACCEPT_COMMAND_ID,
                title: 'Accept AI Inline Completion',
              },
            };
          });

        if (items.length > 0 && currentCursorKey) {
          lastAutoCursorKey = currentCursorKey;
        } else if (items.length === 0 && lastAutoCursorKey === currentCursorKey) {
          lastAutoCursorKey = '';
        }

        return { items };
      } catch (error) {
        statusState = 'error';
        lastErrorMessage = String(error?.message || error);
        if (lastAutoCursorKey === currentCursorKey) {
          lastAutoCursorKey = '';
        }
        return { items: [] };
      } finally {
        if (inFlightWorkerRequestId === requestId) {
          inFlightWorkerRequestId = null;
          inFlightStartedAt = 0;
        }
        if (activeAbortController === abortController) {
          activeAbortController = null;
        }
        if (activeRequestId === requestId) {
          activeRequestId = null;
        }
      }
    };

    let providerDisposable = null;
    let serviceWatchCleanup = null;
    let configUnsubscribe = null;
    let cursorWatcherDisposer = null;

    const triggerCursorIdleInlineCompletion = () => {
      if (!enabled || triggerMode !== 'auto') return;
      if (inFlightWorkerRequestId || activeAbortController) {
        if (inFlightStartedAt > 0 && Date.now() - inFlightStartedAt > 8000) {
          cancelActiveCompletion(null, true);
        } else {
          return;
        }
      }
      const editorBridge = getEditorBridge();
      const editor = activeEditorInstance || editorBridge?.getActiveEditor?.();
      if (!editor || typeof editor.trigger !== 'function') return;
      if (typeof editor.hasTextFocus === 'function' && !editor.hasTextFocus()) return;

      const model = typeof editor.getModel === 'function' ? editor.getModel() : null;
      const position = typeof editor.getPosition === 'function' ? editor.getPosition() : null;
      const selection = typeof editor.getSelection === 'function' ? editor.getSelection() : null;
      if (
        selection &&
        typeof selection.isEmpty === 'function' &&
        !selection.isEmpty()
      ) {
        return;
      }

      if (model && position) {
        const versionId = typeof model.getVersionId === 'function' ? model.getVersionId() : 1;
        const cursorKey = `${versionId}:${position.lineNumber}:${position.column}`;
        if (cursorKey === lastAutoCursorKey && hasVisibleInlineSuggestion) return;

        const fullText = typeof model.getValue === 'function' ? model.getValue() : '';
        if (!fullText || fullText.trim().length === 0) return;

        lastAutoCursorKey = cursorKey;
      }

      pendingAutoTriggerUntil = Date.now() + 1000;
      if (!hasVisibleInlineSuggestion) {
        try {
          editor.trigger('vibex.code-completion.auto', 'editor.action.inlineSuggest.hide', {});
        } catch {
          // ignore
        }
      }
      editor.trigger('vibex.code-completion.auto', 'editor.action.inlineSuggest.trigger', {});
    };

    const scheduleCursorIdleAutoTrigger = (delayMs = 320) => {
      if (cursorIdleTimer !== null) {
        clearTimeout(cursorIdleTimer);
        cursorIdleTimer = null;
      }
      if (!enabled || triggerMode !== 'auto') return;
      cursorIdleTimer = setTimeout(() => {
        cursorIdleTimer = null;
        triggerCursorIdleInlineCompletion();
      }, delayMs);
    };

    const bindEditorCursorListeners = (editor) => {
      if (typeof cursorWatcherDisposer === 'function') {
        cursorWatcherDisposer();
        cursorWatcherDisposer = null;
      }
      if (!editor || typeof editor !== 'object') return;
      const initialModel = typeof editor.getModel === 'function' ? editor.getModel() : null;
      if (initialModel && typeof initialModel.getVersionId === 'function') {
        lastKnownVersionId = initialModel.getVersionId();
      }
      const subs = [];
      if (typeof editor.onDidChangeModelContent === 'function') {
        const sub = editor.onDidChangeModelContent(() => {
          hasVisibleInlineSuggestion = false;
          const m = typeof editor.getModel === 'function' ? editor.getModel() : null;
          if (m && typeof m.getVersionId === 'function') {
            lastKnownVersionId = m.getVersionId();
          }
          if (cursorIdleTimer !== null) {
            clearTimeout(cursorIdleTimer);
            cursorIdleTimer = null;
          }
        });
        if (sub && typeof sub.dispose === 'function') subs.push(() => sub.dispose());
      }
      if (typeof editor.onDidChangeCursorPosition === 'function') {
        const sub = editor.onDidChangeCursorPosition((e) => {
          hasVisibleInlineSuggestion = false;
          const m = typeof editor.getModel === 'function' ? editor.getModel() : null;
          const currentVersionId =
            m && typeof m.getVersionId === 'function' ? m.getVersionId() : lastKnownVersionId;
          // If cursor position changed due to typing/editing, Monaco already triggers provideInlineCompletions
          if (currentVersionId !== lastKnownVersionId || e?.reason === 2) {
            lastKnownVersionId = currentVersionId;
            if (cursorIdleTimer !== null) {
              clearTimeout(cursorIdleTimer);
              cursorIdleTimer = null;
            }
            return;
          }
          scheduleCursorIdleAutoTrigger(320);
        });
        if (sub && typeof sub.dispose === 'function') subs.push(() => sub.dispose());
      }
      if (typeof editor.onDidFocusEditorText === 'function') {
        const sub = editor.onDidFocusEditorText(() => {
          scheduleCursorIdleAutoTrigger(320);
        });
        if (sub && typeof sub.dispose === 'function') subs.push(() => sub.dispose());
      }
      cursorWatcherDisposer = () => {
        for (const dispose of subs) {
          try {
            dispose();
          } catch {
            // ignore
          }
        }
      };
    };

    const attachToEditorBridge = (editorBridge) => {
      if (!editorBridge || providerDisposable) return;

      const currentActive = editorBridge.getActiveEditor?.();
      if (currentActive) {
        activeEditorInstance = currentActive;
        bindEditorCursorListeners(currentActive);
        scheduleCursorIdleAutoTrigger(350);
      }

      if (typeof editorBridge.onDidActiveEditorChange === 'function') {
        editorBridge.onDidActiveEditorChange((editor) => {
          activeEditorInstance = editor;
          bindEditorCursorListeners(editor);
          scheduleCursorIdleAutoTrigger(350);
        });
      }

      const inlineProvider = {
        provideInlineCompletions,
        freeInlineCompletions() {},
        handleItemDidShow() {
          hasVisibleInlineSuggestion = true;
        },
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

    if (typeof context?.config?.subscribe === 'function') {
      configUnsubscribe = context.config.subscribe((nextCfg) => {
        applyRuntimeConfig(nextCfg);
      });
    }

    const onWindowConfigUpdated = (event) => {
      const detail = event?.detail;
      if (
        detail &&
        (detail.pluginId === 'vibex.code-completion' || detail.pluginId === 'code-completion') &&
        detail.config &&
        typeof detail.config === 'object'
      ) {
        applyRuntimeConfig(detail.config);
        void invokeWorker('completion.configure', detail.config).catch(() => {});
      }
    };

    const onWindowMouseUp = (event) => {
      if (!enabled || triggerMode !== 'auto') return;
      const targetEl = event?.target;
      if (
        targetEl &&
        typeof targetEl.closest === 'function' &&
        targetEl.closest('.monaco-editor')
      ) {
        scheduleCursorIdleAutoTrigger(260);
      }
    };

    const onWindowKeyDown = (event) => {
      if (!enabled) return;
      if (manualShortcut && doesEventMatchShortcut(event, manualShortcut)) {
        const targetEl = event?.target;
        const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
        const inMonacoDom =
          Boolean(targetEl && typeof targetEl.closest === 'function' && targetEl.closest('.monaco-editor')) ||
          Boolean(activeEl && typeof activeEl.closest === 'function' && activeEl.closest('.monaco-editor'));

        const editorBridge = getEditorBridge();
        const activeEditor = activeEditorInstance || editorBridge?.getActiveEditor?.();
        const hasEditorFocus =
          inMonacoDom ||
          Boolean(typeof activeEditor?.hasTextFocus === 'function' && activeEditor.hasTextFocus());

        if (!hasEditorFocus) return;

        event.preventDefault?.();
        event.stopPropagation?.();
        cancelActiveCompletion(null, false);
        lastAutoCursorKey = '';
        hasVisibleInlineSuggestion = false;
        pendingManualTriggerUntil = Date.now() + 1500;
        if (typeof activeEditor?.trigger === 'function') {
          try {
            activeEditor.trigger('vibex.code-completion', 'editor.action.inlineSuggest.hide', {});
          } catch {
            // ignore
          }
        }
        if (editorBridge && typeof editorBridge.triggerInlineCompletion === 'function') {
          void editorBridge.triggerInlineCompletion(activeEditor);
        } else if (typeof activeEditor?.trigger === 'function') {
          activeEditor.trigger('vibex.code-completion', 'editor.action.inlineSuggest.trigger', {});
        }
        return;
      }

      if (
        triggerMode === 'auto' &&
        (event?.key === 'ArrowDown' ||
          event?.key === 'ArrowUp' ||
          event?.key === 'ArrowRight' ||
          event?.key === 'ArrowLeft' ||
          event?.key === 'End')
      ) {
        const targetEl = event?.target;
        if (
          targetEl &&
          typeof targetEl.closest === 'function' &&
          targetEl.closest('.monaco-editor')
        ) {
          scheduleCursorIdleAutoTrigger(280);
        }
      }
    };

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('vibex:plugin-config-updated', onWindowConfigUpdated);
      window.addEventListener('keydown', onWindowKeyDown, true);
      window.addEventListener('mouseup', onWindowMouseUp, true);
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
      hasVisibleInlineSuggestion = false;
      lastAutoCursorKey = '';
      const targetEditor = editorArg || activeEditorInstance || getEditorBridge()?.getActiveEditor?.();
      applyWithUndoStopBarrier(targetEditor, () => {});
      scheduleCursorIdleAutoTrigger(180);
      return { accepted: true };
    });

    registerHandler('completion.status', async () => {
      const workerStatus = (await invokeWorker('completion.status', {}).catch(() => null)) || {};
      applyRuntimeConfig(workerStatus);
      return {
        ...workerStatus,
        enabled,
        triggerMode,
        manualShortcut,
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
        cancelActiveCompletion(null, true);
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
      cancelActiveCompletion(null, false);
      lastAutoCursorKey = '';
      hasVisibleInlineSuggestion = false;
      pendingManualTriggerUntil = Date.now() + 1500;
      const editorBridge = getEditorBridge();
      const activeEditor = activeEditorInstance || editorBridge?.getActiveEditor?.();
      if (typeof activeEditor?.trigger === 'function') {
        try {
          activeEditor.trigger('vibex.code-completion', 'editor.action.inlineSuggest.hide', {});
        } catch {
          // ignore
        }
      }
      if (editorBridge && typeof editorBridge.triggerInlineCompletion === 'function') {
        await editorBridge.triggerInlineCompletion(activeEditor);
        return { triggered: true, via: 'editor-bridge' };
      }
      if (params && typeof params.prefix === 'string') {
        return await provideInlineCompletions({ ...params, manual: true }, params.position, {
          triggerKind: 1,
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
        if (cursorIdleTimer !== null) {
          clearTimeout(cursorIdleTimer);
          cursorIdleTimer = null;
        }
        if (typeof cursorWatcherDisposer === 'function') {
          cursorWatcherDisposer();
          cursorWatcherDisposer = null;
        }
        cancelActiveCompletion(null, true);
        cache.clear();
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
          window.removeEventListener('vibex:plugin-config-updated', onWindowConfigUpdated);
          window.removeEventListener('keydown', onWindowKeyDown, true);
          window.removeEventListener('mouseup', onWindowMouseUp, true);
        }
        if (typeof configUnsubscribe === 'function') {
          configUnsubscribe();
          configUnsubscribe = null;
        }
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
