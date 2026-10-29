import { type ComponentType } from 'react';
import { type IDockviewPanelProps } from 'dockview-react';

/**
 * Builtin panels are registered through the same `panelRegistry` as plugin
 * panels, so they are declared as manifests in the plugin `integrations`
 * vocabulary instead of a hand-written array in `PanelRegistry`.
 *
 * `app.panel` (see `packages/plugin-sdk/src/manifest.ts`) allows `left` and
 * `center`. Builtin panels additionally open the Dockview bottom group and the
 * session group, so those host zones appear here and nowhere in the plugin
 * manifest schema yet.
 */
export type BuiltinPanelPosition = 'left' | 'center' | 'bottom' | 'session';

export interface BuiltinPanelModule {
  default: ComponentType<IDockviewPanelProps>;
}

export interface BuiltinPanelManifest {
  readonly id: string;
  readonly kind: 'app.panel';
  /**
   * Title key inside the `panels` locale namespace, e.g.
   * `panelRegistry.fileExplorer`. Dockview persists a tab's title string in the
   * saved layout, so builtin tab titles resolve through this key at render
   * time instead of being frozen in the language they were created in.
   */
  readonly titleKey: string;
  readonly defaultPosition: BuiltinPanelPosition;
  readonly multiInstance?: boolean;
  /**
   * Builtin-only resolution: a plugin manifest names a Host handler
   * (`surface.createSession`) and the Host resolves the surface. A builtin
   * panel is already inside the Host, so it names the module to load.
   */
  readonly component: () => Promise<BuiltinPanelModule>;
}

/** Dockview group each manifest position opens (one source for the mapping). */
export const PANEL_ZONE_BY_POSITION = {
  left: 'left',
  center: 'editor',
  bottom: 'bottom',
  session: 'session',
} as const satisfies Record<BuiltinPanelPosition, string>;
