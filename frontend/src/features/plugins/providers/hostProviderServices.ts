import {
  type Disposer,
  Registry,
  serviceContainer,
  type VibeXPluginContext,
} from '@vibex/plugin-sdk';
import { attemptsApi, configApi, projectsApi } from '@/lib/api';
import { createPluginControlApi } from '@/lib/api/plugins';
import {
  backendCall,
  configuredBackendTransport,
} from '@/lib/backendTransport';
import type {
  ProviderCatalogListView,
  ProviderCatalogSourceView,
  ProviderCatalogTemplateView,
} from '@/pages/settings/providerCatalogTypes';
import type { AgentId, EditorType, PlanUsageResult } from 'shared/types';

export interface RuntimeModelCatalogSource {
  id: string;
  pluginId: string;
  pluginLabel: string;
  label: string;
  agents: string[];
  description?: string | null;
  templates: Omit<
    ProviderCatalogTemplateView,
    'plugin_id' | 'plugin_label' | 'contribution_id'
  >[];
}

export interface ModelCatalogProviderService {
  listCatalog(
    agentId: string,
    fallbackFetcher?: (agentId: string) => Promise<ProviderCatalogListView>
  ): Promise<ProviderCatalogListView>;
  registerCatalogSource(source: RuntimeModelCatalogSource): () => void;
  listCatalogSources(agentId?: string): readonly RuntimeModelCatalogSource[];
  hasRuntimeSources(agentId?: string): boolean;
}

export interface UsageProberRegistration {
  id: string;
  pluginId?: string;
  label: string;
  agents?: string[];
  probe(input: {
    agentId: AgentId | string;
    current?: PlanUsageResult | null;
  }): Promise<PlanUsageResult | null | undefined>;
}

export interface UsageProviderService {
  probeAgentUsage(
    agentId: AgentId | string,
    fallbackFetcher?: (agentId: AgentId) => Promise<PlanUsageResult>
  ): Promise<PlanUsageResult>;
  registerUsageProber(prober: UsageProberRegistration): () => void;
  listUsageProbers(agentId?: string): readonly UsageProberRegistration[];
}

export interface CustomEditorOpenerRegistration {
  id: string;
  label: string;
  hint: string;
  pluginId?: string;
  isAvailable?: () => Promise<boolean> | boolean;
  openAttempt?: (input: {
    attemptId: string;
    editorType?: EditorType | string | null;
    filePath?: string | null;
  }) => Promise<{ url?: string } | void>;
  openProject?: (input: {
    projectId: string;
    editorType?: EditorType | string | null;
    filePath?: string | null;
  }) => Promise<{ url?: string } | void>;
}

export interface EditorOpenerProviderService {
  openAttemptInEditor(
    attemptId: string,
    options?: {
      editorType?: EditorType | string | null;
      filePath?: string | null;
    }
  ): Promise<{ url?: string }>;
  openProjectInEditor(
    projectId: string,
    options?: {
      editorType?: EditorType | string | null;
      filePath?: string | null;
    }
  ): Promise<{ url?: string }>;
  checkAvailability(editorType: EditorType | string): Promise<boolean>;
  registerEditorOpener(opener: CustomEditorOpenerRegistration): () => void;
  listEditorOpeners(): readonly CustomEditorOpenerRegistration[];
}

export type HybridDisposer = Disposer & {
  dispose: () => void;
};

export interface CodeEditorPositionLike {
  readonly lineNumber: number;
  readonly column: number;
}

export interface CodeEditorRangeLike {
  readonly startLineNumber: number;
  readonly startColumn: number;
  readonly endLineNumber: number;
  readonly endColumn: number;
}

export interface CodeEditorDocumentSnapshot {
  readonly filePath: string;
  readonly displayPath?: string | null;
  readonly languageId: string;
  readonly content: string;
  readonly versionId?: number;
  readonly isActive: boolean;
  readonly lastAccessedAt: number;
}

export interface CodeEditorInstanceMetadata {
  readonly filePath?: string | null;
  readonly displayPath?: string | null;
  readonly languageId?: string | null;
}

export interface InlineCompletionItemResult {
  readonly insertText: string;
  readonly range?: CodeEditorRangeLike;
  readonly command?: {
    readonly id: string;
    readonly title: string;
    readonly arguments?: unknown[];
  };
}

export interface InlineCompletionContextPayload {
  readonly filePath: string;
  readonly languageId: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly linePrefix: string;
  readonly lineSuffix: string;
  readonly position: CodeEditorPositionLike;
  readonly triggerKind: 'automatic' | 'explicit';
  readonly manual: boolean;
  readonly signal: AbortSignal;
  readonly openDocuments: readonly CodeEditorDocumentSnapshot[];
}

export interface MonacoInlineCompletionProviderLike {
  provideInlineCompletions(
    model: unknown,
    position: unknown,
    context: unknown,
    token: unknown
  ): Promise<
    | { items: InlineCompletionItemResult[] }
    | InlineCompletionItemResult[]
    | null
    | undefined
  >;
  freeInlineCompletions?(completions: unknown): void;
  disposeInlineCompletions?(completions: unknown, reason?: unknown): void;
  handleItemDidShow?(
    completions: unknown,
    item: unknown,
    updatedInsertText: string
  ): void;
}

export interface InlineCompletionHandlerRegistration {
  readonly id: string;
  readonly pluginId?: string;
  readonly languages?: readonly string[] | '*';
  provideInlineCompletions(
    context: InlineCompletionContextPayload,
    rawMonacoArgs?: {
      model: unknown;
      position: unknown;
      completionContext: unknown;
      token: unknown;
    }
  ): Promise<
    | { items: InlineCompletionItemResult[] }
    | InlineCompletionItemResult[]
    | null
    | undefined
  >;
  freeInlineCompletions?(completions: unknown): void;
}

export interface InlineEditActionRegistration {
  readonly id: string;
  readonly label: string;
  readonly keybindings?: readonly number[];
  readonly precondition?: string;
  readonly contextMenuGroupId?: string;
  readonly contextMenuOrder?: number;
  run(editor: unknown, ...args: unknown[]): void | Promise<void>;
}

export interface TabYieldContext {
  readonly suggestWidgetVisible?: boolean;
  readonly inSnippetMode?: boolean;
  readonly inlineSuggestionVisible?: boolean;
  readonly linePrefix?: string;
  readonly lineSuffix?: string;
}

