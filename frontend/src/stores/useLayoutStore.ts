import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Orientation, SerializedDockview } from 'dockview-core';
import { GLOBAL_PROJECT_SCOPE } from '@/lib/projectScope';
import { DEFAULT_SESSION_PANEL_WIDTH } from '@/utils/dockviewStartupSizing';

/**
 * Panel IDs used to register and identify panels in the dockview layout.
 */
export const PANEL_IDS = {
  KANBAN: 'kanban',
  FILE_TREE: 'file-tree',
  PREVIEW: 'preview',
  DIFFS: 'diffs',
  TERMINAL: 'terminal',
  AI_CHAT: 'ai-chat',
  GIT: 'git',
  MERGE: 'merge',
  WELCOME: 'welcome',
  LOGS: 'logs',
  NOTES: 'notes',
  SESSION_DETAILS: 'session-details',
  PROCESSES: 'processes',
  SEARCH: 'search',
  SESSION_LIST: 'session-list',
  BOTS: 'bots',
  COLLABORATION_SPACE: 'collaboration-space',
  EXTERNAL_DIRECTORY: 'external-directory',
} as const;

export type PanelId = (typeof PANEL_IDS)[keyof typeof PANEL_IDS];

/**
 * Group IDs for organizing panels in the dockview layout.
 */
export const GROUP_IDS = {
  LEFT: 'group-left',
  BOTTOM: 'group-bottom',
  RIGHT: 'group-right',
} as const;

export type GroupId = (typeof GROUP_IDS)[keyof typeof GROUP_IDS];

export const EDITOR_GROUP_PREFIX = 'group-editor-';
export const MAX_EDITOR_GROUPS = 4;

const MAX_PERSISTED_PROJECT_LAYOUTS = 50;
const FALLBACK_GRID_WIDTH = 1280;
const FALLBACK_GRID_HEIGHT = 800;

export type WorkspaceTab = string;

interface LayoutState {
  /** Current project scope key */
  currentProjectKey: string;

  /** Cached layout state per project */
  projectLayouts: Record<string, LayoutSnapshot>;

  /** Serialized dockview layout for persistence */
  serializedLayout: SerializedDockview | null;

  /** Whether the file tree sidebar is visible */
  isFileTreeVisible: boolean;

  /** Width of the right (AI chat) panel in pixels */
  rightPanelWidth: number;

  /** Width of the session slot on the kanban page in pixels */
  kanbanSessionWidth: number;

  /** Whether the right (AI chat) panel is visible */
  isRightPanelVisible: boolean;

  /** Whether the workspace editor/terminal area is visible */
  isEditorAreaVisible: boolean;

  /** Whether the Kanban session list is visible */
  isKanbanListVisible: boolean;

  /** Whether the Kanban session monitor is visible */
  isKanbanMonitorVisible: boolean;

  /** Whether the Kanban session execution area is visible */
  isKanbanSessionVisible: boolean;

  /** Active tab: workspace or kanban */
  activeTab: WorkspaceTab;

  /** Actions */
  setCurrentProject: (projectKey: string) => void;
  setSerializedLayout: (layout: SerializedDockview | null) => void;
  toggleFileTree: () => void;
  setFileTreeVisible: (visible: boolean) => void;
  setRightPanelWidth: (width: number) => void;
  setKanbanSessionWidth: (width: number) => void;
  toggleRightPanel: () => void;
  setRightPanelVisible: (visible: boolean) => void;
  toggleEditorArea: () => void;
  setEditorAreaVisible: (visible: boolean) => void;
  toggleKanbanList: () => void;
  setKanbanListVisible: (visible: boolean) => void;
  toggleKanbanMonitor: () => void;
  setKanbanMonitorVisible: (visible: boolean) => void;
  toggleKanbanSession: () => void;
  setKanbanSessionVisible: (visible: boolean) => void;
  setActiveTab: (tab: WorkspaceTab) => void;
  setProjectActiveTab: (projectKey: string, tab: WorkspaceTab) => void;
  resetLayout: () => void;
  resetKanbanLayout: () => void;
}

// Previous default was 620px; 434px is exactly 30% smaller. This is only the
// seed for new/reset project snapshots and never overwrites a persisted drag.
const DEFAULT_RIGHT_PANEL_WIDTH = DEFAULT_SESSION_PANEL_WIDTH;
const DEFAULT_KANBAN_SESSION_WIDTH = 520;
/** Exported so the workspace dockview can self-heal a crushed session column. */
export const MIN_RIGHT_PANEL_WIDTH = 400;
const MAX_RIGHT_PANEL_WIDTH = 900;

export interface LayoutSnapshot {
  serializedLayout: SerializedDockview | null;
  isFileTreeVisible: boolean;
  rightPanelWidth: number;
  kanbanSessionWidth: number;
  isRightPanelVisible: boolean;
  isEditorAreaVisible: boolean;
  isKanbanListVisible: boolean;
  isKanbanMonitorVisible: boolean;
  isKanbanSessionVisible: boolean;
  activeTab: WorkspaceTab;
}

const DEFAULT_LAYOUT_SNAPSHOT: LayoutSnapshot = {
  serializedLayout: null,
  isFileTreeVisible: true,
  rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
  kanbanSessionWidth: DEFAULT_KANBAN_SESSION_WIDTH,
  isRightPanelVisible: false,
  isEditorAreaVisible: true,
  isKanbanListVisible: true,
  isKanbanMonitorVisible: true,
  isKanbanSessionVisible: true,
  activeTab: 'workspace',
};

