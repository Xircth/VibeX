/**
 * Tauri `listen` / `emit` event names may only contain alphanumeric
 * characters, `-`, `/`, `:`, and `_`. A `.` is rejected at the IPC
 * boundary as `invalid args event for command listen`.
 */
const TAURI_EVENT_NAME = /^[A-Za-z0-9_\-/:]+$/;

export function isValidTauriEventName(event: string): boolean {
  return event.length > 0 && TAURI_EVENT_NAME.test(event);
}