export interface CodeEditorProviderService {
  setMonacoInstance(monaco: unknown): void;
  getMonacoInstance(): unknown;
  registerEditorInstance(
    editor: unknown,
    metadata?: CodeEditorInstanceMetadata
  ): HybridDisposer;
  getActiveEditor(): unknown;
  getActiveDocument(): CodeEditorDocumentSnapshot | null;
  getOpenDocuments(options?: {
    excludeActive?: boolean;
    maxDocuments?: number;
  }): Promise<CodeEditorDocumentSnapshot[]>;
  getOpenDocumentsSnapshot(options?: {
    excludeActive?: boolean;
    maxDocuments?: number;
  }): CodeEditorDocumentSnapshot[];
  onDidChangeActiveEditor(listener: (editor: unknown) => void): HybridDisposer;
  onDidActiveEditorChange(listener: (editor: unknown) => void): HybridDisposer;
  registerInlineCompletionHandler(
    registration: InlineCompletionHandlerRegistration
  ): HybridDisposer;
  registerInlineCompletionProvider(
    selectorOrRegistration:
      | string
      | readonly string[]
      | InlineCompletionHandlerRegistration,
    provider?: MonacoInlineCompletionProviderLike
  ): HybridDisposer;
  registerInlineCompletionsProvider(
    selectorOrRegistration:
      | string
      | readonly string[]
      | InlineCompletionHandlerRegistration,
    provider?: MonacoInlineCompletionProviderLike
  ): HybridDisposer;
  listInlineCompletionHandlers(
    languageId?: string
  ): readonly InlineCompletionHandlerRegistration[];
  registerInlineEditAction(
    action: InlineEditActionRegistration
  ): HybridDisposer;
  registerEditorAction(action: InlineEditActionRegistration): HybridDisposer;
  listInlineEditActions(): readonly InlineEditActionRegistration[];
  triggerInlineCompletion(editor?: unknown): Promise<void>;
  computeAdaptiveDebounceMs(prefix: string, manual?: boolean): number;
  applyWithUndoStopBarrier<T>(editor: unknown, callback: () => T): T;
  acceptInlineCompletion(
    editor: unknown,
    insertText: string,
    range?: CodeEditorRangeLike
  ): boolean;
  acceptNextCompletionWord(
    editor: unknown,
    remainingText: string,
    range?: CodeEditorRangeLike
  ): { acceptedText: string; remainingText: string };
  acceptNextCompletionLine(
    editor: unknown,
    remainingText: string,
    range?: CodeEditorRangeLike
  ): { acceptedText: string; remainingText: string };
  shouldYieldTabToNativeEditor(
    editor: unknown,
    context?: TabYieldContext
  ): boolean;
}

export const runtimeModelCatalogRegistry =
  new Registry<RuntimeModelCatalogSource>();
export const runtimeUsageProberRegistry =
  new Registry<UsageProberRegistration>();
export const runtimeEditorOpenerRegistry =
  new Registry<CustomEditorOpenerRegistration>();
export const runtimeInlineCompletionRegistry =
  new Registry<InlineCompletionHandlerRegistration>();
export const runtimeInlineEditActionRegistry =
  new Registry<InlineEditActionRegistration>();

function mergeCatalogWithRuntimeSources(
  agentId: string,
  baseView: ProviderCatalogListView
): ProviderCatalogListView {
  const runtimeSources = runtimeModelCatalogRegistry
    .getAll()
    .filter((src) => src.agents.length === 0 || src.agents.includes(agentId));
  if (runtimeSources.length === 0) {
    return baseView;
  }

  const existingTemplateKeys = new Set(
    baseView.templates.map(
      (tpl) => `${tpl.plugin_id}:${tpl.contribution_id}:${tpl.id}`
    )
  );
  const mergedTemplates = [...baseView.templates];
  const mergedSources: ProviderCatalogSourceView[] = [...baseView.sources];

  for (const src of runtimeSources) {
    let addedCount = 0;
    for (const tpl of src.templates) {
      if (tpl.agent_id && tpl.agent_id !== agentId) continue;
      const key = `${src.pluginId}:${src.id}:${tpl.id}`;
      if (existingTemplateKeys.has(key)) continue;
      existingTemplateKeys.add(key);
      mergedTemplates.push({
        ...tpl,
        plugin_id: src.pluginId,
        plugin_label: src.pluginLabel,
        contribution_id: src.id,
        agent_id: tpl.agent_id || agentId,
      });
      addedCount += 1;
    }
    if (
      !mergedSources.some(
        (existing) =>
          existing.plugin_id === src.pluginId &&
          existing.contribution_id === src.id
      )
    ) {
      mergedSources.push({
        plugin_id: src.pluginId,
        contribution_id: src.id,
        label: src.label,
        template_count: addedCount,
      });
    }
  }

  return {
    agent_id: baseView.agent_id || agentId,
    generation: baseView.generation,
    templates: mergedTemplates,
    sources: mergedSources,
  };
}

export const defaultModelCatalogProviderService: ModelCatalogProviderService = {
  async listCatalog(agentId, fallbackFetcher) {
    const fetcher =
      fallbackFetcher ??
      (async (id: string): Promise<ProviderCatalogListView> => {
        try {
          const api = createPluginControlApi(configuredBackendTransport);
          return (await api.providerCatalogList(id)) as ProviderCatalogListView;
        } catch {
          return {
            agent_id: id,
            generation: 0,
            templates: [],
            sources: [],
          };
        }
      });
    const baseView: ProviderCatalogListView = await fetcher(agentId);
    const merged = mergeCatalogWithRuntimeSources(agentId, {
      agent_id:
        typeof baseView?.agent_id === 'string' ? baseView.agent_id : agentId,
      generation:
        typeof baseView?.generation === 'number' ? baseView.generation : 0,
      templates: Array.isArray(baseView?.templates) ? baseView.templates : [],
      sources: Array.isArray(baseView?.sources) ? baseView.sources : [],
    });
    return serviceContainer.runWaterfall(
      'provider.model.catalog:resolve',
      merged,
      async (val) => val
    );
  },

  registerCatalogSource(source) {
    return runtimeModelCatalogRegistry.register(
      `${source.pluginId}:${source.id}`,
      source
    );
  },

  listCatalogSources(agentId) {
    const all = runtimeModelCatalogRegistry.getAll();
    if (!agentId) return all;
    return all.filter(
      (src) => src.agents.length === 0 || src.agents.includes(agentId)
    );
  },

  hasRuntimeSources(agentId) {
    return this.listCatalogSources(agentId).length > 0;
  },
};

