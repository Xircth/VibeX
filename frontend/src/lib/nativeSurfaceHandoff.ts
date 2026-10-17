/**
 * Native HWND paints above HTML. Chrome view switches (workspace ↔ kanban /
 * plugin tab) therefore park the live surface first: freeze-frame occupies the
 * host, the HWND is hidden, then the HTML view may commit. Coming back keeps
 * that stand-in until the destination slot has a stable laid-out rect.
 */

export const NATIVE_SURFACE_DESTINATION_STABLE_SAMPLES = 3;

export function chromeHidesNativeSurface(
  activeTab: string,
  tabContextMenuOpen = false
): boolean {
  return tabContextMenuOpen || activeTab !== 'workspace';
}

/**
 * Leave a workspace that owns a native page: occlude (freeze + hide HWND)
 * and only then commit the HTML view. Entering workspace commits immediately
 * while the HWND stays parked; reveal is a separate step after layout.
 */
export async function parkNativeSurfaceThen(args: {
  park: boolean;
  occlude: () => void;
  waitUntilParked: () => Promise<void>;
  commit: () => void;
}): Promise<void> {
  if (args.park) {
    args.occlude();
    await args.waitUntilParked();
  }
  args.commit();
}

export function nativeSurfaceDestinationProgress(args: {
  signature: string;
  laidOut: boolean;
  previousSignature: string;
  matches: number;
}): { previousSignature: string; matches: number; ready: boolean } {
  if (!args.laidOut) {
    return {
      previousSignature: args.signature,
      matches: 0,
      ready: false,
    };
  }
  const matches =
    args.signature === args.previousSignature ? args.matches + 1 : 1;
  return {
    previousSignature: args.signature,
    matches,
    ready: matches >= NATIVE_SURFACE_DESTINATION_STABLE_SAMPLES,
  };
}
