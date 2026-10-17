import { isValidTauriEventName } from '@/lib/tauriEventName';

/**
 * Native browser page events (`tab.state`, `tab.open`, `tab.chrome`, pick).
 * Must stay a legal Tauri event name: alphanumeric, `-`, `/`, `:`, `_`.
 */
export const BROWSER_HOST_EVENT = 'plugin:browser';

if (!isValidTauriEventName(BROWSER_HOST_EVENT)) {
  throw new Error(
    `BROWSER_HOST_EVENT "${BROWSER_HOST_EVENT}" is not a legal Tauri event name`
  );
}