export const defaultUsageProviderService: UsageProviderService = {
  async probeAgentUsage(agentId, fallbackFetcher) {
    const probers = this.listUsageProbers(String(agentId));
    let current: PlanUsageResult | null = null;
    const fetcher =
      fallbackFetcher ??
      ((id: AgentId) =>
        backendCall<PlanUsageResult>('agent_plan_usage', { agentId: id }));

    try {
      current = await fetcher(agentId as AgentId);
    } catch (err) {
      if (probers.length === 0) {
        throw err;
      }
    }

    for (const prober of probers) {
      try {
        const next = await prober.probe({ agentId, current });
        if (next) {
          current = next;
        }
      } catch (err) {
        console.warn(
          `[UsageProviderService] Prober "${prober.id}" failed:`,
          err
        );
      }
    }

    const baseResult: PlanUsageResult =
      current ??
      ({
        status: 'unavailable',
        reason: 'No usage prober returned data',
      } as unknown as PlanUsageResult);

    return serviceContainer.runWaterfall(
      'provider.usage:resolve',
      baseResult,
      async (val) => val
    );
  },

  registerUsageProber(prober) {
    return runtimeUsageProberRegistry.register(prober.id, prober);
  },

  listUsageProbers(agentId) {
    const all = runtimeUsageProberRegistry.getAll();
    if (!agentId) return all;
    return all.filter(
      (p) => !p.agents || p.agents.length === 0 || p.agents.includes(agentId)
    );
  },
};

export const defaultEditorOpenerProviderService: EditorOpenerProviderService = {
  async openAttemptInEditor(attemptId, options) {
    const editorType = options?.editorType ?? null;
    const filePath = options?.filePath ?? null;

    if (editorType) {
      const custom = runtimeEditorOpenerRegistry.get(String(editorType));
      if (custom?.openAttempt) {
        const res = await custom.openAttempt({
          attemptId,
          editorType,
          filePath,
        });
        return res ?? {};
      }
    }

    const initialAttemptPayload: {
      attemptId: string;
      editorType: EditorType | string | null;
      filePath: string | null;
      handled?: boolean;
      url?: string;
    } = {
      attemptId,
      editorType,
      filePath,
    };
    const intercepted = await serviceContainer.runWaterfall(
      'provider.editor.opener:openAttempt',
      initialAttemptPayload,
      async (val) => val
    );
    if (intercepted?.handled) {
      return { url: intercepted.url };
    }

    const response = await attemptsApi.openEditor(attemptId, {
      editor_type: (editorType as EditorType | null) ?? null,
      file_path: filePath,
    });
    return { url: response.url ?? undefined };
  },

  async openProjectInEditor(projectId, options) {
    const editorType = options?.editorType ?? null;
    const filePath = options?.filePath ?? null;

    if (editorType) {
      const custom = runtimeEditorOpenerRegistry.get(String(editorType));
      if (custom?.openProject) {
        const res = await custom.openProject({
          projectId,
          editorType,
          filePath,
        });
        return res ?? {};
      }
    }

    const initialProjectPayload: {
      projectId: string;
      editorType: EditorType | string | null;
      filePath: string | null;
      handled?: boolean;
      url?: string;
    } = {
      projectId,
      editorType,
      filePath,
    };
    const intercepted = await serviceContainer.runWaterfall(
      'provider.editor.opener:openProject',
      initialProjectPayload,
      async (val) => val
    );
    if (intercepted?.handled) {
      return { url: intercepted.url };
    }

    const response = await projectsApi.openEditor(projectId, {
      editor_type: (editorType as EditorType | null) ?? null,
      file_path: filePath,
    });
    return { url: response.url ?? undefined };
  },

  async checkAvailability(editorType) {
    const custom = runtimeEditorOpenerRegistry.get(String(editorType));
    if (custom?.isAvailable) {
      return Boolean(await custom.isAvailable());
    }
    const result = await configApi.checkEditorAvailability(
      editorType as EditorType
    );
    return Boolean(result.available);
  },

  registerEditorOpener(opener) {
    return runtimeEditorOpenerRegistry.register(opener.id, opener);
  },

  listEditorOpeners() {
    return runtimeEditorOpenerRegistry.getAll();
  },
};

export const NORMAL_COMPLETION_DEBOUNCE_MS = 180;
export const FAST_TRIGGER_COMPLETION_DEBOUNCE_MS = 60;

const STRUCTURAL_TRIGGER_CHARS = new Set([
  '.',
  '(',
  '{',
  '[',
  ':',
  '=',
  ',',
  '/',
  '\n',
]);

export function toHybridDisposer(disposeFn: () => void): HybridDisposer {
  let disposed = false;
  const run = () => {
    if (disposed) return;
    disposed = true;
    disposeFn();
  };
  return Object.assign(run, { dispose: run });
}

/**
 * Two-tier adaptive debounce for inline code completion:
 * - `0ms` for explicit manual trigger (`Alt + \`).
 * - `60ms` after structural trigger characters (`.`, `(`, `{`, `[`, `:`, `=`, `,`, `/`, `\n`, `=>`, `->`, or indented newline).
 * - `180ms` for continuous normal typing.
 */
export function computeAdaptiveDebounceMs(
  prefix: string,
  manual = false
): number {
  if (manual) return 0;
  if (!prefix) return NORMAL_COMPLETION_DEBOUNCE_MS;
  const lastChar = prefix[prefix.length - 1] ?? '';
  if (STRUCTURAL_TRIGGER_CHARS.has(lastChar)) {
    return FAST_TRIGGER_COMPLETION_DEBOUNCE_MS;
  }
  const currentLine = prefix.split('\n').pop() ?? '';
  const trimmedLine = currentLine.trimEnd();
  const lastNonSpaceChar = trimmedLine[trimmedLine.length - 1] ?? '';
  if (
    STRUCTURAL_TRIGGER_CHARS.has(lastNonSpaceChar) ||
    trimmedLine.endsWith('=>') ||
    trimmedLine.endsWith('->') ||
    /\n[ \t]+$/.test(prefix)
  ) {
    return FAST_TRIGGER_COMPLETION_DEBOUNCE_MS;
  }
  return NORMAL_COMPLETION_DEBOUNCE_MS;
}

/**
 * Forward-Typing Prefix Cache (`0ms` local slicing when user continues typing characters
 * that match the prefix of the last returned inline completion on the same line & suffix).
 */
export class PrefixCompletionCache {
  private readonly maxEntries: number;
  private readonly entries = new Map<
    string,
    {
      linePrefix: string;
      suffix: string;
      insertText: string;
      timestamp: number;
    }
  >();

  constructor(maxEntries = 32) {
    this.maxEntries = maxEntries;
  }

  private buildKey(filePath: string, lineNumber: number): string {
    return `${filePath || 'untitled'}::${lineNumber || 1}`;
  }

