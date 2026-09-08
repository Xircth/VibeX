/** Server-bound Host app window (not its Settings companion). */
export function isHostAppWindowLabel(label: string): boolean {
  return label.startsWith('host-') && label.length > 'host-'.length;
}

/** Server-bound Host windows and their Settings companion. */
export function isHostBoundWindowLabel(label: string): boolean {
  if (label.startsWith('settings-host-')) {
    return label.length > 'settings-host-'.length;
  }
  return isHostAppWindowLabel(label);
}
