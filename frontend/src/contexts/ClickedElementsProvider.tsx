import {
  createContext,
  useContext,
  useState,
  useRef,
  ReactNode,
  useEffect,
  useCallback,
} from 'react';
import type {
  OpenInEditorPayload,
  ComponentInfo,
  SelectedComponent,
} from '@/utils/previewBridge';
import type { Workspace } from 'shared/types';
import { genId } from '@/utils/id';

export interface ClickedEntry {
  id: string;
  payload: OpenInEditorPayload;
  timestamp: number;
  dedupeKey: string;
  selectedDepth?: number; // 0 = innermost (selected), 1 = parent, etc.
}

interface ClickedElementsContextType {
  elements: ClickedEntry[];
  addElement: (payload: OpenInEditorPayload) => void;
  removeElement: (id: string) => void;
  clearElements: () => void;
  /** Sync attempt info so the provider can track workspace root and clear on attempt change */
  syncAttempt: (
    attemptId: string | undefined,
    containerRef: string | undefined
  ) => void;
  /** Register a callback that fires when a new element is added (returns unregister fn) */
  registerOnElementAdded: (
    callback: (entry: ClickedEntry) => void
  ) => () => void;
  /** Current workspace root for path relativization */
  workspaceRoot: string | undefined;
}

const ClickedElementsContext = createContext<ClickedElementsContextType | null>(
  null
);

export function useClickedElements() {
  const context = useContext(ClickedElementsContext);
  if (!context) {
    throw new Error(
      'useClickedElements must be used within a ClickedElementsProvider'
    );
  }
  return context;
}

interface ClickedElementsProviderProps {
  children: ReactNode;
  attempt?: Workspace | null;
}

const MAX_ELEMENTS = 20;

// Helpers

function stripPrefixes(p?: string): string {
  if (!p) return '';
  return p
    .replace(/^file:\/\//, '')
    .replace(/^webpack:\/\/\//, '')
    .replace(/^webpack:\/\//, '')
    .trim();
}

// macOS alias handling; no-ops on other OSes
function normalizeMacPrivateAliases(p: string): string {
  if (!p) return p;
  // Very light normalization mimicking path.rs logic
  if (p === '/private/var') return '/var';
  if (p.startsWith('/private/var/'))
    return '/var/' + p.slice('/private/var/'.length);
  if (p === '/private/tmp') return '/tmp';
  if (p.startsWith('/private/tmp/'))
    return '/tmp/' + p.slice('/private/tmp/'.length);
  return p;
}

// Return { path, line?, col? } where `path` has no trailing :line(:col).
// Works even when Windows drive letters contain a colon.
function parsePathWithLineCol(raw?: string): {
  path: string;
  line?: number;
  col?: number;
} {
  const s = stripPrefixes(raw);
  if (!s) return { path: '' };
  const normalized = normalizeMacPrivateAliases(s);

  // Try to split trailing :line(:col). Last and second-to-last tokens must be numbers.
  const parts = normalized.split(':');
  if (parts.length <= 2) return { path: normalized };

  const last = parts[parts.length - 1];
  const maybeCol = Number(last);
  if (!Number.isFinite(maybeCol)) return { path: normalized };

  const prev = parts[parts.length - 2];
  const maybeLine = Number(prev);
  if (!Number.isFinite(maybeLine)) return { path: normalized };

  // Windows drive (e.g., "C") is at index 0; this still works because we only strip the end
  const basePath = parts.slice(0, parts.length - 2).join(':');
  return { path: basePath, line: maybeLine, col: maybeCol };
}

function relativizePath(p: string, workspaceRoot?: string): string {
  if (!p) return '';
  const normalized = normalizeMacPrivateAliases(stripPrefixes(p));

  if (!workspaceRoot) return normalized;

  // Simple prefix strip; robust handling is on backend (path.rs).
  // This keeps the UI stable even when run inside macOS /private/var containers.
  const wr = normalizeMacPrivateAliases(workspaceRoot.replace(/\/+$/, ''));
  if (
    normalized.startsWith(wr.endsWith('/') ? wr : wr + '/') ||
    normalized === wr
  ) {
    const rel = normalized.slice(wr.length);
    return rel.startsWith('/') ? rel.slice(1) : rel || '.';
  }
  return normalized;
}

function formatLoc(path: string, line?: number, col?: number) {
  if (!path) return '';
  if (line == null) return path;
  return `${path}:${line}${col != null ? `:${col}` : ''}`;
}

function formatDomBits(ce?: OpenInEditorPayload['clickedElement']) {
  const bits: string[] = [];
  if (ce?.tag) bits.push(ce.tag.toLowerCase());
  if (ce?.id) bits.push(`#${ce.id}`);
  const classes = normalizeClassName(ce?.className);
  if (classes) bits.push(`.${classes}`);
  if (ce?.role) bits.push(`@${ce.role}`);
  return bits.join('') || '(unknown)';
}

function normalizeClassName(className?: string): string {
  if (!className) return '';
  return className.split(/\s+/).filter(Boolean).sort().join('.');
}

function makeDedupeKey(
  payload: OpenInEditorPayload,
  workspaceRoot?: string
): string {
  const s = payload.selected;
  const ce = payload.clickedElement;

  const { path } = parsePathWithLineCol(s.pathToSource);
  const rel = relativizePath(path, workspaceRoot);

  const domBits: string[] = [];
  if (ce?.tag) domBits.push(ce.tag.toLowerCase());
  if (ce?.id) domBits.push(`#${ce.id}`);
  const normalizedClasses = normalizeClassName(ce?.className);
  if (normalizedClasses) domBits.push(`.${normalizedClasses}`);
  if (ce?.role) domBits.push(`@${ce.role}`);

  const locKey = [
    rel,
    s.source?.lineNumber ?? '',
    s.source?.columnNumber ?? '',
  ].join(':');
  return `${s.name}|${locKey}|${domBits.join('')}`;
}

// Remove heavy or unsafe props while retaining debuggability
function pruneValue(
  value: unknown,
  depth: number,
  maxString = 200,
  maxArray = 20
): unknown {
  if (depth <= 0) return '[MaxDepth]';

  if (value == null) return value;
  const t = typeof value;
  if (t === 'string')
    return (value as string).length > maxString
      ? (value as string).slice(0, maxString) + '…'
      : value;
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'function') return '[Function]';
  if (t === 'bigint') return value.toString() + 'n';
  if (t === 'symbol') return value.toString();

  if (Array.isArray(value)) {
    const lim = (value as unknown[])
      .slice(0, maxArray)
      .map((v) => pruneValue(v, depth - 1, maxString, maxArray));
    if ((value as unknown[]).length > maxArray)
      lim.push(`[+${(value as unknown[]).length - maxArray} more]`);
    return lim;
  }

  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const k of Object.keys(obj)) {
      // Cap keys to keep small
      if (count++ > 50) {
        out['[TruncatedKeys]'] = true;
        break;
      }
      out[k] = pruneValue(obj[k], depth - 1, maxString, maxArray);
    }
    return out;
  }

  return '[Unknown]';
}

