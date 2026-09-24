export type LiveBrowserSurface = {
  tabId: string;
  url: string;
};

const liveSurfaces = new Map<string, LiveBrowserSurface>();

export function browserPanelSurfaceKey(
  projectKey: string,
  panelId: string
): string {
  return `${projectKey}::${panelId}`;
}

export function rememberBrowserSurface(
  key: string,
  surface: LiveBrowserSurface
): void {
  if (!key || !surface.tabId) return;
  liveSurfaces.set(key, surface);
}

export function recallBrowserSurface(
  key: string
): LiveBrowserSurface | undefined {
  return liveSurfaces.get(key);
}

export function forgetBrowserSurface(key: string): void {
  liveSurfaces.delete(key);
}

export function serializedLayoutHasPanel(
  layout: unknown,
  panelId: string
): boolean {
  if (!panelId || layout == null || typeof layout !== 'object') return false;
  const panels = (layout as { panels?: Record<string, unknown> }).panels;
  if (panels && Object.prototype.hasOwnProperty.call(panels, panelId)) {
    return true;
  }
  return walkForPanelId(layout, panelId);
}

function walkForPanelId(value: unknown, panelId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some(
      (entry) => entry === panelId || walkForPanelId(entry, panelId)
    );
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.views) && record.views.includes(panelId)) {
    return true;
  }
  return Object.values(record).some((entry) => walkForPanelId(entry, panelId));
}

export function projectLayoutStillHasBrowserPanel(
  state: {
    currentProjectKey: string;
    serializedLayout?: unknown;
    projectLayouts?: Record<string, { serializedLayout?: unknown }>;
  },
  projectKey: string,
  panelId: string
): boolean {
  const saved = state.projectLayouts?.[projectKey]?.serializedLayout;
  if (serializedLayoutHasPanel(saved, panelId)) return true;
  if (state.currentProjectKey === projectKey) {
    return serializedLayoutHasPanel(state.serializedLayout, panelId);
  }
  return false;
}

const HIDDEN_BOUNDS = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  scale: 1,
  visible: false,
};

export function hiddenBrowserBounds() {
  return { ...HIDDEN_BOUNDS };
}
