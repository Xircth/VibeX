/**
 * The terminal toggle opens a normal editor group under the workspace column.
 * It is not a dedicated terminal zone: any tab can live there. Visibility is
 * remembered so layout restore does not force the group back open.
 */
let shelfGroupId: string | null = null;
let shelfOpen = false;

export function markTerminalShelf(groupId: string, open: boolean): void {
  shelfGroupId = groupId;
  shelfOpen = open;
}

export function clearTerminalShelf(groupId?: string): void {
  if (groupId && shelfGroupId !== groupId) return;
  shelfGroupId = null;
  shelfOpen = false;
}

export function terminalShelfGroupId(): string | null {
  return shelfGroupId;
}

export function isTerminalShelfGroup(groupId: string): boolean {
  return shelfGroupId === groupId;
}

export function isTerminalShelfOpen(): boolean {
  return shelfOpen;
}

export function resetTerminalShelfForTests(): void {
  shelfGroupId = null;
  shelfOpen = false;
}