const LEFT_DOCK_PANEL_IDS: ReadonlySet<string> = new Set([
  PANEL_IDS.SESSION_LIST,
  PANEL_IDS.BOTS,
  PANEL_IDS.FILE_TREE,
  PANEL_IDS.GIT,
  PANEL_IDS.SEARCH,
]);

type SanitizedZone = 'dock' | 'terminal' | 'session' | 'workspace';

interface SanitizedGroupData {
  id: string;
  views: string[];
  activeView?: string;
  [key: string]: unknown;
}

interface SanitizedLeafNode {
  type: 'leaf';
  data: SanitizedGroupData;
  size?: number;
  visible?: boolean;
}

interface SanitizedBranchNode {
  type: 'branch';
  data: SanitizedGridNode[];
  size?: number;
}

type SanitizedGridNode = SanitizedLeafNode | SanitizedBranchNode;

interface LeafAuditRecord {
  id: string;
  zone: SanitizedZone;
  newlyEmptied: boolean;
}

function clampSessionWidth(width: number): number {
  return Math.max(
    MIN_RIGHT_PANEL_WIDTH,
    Math.min(MAX_RIGHT_PANEL_WIDTH, width)
  );
}

/**
 * Sanitize a persisted session width. Values above the maximum are treated
 * as corrupted (an interim build briefly synced the flexible center-slot
 * remainder into this preference) and reset to the given default.
 */
function sanitizeSessionWidth(
  width: number | null | undefined,
  defaultWidth: number
): number {
  if (width == null || width === 420 || width === 500) {
    return defaultWidth;
  }
  if (width > MAX_RIGHT_PANEL_WIDTH) {
    return defaultWidth;
  }
  return clampSessionWidth(width);
}

function isRetiredWebPreviewId(value: string): boolean {
  return (
    value === 'web-preview' ||
    value === 'dev-preview' ||
    value.startsWith('web-preview:') ||
    value.startsWith('dev-preview:')
  );
}

function cloneJsonCompatible<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function classifySanitizedLeafZone(
  id: string,
  originalViews: readonly string[]
): SanitizedZone {
  if (id === GROUP_IDS.LEFT || id.startsWith(`${GROUP_IDS.LEFT}-`)) {
    return 'dock';
  }
  if (id === GROUP_IDS.BOTTOM) {
    return 'terminal';
  }
  if (id === GROUP_IDS.RIGHT || id.startsWith(`${GROUP_IDS.RIGHT}-`)) {
    return 'session';
  }
  if (id.startsWith(EDITOR_GROUP_PREFIX)) {
    return 'workspace';
  }
  if (originalViews.some((view) => LEFT_DOCK_PANEL_IDS.has(view))) {
    return 'dock';
  }
  if (originalViews.includes(PANEL_IDS.TERMINAL)) {
    return 'terminal';
  }
  if (
    originalViews.some(
      (view) =>
        view === PANEL_IDS.AI_CHAT || view.startsWith(`${PANEL_IDS.AI_CHAT}:`)
    )
  ) {
    return 'session';
  }
  return 'workspace';
}

function primaryAnchorGroupIdForZone(zone: SanitizedZone): string {
  switch (zone) {
    case 'dock':
      return GROUP_IDS.LEFT;
    case 'terminal':
      return GROUP_IDS.BOTTOM;
    case 'session':
      return GROUP_IDS.RIGHT;
    case 'workspace':
      return `${EDITOR_GROUP_PREFIX}1`;
  }
}

const VERTICAL_ORIENTATION = 'VERTICAL' as Orientation;
const HORIZONTAL_ORIENTATION = 'HORIZONTAL' as Orientation;

function orthogonalOrientation(orientation: Orientation): Orientation {
  return orientation === VERTICAL_ORIENTATION
    ? HORIZONTAL_ORIENTATION
    : VERTICAL_ORIENTATION;
}

/**
 * Collapse single-child non-root branches using Dockview Gridview's exact
 * orientation-parity invariants (`Gridview.removeView`):
 * - If a non-root branch drops to 1 leaf child, replace the branch with that
 *   leaf inheriting the branch's size along the parent split axis.
 * - If a non-root branch drops to 1 branch child, that grandchild already has
 *   the same orientation as the grandparent (`orthogonal(orthogonal(O)) === O`),
 *   so splice its children directly into the grandparent.
 */
function reduceSanitizedChildren(
  children: readonly SanitizedGridNode[],
  prunedLeafIds: ReadonlySet<string>
): SanitizedGridNode[] {
  const reduced: SanitizedGridNode[] = [];

  for (const child of children) {
    if (child.type === 'leaf') {
      if (!prunedLeafIds.has(child.data.id)) {
        reduced.push(child);
      }
      continue;
    }

    const nextGrandchildren = reduceSanitizedChildren(
      child.data,
      prunedLeafIds
    );
    if (nextGrandchildren.length === 0) {
      continue;
    }

    if (nextGrandchildren.length === 1) {
      const soleChild = nextGrandchildren[0];
      if (soleChild.type === 'leaf') {
        reduced.push({
          ...soleChild,
          ...(typeof child.size === 'number' ? { size: child.size } : {}),
        });
      } else {
        reduced.push(...soleChild.data);
      }
      continue;
    }

    reduced.push({
      ...child,
      data: nextGrandchildren,
    });
  }

  return reduced;
}