  store(
    filePath: string,
    lineNumber: number,
    linePrefix: string,
    suffix: string,
    insertText: string
  ): void {
    if (!insertText) return;
    const key = this.buildKey(filePath, lineNumber);
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, {
      linePrefix: String(linePrefix ?? ''),
      suffix: String(suffix ?? ''),
      insertText: String(insertText),
      timestamp: Date.now(),
    });
  }

  lookup(
    filePath: string,
    lineNumber: number,
    currentLinePrefix: string,
    currentSuffix: string
  ): string | null {
    const key = this.buildKey(filePath, lineNumber);
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.suffix !== String(currentSuffix ?? '')) {
      return null;
    }
    const prefixStr = String(currentLinePrefix ?? '');
    if (!prefixStr.startsWith(entry.linePrefix)) {
      return null;
    }
    const typedDelta = prefixStr.slice(entry.linePrefix.length);
    if (typedDelta.length === 0) {
      return entry.insertText;
    }
    if (entry.insertText.startsWith(typedDelta)) {
      const sliced = entry.insertText.slice(typedDelta.length);
      return sliced.length > 0 ? sliced : null;
    }
    return null;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Wrap an inline completion edit inside a Monaco Undo Stop Barrier
 * (`editor.pushUndoStop()` + `model.pushStackElement()` before and after `executeEdits`)
 * so that a single `Ctrl/Cmd + Z` atomically reverts the entire accepted completion block.
 */
export function applyWithUndoStopBarrier<T>(
  editor: unknown,
  callback: () => T
): T {
  const editorLike = editor as {
    pushUndoStop?: () => void;
    getModel?: () => { pushStackElement?: () => void } | null;
  } | null;

  const model =
    typeof editorLike?.getModel === 'function' ? editorLike.getModel() : null;

  editorLike?.pushUndoStop?.();
  model?.pushStackElement?.();
  try {
    return callback();
  } finally {
    model?.pushStackElement?.();
    editorLike?.pushUndoStop?.();
  }
}

function resolveEditorInsertionRange(
  editor: unknown,
  explicitRange?: CodeEditorRangeLike
): CodeEditorRangeLike {
  if (explicitRange) {
    return explicitRange;
  }
  const editorLike = editor as {
    getSelection?: () => Partial<CodeEditorRangeLike> | null;
    getPosition?: () => Partial<CodeEditorPositionLike> | null;
  } | null;
  const selection =
    typeof editorLike?.getSelection === 'function'
      ? editorLike.getSelection()
      : null;
  if (
    selection &&
    typeof selection.startLineNumber === 'number' &&
    typeof selection.startColumn === 'number' &&
    typeof selection.endLineNumber === 'number' &&
    typeof selection.endColumn === 'number'
  ) {
    return {
      startLineNumber: selection.startLineNumber,
      startColumn: selection.startColumn,
      endLineNumber: selection.endLineNumber,
      endColumn: selection.endColumn,
    };
  }
  const position =
    typeof editorLike?.getPosition === 'function'
      ? editorLike.getPosition()
      : null;
  const lineNumber = position?.lineNumber ?? 1;
  const column = position?.column ?? 1;
  return {
    startLineNumber: lineNumber,
    startColumn: column,
    endLineNumber: lineNumber,
    endColumn: column,
  };
}

export function acceptInlineCompletionWithUndoBarrier(
  editor: unknown,
  insertText: string,
  range?: CodeEditorRangeLike
): boolean {
  if (!editor || !insertText) return false;
  const editorLike = editor as {
    executeEdits?: (
      source: string,
      edits: Array<{
        range: CodeEditorRangeLike;
        text: string;
        forceMoveMarkers?: boolean;
      }>
    ) => boolean | void;
  };
  if (typeof editorLike.executeEdits !== 'function') {
    return false;
  }
  const targetRange = resolveEditorInsertionRange(editor, range);
  return applyWithUndoStopBarrier(editor, () => {
    const result = editorLike.executeEdits?.('inlineCompletion.accept', [
      {
        range: targetRange,
        text: insertText,
        forceMoveMarkers: true,
      },
    ]);
    return result !== false;
  });
}

export function extractNextWordSlice(remainingText: string): {
  acceptedText: string;
  remainingText: string;
} {
  if (!remainingText) {
    return { acceptedText: '', remainingText: '' };
  }
  const match = remainingText.match(/^(\s*\S+|\s+)/);
  const acceptedText = match?.[0] ?? remainingText;
  return {
    acceptedText,
    remainingText: remainingText.slice(acceptedText.length),
  };
}

export function extractNextLineSlice(remainingText: string): {
  acceptedText: string;
  remainingText: string;
} {
  if (!remainingText) {
    return { acceptedText: '', remainingText: '' };
  }
  const newlineIndex = remainingText.indexOf('\n');
  if (newlineIndex === -1) {
    return { acceptedText: remainingText, remainingText: '' };
  }
  const acceptedText = remainingText.slice(0, newlineIndex + 1);
  return {
    acceptedText,
    remainingText: remainingText.slice(newlineIndex + 1),
  };
}

/**
 * Determine whether `Tab` must yield to Monaco's native behavior instead of accepting Ghost Text:
 * 1. Native `Suggest Widget` is visible (`suggestWidgetVisible === true`).
 * 2. Native `Snippet` placeholder jump mode is active (`inSnippetMode === true`).
 * 3. Cursor is in leading indentation whitespace before existing code on the same line
 *    (`/^\s*$/` before cursor while `lineSuffix` has code and no inline Ghost Text is explicitly active),
 *    preserving standard code indentation.
 */
export function shouldYieldTabToNativeEditor(
  editor: unknown,
  context?: TabYieldContext
): boolean {
  const editorLike = editor as {
    getContextKeyValue?: (key: string) => unknown;
    _contextKeyService?: { getContextKeyValue?: (key: string) => unknown };
    getModel?: () => {
      getLineContent?: (lineNumber: number) => string;
    } | null;
    getPosition?: () => CodeEditorPositionLike | null;
  } | null;

  const readContextKey = (key: string): boolean | undefined => {
    const direct = editorLike?.getContextKeyValue?.(key);
    if (typeof direct === 'boolean') return direct;
    const nested = editorLike?._contextKeyService?.getContextKeyValue?.(key);
    if (typeof nested === 'boolean') return nested;
    return undefined;
  };

  const suggestVisible =
    context?.suggestWidgetVisible ?? readContextKey('suggestWidgetVisible');
  if (suggestVisible === true) {
    return true;
  }

  const snippetActive =
    context?.inSnippetMode ?? readContextKey('inSnippetMode');
  if (snippetActive === true) {
    return true;
  }

  const inlineVisible =
    context?.inlineSuggestionVisible ??
    readContextKey('inlineSuggestionVisible');
  if (inlineVisible === false) {
    return true;
  }

  let linePrefix = context?.linePrefix;
  let lineSuffix = context?.lineSuffix;
  if (linePrefix === undefined || lineSuffix === undefined) {
    const model =
      typeof editorLike?.getModel === 'function' ? editorLike.getModel() : null;
    const position =
      typeof editorLike?.getPosition === 'function'
        ? editorLike.getPosition()
        : null;
    if (model && typeof model.getLineContent === 'function' && position) {
      const lineContent = model.getLineContent(position.lineNumber) ?? '';
      const splitIdx = Math.max(0, (position.column ?? 1) - 1);
      linePrefix = linePrefix ?? lineContent.slice(0, splitIdx);
      lineSuffix = lineSuffix ?? lineContent.slice(splitIdx);
    }
  }

  if (
    typeof linePrefix === 'string' &&
    typeof lineSuffix === 'string' &&
    /^\s*$/.test(linePrefix) &&
    lineSuffix.trim().length > 0 &&
    inlineVisible !== true
  ) {
    return true;
  }

  return false;
}

