import { serviceContainer } from './services.js';
const SLOT_ALIAS_GROUPS = [
    ['status.bar', 'statusbar.items', 'status.main'],
    ['toolbar.actions', 'toolbar.right', 'toolbar'],
    ['rail.sections', 'rail.section'],
    ['composer.actions', 'composer.toolbar'],
    ['global.overlay', 'floating'],
];
function matchingSlotAliases(slot) {
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
export class Registry {
    items = new Map();
    listeners = new Set();
    snapshot = Object.freeze([]);
    slotSnapshots = new Map();
    subscribe = (listener) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    getAll = () => {
        return this.snapshot;
    };
    getSnapshot = () => {
        return this.snapshot;
    };
    getIds() {
        return this.snapshot.map((item) => item.id);
    }
    get(id) {
        const direct = this.items.get(id);
        if (direct)
            return direct;
        for (const item of this.items.values()) {
            if (item.id === id ||
                (item.pluginId &&
                    (`${item.pluginId}:${item.id}` === id ||
                        `plugin:${item.pluginId}/${item.id}` === id))) {
                return item;
            }
        }
        return undefined;
    }
    has(id) {
        return this.get(id) !== undefined;
    }
    get size() {
        return this.items.size;
    }
    getBySlot(slot) {
        const cached = this.slotSnapshots.get(slot);
        if (cached) {
            return cached;
        }
        const aliases = matchingSlotAliases(slot);
        const filtered = Object.freeze(this.snapshot.filter((item) => {
            const candidate = item.slot;
            return typeof candidate === 'string' && aliases.has(candidate);
        }));
        this.slotSnapshots.set(slot, filtered);
        return filtered;
    }
    storageKey(item) {
        if (item.pluginId &&
            !item.id.startsWith(`${item.pluginId}:`) &&
            !item.id.startsWith(`plugin:${item.pluginId}/`)) {
            return `${item.pluginId}:${item.id}`;
        }
        return item.id;
    }
    register(idOrItem, itemOrPluginId, maybePluginId) {
        const item = typeof idOrItem === 'string'
            ? { ...itemOrPluginId, id: idOrItem }
            : idOrItem;
        const pluginId = typeof idOrItem === 'string'
            ? maybePluginId
            : itemOrPluginId;
        const normalized = pluginId && !item.pluginId ? { ...item, pluginId } : item;
        const key = this.storageKey(normalized);
        this.items.set(key, normalized);
        this.rebuildSnapshot();
        this.emit();
        return () => {
            if (this.items.get(key) === normalized) {
                this.items.delete(key);
                this.rebuildSnapshot();
                this.emit();
            }
        };
    }
    unregister(id) {
        let deleted = this.items.delete(id);
        if (!deleted) {
            for (const [key, item] of this.items.entries()) {
                if (item.id === id ||
                    (item.pluginId &&
                        (`${item.pluginId}:${item.id}` === id ||
                            `plugin:${item.pluginId}/${item.id}` === id))) {
                    this.items.delete(key);
                    deleted = true;
                    break;
                }
            }
        }
        if (deleted) {
            this.rebuildSnapshot();
            this.emit();
        }
        return deleted;
    }
    unregisterByPlugin(pluginId) {
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
    clearByPlugin = (pluginId) => {
        return this.unregisterByPlugin(pluginId);
    };
    clear() {
        if (this.items.size === 0) {
            return;
        }
        this.items.clear();
        this.rebuildSnapshot();
        this.emit();
    }
    rebuildSnapshot() {
        const next = Array.from(this.items.values()).sort((a, b) => {
            const orderDiff = (a.order ?? 0) - (b.order ?? 0);
            if (orderDiff !== 0) {
                return orderDiff;
            }
            const idDiff = a.id.localeCompare(b.id);
            if (idDiff !== 0) {
                return idDiff;
            }
            return (a.pluginId ?? '').localeCompare(b.pluginId ?? '');
        });
        this.snapshot = Object.freeze(next);
        this.slotSnapshots.clear();
    }
    emit() {
        for (const listener of Array.from(this.listeners)) {
            try {
                listener();
            }
            catch {
                // Isolate subscriber errors so one broken listener cannot stall others.
            }
        }
    }
}
export const MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES = 16 * 1024;
export const slotRegistry = new Registry();
export const commandRegistry = new Registry();
export const viewRegistry = new Registry();
export const settingRegistry = new Registry();
export const slashCommandRegistry = new Registry();
export const promptContextRegistry = new Registry();
export const providerRegistry = new Registry();
export const themeRegistry = new Registry();
export const internalMessageCaptureRegistry = new Registry();
export const conversationModeRegistry = new Registry();
export const markdownRegistry = new Registry();
export const overlayRegistry = new Registry();
export const panelRegistry = new Registry();
export const kanbanViewRegistry = new Registry();
export const settingsPageRegistry = new Registry();
/**
 * Resolves the first matching `MarkdownRendererContribution` for a code block.
 */
export function findMarkdownRenderer(code, language) {
    const normalizedLang = (language ?? '').trim().toLowerCase();
    for (const renderer of markdownRegistry.getAll()) {
        const langs = Array.isArray(renderer.language)
            ? renderer.language
            : [renderer.language];
        const langMatch = langs.some((candidate) => {
            const norm = String(candidate).trim().toLowerCase();
            return norm === '*' || (normalizedLang.length > 0 && norm === normalizedLang);
        });
        if (!langMatch)
            continue;
        if (renderer.match) {
            try {
                if (!renderer.match(code, language))
                    continue;
            }
            catch {
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
export function disposePluginRegistrations(pluginId) {
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
export async function resolveBeforeTurnPromptContributions(input) {
    const blocks = [
        ...(input.internalPromptContributions ?? []),
    ];
    const encoder = new TextEncoder();
    let usedBytes = blocks.reduce((sum, item) => sum + encoder.encode(item.content ?? '').byteLength, 0);
    const prependSystemPrompts = [];
    const appendPrompts = [];
    let effectiveText = input.text;
    for (const contributor of promptContextRegistry.getAll()) {
        try {
            const result = await contributor.beforeTurn({
                ...input,
                text: effectiveText,
            });
            if (!result)
                continue;
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
                    if (!itemContent)
                        continue;
                    const blockBytes = encoder.encode(itemContent).byteLength;
                    if (usedBytes + blockBytes <=
                        MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES) {
                        usedBytes += blockBytes;
                        blocks.push({
                            pluginId: contributor.pluginId ?? contributor.id,
                            label: item.label ?? null,
                            content: itemContent,
                            priority: item.priority ?? result.priority ?? contributor.order ?? 100,
                        });
                    }
                }
            }
        }
        catch {
            // Fault isolation: one failing plugin contributor must not block the user's turn.
        }
    }
    const waterfallState = {
        ...input,
        text: effectiveText,
        internalPromptContributions: blocks,
    };
    try {
        const out = await serviceContainer.runWaterfall('conversation.beforeTurn', waterfallState);
        if (out && typeof out === 'object') {
            if (typeof out.text === 'string' &&
                out.text.trim()) {
                effectiveText = out.text;
            }
            if (Array.isArray(out
                .internalPromptContributions)) {
                blocks.splice(0, blocks.length, ...(out.internalPromptContributions ?? []));
            }
        }
    }
    catch {
        // Fault isolation for waterfall hooks.
    }
    const totalBytes = blocks.reduce((sum, item) => sum + encoder.encode(item.content ?? '').byteLength, 0);
    if (totalBytes > MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES) {
        throw new Error(`internalPromptContributions size (${totalBytes} bytes) exceeds maximum allowed ${MAX_INTERNAL_PROMPT_CONTRIBUTIONS_BYTES} bytes (16 KiB)`);
    }
    const sections = [];
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
export async function collectBeforeTurnContributions(input) {
    const encoder = new TextEncoder();
    let usedBytes = 0;
    const prependSystemPrompts = [];
    const appendPrompts = [];
    const hiddenContexts = [];
    const internalPromptContributions = [];
    for (const contributor of promptContextRegistry.getAll()) {
        try {
            const result = await contributor.beforeTurn(input);
            if (!result)
                continue;
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
        }
        catch {
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
export async function applyBeforeTurnPromptContributions(draftText, input) {
    const contributions = await collectBeforeTurnContributions({
        ...input,
        text: draftText,
    });
    const sections = [];
    if (contributions.prependSystemPrompts.length > 0) {
        sections.push(contributions.prependSystemPrompts.join('\n\n'));
    }
    sections.push(draftText);
    if (contributions.appendPrompts.length > 0) {
        sections.push(contributions.appendPrompts.join('\n\n'));
    }
    if (contributions.hiddenContexts.length > 0) {
        sections.push(`<vibex-plugin-context>\n${contributions.hiddenContexts.join('\n\n')}\n</vibex-plugin-context>`);
    }
    return {
        visibleUserText: draftText,
        agentPromptText: sections.join('\n\n'),
        contributions,
    };
}
const INTERNAL_META_TAG_RE = /<vibex-internal-meta\s+channel="([^"]+)"(?:\s+nonce="([^"]*)")?\s*>([\s\S]*?)<\/vibex-internal-meta>/g;
const INTERNAL_COMMENT_RE = /<!--\s*vibex-internal:([a-zA-Z0-9_.:-]+)\s+([\s\S]*?)\s*-->/g;
const INTERNAL_FENCE_RE = /```vibex-internal:([a-zA-Z0-9_.:-]+)\r?\n([\s\S]*?)\r?\n```/g;
function tryParseJson(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return '';
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return trimmed;
    }
}
function parseInternalHeader(header) {
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
export function dispatchCapturedInternalMessage(msg) {
    const handlers = internalMessageCaptureRegistry.getAll();
    for (const handler of handlers) {
        const channelMatch = handler.channel === '*' ||
            handler.channel === msg.channel ||
            (msg.pluginId
                ? handler.channel === `${msg.pluginId}:${msg.channel}` ||
                    handler.channel === msg.pluginId ||
                    (handler.pluginId === msg.pluginId && handler.channel === msg.nonce)
                : false);
        if (!channelMatch)
            continue;
        if (handler.nonce && handler.nonce !== msg.nonce)
            continue;
        try {
            if (handler.validate && !handler.validate(msg.parsedPayload)) {
                continue;
            }
            void handler.onCapture(msg);
        }
        catch {
            // Isolate plugin handler errors.
        }
    }
}
const INTERNAL_PARTIAL_PREFIXES = [
    '<vibex-internal-meta',
    '<!--vibex-internal:',
    '<!-- vibex-internal:',
    '```vibex-internal:',
];
function findIncompleteInternalTail(text) {
    const candidates = [
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
            if (INTERNAL_PARTIAL_PREFIXES.some((prefix) => prefix.startsWith(tail) && tail.length < prefix.length)) {
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
export function extractAndStripInternalMessages(text, options) {
    const captured = [];
    const shouldDispatch = options?.dispatch !== false;
    const handleMatch = (pluginId, channel, nonce, rawPayload) => {
        const normalizedNonce = nonce ?? '';
        const parsedPayload = tryParseJson(rawPayload);
        const msg = {
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
        return handleMatch(parsed.pluginId, String(ch), nonce ? String(nonce) : parsed.nonce, String(payload));
    })
        .replace(INTERNAL_COMMENT_RE, (_full, header, payload) => {
        const parsed = parseInternalHeader(String(header));
        return handleMatch(parsed.pluginId, parsed.channel, parsed.nonce, String(payload));
    })
        .replace(INTERNAL_FENCE_RE, (_full, header, payload) => {
        const parsed = parseInternalHeader(String(header));
        return handleMatch(parsed.pluginId, parsed.channel, parsed.nonce, String(payload));
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