function collectGridLeaves(
  node: SanitizedGridNode,
  out: SanitizedLeafNode[]
): void {
  if (node.type === 'leaf') {
    out.push(node);
    return;
  }
  for (const child of node.data) {
    collectGridLeaves(child, out);
  }
}

function isValidMaximizedNodeLocation(
  root: SanitizedBranchNode,
  location: unknown
): boolean {
  if (
    !Array.isArray(location) ||
    location.length === 0 ||
    !location.every(
      (step): step is number =>
        typeof step === 'number' && Number.isInteger(step)
    )
  ) {
    return false;
  }

  let current: SanitizedGridNode = root;
  for (const index of location) {
    if (
      current.type !== 'branch' ||
      index < 0 ||
      index >= current.data.length
    ) {
      return false;
    }
    current = current.data[index];
  }

  return current.type === 'leaf' && current.data.views.length > 0;
}

/**
 * Reconcile a persisted `SerializedDockview` bidirectionally so
 * `DockviewApi.fromJSON()` cannot throw on retired panels, dangling leaf view
 * references, duplicate view IDs, malformed group metadata, or orphaned split
 * branches, while also pruning unreferenced panel blobs from `panels`.
 */
export function sanitizeSerializedDockview(
  layout: SerializedDockview | null
): SerializedDockview | null {
  if (!isPlainRecord(layout)) return null;

  const rawGrid = layout.grid;
  if (!isPlainRecord(rawGrid) || !isPlainRecord(rawGrid.root)) {
    return null;
  }

  const validPanels: Record<string, Record<string, unknown>> = {};
  if (isPlainRecord(layout.panels)) {
    for (const [panelId, rawPanel] of Object.entries(layout.panels)) {
      if (
        !panelId ||
        isRetiredWebPreviewId(panelId) ||
        !isPlainRecord(rawPanel)
      ) {
        continue;
      }
      const viewObj = isPlainRecord(rawPanel.view) ? rawPanel.view : undefined;
      const contentObj =
        viewObj && isPlainRecord(viewObj.content) ? viewObj.content : undefined;
      const componentId =
        typeof contentObj?.id === 'string'
          ? contentObj.id
          : typeof rawPanel.contentComponent === 'string'
            ? rawPanel.contentComponent
            : '';
      if (isRetiredWebPreviewId(componentId)) {
        continue;
      }

      const clonedPanel = cloneJsonCompatible(rawPanel);
      clonedPanel.id = panelId;
      validPanels[panelId] = clonedPanel;
    }
  }

  const rootRecord = rawGrid.root;
  const rootType = rootRecord.type;
  if (rootType !== 'branch' && rootType !== 'leaf') {
    // Preserve synthetic empty-root layout stubs while still stripping retired
    // panels; reject non-empty malformed roots that cannot be deserialized.
    if (Object.keys(rootRecord).length === 0) {
      const clonedStub = cloneJsonCompatible(layout) as unknown as Record<
        string,
        unknown
      >;
      clonedStub.panels = validPanels;
      return clonedStub as unknown as SerializedDockview;
    }
    return null;
  }

  const seenPanelIds = new Set<string>();
  const seenGroupIds = new Set<string>();
  let recoveredGroupCounter = 1;

  const allocateGroupId = (rawId: unknown): string => {
    if (
      typeof rawId === 'string' &&
      rawId.length > 0 &&
      !seenGroupIds.has(rawId)
    ) {
      seenGroupIds.add(rawId);
      return rawId;
    }
    while (seenGroupIds.has(`group-recovered-${recoveredGroupCounter}`)) {
      recoveredGroupCounter += 1;
    }
    const nextId = `group-recovered-${recoveredGroupCounter}`;
    recoveredGroupCounter += 1;
    seenGroupIds.add(nextId);
    return nextId;
  };

  const sanitizeGroupState = (
    rawData: unknown
  ): {
    data: SanitizedGroupData;
    hadViews: boolean;
    originalViews: string[];
  } => {
    const clonedData = isPlainRecord(rawData)
      ? cloneJsonCompatible(rawData)
      : {};
    const id = allocateGroupId(clonedData.id);
    const rawViews = Array.isArray(clonedData.views) ? clonedData.views : [];
    const originalViews = rawViews.filter(
      (view): view is string => typeof view === 'string'
    );
    const hadViews = rawViews.length > 0;

    const views: string[] = [];
    for (const viewId of originalViews) {
      if (
        !isRetiredWebPreviewId(viewId) &&
        Boolean(validPanels[viewId]) &&
        !seenPanelIds.has(viewId)
      ) {
        seenPanelIds.add(viewId);
        views.push(viewId);
      }
    }

    clonedData.id = id;
    clonedData.views = views;
    if (views.length === 0) {
      delete clonedData.activeView;
    } else if (
      typeof clonedData.activeView !== 'string' ||
      !views.includes(clonedData.activeView)
    ) {
      clonedData.activeView = views[0];
    }

    return {
      data: clonedData as SanitizedGroupData,
      hadViews,
      originalViews,
    };
  };

  const leafAudits: LeafAuditRecord[] = [];

  const sanitizeGridNode = (rawNode: unknown): SanitizedGridNode | null => {
    if (!isPlainRecord(rawNode)) return null;

    if (rawNode.type === 'leaf') {
      const { data, hadViews, originalViews } = sanitizeGroupState(
        rawNode.data
      );
      const zone = classifySanitizedLeafZone(data.id, originalViews);
      leafAudits.push({
        id: data.id,
        zone,
        newlyEmptied: hadViews && data.views.length === 0,
      });

      const leaf: SanitizedLeafNode = {
        type: 'leaf',
        data,
      };
      if (typeof rawNode.size === 'number' && Number.isFinite(rawNode.size)) {
        leaf.size = rawNode.size;
      }
      if (typeof rawNode.visible === 'boolean') {
        leaf.visible = rawNode.visible;
      }
      return leaf;
    }

    if (rawNode.type === 'branch') {
      if (!Array.isArray(rawNode.data)) return null;
      const children: SanitizedGridNode[] = [];
      for (const rawChild of rawNode.data) {
        const sanitizedChild = sanitizeGridNode(rawChild);
        if (sanitizedChild) {
          children.push(sanitizedChild);
        }
      }
      if (children.length === 0) return null;

      const branch: SanitizedBranchNode = {
        type: 'branch',
        data: children,
      };
      if (typeof rawNode.size === 'number' && Number.isFinite(rawNode.size)) {
        branch.size = rawNode.size;
      }
      return branch;
    }

    return null;
  };

  const pass1Root = sanitizeGridNode(rootRecord);
  if (!pass1Root) return null;

  const auditsByZone: Record<SanitizedZone, LeafAuditRecord[]> = {
    dock: [],
    terminal: [],
    session: [],
    workspace: [],
  };
  for (const audit of leafAudits) {
    auditsByZone[audit.zone].push(audit);
  }

  const prunedLeafIds = new Set<string>();
  for (const [zone, records] of Object.entries(auditsByZone) as Array<
    [SanitizedZone, LeafAuditRecord[]]
  >) {
    if (records.length <= 1) continue;
    const newlyEmptied = records.filter((record) => record.newlyEmptied);
    if (newlyEmptied.length === 0) continue;

    if (newlyEmptied.length < records.length) {
      for (const record of newlyEmptied) {
        prunedLeafIds.add(record.id);
      }
    } else {
      const preferredAnchorId = primaryAnchorGroupIdForZone(zone);
      const anchor =
        records.find((record) => record.id === preferredAnchorId) ?? records[0];
      for (const record of newlyEmptied) {
        if (record.id !== anchor.id) {
          prunedLeafIds.add(record.id);
        }
      }
    }
  }

  const gridWidth =
    typeof rawGrid.width === 'number' &&
    Number.isFinite(rawGrid.width) &&
    rawGrid.width > 0
      ? rawGrid.width
      : FALLBACK_GRID_WIDTH;
  const gridHeight =
    typeof rawGrid.height === 'number' &&
    Number.isFinite(rawGrid.height) &&
    rawGrid.height > 0
      ? rawGrid.height
      : FALLBACK_GRID_HEIGHT;
  let nextOrientation: Orientation =
    rawGrid.orientation === VERTICAL_ORIENTATION
      ? VERTICAL_ORIENTATION
      : HORIZONTAL_ORIENTATION;

  let nextRoot: SanitizedBranchNode;
  if (pass1Root.type === 'leaf') {
    if (prunedLeafIds.has(pass1Root.data.id)) return null;
    nextRoot = {
      type: 'branch',
      data: [pass1Root],
      size: nextOrientation === VERTICAL_ORIENTATION ? gridWidth : gridHeight,
    };
  } else {
    const reducedTop = reduceSanitizedChildren(pass1Root.data, prunedLeafIds);
    if (reducedTop.length === 0) return null;
    if (reducedTop.length === 1 && reducedTop[0].type === 'branch') {
      nextRoot = reducedTop[0];
      nextOrientation = orthogonalOrientation(nextOrientation);
    } else {
      nextRoot = {
        ...pass1Root,
        data: reducedTop,
      };
    }
  }

  const survivingFloatingGroups: Array<Record<string, unknown>> = [];
  if (Array.isArray(layout.floatingGroups)) {
    for (const rawFloating of layout.floatingGroups) {
      if (!isPlainRecord(rawFloating) || !isPlainRecord(rawFloating.position)) {
        continue;
      }
      const { data, hadViews } = sanitizeGroupState(rawFloating.data);
      if (hadViews && data.views.length === 0) {
        continue;
      }
      survivingFloatingGroups.push({
        ...cloneJsonCompatible(rawFloating),
        data,
      });
    }
  }

  const survivingPopoutGroups: Array<Record<string, unknown>> = [];
  if (Array.isArray(layout.popoutGroups)) {
    for (const rawPopout of layout.popoutGroups) {
      if (!isPlainRecord(rawPopout)) {
        continue;
      }
      const { data, hadViews } = sanitizeGroupState(rawPopout.data);
      if (hadViews && data.views.length === 0) {
        continue;
      }
      survivingPopoutGroups.push({
        ...cloneJsonCompatible(rawPopout),
        data,
      });
    }
  }

  const gridLeaves: SanitizedLeafNode[] = [];
  collectGridLeaves(nextRoot, gridLeaves);

  const survivingGroupIds = new Set<string>();
  const referencedPanelIds = new Set<string>();

  for (const leaf of gridLeaves) {
    survivingGroupIds.add(leaf.data.id);
    for (const viewId of leaf.data.views) {
      referencedPanelIds.add(viewId);
    }
  }
  for (const floating of survivingFloatingGroups) {
    const data = floating.data as SanitizedGroupData;
    survivingGroupIds.add(data.id);
    for (const viewId of data.views) {
      referencedPanelIds.add(viewId);
    }
  }
  for (const popout of survivingPopoutGroups) {
    const data = popout.data as SanitizedGroupData;
    survivingGroupIds.add(data.id);
    for (const viewId of data.views) {
      referencedPanelIds.add(viewId);
    }
  }

  const nextPanels: Record<string, unknown> = {};
  for (const panelId of referencedPanelIds) {
    if (validPanels[panelId]) {
      nextPanels[panelId] = validPanels[panelId];
    }
  }

  const nextGrid: Record<string, unknown> = {
    ...cloneJsonCompatible(rawGrid),
    root: nextRoot,
    width: gridWidth,
    height: gridHeight,
    orientation: nextOrientation,
  };
  if (
    'maximizedNode' in nextGrid &&
    !isValidMaximizedNodeLocation(
      nextRoot,
      isPlainRecord(nextGrid.maximizedNode)
        ? nextGrid.maximizedNode.location
        : undefined
    )
  ) {
    delete nextGrid.maximizedNode;
  }

  const nextActiveGroup =
    typeof layout.activeGroup === 'string' &&
    survivingGroupIds.has(layout.activeGroup)
      ? layout.activeGroup
      : (gridLeaves.find(
          (leaf) =>
            leaf.data.views.length > 0 &&
            leaf.visible !== false &&
            classifySanitizedLeafZone(leaf.data.id, leaf.data.views) ===
              'workspace'
        )?.data.id ??
        gridLeaves.find(
          (leaf) => leaf.data.views.length > 0 && leaf.visible !== false
        )?.data.id ??
        gridLeaves[0]?.data.id);

  const result: Record<string, unknown> = {
    grid: nextGrid,
    panels: nextPanels,
  };
  if (nextActiveGroup !== undefined) {
    result.activeGroup = nextActiveGroup;
  }
  if (survivingFloatingGroups.length > 0) {
    result.floatingGroups = survivingFloatingGroups;
  }
  if (survivingPopoutGroups.length > 0) {
    for (const popout of survivingPopoutGroups) {
      if (
        typeof popout.gridReferenceGroup === 'string' &&
        !survivingGroupIds.has(popout.gridReferenceGroup)
      ) {
        delete popout.gridReferenceGroup;
      }
    }
    result.popoutGroups = survivingPopoutGroups;
  }

  return result as unknown as SerializedDockview;
}

