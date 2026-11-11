import { applyPatch, type Operation } from 'rfc6902';

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveParentContainer(
  target: object,
  path: string
): { parent: unknown; segment: string } | null {
  const segments = path.split('/').slice(1).map(decodePointerSegment);

  if (segments.length === 0) {
    return null;
  }

  let current: unknown = target;

  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return null;
      }
      current = current[index];
      continue;
    }

    if (typeof current !== 'object' || current === null) {
      return null;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return {
    parent: current,
    segment: segments[segments.length - 1]!,
  };
}

function normalizeAddOperation(target: object, op: Operation): Operation {
  if (op.op !== 'add') {
    return op;
  }

  const resolved = resolveParentContainer(target, op.path);
  if (!resolved) {
    return op;
  }

  const { parent, segment } = resolved;
  if (!Array.isArray(parent)) {
    return op;
  }

  if (segment === '-') {
    return op;
  }

  const index = Number(segment);
  if (!Number.isInteger(index) || index < 0) {
    return op;
  }

  if (index < parent.length) {
    return { ...op, op: 'replace' };
  }

  return op;
}

export function applyUpsertPatch(target: object, ops: Operation[]): void {
  ops.forEach((op) => {
    const normalizedOp = normalizeAddOperation(target, op);
    const [error] = applyPatch(target, [normalizedOp]);

    if (normalizedOp.op === 'replace' && error?.name === 'MissingError') {
      applyPatch(target, [{ ...normalizedOp, op: 'add' }]);
    }
  });
}

function shallowCloneContainer<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.slice() as unknown as T;
  }
  if (typeof value === 'object' && value !== null) {
    return { ...(value as Record<string, unknown>) } as T;
  }
  return value;
}

function ensureClonedPath(
  root: object,
  pointer: string,
  clonedSet: WeakSet<object>
): void {
  const segments = pointer.split('/').slice(1).map(decodePointerSegment);
  let current: unknown = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i]!;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return;
      }
      const child = current[index];
      if (typeof child !== 'object' || child === null) return;
      if (!clonedSet.has(child)) {
        const clonedChild = shallowCloneContainer(child);
        current[index] = clonedChild;
        clonedSet.add(clonedChild);
      }
      current = current[index];
      continue;
    }
    if (typeof current !== 'object' || current === null) {
      return;
    }
    const record = current as Record<string, unknown>;
    const child = record[segment];
    if (typeof child !== 'object' || child === null) return;
    if (!clonedSet.has(child)) {
      const clonedChild = shallowCloneContainer(child);
      record[segment] = clonedChild;
      clonedSet.add(clonedChild);
    }
    current = record[segment];
  }
}

export function cloneAndApplyUpsertPatch<T extends object>(
  target: T,
  ops: Operation[]
): T {
  const rootClone = shallowCloneContainer(target);
  const clonedSet = new WeakSet<object>([rootClone]);
  for (const op of ops) {
    ensureClonedPath(rootClone, op.path, clonedSet);
    if ('from' in op && typeof op.from === 'string') {
      ensureClonedPath(rootClone, op.from, clonedSet);
    }
    const normalizedOp = normalizeAddOperation(rootClone, op);
    const [error] = applyPatch(rootClone, [normalizedOp]);
    if (normalizedOp.op === 'replace' && error?.name === 'MissingError') {
      applyPatch(rootClone, [{ ...normalizedOp, op: 'add' }]);
    }
  }
  return rootClone;
}

