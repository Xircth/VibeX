import { serviceContainer } from './services.js';

export type Disposer = () => void;

export type UIContributionSlot =
  | 'rail.section'
  | 'panel.left'
  | 'panel.right'
  | 'panel.bottom'
  | 'tab.main'
  | 'toolbar.left'
  | 'toolbar.right'
  | 'status.left'
  | 'status.main'
  | 'status.after-mcp'
  | 'status.right'
  | 'composer.toolbar'
  | 'composer.slash'
  | 'composer.overlay'
  | 'timeline.card'
  | 'message.footer'
  | 'kanban.view'
  | 'settings.section'
  | 'settings.page'
  | 'artifact.editor'
  | 'artifact.preview'
  | 'empty-state'
  | 'floating'
  | 'toolbar.actions'
  | 'statusbar.items'
  | 'rail.sections'
  | 'composer.actions'
  | 'composer.mode'
  | 'markdown.codeblock'
  | 'global.overlay'
  | 'message.context-menu'
  | 'file-tree.context-menu';

export type SlotName = UIContributionSlot | (string & {});

export interface RegistryEntry {
  readonly id: string;
  readonly pluginId?: string;
  readonly order?: number;
}

const SLOT_ALIAS_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['status.bar', 'statusbar.items', 'status.main'],
  ['toolbar.actions', 'toolbar.right', 'toolbar'],
  ['rail.sections', 'rail.section'],
  ['composer.actions', 'composer.toolbar'],
  ['global.overlay', 'floating'],
];

function matchingSlotAliases(slot: string): ReadonlySet<string> {
  for (const group of SLOT_ALIAS_GROUPS) {
    if (group.includes(slot)) {
      return new Set(group);
    }
  }
  return new Set([slot]);
}

/**
 * Reactive, snapshot-cached contribution registry compatible with React's
 * `useSyncExternalStore`. Mutations produce a new frozen array reference;
 * reads between mutations return the exact same array reference.
 */
export class Registry<T extends RegistryEntry> {
  private readonly items = new Map<string, T>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly T[] = Object.freeze([]);
  private readonly slotSnapshots = new Map<string, readonly T[]>();

  readonly subscribe = (listener: () => void): Disposer => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getAll = (): readonly T[] => {
    return this.snapshot;
  };

  readonly getSnapshot = (): readonly T[] => {
    return this.snapshot;
  };

  getIds(): readonly string[] {
    return this.snapshot.map((item) => item.id);
  }