export function dropRetiredWebPreviewPanels(
  layout: SerializedDockview | null
): SerializedDockview | null {
  return sanitizeSerializedDockview(layout);
}

/**
 * Key-order-independent JSON structural equality that treats omitted keys and
 * `undefined`-valued keys identically, matching `JSON.stringify` persistence.
 */
function jsonValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== typeof b ||
    a === null ||
    b === null ||
    typeof a !== 'object'
  ) {
    return false;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let index = 0; index < a.length; index += 1) {
      if (!jsonValuesEqual(a[index], b[index])) {
        return false;
      }
    }
    return true;
  }

  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;

  let definedKeysB = 0;
  for (const key of Object.keys(recordB)) {
    if (recordB[key] !== undefined) {
      definedKeysB += 1;
    }
  }

  let definedKeysA = 0;
  for (const key of Object.keys(recordA)) {
    const valueA = recordA[key];
    if (valueA === undefined) continue;
    definedKeysA += 1;
    if (!(key in recordB)) return false;
    const valueB = recordB[key];
    if (valueB === undefined) return false;
    if (!jsonValuesEqual(valueA, valueB)) return false;
  }

  return definedKeysA === definedKeysB;
}

function serializedDockviewsEqual(
  a: SerializedDockview | null | undefined,
  b: SerializedDockview | null | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  if ((a.activeGroup ?? undefined) !== (b.activeGroup ?? undefined)) {
    return false;
  }
  if (
    a.grid?.width !== b.grid?.width ||
    a.grid?.height !== b.grid?.height ||
    a.grid?.orientation !== b.grid?.orientation
  ) {
    return false;
  }
  return jsonValuesEqual(a, b);
}

