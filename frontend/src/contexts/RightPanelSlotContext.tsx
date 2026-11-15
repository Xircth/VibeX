import { createContext, useContext, useSyncExternalStore } from 'react';

/**
 * Placement of the session (right panel / C zone) content.
 *
 * The session content is rendered exactly once: IDELayout portals it into a
 * detached `host` element. Whichever slot currently owns the placement
 * (the dockview session panel on the workspace page, or the kanban session
 * slot on the kanban page) re-parents that host into its own container.
 * Moving a portal target's DOM node does not remount the React subtree, so
 * conversation state survives tab switches.
 */
export interface SessionPanelPlacement {
  /** Detached element holding the session content, or null when absent. */
  host: HTMLElement | null;
  /** Which page currently owns the session content. */
  placement: 'workspace' | 'kanban';
}

export const RightPanelSlotContext = createContext<SessionPanelPlacement>({
  host: null,
  placement: 'workspace',
});

export function useRightPanelSlot(): SessionPanelPlacement {
  return useContext(RightPanelSlotContext);
}

const hostConsumerCounts = new WeakMap<HTMLElement, number>();
const knownRightPanelHosts = new WeakSet<HTMLElement>();
const hostAttachmentListeners = new Set<() => void>();

function emitHostAttachmentChange(): void {
  for (const listener of hostAttachmentListeners) {
    listener();
  }
}

function subscribeRightPanelHostAttachment(listener: () => void): () => void {
  hostAttachmentListeners.add(listener);
  return () => {
    hostAttachmentListeners.delete(listener);
  };
}

export function getRightPanelHostConsumerCount(host: HTMLElement): number {
  return hostConsumerCounts.get(host) ?? 0;
}

export function isKnownRightPanelHost(host: HTMLElement): boolean {
  return knownRightPanelHosts.has(host);
}

export function isRightPanelHostAttached(host: HTMLElement | null): boolean {
  if (host === null) return true;
  return getRightPanelHostConsumerCount(host) > 0;
}

/**
 * Retains ownership of a shared right-panel portal `host` while a slot mounts
 * it into a visible DOM container. Notifies subscribers when consumer count
 * transitions between `0` and `>0`.
 */
export function retainRightPanelHost(host: HTMLElement): () => void {
  knownRightPanelHosts.add(host);
  const previousCount = getRightPanelHostConsumerCount(host);
  hostConsumerCounts.set(host, previousCount + 1);
  if (previousCount === 0) {
    emitHostAttachmentChange();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;

    const currentCount = getRightPanelHostConsumerCount(host);
    const nextCount = Math.max(0, currentCount - 1);
    if (nextCount === 0) {
      hostConsumerCounts.delete(host);
    } else {
      hostConsumerCounts.set(host, nextCount);
    }
    if (currentCount > 0 && nextCount === 0) {
      emitHostAttachmentChange();
    }
  };
}

export function useIsRightPanelHostAttached(host: HTMLElement | null): boolean {
  return useSyncExternalStore(
    subscribeRightPanelHostAttachment,
    () => isRightPanelHostAttached(host),
    () => host === null
  );
}