interface MountedEditorRecord {
  readonly id: string;
  readonly editor: unknown;
  filePath: string;
  displayPath: string | null;
  languageId: string;
  lastAccessedAt: number;
  readonly actionDisposers: Map<string, () => void>;
}

let hostMonacoInstance: unknown = null;
let mountedEditorSeq = 0;
let inlineProviderSeq = 0;
const mountedEditors = new Map<string, MountedEditorRecord>();
let activeEditorId: string | null = null;
const activeEditorListeners = new Set<(editor: unknown) => void>();
const monacoProviderDisposers = new Map<string, () => void>();

function extractSnapshotFromRecord(
  record: MountedEditorRecord,
  isActive: boolean
): CodeEditorDocumentSnapshot {
  const editorLike = record.editor as {
    getValue?: () => string;
    getModel?: () => {
      getValue?: () => string;
      getLanguageId?: () => string;
      getVersionId?: () => number;
      uri?: { fsPath?: string; path?: string; toString?: () => string };
    } | null;
  } | null;

  const model =
    typeof editorLike?.getModel === 'function' ? editorLike.getModel() : null;
  const content =
    (typeof model?.getValue === 'function'
      ? model.getValue()
      : typeof editorLike?.getValue === 'function'
        ? editorLike.getValue()
        : '') ?? '';
  const detectedLang =
    (typeof model?.getLanguageId === 'function'
      ? model.getLanguageId()
      : null) ||
    record.languageId ||
    'plaintext';
  const detectedPath =
    record.filePath ||
    model?.uri?.fsPath ||
    model?.uri?.path ||
    model?.uri?.toString?.() ||
    'untitled';
  const versionId =
    typeof model?.getVersionId === 'function' ? model.getVersionId() : 1;

  return {
    filePath: detectedPath,
    displayPath: record.displayPath ?? detectedPath,
    languageId: detectedLang,
    content,
    versionId,
    isActive,
    lastAccessedAt: record.lastAccessedAt,
  };
}

function buildContextPayloadFromMonaco(
  model: unknown,
  position: unknown,
  completionContext: unknown,
  token: unknown
): InlineCompletionContextPayload {
  const modelLike = model as {
    getValue?: () => string;
    getOffsetAt?: (pos: CodeEditorPositionLike) => number;
    getLineContent?: (lineNumber: number) => string;
    getLanguageId?: () => string;
    uri?: { fsPath?: string; path?: string; toString?: () => string };
    filePath?: string;
    languageId?: string;
  } | null;

  const posLike = (position as Partial<CodeEditorPositionLike> | null) ?? {};
  const lineNumber = Math.max(1, Number(posLike.lineNumber ?? 1));
  const column = Math.max(1, Number(posLike.column ?? 1));

  const fullText =
    (typeof modelLike?.getValue === 'function' ? modelLike.getValue() : '') ??
    '';
  let prefix = '';
  let suffix = '';
  if (typeof modelLike?.getOffsetAt === 'function') {
    const offset = modelLike.getOffsetAt({ lineNumber, column });
    prefix = fullText.slice(0, offset);
    suffix = fullText.slice(offset);
  } else {
    const lines = fullText.split('\n');
    const beforeLines = lines.slice(0, Math.max(0, lineNumber - 1));
    const currentLine = lines[lineNumber - 1] ?? '';
    const afterLines = lines.slice(lineNumber);
    prefix = [
      ...beforeLines,
      currentLine.slice(0, Math.max(0, column - 1)),
    ].join('\n');
    suffix = [currentLine.slice(Math.max(0, column - 1)), ...afterLines].join(
      '\n'
    );
  }

  const linePrefix = prefix.split('\n').pop() ?? '';
  const lineSuffix = suffix.split('\n')[0] ?? '';

  const activeRecord = activeEditorId
    ? mountedEditors.get(activeEditorId)
    : undefined;
  const filePath =
    activeRecord?.filePath ||
    modelLike?.filePath ||
    modelLike?.uri?.fsPath ||
    modelLike?.uri?.path ||
    modelLike?.uri?.toString?.() ||
    'untitled';
  const languageId =
    (typeof modelLike?.getLanguageId === 'function'
      ? modelLike.getLanguageId()
      : null) ||
    modelLike?.languageId ||
    activeRecord?.languageId ||
    'typescript';

  const abortController = new AbortController();
  const tokenLike = token as {
    isCancellationRequested?: boolean;
    aborted?: boolean;
    onCancellationRequested?: (cb: () => void) => void;
    addEventListener?: (
      type: string,
      cb: () => void,
      opts?: { once?: boolean }
    ) => void;
  } | null;

  if (tokenLike?.isCancellationRequested || tokenLike?.aborted) {
    abortController.abort();
  } else if (typeof tokenLike?.onCancellationRequested === 'function') {
    tokenLike.onCancellationRequested(() => abortController.abort());
  } else if (typeof tokenLike?.addEventListener === 'function') {
    tokenLike.addEventListener('abort', () => abortController.abort(), {
      once: true,
    });
  }

  const ctxLike = completionContext as {
    triggerKind?: number | string;
    manual?: boolean;
  } | null;
  const isPendingManual = Date.now() < pendingManualInlineTriggerUntil;
  if (isPendingManual) {
    pendingManualInlineTriggerUntil = 0;
  }
  const manual =
    isPendingManual ||
    Boolean(ctxLike?.manual) ||
    ctxLike?.triggerKind === 1 ||
    ctxLike?.triggerKind === 'explicit';

  return {
    filePath,
    languageId,
    prefix,
    suffix,
    linePrefix,
    lineSuffix,
    position: { lineNumber, column },
    triggerKind: manual ? 'explicit' : 'automatic',
    manual,
    signal: abortController.signal,
    openDocuments: defaultCodeEditorProviderService.getOpenDocumentsSnapshot({
      excludeActive: true,
      maxDocuments: 5,
    }),
  };
}

let pendingManualInlineTriggerUntil = 0;