function buildProjectLayoutState(
  partial?: Partial<LayoutSnapshot> | null
): LayoutSnapshot {
  return {
    ...DEFAULT_LAYOUT_SNAPSHOT,
    ...partial,
    serializedLayout: sanitizeSerializedDockview(
      partial?.serializedLayout ?? null
    ),
    rightPanelWidth: sanitizeSessionWidth(
      partial?.rightPanelWidth,
      DEFAULT_RIGHT_PANEL_WIDTH
    ),
    kanbanSessionWidth: sanitizeSessionWidth(
      partial?.kanbanSessionWidth,
      DEFAULT_KANBAN_SESSION_WIDTH
    ),
  };
}

function pruneExcessProjectLayouts(
  projectLayouts: Record<string, LayoutSnapshot>,
  currentProjectKey: string
): Record<string, LayoutSnapshot> {
  const keys = Object.keys(projectLayouts);
  if (keys.length <= MAX_PERSISTED_PROJECT_LAYOUTS) {
    return projectLayouts;
  }

  const protectedKeys = new Set([GLOBAL_PROJECT_SCOPE, currentProjectKey]);
  const removableKeys = keys.filter((key) => !protectedKeys.has(key));
  const excessCount = keys.length - MAX_PERSISTED_PROJECT_LAYOUTS;
  const evictedKeys = new Set(removableKeys.slice(0, excessCount));

  const nextLayouts: Record<string, LayoutSnapshot> = {};
  for (const key of keys) {
    if (!evictedKeys.has(key)) {
      nextLayouts[key] = projectLayouts[key];
    }
  }
  return nextLayouts;
}

