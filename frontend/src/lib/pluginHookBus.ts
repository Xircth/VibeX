/**
 * Synchronous window-event bus between the plugin buttons in the right panel
 * sidebar and the session composer. `dispatchEvent` runs listeners inline, so
 * the caller can read the listener's verdict from the mutated detail right
 * after dispatch — no store plumbing across dockview panel boundaries.
 */

const PLUGIN_HOOK_EVENT = 'vibex:plugin-hook';

export type PluginHookAction = 'check' | 'insert';

export type PluginHookResult = 'ok' | 'blocked' | 'no-composer';

export interface PluginHookDetail {
  workspaceId: string;
  action: PluginHookAction;
  /** Hook text to insert (required for `insert`). */
  text?: string;
  /** Filled in by the composer-side listener. */
  result?: PluginHookResult;
}

/**
 * Probe (`check`) or write into (`insert`) the composer of the given
 * workspace. Returns `blocked` when a turn is running or the composer already
 * has content, `no-composer` when no composer for the workspace is mounted.
 */
export function requestPluginHook(
  detail: Omit<PluginHookDetail, 'result'>
): PluginHookResult {
  const payload: PluginHookDetail = { ...detail };
  window.dispatchEvent(
    new CustomEvent<PluginHookDetail>(PLUGIN_HOOK_EVENT, { detail: payload })
  );
  return payload.result ?? 'no-composer';
}

export function listenPluginHook(
  handler: (detail: PluginHookDetail) => void
): () => void {
  const listener = (event: Event) => {
    handler((event as CustomEvent<PluginHookDetail>).detail);
  };
  window.addEventListener(PLUGIN_HOOK_EVENT, listener);
  return () => window.removeEventListener(PLUGIN_HOOK_EVENT, listener);
}
