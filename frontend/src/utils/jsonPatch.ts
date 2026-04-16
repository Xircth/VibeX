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