function getCurrentSnapshot(state: LayoutState): LayoutSnapshot {
  return {
    serializedLayout: state.serializedLayout,
    isFileTreeVisible: state.isFileTreeVisible,
    rightPanelWidth: state.rightPanelWidth,
    kanbanSessionWidth: state.kanbanSessionWidth,
    isRightPanelVisible: state.isRightPanelVisible,
    isEditorAreaVisible: state.isEditorAreaVisible,
    isKanbanListVisible: state.isKanbanListVisible,
    isKanbanMonitorVisible: state.isKanbanMonitorVisible,
    isKanbanSessionVisible: state.isKanbanSessionVisible,
    activeTab: state.activeTab,
  };
}

function applySnapshot(nextSnapshot: LayoutSnapshot): Partial<LayoutState> {
  return {
    serializedLayout: nextSnapshot.serializedLayout,
    isFileTreeVisible: nextSnapshot.isFileTreeVisible,
    rightPanelWidth: nextSnapshot.rightPanelWidth,
    kanbanSessionWidth: nextSnapshot.kanbanSessionWidth,
    isRightPanelVisible: nextSnapshot.isRightPanelVisible,
    isEditorAreaVisible: nextSnapshot.isEditorAreaVisible,
    isKanbanListVisible: nextSnapshot.isKanbanListVisible,
    isKanbanMonitorVisible: nextSnapshot.isKanbanMonitorVisible,
    isKanbanSessionVisible: nextSnapshot.isKanbanSessionVisible,
    activeTab: nextSnapshot.activeTab,
  };
}

function applyCurrentProjectPatch(
  state: LayoutState,
  patch: Partial<LayoutSnapshot>
): Partial<LayoutState> {
  return {
    ...patch,
    projectLayouts: {
      ...state.projectLayouts,
      [state.currentProjectKey]: {
        ...getCurrentSnapshot(state),
        ...patch,
      },
    },
  };
}

export interface MigratedLayoutState extends LayoutSnapshot {
  currentProjectKey: string;
  projectLayouts: Record<string, LayoutSnapshot>;
}

const DEFAULT_STARTUP_PANEL_IDS: ReadonlySet<string> = new Set([
  PANEL_IDS.AI_CHAT,
  PANEL_IDS.WELCOME,
  PANEL_IDS.FILE_TREE,
  PANEL_IDS.GIT,
  PANEL_IDS.SEARCH,
  PANEL_IDS.SESSION_LIST,
  PANEL_IDS.BOTS,
]);

/**
 * Upgrade persisted per-project layout snapshots.
 *
 * Persisted widths always represent user choices. Default-width changes apply
 * only when a project has no snapshot yet; migrations must not infer intent
 * from a pixel value that a user may also have selected by dragging.
 */
export function migratePersistedLayoutState(
  persistedState: unknown,
  version: number
): MigratedLayoutState {
  const state = (persistedState ?? {}) as Partial<LayoutState>;
  const legacySnapshot = buildProjectLayoutState({
    serializedLayout: null,
    isFileTreeVisible: state.isFileTreeVisible,
    rightPanelWidth: state.rightPanelWidth,
    isRightPanelVisible: version < 29 ? false : state.isRightPanelVisible,
    isEditorAreaVisible: state.isEditorAreaVisible,
    activeTab: state.activeTab,
  });
  const currentProjectKey = state.currentProjectKey ?? GLOBAL_PROJECT_SCOPE;
  const rawProjectLayouts = Object.entries(state.projectLayouts ?? {}).reduce<
    Record<string, LayoutSnapshot>
  >((accumulator, [projectKey, projectState]) => {
    accumulator[projectKey] = buildProjectLayoutState(projectState);

    // v<21 corrupted zone sizes; v23 percentage-based defaults; v24 Dockview
    // A/C zone minimum-width constraints — rebuild older grids with defaults.
    if (version < 24) {
      accumulator[projectKey].serializedLayout = null;
    }

    // v29: Unified A/B Zone shell no longer auto-spawns a legacy right AI Chat
    // column on startup. Heal untouched startup snapshots that only hold the
    // unbound default AI_CHAT panel without bound session tabs.
    if (version < 29) {
      const layout = accumulator[projectKey].serializedLayout as
        | (SerializedDockview & { panels?: Record<string, unknown> })
        | null;
      const panelIds = layout?.panels ? Object.keys(layout.panels) : [];
      const hasBoundSessionTabs = panelIds.some((id) =>
        id.startsWith(`${PANEL_IDS.AI_CHAT}:`)
      );
      if (!hasBoundSessionTabs) {
        if (!layout || panelIds.includes(PANEL_IDS.AI_CHAT)) {
          accumulator[projectKey].isRightPanelVisible = false;
        }
        if (
          panelIds.includes(PANEL_IDS.AI_CHAT) &&
          panelIds.every((id) => DEFAULT_STARTUP_PANEL_IDS.has(id))
        ) {
          accumulator[projectKey].serializedLayout = null;
        }
      }
    }
    return accumulator;
  }, {});

  if (!rawProjectLayouts[currentProjectKey]) {
    rawProjectLayouts[currentProjectKey] = legacySnapshot;
  }

  const projectLayouts = pruneExcessProjectLayouts(
    rawProjectLayouts,
    currentProjectKey
  );
  const activeSnapshot = buildProjectLayoutState(
    projectLayouts[currentProjectKey]
  );

  return {
    currentProjectKey,
    projectLayouts,
    ...activeSnapshot,
  };
}

