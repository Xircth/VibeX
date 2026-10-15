/**
 * Registers on-screen conversations for the backend keepalive.
 *
 * The activity bump runs inside the agent runtime (30s, or sooner when the
 * idle timeout is shorter). This module only tells that loop which surfaces
 * are on screen. It does not schedule a timer, connect, resume, or surface a
 * status notice. Hiding the window leaves the registration in place.
 * Off-screen surfaces unregister.
 */

type Registration = {
  generation: number;
  setWatch: (watch: boolean) => Promise<unknown>;
};

const registrations = new Map<string, Registration>();
let generationClock = 0;
let pagehideHandler: (() => void) | null = null;

function releaseAll(): void {
  const snapshot = [...registrations.values()];
  registrations.clear();
  for (const registration of snapshot) {
    void registration.setWatch(false).catch(() => undefined);
  }
}

function bindPagehide(): void {
  if (pagehideHandler != null || typeof window === 'undefined') return;
  pagehideHandler = () => {
    releaseAll();
  };
  window.addEventListener('pagehide', pagehideHandler);
}

export function retainConversationKeepalive(
  conversationId: string,
  setWatch: (watch: boolean) => Promise<unknown>
): () => void {
  bindPagehide();
  generationClock += 1;
  const generation = generationClock;
  registrations.set(conversationId, { generation, setWatch });
  void setWatch(true).catch(() => undefined);
  return () => {
    const current = registrations.get(conversationId);
    if (!current || current.generation !== generation) return;
    registrations.delete(conversationId);
    void setWatch(false).catch(() => undefined);
  };
}

/** Test seam. Production callers release through the function above. */
export function resetConversationKeepaliveForTests(): void {
  registrations.clear();
  generationClock = 0;
  if (pagehideHandler != null && typeof window !== 'undefined') {
    window.removeEventListener('pagehide', pagehideHandler);
  }
  pagehideHandler = null;
}