function stripHeavyProps(payload: OpenInEditorPayload): OpenInEditorPayload {
  // Avoid mutating caller objects
  const shallowSelected = {
    ...payload.selected,
    props: pruneValue(payload.selected.props, 2) as Record<string, unknown>,
  };

  const shallowComponents = payload.components.map((c) => ({
    ...c,
    props: pruneValue(c.props, 2) as Record<string, unknown>,
  }));

  // dataset and coords are typically small; keep as-is.
  return {
    ...payload,
    selected: shallowSelected,
    components: shallowComponents,
  };
}

// Build component chain from inner-most to outer-most
function buildChainInnerToOuter(
  payload: OpenInEditorPayload,
  workspaceRoot?: string
) {
  const comps = payload.components ?? [];
  const s = payload.selected;

  // Start with the selected component as innermost
  const innerToOuter: (ComponentInfo | SelectedComponent)[] = [s];

  // Add components that aren't duplicates of selected
  const selectedKey = `${s.name}|${s.pathToSource}|${s.source?.lineNumber}|${s.source?.columnNumber}`;
  comps.forEach((c) => {
    const compKey = `${c.name}|${c.pathToSource}|${c.source?.lineNumber}|${c.source?.columnNumber}`;
    if (compKey !== selectedKey) {
      innerToOuter.push(c);
    }
  });

  // Remove duplicates by creating unique keys
  const seen = new Set<string>();
  return innerToOuter.filter((c) => {
    const parsed = parsePathWithLineCol(c.pathToSource);
    const rel = relativizePath(parsed.path, workspaceRoot);
    const loc = formatLoc(
      rel,
      c.source?.lineNumber ?? parsed.line,
      c.source?.columnNumber ?? parsed.col
    );
    const key = `${c.name}|${loc}`;

    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatClickedMarkdown(
  entry: ClickedEntry,
  workspaceRoot?: string
): string {
  const { payload, selectedDepth = 0 } = entry;
  const chain = buildChainInnerToOuter(payload, workspaceRoot);
  const effectiveChain = chain.slice(selectedDepth); // Start from selected anchor outward

  // DOM
  const dom = formatDomBits(payload.clickedElement);

  // HTML preview (source code of the clicked element)
  const htmlPreview = payload.clickedElement?.dataset?.['preview'];

  // Use first component in effective chain as the "selected start"
  const first = effectiveChain[0];
  const parsed = parsePathWithLineCol(first.pathToSource);
  const rel = relativizePath(parsed.path, workspaceRoot);
  const loc = formatLoc(
    rel,
    first.source?.lineNumber ?? parsed.line,
    first.source?.columnNumber ?? parsed.col
  );

  // Build hierarchy from effective chain
  const items = effectiveChain.map((c, i) => {
    const p = parsePathWithLineCol(c.pathToSource);
    const r = relativizePath(p.path, workspaceRoot);
    const l = formatLoc(
      r,
      c.source?.lineNumber ?? p.line,
      c.source?.columnNumber ?? p.col
    );
    const indent = '  '.repeat(i);
    const arrow = i > 0 ? '└─ ' : '';
    const tag = i === 0 ? ' ← start' : '';
    return `${indent}${arrow}${c.name} (\`${l || 'no source'}\`)${tag}`;
  });

  return [
    `From preview click:`,
    `- DOM: ${dom}`,
    `- Selected start: ${first.name} (${loc ? `\`${loc}\`` : 'no source'})`,
    htmlPreview ? `- Element source:\n\`\`\`html\n${htmlPreview}\n\`\`\`` : '',
    effectiveChain.length > 1
      ? ['- Component hierarchy:', ...items].join('\n')
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ====== Public utility: convert ClickedEntry to chip node data ======

export interface ClickedElementChipData {
  entryId: string;
  componentName: string;
  filePath: string;
  htmlPreview?: string;
  componentChain: string[];
  fullMarkdown: string;
}

export function buildClickedElementData(
  entry: ClickedEntry,
  workspaceRoot?: string
): ClickedElementChipData {
  const { payload } = entry;
  const chain = buildChainInnerToOuter(payload, workspaceRoot);

  // Component name: innermost component
  const componentName = chain[0]?.name ?? payload.selected?.name ?? 'Unknown';

  // File path: first component with a path
  const first = chain[0];
  const parsed = first
    ? parsePathWithLineCol(first.pathToSource)
    : { path: '' };
  const rel = relativizePath(parsed.path, workspaceRoot);
  const filePath = formatLoc(
    rel,
    first?.source?.lineNumber ?? parsed.line,
    first?.source?.columnNumber ?? parsed.col
  );

  // HTML preview
  const htmlPreview = payload.clickedElement?.dataset?.['preview'] ?? '';

  // Component chain names from inner to outer
  const componentChain = chain.map((c) => c.name);

  // Full markdown for export
  const fullMarkdown = formatClickedMarkdown(entry, workspaceRoot);

  return {
    entryId: entry.id,
    componentName,
    filePath,
    htmlPreview: htmlPreview || undefined,
    componentChain,
    fullMarkdown,
  };
}

export function ClickedElementsProvider({
  children,
  attempt,
}: ClickedElementsProviderProps) {
  const [elements, setElements] = useState<ClickedEntry[]>([]);

  // Track attempt info from either prop or syncAttempt calls
  const [syncedAttemptId, setSyncedAttemptId] = useState<string | undefined>();
  const [syncedContainerRef, setSyncedContainerRef] = useState<
    string | undefined
  >();
  const prevAttemptIdRef = useRef<string | undefined>();

  // Effective values: prop takes precedence over synced state
  const effectiveAttemptId = attempt?.id ?? syncedAttemptId;
  const workspaceRoot = attempt?.container_ref ?? syncedContainerRef;

  // Clear elements when attempt changes
  useEffect(() => {
    if (effectiveAttemptId === prevAttemptIdRef.current) return;
    prevAttemptIdRef.current = effectiveAttemptId;
    setElements([]);
  }, [effectiveAttemptId]);

  // Callback registry for element-added notifications
  const onElementAddedCallbacksRef = useRef<Set<(entry: ClickedEntry) => void>>(
    new Set()
  );

  const addElement = useCallback(
    (payload: OpenInEditorPayload) => {
      const sanitized = stripHeavyProps(payload);
      const dedupeKey = makeDedupeKey(sanitized, workspaceRoot || undefined);

      let newEntry: ClickedEntry | null = null;

      setElements((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.dedupeKey === dedupeKey) {
          return prev; // Skip consecutive duplicate
        }
        newEntry = {
          id: genId(),
          payload: sanitized,
          timestamp: Date.now(),
          dedupeKey,
        };
        const updated = [...prev, newEntry];
        return updated.length > MAX_ELEMENTS
          ? updated.slice(-MAX_ELEMENTS)
          : updated;
      });

      // Notify registered callbacks after state update
      // Use queueMicrotask to ensure state is committed first
      if (newEntry) {
        const entry = newEntry;
        queueMicrotask(() => {
          onElementAddedCallbacksRef.current.forEach((cb) => cb(entry));
        });
      }
    },
    [workspaceRoot]
  );

  const removeElement = useCallback((id: string) => {
    setElements((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const clearElements = useCallback(() => {
    setElements([]);
  }, []);

  const syncAttempt = useCallback(
    (attemptId: string | undefined, containerRef: string | undefined) => {
      setSyncedAttemptId(attemptId);
      setSyncedContainerRef(containerRef);
    },
    []
  );

  const registerOnElementAdded = useCallback(
    (callback: (entry: ClickedEntry) => void) => {
      onElementAddedCallbacksRef.current.add(callback);
      return () => {
        onElementAddedCallbacksRef.current.delete(callback);
      };
    },
    []
  );

  return (
    <ClickedElementsContext.Provider
      value={{
        elements,
        addElement,
        removeElement,
        clearElements,
        syncAttempt,
        registerOnElementAdded,
        workspaceRoot,
      }}
    >
      {children}
    </ClickedElementsContext.Provider>
  );
}