  get(id: string): T | undefined {
    const direct = this.items.get(id);
    if (direct) return direct;
    for (const item of this.items.values()) {
      if (item.pluginId && `${item.pluginId}:${item.id}` === id) {
        return item;
      }
    }
    return undefined;
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  get size(): number {
    return this.items.size;
  }

  getBySlot(slot: string): readonly T[] {
    const cached = this.slotSnapshots.get(slot);
    if (cached) {
      return cached;
    }
    const aliases = matchingSlotAliases(slot);
    const filtered = Object.freeze(
      this.snapshot.filter((item) => {
        const candidate = (item as unknown as { slot?: string }).slot;
        return typeof candidate === 'string' && aliases.has(candidate);
      })
    );
    this.slotSnapshots.set(slot, filtered);
    return filtered;
  }

  register(item: T, pluginId?: string): Disposer;
  register(id: string, item: T, pluginId?: string): Disposer;
  register(
    idOrItem: string | T,
    itemOrPluginId?: T | string,
    maybePluginId?: string
  ): Disposer {
    const item: T =
      typeof idOrItem === 'string'
        ? { ...(itemOrPluginId as T), id: idOrItem }
        : idOrItem;
    const pluginId =
      typeof idOrItem === 'string'
        ? maybePluginId
        : (itemOrPluginId as string | undefined);
    const normalized: T =
      pluginId && !item.pluginId ? { ...item, pluginId } : item;
    this.items.set(normalized.id, normalized);
    this.rebuildSnapshot();
    this.emit();
    return () => {
      if (this.items.get(normalized.id) === normalized) {
        this.items.delete(normalized.id);
        this.rebuildSnapshot();
        this.emit();
      }
    };
  }

  unregister(id: string): boolean {
    const deleted = this.items.delete(id);
    if (deleted) {
      this.rebuildSnapshot();
      this.emit();
    }
    return deleted;
  }

  unregisterByPlugin(pluginId: string): number {
    let removed = 0;
    for (const [id, item] of this.items.entries()) {
      if (item.pluginId === pluginId) {
        this.items.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.rebuildSnapshot();
      this.emit();
    }
    return removed;
  }

  readonly clearByPlugin = (pluginId: string): number => {
    return this.unregisterByPlugin(pluginId);
  };

  clear(): void {
    if (this.items.size === 0) {
      return;
    }
    this.items.clear();
    this.rebuildSnapshot();
    this.emit();
  }

  private rebuildSnapshot(): void {
    const next = Array.from(this.items.values()).sort((a, b) => {
      const orderDiff = (a.order ?? 0) - (b.order ?? 0);
      if (orderDiff !== 0) {
        return orderDiff;
      }
      return a.id.localeCompare(b.id);
    });
    this.snapshot = Object.freeze(next);
    this.slotSnapshots.clear();
  }

  private emit(): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch {
        // Isolate subscriber errors so one broken listener cannot stall others.
      }
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginComponent<P = any> = (props: P) => any;

export interface SlotContribution extends RegistryEntry {
  readonly slot: UIContributionSlot | (string & {});
  readonly label?: string;
  readonly tooltip?: string;
  readonly icon?: string;
  readonly component?: PluginComponent;
  readonly render?: (props: Record<string, unknown>) => unknown;
  readonly onActivate?: (context?: Record<string, unknown>) => void | Promise<void>;
  readonly when?: (context: Record<string, unknown>) => boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface CommandContribution extends RegistryEntry {
  readonly title: string;
  readonly category?: string;
  readonly icon?: string;
  readonly shortcut?: string;
  readonly handler: (args?: unknown) => void | Promise<void>;
}

export interface ViewContribution extends RegistryEntry {
  readonly title: string;
  readonly icon?: string;
  readonly kind?: 'panel' | 'tab' | 'kanban' | 'settings' | (string & {});
  readonly slot?:
    | 'tab.main'
    | 'panel.left'
    | 'panel.right'
    | 'panel.bottom'
    | 'floating'
    | (string & {});
  readonly component?: PluginComponent;
  readonly render?: (props: Record<string, unknown>) => unknown;
}

export interface SettingSectionContribution extends RegistryEntry {
  readonly title: string;
  readonly description?: string;
  readonly icon?: string;
  readonly category?: string;
  readonly component?: PluginComponent;
}

export interface SlashCommandContribution extends RegistryEntry {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly prompt?: string;
  readonly argumentHint?: string;
  readonly execute?: (
    args: string
  ) => void | string | Promise<void | string>;
}

export interface PromptTurnContextInput {
  readonly conversationId: string;
  readonly workspaceId?: string | null;
  readonly projectId?: string | null;
  readonly agentId?: string | null;
  readonly text: string;
}

export interface InternalPromptContributionBlock {
  readonly pluginId: string;
  readonly label?: string | null;
  readonly content: string;
  readonly priority?: number | null;
}

export const MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES = 16 * 1024;

export interface PromptTurnContributionResult {
  readonly text?: string;
  readonly prependSystemPrompt?: string;
  readonly appendPrompt?: string;
  readonly hiddenContext?: string;
  readonly content?: string;
  readonly label?: string;
  readonly priority?: number;
  readonly blocks?: ReadonlyArray<{
    readonly label?: string | null;
    readonly content: string;
    readonly priority?: number;
  }>;
}

export interface PromptContextContribution extends RegistryEntry {
  readonly beforeTurn: (
    turn: PromptTurnContextInput
  ) =>
    | Promise<PromptTurnContributionResult | null | void>
    | PromptTurnContributionResult
    | null
    | void;
}

export interface ProviderContribution extends RegistryEntry {
  readonly label: string;
  readonly category?: string;
  readonly baseUrl?: string;
  readonly models?: readonly string[];
  readonly listTemplates?: (
    agentId: string
  ) => Promise<readonly unknown[]> | readonly unknown[];
  readonly metadata?: Record<string, unknown>;
}

export interface ThemeContribution extends RegistryEntry {
  readonly label: string;
  readonly scheme: 'light' | 'dark';
  readonly cssVariables: Readonly<Record<string, string>>;
}

export interface CapturedInternalMessage {
  readonly pluginId?: string;
  readonly channel: string;
  readonly nonce: string;
  readonly rawPayload: string;
  readonly parsedPayload: unknown;
  readonly conversationId?: string | null;
  readonly turnId?: string | null;
}

export interface InternalMessageCaptureContribution extends RegistryEntry {
  readonly channel: string;
  readonly nonce?: string;
  readonly validate?: (payload: unknown) => boolean;
  readonly onCapture: (
    message: CapturedInternalMessage
  ) => void | Promise<void>;
}

export interface ConversationModeContribution extends RegistryEntry {
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  readonly takeover?: boolean;
  readonly component?: PluginComponent;
  readonly render?: (props: Record<string, unknown>) => unknown;
  readonly onActivate?: (
    context?: Record<string, unknown>
  ) => void | Promise<void>;
}

export interface MarkdownRendererProps {
  readonly code: string;
  readonly language?: string;
  readonly isStreaming?: boolean;
  readonly workspacePath?: string | null;
  readonly taskAttemptId?: string;
  readonly taskId?: string;
}

export interface MarkdownRendererContribution extends RegistryEntry {
  readonly language: string | readonly string[];
  readonly match?: (code: string, language?: string) => boolean;
  readonly component?: PluginComponent<MarkdownRendererProps>;
  readonly render?: (props: MarkdownRendererProps) => unknown;
}

export interface OverlayContribution extends RegistryEntry {
  readonly title?: string;
  readonly zIndex?: number;
  readonly component?: PluginComponent;
  readonly render?: (props: Record<string, unknown>) => unknown;
  readonly when?: (context: Record<string, unknown>) => boolean;
}

export interface PanelContribution extends RegistryEntry {
  readonly title: string;
  readonly icon?: string;
  readonly zone?: 'left' | 'editor' | 'bottom' | 'session';
  readonly builtin?: boolean;
  readonly multiInstance?: boolean;
  readonly component?: PluginComponent;
  readonly render?: (props: Record<string, unknown>) => unknown;
}

export interface KanbanViewContribution extends RegistryEntry {
  readonly title: string;
  readonly titleKey?: string;
  readonly icon?: string;
  readonly hidesBottomDock?: boolean;
  readonly builtin?: boolean;
  readonly component?: PluginComponent;
  readonly render?: (props: Record<string, unknown>) => unknown;
}

export interface SettingsPageContribution extends RegistryEntry {
  readonly title: string;
  readonly titleKey?: string;
  readonly description?: string;
  readonly descriptionKey?: string;
  readonly group?: string;
  readonly groupLabelKey?: string;
  readonly icon?: string;
  readonly path?: string;
  readonly builtin?: boolean;
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly component?: PluginComponent;
  readonly render?: (props: Record<string, unknown>) => unknown;
}

export const slotRegistry = new Registry<SlotContribution>();
export const commandRegistry = new Registry<CommandContribution>();
export const viewRegistry = new Registry<ViewContribution>();
export const settingRegistry = new Registry<SettingSectionContribution>();
export const slashCommandRegistry = new Registry<SlashCommandContribution>();
export const promptContextRegistry = new Registry<PromptContextContribution>();
export const providerRegistry = new Registry<ProviderContribution>();
export const themeRegistry = new Registry<ThemeContribution>();
export const internalMessageCaptureRegistry =
  new Registry<InternalMessageCaptureContribution>();
export const conversationModeRegistry =
  new Registry<ConversationModeContribution>();
export const markdownRegistry = new Registry<MarkdownRendererContribution>();
export const overlayRegistry = new Registry<OverlayContribution>();
export const panelRegistry = new Registry<PanelContribution>();
export const kanbanViewRegistry = new Registry<KanbanViewContribution>();
export const settingsPageRegistry = new Registry<SettingsPageContribution>();

/**
 * Resolves the first matching `MarkdownRendererContribution` for a code block.
 */
export function findMarkdownRenderer(
  code: string,
  language?: string
): MarkdownRendererContribution | undefined {
  const normalizedLang = (language ?? '').trim().toLowerCase();
  for (const renderer of markdownRegistry.getAll()) {
    const langs = Array.isArray(renderer.language)
      ? renderer.language
      : [renderer.language];
    const langMatch = langs.some((candidate) => {
      const norm = String(candidate).trim().toLowerCase();
      return norm === '*' || (normalizedLang.length > 0 && norm === normalizedLang);
    });
    if (!langMatch) continue;
    if (renderer.match) {
      try {
        if (!renderer.match(code, language)) continue;
      } catch {
        continue;
      }
    }
    return renderer;
  }
  return undefined;
}

/**
 * Removes every contribution registered by `pluginId` across all global registries.
 */
export function disposePluginRegistrations(pluginId: string): void {
  slotRegistry.unregisterByPlugin(pluginId);
  commandRegistry.unregisterByPlugin(pluginId);
  viewRegistry.unregisterByPlugin(pluginId);
  settingRegistry.unregisterByPlugin(pluginId);
  slashCommandRegistry.unregisterByPlugin(pluginId);
  promptContextRegistry.unregisterByPlugin(pluginId);
  providerRegistry.unregisterByPlugin(pluginId);
  themeRegistry.unregisterByPlugin(pluginId);
  internalMessageCaptureRegistry.unregisterByPlugin(pluginId);
  conversationModeRegistry.unregisterByPlugin(pluginId);
  markdownRegistry.unregisterByPlugin(pluginId);
  overlayRegistry.unregisterByPlugin(pluginId);
  panelRegistry.unregisterByPlugin(pluginId);
  kanbanViewRegistry.unregisterByPlugin(pluginId);
  settingsPageRegistry.unregisterByPlugin(pluginId);
}

/**
 * Runs all registered `beforeTurn` prompt contributors and `conversation.beforeTurn`
 * waterfall hooks in priority order, returning both legacy text sections and
 * structured `internalPromptContributions` (enforcing the 16 KiB cap).
 */
export async function resolveBeforeTurnPromptContributions(
  input: PromptTurnContextInput & {
    readonly internalPromptContributions?: readonly InternalPromptContributionBlock[];
  }
): Promise<{
  readonly visibleUserText: string;
  readonly agentPromptText: string;
  readonly internalPromptContributions: readonly InternalPromptContributionBlock[];
}> {
  const blocks: InternalPromptContributionBlock[] = [
    ...(input.internalPromptContributions ?? []),
  ];
  const encoder = new TextEncoder();
  let usedBytes = blocks.reduce(
    (sum, item) => sum + encoder.encode(item.content ?? '').byteLength,
    0
  );
  const prependSystemPrompts: string[] = [];
  const appendPrompts: string[] = [];
  let effectiveText = input.text;

  for (const contributor of promptContextRegistry.getAll()) {
    try {
      const result = await contributor.beforeTurn({
        ...input,
        text: effectiveText,
      });
      if (!result) continue;
      if (typeof result.text === 'string' && result.text.trim()) {
        effectiveText = result.text;
      }
      if (result.prependSystemPrompt?.trim()) {
        prependSystemPrompts.push(result.prependSystemPrompt.trim());
      }
      if (result.appendPrompt?.trim()) {
        appendPrompts.push(result.appendPrompt.trim());
      }
      const hidden = result.content?.trim() || result.hiddenContext?.trim();
      if (hidden) {
        const blockBytes = encoder.encode(hidden).byteLength;
        if (usedBytes + blockBytes <= MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES) {
          usedBytes += blockBytes;
          blocks.push({
            pluginId: contributor.pluginId ?? contributor.id,
            label: result.label ?? null,
            content: hidden,
            priority: result.priority ?? contributor.order ?? 0,
          });
        }
      }
      if (Array.isArray(result.blocks)) {
        for (const item of result.blocks) {
          const itemContent = item?.content?.trim();
          if (!itemContent) continue;
          const blockBytes = encoder.encode(itemContent).byteLength;
          if (
            usedBytes + blockBytes <=
            MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES
          ) {
            usedBytes += blockBytes;
            blocks.push({
              pluginId: contributor.pluginId ?? contributor.id,
              label: item.label ?? null,
              content: itemContent,
              priority:
                item.priority ?? result.priority ?? contributor.order ?? 100,
            });
          }
        }
      }
    } catch {
      // Fault isolation: one failing plugin contributor must not block the user's turn.
    }
  }

  const waterfallState = {
    ...input,
    text: effectiveText,
    internalPromptContributions: blocks,
  };
  try {
    const out = await serviceContainer.runWaterfall(
      'conversation.beforeTurn',
      waterfallState
    );
    if (out && typeof out === 'object') {
      if (
        typeof (out as { text?: unknown }).text === 'string' &&
        (out as { text: string }).text.trim()
      ) {
        effectiveText = (out as { text: string }).text;
      }
      if (
        Array.isArray(
          (out as { internalPromptContributions?: unknown })
            .internalPromptContributions
        )
      ) {
        blocks.splice(
          0,
          blocks.length,
          ...((
            out as {
              internalPromptContributions: InternalPromptContributionBlock[];
            }
          ).internalPromptContributions ?? [])
        );
      }
    }
  } catch {
    // Fault isolation for waterfall hooks.
  }

  const totalBytes = blocks.reduce(
    (sum, item) => sum + encoder.encode(item.content ?? '').byteLength,
    0
  );
  if (totalBytes > MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES) {
    throw new Error(
      `internalPromptContributions size (${totalBytes} bytes) exceeds maximum allowed ${MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES} bytes (16 KiB)`
    );
  }

  const sections: string[] = [];
  if (prependSystemPrompts.length > 0) {
    sections.push(prependSystemPrompts.join('\n\n'));
  }
  sections.push(effectiveText);
  if (appendPrompts.length > 0) {
    sections.push(appendPrompts.join('\n\n'));
  }

  return {
    visibleUserText: input.text,
    agentPromptText: sections.join('\n\n'),
    internalPromptContributions: blocks,
  };
}

/**
 * Runs all registered `beforeTurn` prompt contributors in priority order and merges
 * their prompt additions. Errors in individual plugins are caught and isolated.
 */
export async function collectBeforeTurnContributions(
  input: PromptTurnContextInput
): Promise<{
  readonly prependSystemPrompts: readonly string[];
  readonly appendPrompts: readonly string[];
  readonly hiddenContexts: readonly string[];
  readonly internalPromptContributions: readonly InternalPromptContributionBlock[];
}> {
  const encoder = new TextEncoder();
  let usedBytes = 0;
  const prependSystemPrompts: string[] = [];
  const appendPrompts: string[] = [];
  const hiddenContexts: string[] = [];
  const internalPromptContributions: InternalPromptContributionBlock[] = [];

  for (const contributor of promptContextRegistry.getAll()) {
    try {
      const result = await contributor.beforeTurn(input);
      if (!result) continue;
      if (result.prependSystemPrompt?.trim()) {
        prependSystemPrompts.push(result.prependSystemPrompt.trim());
      }
      if (result.appendPrompt?.trim()) {
        appendPrompts.push(result.appendPrompt.trim());
      }
      const hidden = result.content?.trim() || result.hiddenContext?.trim();
      if (hidden) {
        const blockBytes = encoder.encode(hidden).byteLength;
        if (usedBytes + blockBytes <= MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES) {
          usedBytes += blockBytes;
          hiddenContexts.push(hidden);
          internalPromptContributions.push({
            pluginId: contributor.pluginId ?? contributor.id,
            label: result.label ?? null,
            content: hidden,
            priority: result.priority ?? contributor.order ?? 0,
          });
        }
      }
    } catch {
      // Fault isolation: one failing plugin contributor must not block the user's turn.
    }
  }

  return {
    prependSystemPrompts,
    appendPrompts,
    hiddenContexts,
    internalPromptContributions,
  };
}

export async function applyBeforeTurnPromptContributions(
  draftText: string,
  input: Omit<PromptTurnContextInput, 'text'>
): Promise<{
  readonly visibleUserText: string;
  readonly agentPromptText: string;
  readonly contributions: {
    readonly prependSystemPrompts: readonly string[];
    readonly appendPrompts: readonly string[];
    readonly hiddenContexts: readonly string[];
    readonly internalPromptContributions: readonly InternalPromptContributionBlock[];
  };
}> {
  const contributions = await collectBeforeTurnContributions({
    ...input,
    text: draftText,
  });

  const sections: string[] = [];
  if (contributions.prependSystemPrompts.length > 0) {
    sections.push(contributions.prependSystemPrompts.join('\n\n'));
  }
  sections.push(draftText);
  if (contributions.appendPrompts.length > 0) {
    sections.push(contributions.appendPrompts.join('\n\n'));
  }
  if (contributions.hiddenContexts.length > 0) {
    sections.push(
      `<vibex-plugin-context>\n${contributions.hiddenContexts.join('\n\n')}\n</vibex-plugin-context>`
    );
  }

  return {
    visibleUserText: draftText,
    agentPromptText: sections.join('\n\n'),
    contributions,
  };
}

const INTERNAL_META_TAG_RE =
  /<vibex-internal-meta\s+channel="([^"]+)"(?:\s+nonce="([^"]*)")?\s*>([\s\S]*?)<\/vibex-internal-meta>/g;
const INTERNAL_COMMENT_RE =
  /<!--\s*vibex-internal:([a-zA-Z0-9_.:-]+)\s+([\s\S]*?)\s*-->/g;
const INTERNAL_FENCE_RE =
  /```vibex-internal:([a-zA-Z0-9_.:-]+)\r?\n([\s\S]*?)\r?\n```/g;

function tryParseJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function parseInternalHeader(header: string): {
  pluginId: string;
  channel: string;
  nonce: string;
} {
  const parts = header.trim().split(':');
  if (parts.length >= 3) {
    return {
      pluginId: parts[0] ?? '',
      channel: parts[1] ?? '',
      nonce: parts.slice(2).join(':'),
    };
  }
  if (parts.length === 2) {
    return {
      pluginId: parts[0] ?? '',
      channel: `${parts[0]}:${parts[1]}`,
      nonce: parts[1] ?? '',
    };
  }
  return {
    pluginId: header.trim(),
    channel: header.trim(),
    nonce: '',
  };
}

/**
 * Dispatches a captured internal message (from either the Rust projector event stream
 * or local extraction) to all matching `InternalMessageCaptureContribution` handlers.
 */
export function dispatchCapturedInternalMessage(
  msg: CapturedInternalMessage
): void {
  const handlers = internalMessageCaptureRegistry.getAll();
  for (const handler of handlers) {
    const channelMatch =
      handler.channel === '*' ||
      handler.channel === msg.channel ||
      (msg.pluginId
        ? handler.channel === `${msg.pluginId}:${msg.channel}` ||
          handler.channel === msg.pluginId ||
          (handler.pluginId === msg.pluginId && handler.channel === msg.nonce)
        : false);
    if (!channelMatch) continue;
    if (handler.nonce && handler.nonce !== msg.nonce) continue;
    try {
      if (handler.validate && !handler.validate(msg.parsedPayload)) {
        continue;
      }
      void handler.onCapture(msg);
    } catch {
      // Isolate plugin handler errors.
    }
  }
}

const INTERNAL_PARTIAL_PREFIXES = [
  '<vibex-internal-meta',
  '<!--vibex-internal:',
  '<!-- vibex-internal:',
  '```vibex-internal:',
] as const;

function findIncompleteInternalTail(text: string): number | null {
  const candidates: Array<{ open: string; close: string }> = [
    { open: '<vibex-internal-meta', close: '</vibex-internal-meta>' },
    { open: '<!--vibex-internal:', close: '-->' },
    { open: '<!-- vibex-internal:', close: '-->' },
    { open: '```vibex-internal:', close: '```' },
  ];
  for (const { open, close } of candidates) {
    const idx = text.lastIndexOf(open);
    if (idx !== -1) {
      const after = text.slice(idx + open.length);
      if (!after.includes(close)) {
        return idx;
      }
    }
  }
  const searchStart = Math.max(0, text.length - 32);
  for (let idx = searchStart; idx < text.length; idx++) {
    const tail = text.slice(idx);
    if (tail.startsWith('<') || tail.startsWith('`')) {
      if (
        INTERNAL_PARTIAL_PREFIXES.some(
          (prefix) => prefix.startsWith(tail) && tail.length < prefix.length
        )
      ) {
        return idx;
      }
    }
  }
  return null;
}

/**
 * Strips `<vibex-internal-meta>`, `<!--vibex-internal:channel:nonce ...-->`, and
 * fenced `vibex-internal:channel:nonce` blocks from assistant text so internal
 * plugin protocol payloads never leak into the user-visible chat timeline, while
 * dispatching matching payloads to registered `InternalMessageCaptureContribution`s.
 */
export function extractAndStripInternalMessages(
  text: string,
  options?: { conversationId?: string | null; turnId?: string | null; dispatch?: boolean }
): {
  readonly cleanedText: string;
  readonly captured: readonly CapturedInternalMessage[];
  readonly hasIncompleteTrailingTag: boolean;
} {
  const captured: CapturedInternalMessage[] = [];
  const shouldDispatch = options?.dispatch !== false;

  const handleMatch = (
    pluginId: string,
    channel: string,
    nonce: string | undefined,
    rawPayload: string
  ): string => {
    const normalizedNonce = nonce ?? '';
    const parsedPayload = tryParseJson(rawPayload);
    const msg: CapturedInternalMessage = {
      pluginId,
      channel,
      nonce: normalizedNonce,
      rawPayload: rawPayload.trim(),
      parsedPayload,
      conversationId: options?.conversationId ?? null,
      turnId: options?.turnId ?? null,
    };
    captured.push(msg);

    if (shouldDispatch) {
      dispatchCapturedInternalMessage(msg);
    }
    return '';
  };

  let workingText = text
    .replace(INTERNAL_META_TAG_RE, (_full, ch, nonce, payload) => {
      const parsed = parseInternalHeader(String(ch));
      return handleMatch(
        parsed.pluginId,
        String(ch),
        nonce ? String(nonce) : parsed.nonce,
        String(payload)
      );
    })
    .replace(INTERNAL_COMMENT_RE, (_full, header, payload) => {
      const parsed = parseInternalHeader(String(header));
      return handleMatch(
        parsed.pluginId,
        parsed.channel,
        parsed.nonce,
        String(payload)
      );
    })
    .replace(INTERNAL_FENCE_RE, (_full, header, payload) => {
      const parsed = parseInternalHeader(String(header));
      return handleMatch(
        parsed.pluginId,
        parsed.channel,
        parsed.nonce,
        String(payload)
      );
    });

  const incompleteIdx = findIncompleteInternalTail(workingText);
  let hasIncompleteTrailingTag = false;
  if (incompleteIdx !== null) {
    workingText = workingText.slice(0, incompleteIdx);
    hasIncompleteTrailingTag = true;
  }

  const cleanedText = workingText.replace(/\n{3,}/g, '\n\n').trim();

  return { cleanedText, captured, hasIncompleteTrailingTag };
}
