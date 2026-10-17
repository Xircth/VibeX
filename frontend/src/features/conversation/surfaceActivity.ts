export type SurfaceVisibility = 'visible' | 'hidden' | 'prerender';

/**
 * Whether a mounted conversation surface should stay connected.
 *
 * A hidden window keeps the last answer. Codeg keeps open tabs alive in the
 * background so the idle sweep does not reap them and the next focus does not
 * resume every conversation. An off-screen surface, after it has been seen,
 * drops activity so the sweep can release that agent.
 */
export function nextSurfaceActive(input: {
  active: boolean;
  intersecting: boolean;
  visibilityState: SurfaceVisibility;
  seenVisible: boolean;
}): { active: boolean; seenVisible: boolean } {
  if (input.visibilityState !== 'visible') {
    return { active: input.active, seenVisible: input.seenVisible };
  }
  if (input.intersecting) {
    return { active: true, seenVisible: true };
  }
  if (!input.seenVisible) {
    return { active: input.active, seenVisible: false };
  }
  return { active: false, seenVisible: true };
}
