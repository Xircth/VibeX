export const BUILTIN_KANBAN_VIEW_IDS = [
  'builtin:columns',
  'builtin:sessions',
  'builtin:canvas',
  'builtin:usage',
] as const;

export type BuiltinKanbanViewId = (typeof BUILTIN_KANBAN_VIEW_IDS)[number];

export type LegacyKanbanPanelView = 'board' | 'sessionHub' | 'usageDashboard';

export type KanbanViewDescriptor = {
  id: string;
  titleKey: string;
  hidesBottomDock: boolean;
  builtin: boolean;
  pluginId?: string;
  contributionId?: string;
};

export const BUILTIN_KANBAN_VIEWS: KanbanViewDescriptor[] = [
  {
    id: 'builtin:columns',
    titleKey: 'kanbanViews.columns',
    hidesBottomDock: true,
    builtin: true,
  },
  {
    id: 'builtin:sessions',
    titleKey: 'kanbanViews.sessions',
    hidesBottomDock: true,
    builtin: true,
  },
  {
    id: 'builtin:canvas',
    titleKey: 'kanbanViews.canvas',
    hidesBottomDock: true,
    builtin: true,
  },
  {
    id: 'builtin:usage',
    titleKey: 'kanbanViews.usage',
    hidesBottomDock: true,
    builtin: true,
  },
];

export const DEFAULT_KANBAN_VIEW_ID: BuiltinKanbanViewId = 'builtin:sessions';

export function migrateKanbanViewId(
  panelView?: LegacyKanbanPanelView | string | null,
  boardStyle?: string | null
): string {
  if (typeof panelView === 'string' && panelView.startsWith('builtin:')) {
    return panelView;
  }
  if (typeof panelView === 'string' && panelView.startsWith('plugin:')) {
    return panelView;
  }
  if (boardStyle === 'canvas' && panelView !== 'board' && panelView !== 'usageDashboard') {
    return 'builtin:canvas';
  }
  switch (panelView) {
    case 'board':
      return 'builtin:columns';
    case 'usageDashboard':
      return 'builtin:usage';
    case 'sessionHub':
    default:
      return DEFAULT_KANBAN_VIEW_ID;
  }
}

export function legacyKanbanPanelView(viewId: string): LegacyKanbanPanelView {
  switch (viewId) {
    case 'builtin:columns':
      return 'board';
    case 'builtin:usage':
      return 'usageDashboard';
    default:
      return 'sessionHub';
  }
}

export function resolveKanbanViewId(
  requested: string | null | undefined,
  views: readonly KanbanViewDescriptor[]
): string | null {
  if (views.length === 0) return null;
  if (requested && views.some((view) => view.id === requested)) {
    return requested;
  }
  return views[0]?.id ?? null;
}

export function kanbanViewIndex(
  views: readonly KanbanViewDescriptor[],
  viewId: string | null | undefined
): number {
  const index = views.findIndex((view) => view.id === viewId);
  return index < 0 ? 0 : index;
}

export function adjacentKanbanViewId(
  views: readonly KanbanViewDescriptor[],
  viewId: string,
  direction: -1 | 1
): string {
  if (views.length === 0) return viewId;
  const index = kanbanViewIndex(views, viewId);
  const next = index + direction;
  if (next < 0 || next >= views.length) return viewId;
  return views[next].id;
}

export function kanbanCarouselTranslateX(
  views: readonly KanbanViewDescriptor[],
  viewId: string
): string {
  const index = kanbanViewIndex(views, viewId);
  if (views.length <= 1) return 'translateX(0%)';
  return `translateX(-${(index * 100) / views.length}%)`;
}

export function kanbanCarouselWidth(viewCount: number): string {
  return `${Math.max(viewCount, 1) * 100}%`;
}

export function kanbanPageWidth(viewCount: number): string {
  return `${100 / Math.max(viewCount, 1)}%`;
}