/**
 * Hydrate and sanitize persisted state even when `version` matches and
 * `migrate` does not run. Because `partialize` stores only `currentProjectKey`
 * and `projectLayouts`, top-level snapshot fields must be projected from
 * `projectLayouts[currentProjectKey]` on every rehydration.
 */
function mergePersistedLayoutState(
  persistedState: unknown,
  currentState: LayoutState
): LayoutState {
  if (!isPlainRecord(persistedState)) {
    return currentState;
  }

  const persisted = persistedState as Partial<LayoutState>;
  const currentProjectKey =
    typeof persisted.currentProjectKey === 'string' &&
    persisted.currentProjectKey.length > 0
      ? persisted.currentProjectKey
      : currentState.currentProjectKey;

  const rawProjectLayouts: Record<string, LayoutSnapshot> = {};
  if (isPlainRecord(persisted.projectLayouts)) {
    for (const [projectKey, snapshot] of Object.entries(
      persisted.projectLayouts
    )) {
      rawProjectLayouts[projectKey] = buildProjectLayoutState(snapshot);
    }
  }

  if (!rawProjectLayouts[currentProjectKey]) {
    rawProjectLayouts[currentProjectKey] = buildProjectLayoutState(persisted);
  }

  const projectLayouts = pruneExcessProjectLayouts(
    rawProjectLayouts,
    currentProjectKey
  );
  const activeSnapshot = projectLayouts[currentProjectKey];

  return {
    ...currentState,
    currentProjectKey,
    projectLayouts,
    ...applySnapshot(activeSnapshot),
  };
}