function attachInlineCompletionToMonaco(
  id: string,
  registration: InlineCompletionHandlerRegistration
): void {
  const existingDispose = monacoProviderDisposers.get(id);
  existingDispose?.();
  monacoProviderDisposers.delete(id);

  const monacoLike = hostMonacoInstance as {
    languages?: {
      registerInlineCompletionsProvider?: (
        selector: unknown,
        provider: {
          provideInlineCompletions: (
            model: unknown,
            position: unknown,
            context: unknown,
            token: unknown
          ) => Promise<{ items: InlineCompletionItemResult[] }>;
          freeInlineCompletions: (completions: unknown) => void;
          disposeInlineCompletions: (completions: unknown) => void;
        }
      ) => { dispose?: () => void } | (() => void);
    };
  } | null;

  const registerFn = monacoLike?.languages?.registerInlineCompletionsProvider;
  if (typeof registerFn !== 'function') {
    return;
  }

  const selector =
    !registration.languages || registration.languages === '*'
      ? '*'
      : registration.languages;

  const disposable = registerFn(selector, {
    async provideInlineCompletions(model, position, completionContext, token) {
      const payload = buildContextPayloadFromMonaco(
        model,
        position,
        completionContext,
        token
      );
      const result = await registration.provideInlineCompletions(payload, {
        model,
        position,
        completionContext,
        token,
      });
      if (!result) {
        return { items: [] };
      }
      const items = Array.isArray(result)
        ? result
        : Array.isArray(result.items)
          ? result.items
          : [];
      return { items };
    },
    freeInlineCompletions(completions) {
      registration.freeInlineCompletions?.(completions);
    },
    disposeInlineCompletions(completions) {
      registration.freeInlineCompletions?.(completions);
    },
  });

  const disposeMonaco = () => {
    if (typeof disposable === 'function') {
      disposable();
    } else if (disposable && typeof disposable.dispose === 'function') {
      disposable.dispose();
    }
  };
  monacoProviderDisposers.set(id, disposeMonaco);
}

function attachActionToEditorRecord(
  record: MountedEditorRecord,
  action: InlineEditActionRegistration
): void {
  const prevDispose = record.actionDisposers.get(action.id);
  prevDispose?.();
  record.actionDisposers.delete(action.id);

  const editorLike = record.editor as {
    addAction?: (descriptor: {
      id: string;
      label: string;
      keybindings?: number[];
      precondition?: string;
      contextMenuGroupId?: string;
      contextMenuOrder?: number;
      run: (ed: unknown, ...args: unknown[]) => void | Promise<void>;
    }) => { dispose?: () => void } | (() => void) | void;
  } | null;

  if (typeof editorLike?.addAction !== 'function') {
    return;
  }

  const disposable = editorLike.addAction({
    id: action.id,
    label: action.label,
    keybindings: action.keybindings ? [...action.keybindings] : undefined,
    precondition: action.precondition,
    contextMenuGroupId: action.contextMenuGroupId,
    contextMenuOrder: action.contextMenuOrder,
    run: (ed, ...args) => action.run(ed ?? record.editor, ...args),
  });

  record.actionDisposers.set(action.id, () => {
    if (typeof disposable === 'function') {
      disposable();
    } else if (disposable && typeof disposable.dispose === 'function') {
      disposable.dispose();
    }
  });
}

function notifyActiveEditorChanged(): void {
  const current = defaultCodeEditorProviderService.getActiveEditor();
  for (const listener of activeEditorListeners) {
    try {
      listener(current);
    } catch (err) {
      console.warn('[CodeEditorProviderService] Listener error:', err);
    }
  }
}

