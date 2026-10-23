/**
 * Registry of editable session composers that can receive draft tokens
 * (e.g. from `ctx.conversation.call('draft.insert', …)`).
 *
 * Only the most recently focused editable composer receives an insertion, so
 * split views never insert the same token twice.
 */
export interface ComposerDraftToken {
  label: string;
  markdown: string;
}

interface ComposerDraftTarget {
  readonly id: number;
  isEditable: () => boolean;
  insert: (token: ComposerDraftToken) => void;
  lastFocusedAt: number;
  registeredAt: number;
}

let nextId = 1;
let clock = 0;
const targets = new Map<number, ComposerDraftTarget>();

function tick(): number {
  clock += 1;
  return clock;
}

export interface ComposerDraftTargetHandle {
  readonly id: number;
  markFocused: () => void;
  dispose: () => void;
}

export function registerComposerDraftTarget(options: {
  isEditable: () => boolean;
  insert: (token: ComposerDraftToken) => void;
}): ComposerDraftTargetHandle {
  const id = nextId++;
  const target: ComposerDraftTarget = {
    id,
    isEditable: options.isEditable,
    insert: options.insert,
    lastFocusedAt: 0,
    registeredAt: tick(),
  };
  targets.set(id, target);
  return {
    id,
    markFocused: () => {
      const current = targets.get(id);
      if (current) current.lastFocusedAt = tick();
    },
    dispose: () => {
      targets.delete(id);
    },
  };
}

/** The editable composer that most recently had focus (or, if none was ever
 * focused, the most recently mounted editable composer). */
export function getActiveComposerDraftTargetId(): number | null {
  let best: ComposerDraftTarget | null = null;
  for (const target of targets.values()) {
    if (!target.isEditable()) continue;
    if (
      !best ||
      target.lastFocusedAt > best.lastFocusedAt ||
      (target.lastFocusedAt === best.lastFocusedAt &&
        target.registeredAt > best.registeredAt)
    ) {
      best = target;
    }
  }
  return best?.id ?? null;
}

export function hasActiveComposerDraftTarget(): boolean {
  return getActiveComposerDraftTargetId() !== null;
}

/** Inserts into the active composer only. Returns whether a composer took it. */
export function insertIntoActiveComposer(token: ComposerDraftToken): boolean {
  const label = token.label?.trim();
  const markdown = token.markdown?.trim();
  if (!label || !markdown) return false;
  const id = getActiveComposerDraftTargetId();
  if (id === null) return false;
  targets.get(id)?.insert({ label, markdown });
  return true;
}
