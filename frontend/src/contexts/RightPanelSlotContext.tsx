import { createContext, useContext } from 'react';

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