export const defaultCodeEditorProviderService: CodeEditorProviderService = {
  setMonacoInstance(monaco) {
    hostMonacoInstance = monaco;
    for (const id of runtimeInlineCompletionRegistry.getIds()) {
      const reg = runtimeInlineCompletionRegistry.get(id);
      if (reg) {
        attachInlineCompletionToMonaco(id, reg);
      }
    }
  },

  getMonacoInstance() {
    return hostMonacoInstance;
  },

  registerEditorInstance(editor, metadata) {
    mountedEditorSeq += 1;
    const id = `editor-${mountedEditorSeq}`;
    const record: MountedEditorRecord = {
      id,
      editor,
      filePath: metadata?.filePath || 'untitled',
      displayPath: metadata?.displayPath ?? metadata?.filePath ?? null,
      languageId: metadata?.languageId || 'plaintext',
      lastAccessedAt: Date.now(),
      actionDisposers: new Map(),
    };

    mountedEditors.set(id, record);
    activeEditorId = id;

    for (const action of runtimeInlineEditActionRegistry.getAll()) {
      attachActionToEditorRecord(record, action);
    }

    const editorLike = editor as {
      onDidFocusEditorText?: (cb: () => void) => { dispose?: () => void };
      onDidFocusEditorWidget?: (cb: () => void) => { dispose?: () => void };
    } | null;

    const focusDisposers: Array<() => void> = [];
    const handleFocus = () => {
      record.lastAccessedAt = Date.now();
      if (activeEditorId !== id) {
        activeEditorId = id;
        notifyActiveEditorChanged();
      }
    };

    if (typeof editorLike?.onDidFocusEditorText === 'function') {
      const sub = editorLike.onDidFocusEditorText(handleFocus);
      if (sub && typeof sub.dispose === 'function') {
        focusDisposers.push(() => sub.dispose?.());
      }
    }
    if (typeof editorLike?.onDidFocusEditorWidget === 'function') {
      const sub = editorLike.onDidFocusEditorWidget(handleFocus);
      if (sub && typeof sub.dispose === 'function') {
        focusDisposers.push(() => sub.dispose?.());
      }
    }

    notifyActiveEditorChanged();

    return toHybridDisposer(() => {
      for (const disposeFocus of focusDisposers) {
        disposeFocus();
      }
      for (const disposeAction of record.actionDisposers.values()) {
        disposeAction();
      }
      record.actionDisposers.clear();
      mountedEditors.delete(id);

      if (activeEditorId === id) {
        let nextActiveId: string | null = null;
        let latestAccess = -1;
        for (const [candidateId, candidate] of mountedEditors.entries()) {
          if (candidate.lastAccessedAt >= latestAccess) {
            latestAccess = candidate.lastAccessedAt;
            nextActiveId = candidateId;
          }
        }
        activeEditorId = nextActiveId;
        notifyActiveEditorChanged();
      }
    });
  },

  getActiveEditor() {
    if (!activeEditorId) return null;
    return mountedEditors.get(activeEditorId)?.editor ?? null;
  },

  getActiveDocument() {
    if (!activeEditorId) return null;
    const record = mountedEditors.get(activeEditorId);
    if (!record) return null;
    return extractSnapshotFromRecord(record, true);
  },

  getOpenDocumentsSnapshot(options) {
    const excludeActive = Boolean(options?.excludeActive);
    const maxDocuments = options?.maxDocuments ?? 10;
    const snapshots: CodeEditorDocumentSnapshot[] = [];

    for (const [id, record] of mountedEditors.entries()) {
      const isActive = id === activeEditorId;
      if (excludeActive && isActive) continue;
      snapshots.push(extractSnapshotFromRecord(record, isActive));
    }

    snapshots.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return b.lastAccessedAt - a.lastAccessedAt;
    });

    return snapshots.slice(0, Math.max(0, maxDocuments));
  },

  async getOpenDocuments(options) {
    return this.getOpenDocumentsSnapshot(options);
  },

  onDidChangeActiveEditor(listener) {
    activeEditorListeners.add(listener);
    return toHybridDisposer(() => {
      activeEditorListeners.delete(listener);
    });
  },

  onDidActiveEditorChange(listener) {
    return this.onDidChangeActiveEditor(listener);
  },

  registerInlineCompletionHandler(registration) {
    const id =
      registration.id ||
      `${registration.pluginId || 'plugin'}:inline-completion:${++inlineProviderSeq}`;
    const normalized: InlineCompletionHandlerRegistration = {
      ...registration,
      id,
    };
    const unregister = runtimeInlineCompletionRegistry.register(id, normalized);
    attachInlineCompletionToMonaco(id, normalized);

    return toHybridDisposer(() => {
      unregister();
      const disposeMonaco = monacoProviderDisposers.get(id);
      disposeMonaco?.();
      monacoProviderDisposers.delete(id);
    });
  },

  registerInlineCompletionProvider(selectorOrRegistration, provider) {
    if (
      selectorOrRegistration &&
      typeof selectorOrRegistration === 'object' &&
      !Array.isArray(selectorOrRegistration) &&
      'provideInlineCompletions' in selectorOrRegistration
    ) {
      return this.registerInlineCompletionHandler(selectorOrRegistration);
    }

    if (!provider || typeof provider.provideInlineCompletions !== 'function') {
      return toHybridDisposer(() => {});
    }

    const languages: readonly string[] | '*' =
      selectorOrRegistration === '*' || !selectorOrRegistration
        ? '*'
        : Array.isArray(selectorOrRegistration)
          ? selectorOrRegistration
          : [String(selectorOrRegistration)];

    const handlerId = `monaco-inline-provider-${++inlineProviderSeq}`;
    return this.registerInlineCompletionHandler({
      id: handlerId,
      languages,
      provideInlineCompletions: async (context, rawMonacoArgs) => {
        if (rawMonacoArgs) {
          const completionCtx =
            context.manual &&
            rawMonacoArgs.completionContext &&
            typeof rawMonacoArgs.completionContext === 'object'
              ? {
                  ...(rawMonacoArgs.completionContext as Record<
                    string,
                    unknown
                  >),
                  manual: true,
                }
              : rawMonacoArgs.completionContext;
          return provider.provideInlineCompletions(
            rawMonacoArgs.model,
            rawMonacoArgs.position,
            completionCtx,
            rawMonacoArgs.token
          );
        }
        return provider.provideInlineCompletions(
          context,
          context.position,
          {
            triggerKind: context.manual ? 1 : 0,
            manual: context.manual,
          },
          context.signal
        );
      },
      freeInlineCompletions: (completions) => {
        provider.freeInlineCompletions?.(completions);
        provider.disposeInlineCompletions?.(completions);
      },
    });
  },

  registerInlineCompletionsProvider(selectorOrRegistration, provider) {
    return this.registerInlineCompletionProvider(
      selectorOrRegistration,
      provider
    );
  },

  listInlineCompletionHandlers(languageId) {
    const all = runtimeInlineCompletionRegistry.getAll();
    if (!languageId) return all;
    return all.filter(
      (item) =>
        !item.languages ||
        item.languages === '*' ||
        item.languages.includes('*') ||
        item.languages.includes(languageId)
    );
  },

  registerInlineEditAction(action) {
    const unregister = runtimeInlineEditActionRegistry.register(
      action.id,
      action
    );
    for (const record of mountedEditors.values()) {
      attachActionToEditorRecord(record, action);
    }
    return toHybridDisposer(() => {
      unregister();
      for (const record of mountedEditors.values()) {
        const disposeAction = record.actionDisposers.get(action.id);
        disposeAction?.();
        record.actionDisposers.delete(action.id);
      }
    });
  },

  registerEditorAction(action) {
    return this.registerInlineEditAction(action);
  },

  listInlineEditActions() {
    return runtimeInlineEditActionRegistry.getAll();
  },

  async triggerInlineCompletion(editor) {
    const targetEditor = editor ?? this.getActiveEditor();
    const editorLike = targetEditor as {
      trigger?: (source: string, handlerId: string, payload?: unknown) => void;
    } | null;
    if (typeof editorLike?.trigger === 'function') {
      pendingManualInlineTriggerUntil = Date.now() + 1500;
      try {
        editorLike.trigger(
          'vibex.code-editor',
          'editor.action.inlineSuggest.hide',
          {}
        );
      } catch {
        // ignore
      }
      editorLike.trigger(
        'vibex.code-editor',
        'editor.action.inlineSuggest.trigger',
        {}
      );
    }
  },

  computeAdaptiveDebounceMs(prefix, manual) {
    return computeAdaptiveDebounceMs(prefix, manual);
  },

  applyWithUndoStopBarrier(editor, callback) {
    return applyWithUndoStopBarrier(editor, callback);
  },

  acceptInlineCompletion(editor, insertText, range) {
    return acceptInlineCompletionWithUndoBarrier(editor, insertText, range);
  },

  acceptNextCompletionWord(editor, remainingText, range) {
    const slice = extractNextWordSlice(remainingText);
    if (slice.acceptedText) {
      acceptInlineCompletionWithUndoBarrier(editor, slice.acceptedText, range);
    }
    return slice;
  },

  acceptNextCompletionLine(editor, remainingText, range) {
    const slice = extractNextLineSlice(remainingText);
    if (slice.acceptedText) {
      acceptInlineCompletionWithUndoBarrier(editor, slice.acceptedText, range);
    }
    return slice;
  },

  shouldYieldTabToNativeEditor(editor, context) {
    return shouldYieldTabToNativeEditor(editor, context);
  },
};

interface BuiltinHostProviderBinding {
  readonly serviceKey: string;
  readonly pluginId: string;
  readonly implementation: unknown;
}