export const useLayoutStore = create<LayoutState>()(
  persist(
    (set, get) => ({
      currentProjectKey: GLOBAL_PROJECT_SCOPE,
      projectLayouts: {
        [GLOBAL_PROJECT_SCOPE]: DEFAULT_LAYOUT_SNAPSHOT,
      },
      ...DEFAULT_LAYOUT_SNAPSHOT,

      // Short-circuit before invoking `set(...)` whenever the effective value
      // is unchanged: Zustand's `persist` wrapper calls `storage.setItem`
      // (`JSON.stringify` + `localStorage.setItem`) after every `set(...)`
      // invocation even when the state updater returns `state` unchanged.
      setCurrentProject: (projectKey) => {
        if (get().currentProjectKey === projectKey) {
          return;
        }
        set((state) => {
          if (state.currentProjectKey === projectKey) {
            return state;
          }

          const currentSnapshot = getCurrentSnapshot(state);
          const nextSnapshot = buildProjectLayoutState(
            state.projectLayouts[projectKey]
          );
          const reorderedLayouts = { ...state.projectLayouts };
          delete reorderedLayouts[state.currentProjectKey];
          reorderedLayouts[state.currentProjectKey] = currentSnapshot;
          delete reorderedLayouts[projectKey];
          reorderedLayouts[projectKey] = nextSnapshot;

          const projectLayouts = pruneExcessProjectLayouts(
            reorderedLayouts,
            projectKey
          );

          return {
            currentProjectKey: projectKey,
            projectLayouts,
            ...applySnapshot(nextSnapshot),
          };
        });
      },

      setSerializedLayout: (layout) => {
        const state = get();
        const currentProjectLayout =
          state.projectLayouts[state.currentProjectKey]?.serializedLayout ??
          null;
        if (
          serializedDockviewsEqual(state.serializedLayout, layout) &&
          serializedDockviewsEqual(currentProjectLayout, state.serializedLayout)
        ) {
          return;
        }

        const nextLayout = sanitizeSerializedDockview(layout);
        if (
          serializedDockviewsEqual(state.serializedLayout, nextLayout) &&
          serializedDockviewsEqual(currentProjectLayout, nextLayout)
        ) {
          return;
        }

        set((current) =>
          applyCurrentProjectPatch(current, { serializedLayout: nextLayout })
        );
      },

      toggleFileTree: () =>
        set((state) =>
          applyCurrentProjectPatch(state, {
            isFileTreeVisible: !state.isFileTreeVisible,
          })
        ),

      setFileTreeVisible: (visible) => {
        const state = get();
        if (
          state.isFileTreeVisible === visible &&
          state.projectLayouts[state.currentProjectKey]?.isFileTreeVisible ===
            visible
        ) {
          return;
        }
        set((current) =>
          applyCurrentProjectPatch(current, { isFileTreeVisible: visible })
        );
      },

      setRightPanelWidth: (width) => {
        const nextWidth = clampSessionWidth(width);
        const state = get();
        if (
          state.rightPanelWidth === nextWidth &&
          state.projectLayouts[state.currentProjectKey]?.rightPanelWidth ===
            nextWidth
        ) {
          return;
        }
        set((current) =>
          applyCurrentProjectPatch(current, { rightPanelWidth: nextWidth })
        );
      },

      setKanbanSessionWidth: (width) => {
        const nextWidth = clampSessionWidth(width);
        const state = get();
        if (
          state.kanbanSessionWidth === nextWidth &&
          state.projectLayouts[state.currentProjectKey]?.kanbanSessionWidth ===
            nextWidth
        ) {
          return;
        }
        set((current) =>
          applyCurrentProjectPatch(current, { kanbanSessionWidth: nextWidth })
        );
      },

      toggleRightPanel: () =>
        set((state) =>
          applyCurrentProjectPatch(state, {
            isRightPanelVisible: !state.isRightPanelVisible,
          })
        ),

      setRightPanelVisible: (visible) => {
        const state = get();
        if (
          state.isRightPanelVisible === visible &&
          state.projectLayouts[state.currentProjectKey]?.isRightPanelVisible ===
            visible
        ) {
          return;
        }
        set((current) =>
          applyCurrentProjectPatch(current, { isRightPanelVisible: visible })
        );
      },

      toggleEditorArea: () =>
        set((state) =>
          applyCurrentProjectPatch(state, {
            isEditorAreaVisible: !state.isEditorAreaVisible,
          })
        ),

      setEditorAreaVisible: (visible) => {
        const state = get();
        if (
          state.isEditorAreaVisible === visible &&
          state.projectLayouts[state.currentProjectKey]?.isEditorAreaVisible ===
            visible
        ) {
          return;
        }
        set((current) =>
          applyCurrentProjectPatch(current, { isEditorAreaVisible: visible })
        );
      },

      toggleKanbanList: () =>
        set((state) =>
          applyCurrentProjectPatch(state, {
            isKanbanListVisible: !state.isKanbanListVisible,
          })
        ),

      setKanbanListVisible: (visible) => {
        const state = get();
        if (
          state.isKanbanListVisible === visible &&
          state.projectLayouts[state.currentProjectKey]?.isKanbanListVisible ===
            visible
        ) {
          return;
        }
        set((current) =>
          applyCurrentProjectPatch(current, { isKanbanListVisible: visible })
        );
      },

      toggleKanbanMonitor: () =>
        set((state) =>
          applyCurrentProjectPatch(state, {
            isKanbanMonitorVisible: !state.isKanbanMonitorVisible,
          })
        ),

      setKanbanMonitorVisible: (visible) => {
        const state = get();
        if (
          state.isKanbanMonitorVisible === visible &&
          state.projectLayouts[state.currentProjectKey]
            ?.isKanbanMonitorVisible === visible
        ) {
          return;
        }
        set((current) =>
          applyCurrentProjectPatch(current, {
            isKanbanMonitorVisible: visible,
          })
        );
      },

      toggleKanbanSession: () =>
        set((state) =>
          applyCurrentProjectPatch(state, {
            isKanbanSessionVisible: !state.isKanbanSessionVisible,
          })
        ),

      setKanbanSessionVisible: (visible) => {
        const state = get();
        if (
          state.isKanbanSessionVisible === visible &&
          state.projectLayouts[state.currentProjectKey]
            ?.isKanbanSessionVisible === visible
        ) {
          return;
        }
        set((current) =>
          applyCurrentProjectPatch(current, {
            isKanbanSessionVisible: visible,
          })
        );
      },

      setActiveTab: (tab) => {
        const state = get();
        if (
          state.activeTab === tab &&
          state.projectLayouts[state.currentProjectKey]?.activeTab === tab
        ) {
          return;
        }
        set((current) => applyCurrentProjectPatch(current, { activeTab: tab }));
      },

      setProjectActiveTab: (projectKey, tab) => {
        const state = get();
        const existing = state.projectLayouts[projectKey];
        if (
          projectKey === state.currentProjectKey
            ? state.activeTab === tab && existing?.activeTab === tab
            : Boolean(existing && existing.activeTab === tab)
        ) {
          return;
        }

        set((current) => {
          const nextProjectSnapshot = buildProjectLayoutState(
            current.projectLayouts[projectKey]
          );
          const projectLayouts = pruneExcessProjectLayouts(
            {
              ...current.projectLayouts,
              [projectKey]: {
                ...nextProjectSnapshot,
                activeTab: tab,
              },
            },
            current.currentProjectKey
          );

          if (projectKey !== current.currentProjectKey) {
            return { projectLayouts };
          }

          return {
            activeTab: tab,
            projectLayouts: {
              ...projectLayouts,
              [current.currentProjectKey]: {
                ...getCurrentSnapshot(current),
                activeTab: tab,
              },
            },
          };
        });
      },

      resetLayout: () =>
        set((state) => {
          const nextSnapshot = {
            ...DEFAULT_LAYOUT_SNAPSHOT,
            activeTab: state.activeTab,
          };

          return {
            ...applySnapshot(nextSnapshot),
            projectLayouts: {
              ...state.projectLayouts,
              [state.currentProjectKey]: nextSnapshot,
            },
          };
        }),

      resetKanbanLayout: () => {
        const state = get();
        const currentSnapshot = state.projectLayouts[state.currentProjectKey];
        if (
          state.isKanbanListVisible &&
          state.isKanbanMonitorVisible &&
          state.isKanbanSessionVisible &&
          currentSnapshot?.isKanbanListVisible &&
          currentSnapshot?.isKanbanMonitorVisible &&
          currentSnapshot?.isKanbanSessionVisible
        ) {
          return;
        }

        set((current) =>
          applyCurrentProjectPatch(current, {
            isKanbanListVisible: true,
            isKanbanMonitorVisible: true,
            isKanbanSessionVisible: true,
          })
        );
      },
    }),
    {
      name: 'vibex-ide-layout',
      version: 30,
      migrate: migratePersistedLayoutState,
      merge: mergePersistedLayoutState,
      partialize: (state) => ({
        currentProjectKey: state.currentProjectKey,
        projectLayouts: {
          ...state.projectLayouts,
          [state.currentProjectKey]: getCurrentSnapshot(state),
        },
      }),
    }
  )
);