const BUILTIN_HOST_PROVIDER_BINDINGS: readonly BuiltinHostProviderBinding[] = [
  {
    serviceKey: 'vibex.model-catalog',
    pluginId: 'vibex.core.llm-providers',
    implementation: defaultModelCatalogProviderService,
  },
  {
    serviceKey: 'provider.model.catalog',
    pluginId: 'vibex.core.llm-providers',
    implementation: defaultModelCatalogProviderService,
  },
  {
    serviceKey: 'vibex.provider.model-catalog',
    pluginId: 'vibex.core.llm-providers',
    implementation: defaultModelCatalogProviderService,
  },
  {
    serviceKey: 'vibex.usage',
    pluginId: 'vibex.core.credentials',
    implementation: defaultUsageProviderService,
  },
  {
    serviceKey: 'provider.usage',
    pluginId: 'vibex.core.credentials',
    implementation: defaultUsageProviderService,
  },
  {
    serviceKey: 'vibex.provider.usage',
    pluginId: 'vibex.core.credentials',
    implementation: defaultUsageProviderService,
  },
  {
    serviceKey: 'vibex.editor',
    pluginId: 'vibex.core.filesystem',
    implementation: defaultEditorOpenerProviderService,
  },
  {
    serviceKey: 'provider.editor.opener',
    pluginId: 'vibex.core.filesystem',
    implementation: defaultEditorOpenerProviderService,
  },
  {
    serviceKey: 'vibex.provider.editor-opener',
    pluginId: 'vibex.core.filesystem',
    implementation: defaultEditorOpenerProviderService,
  },
  {
    serviceKey: 'vibex.code-editor',
    pluginId: 'vibex.core.filesystem',
    implementation: defaultCodeEditorProviderService,
  },
  {
    serviceKey: 'provider.editor.monaco',
    pluginId: 'vibex.core.filesystem',
    implementation: defaultCodeEditorProviderService,
  },
  {
    serviceKey: 'vibex.provider.code-editor',
    pluginId: 'vibex.core.filesystem',
    implementation: defaultCodeEditorProviderService,
  },
];

let builtinsRegistered = false;
let disposeBuiltins: Array<() => void> = [];

export interface RegisterBuiltinHostProviderServicesOptions {
  readonly ctx?: VibeXPluginContext;
  readonly serviceKeys?: readonly string[];
  readonly pluginId?: string;
}

export function registerBuiltinHostProviderServices(
  options?: RegisterBuiltinHostProviderServicesOptions
): Disposer {
  builtinsRegistered = true;
  const allowedKeys = options?.serviceKeys
    ? new Set(options.serviceKeys)
    : null;
  const filterPluginId = options?.ctx?.pluginId ?? options?.pluginId;
  const targetBindings = allowedKeys
    ? BUILTIN_HOST_PROVIDER_BINDINGS.filter((b) =>
        allowedKeys.has(b.serviceKey)
      )
    : filterPluginId
      ? BUILTIN_HOST_PROVIDER_BINDINGS.filter(
          (b) => b.pluginId === filterPluginId
        )
      : BUILTIN_HOST_PROVIDER_BINDINGS;

  const disposers: Disposer[] = [];
  for (const binding of targetBindings) {
    if (options?.ctx) {
      disposers.push(
        options.ctx.services.provide(binding.serviceKey, binding.implementation)
      );
    } else if (!serviceContainer.has(binding.serviceKey)) {
      const dispose = serviceContainer.provide(
        binding.serviceKey,
        binding.implementation,
        binding.pluginId
      );
      disposers.push(dispose);
      disposeBuiltins.push(dispose);
    }
  }

  const cleanup: Disposer = () => {
    for (let i = disposers.length - 1; i >= 0; i -= 1) {
      disposers[i]?.();
    }
  };

  if (options?.ctx) {
    options.ctx.effect(() => cleanup);
  }

  return cleanup;
}

export function ensureHostProviderServicesRegistered(): Disposer {
  return registerBuiltinHostProviderServices();
}

export function resetHostProviderServicesForTest(): void {
  for (const dispose of disposeBuiltins) {
    dispose();
  }
  disposeBuiltins = [];
  builtinsRegistered = false;
  for (const id of runtimeModelCatalogRegistry.getIds()) {
    runtimeModelCatalogRegistry.unregister(id);
  }
  for (const id of runtimeUsageProberRegistry.getIds()) {
    runtimeUsageProberRegistry.unregister(id);
  }
  for (const id of runtimeEditorOpenerRegistry.getIds()) {
    runtimeEditorOpenerRegistry.unregister(id);
  }
  for (const id of runtimeInlineCompletionRegistry.getIds()) {
    runtimeInlineCompletionRegistry.unregister(id);
  }
  for (const id of runtimeInlineEditActionRegistry.getIds()) {
    runtimeInlineEditActionRegistry.unregister(id);
  }
  for (const disposeMonaco of monacoProviderDisposers.values()) {
    disposeMonaco();
  }
  monacoProviderDisposers.clear();
  for (const record of mountedEditors.values()) {
    for (const disposeAction of record.actionDisposers.values()) {
      disposeAction();
    }
    record.actionDisposers.clear();
  }
  mountedEditors.clear();
  activeEditorId = null;
  activeEditorListeners.clear();
  hostMonacoInstance = null;
  ensureHostProviderServicesRegistered();
}

export function getModelCatalogService(): ModelCatalogProviderService {
  if (!builtinsRegistered) {
    ensureHostProviderServicesRegistered();
  }
  return (
    serviceContainer.get<ModelCatalogProviderService>('vibex.model-catalog') ??
    serviceContainer.get<ModelCatalogProviderService>(
      'provider.model.catalog'
    ) ??
    serviceContainer.get<ModelCatalogProviderService>(
      'vibex.provider.model-catalog'
    ) ??
    defaultModelCatalogProviderService
  );
}

export function getUsageProviderService(): UsageProviderService {
  if (!builtinsRegistered) {
    ensureHostProviderServicesRegistered();
  }
  return (
    serviceContainer.get<UsageProviderService>('vibex.usage') ??
    serviceContainer.get<UsageProviderService>('provider.usage') ??
    serviceContainer.get<UsageProviderService>('vibex.provider.usage') ??
    defaultUsageProviderService
  );
}

export function getEditorOpenerService(): EditorOpenerProviderService {
  if (!builtinsRegistered) {
    ensureHostProviderServicesRegistered();
  }
  return (
    serviceContainer.get<EditorOpenerProviderService>('vibex.editor') ??
    serviceContainer.get<EditorOpenerProviderService>(
      'provider.editor.opener'
    ) ??
    serviceContainer.get<EditorOpenerProviderService>(
      'vibex.provider.editor-opener'
    ) ??
    defaultEditorOpenerProviderService
  );
}

export function getCodeEditorService(): CodeEditorProviderService {
  if (!builtinsRegistered) {
    ensureHostProviderServicesRegistered();
  }
  return (
    serviceContainer.get<CodeEditorProviderService>('vibex.code-editor') ??
    serviceContainer.get<CodeEditorProviderService>('provider.editor.monaco') ??
    serviceContainer.get<CodeEditorProviderService>(
      'vibex.provider.code-editor'
    ) ??
    defaultCodeEditorProviderService
  );
}
