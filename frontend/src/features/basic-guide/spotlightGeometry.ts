export type Rect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type SpotlightShape = 'rect' | 'circle';

export type SpotlightTarget = {
  id: string;
  copyKey?: string;
  group?: string;
  shape?: 'auto' | 'circle' | 'rect';
};

export type MeasuredTarget = SpotlightTarget & Rect;

export type MergedSpotlight = Rect & {
  shape: SpotlightShape;
  sourceIds: string[];
  copyKeys: string[];
  group?: string;
};

export type PlacedCallout = Rect & {
  key: string;
};

export type CalloutAnchor = PlacedCallout & {
  text: string;
};

export type CalloutMovePlan = {
  moves: { from: CalloutAnchor; to: CalloutAnchor }[];
  appear: CalloutAnchor[];
  disappear: CalloutAnchor[];
};

export type Connector = {
  copyKey: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
};

export const CIRCLE_MAX_EDGE = 44;
export const CIRCLE_ASPECT = 0.75;
export const MERGE_GAP = 4;
export const GROUP_MERGE_GAP = 16;
export const CALLOUT_MAX_WIDTH = 240;
export const CALLOUT_MIN_WIDTH = 140;
export const VIEWPORT_MARGIN = 12;
export const CALLOUT_GAP = 16;
export const BASIC_GUIDE_IDLE_MS = 5000;
export const CALLOUT_MOVE_MS = 480;

export function isCircleLike(
  box: Rect,
  shape?: 'auto' | 'circle' | 'rect'
): boolean {
  if (shape === 'circle') return true;
  if (shape === 'rect') return false;
  const min = Math.min(box.width, box.height);
  const max = Math.max(box.width, box.height);
  return max > 0 && max <= CIRCLE_MAX_EDGE && min >= CIRCLE_ASPECT * max;
}

export function gapBetween(a: Rect, b: Rect): number {
  const dx = Math.max(
    0,
    a.left - (b.left + b.width),
    b.left - (a.left + a.width)
  );
  const dy = Math.max(
    0,
    a.top - (b.top + b.height),
    b.top - (a.top + a.height)
  );
  if (dx === 0 && dy === 0) {
    const overlapX =
      Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
    const overlapY =
      Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
    if (overlapX > 0 && overlapY > 0) return -Math.min(overlapX, overlapY);
    return 0;
  }
  if (dx === 0) return dy;
  if (dy === 0) return dx;
  return Math.hypot(dx, dy);
}

export function unionRect(a: Rect, b: Rect): Rect {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const right = Math.max(a.left + a.width, b.left + b.width);
  const bottom = Math.max(a.top + a.height, b.top + b.height);
  return { left, top, width: right - left, height: bottom - top };
}

export function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
  );
}

export function padMeasured(box: MeasuredTarget): MergedSpotlight {
  const circle = isCircleLike(box, box.shape);
  const sourceIds = box.id ? [box.id] : [];
  const copyKeys = box.copyKey ? [box.copyKey] : [];
  if (circle) {
    const size = Math.max(box.width, box.height);
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    return {
      left: cx - size / 2,
      top: cy - size / 2,
      width: size,
      height: size,
      shape: 'circle',
      sourceIds,
      copyKeys,
      group: box.group,
    };
  }
  return {
    left: box.left - 4,
    top: box.top - 4,
    width: box.width + 8,
    height: box.height + 8,
    shape: 'rect',
    sourceIds,
    copyKeys,
    group: box.group,
  };
}

export function mergeOverlapping(boxes: MeasuredTarget[]): MergedSpotlight[] {
  const items = boxes
    .filter((box) => box.width >= 2 && box.height >= 2)
    .map(padMeasured);

  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i]!;
        const b = items[j]!;
        if (rectContains(a, b) || rectContains(b, a)) continue;
        const sameGroup = Boolean(a.group && a.group === b.group);
        const gap = gapBetween(a, b);
        const shouldMerge = sameGroup
          ? gap <= GROUP_MERGE_GAP
          : gap <= MERGE_GAP;
        if (!shouldMerge) continue;
        const merged: MergedSpotlight = {
          ...unionRect(a, b),
          shape: 'rect',
          sourceIds: uniqueStrings([...a.sourceIds, ...b.sourceIds]),
          copyKeys: uniqueStrings([...a.copyKeys, ...b.copyKeys]),
          group: a.group ?? b.group,
        };
        items.splice(j, 1);
        items.splice(i, 1, merged);
        changed = true;
        break outer;
      }
    }
  }
  return items;
}

export const CALLOUT_ACTION_HEIGHT = 36;

export function estimateCalloutSize(
  text: string,
  options?: { hasAction?: boolean }
): {
  width: number;
  height: number;
} {
  const plain = text.replace(/\*\*/g, '').trim() || ' ';
  const font = 13;
  const padX = 24;
  const padY = 20;
  const lineHeight = 20;
  const maxInner = CALLOUT_MAX_WIDTH - padX;
  const charsPerLine = Math.max(8, Math.floor(maxInner / font));
  const lines = Math.max(1, Math.ceil(plain.length / charsPerLine));
  const contentW = Math.min(maxInner, plain.length * font);
  const action = options?.hasAction ? CALLOUT_ACTION_HEIGHT : 0;
  return {
    width: Math.min(
      CALLOUT_MAX_WIDTH,
      Math.max(CALLOUT_MIN_WIDTH, contentW + padX)
    ),
    height: padY + lines * lineHeight + action,
  };
}

function rectsOverlap(a: Rect, b: Rect, gap = 8): boolean {
  return gapBetween(a, b) < gap;
}

function clampCallout(
  rect: Rect,
  viewport: { width: number; height: number }
): Rect {
  const margin = VIEWPORT_MARGIN;
  const width = Math.min(rect.width, Math.max(80, viewport.width - 2 * margin));
  const height = Math.min(
    rect.height,
    Math.max(32, viewport.height - 2 * margin)
  );
  const left = Math.min(
    Math.max(rect.left, margin),
    viewport.width - width - margin
  );
  const top = Math.min(
    Math.max(rect.top, margin),
    viewport.height - height - margin
  );
  return { left, top, width, height };
}

function centerOf(rect: Rect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export function edgePoint(
  box: Rect,
  toward: { x: number; y: number },
  shape: SpotlightShape,
  slot = 0,
  slots = 1
): { x: number; y: number } {
  const center = centerOf(box);
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const offset = slots > 1 ? (slot - (slots - 1) / 2) * 14 : 0;
  if (shape === 'circle') {
    const radius = Math.min(box.width, box.height) / 2;
    const angle = Math.atan2(dy, dx) + (offset / Math.max(radius, 1)) * 0.35;
    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    };
  }
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const halfW = box.width / 2;
  const halfH = box.height / 2;
  if (absDx * halfH > absDy * halfW) {
    const side = dx >= 0 ? 1 : -1;
    const x = center.x + side * halfW;
    const y = Math.min(
      box.top + box.height - 8,
      Math.max(
        box.top + 8,
        center.y + (absDx === 0 ? 0 : (dy / absDx) * halfW) + offset
      )
    );
    return { x, y };
  }
  const side = dy >= 0 ? 1 : -1;
  const y = center.y + side * halfH;
  const x = Math.min(
    box.left + box.width - 8,
    Math.max(
      box.left + 8,
      center.x + (absDy === 0 ? 0 : (dx / absDy) * halfH) + offset
    )
  );
  return { x, y };
}

export function layoutCallouts({
  boxes,
  callouts,
  panel,
  viewport,
}: {
  boxes: MergedSpotlight[];
  callouts: { key: string; text: string; hasAction?: boolean }[];
  panel: Rect | null;
  viewport: { width: number; height: number };
}): { callouts: PlacedCallout[]; connectors: Connector[] } {
  const obstacles: Rect[] = [...boxes];
  if (panel) obstacles.push(panel);
  const placed: PlacedCallout[] = [];

  const sourcesFor = (key: string) =>
    boxes.filter((box) => box.copyKeys.includes(key));

  callouts.forEach((item, index) => {
    const size = estimateCalloutSize(item.text, {
      hasAction: item.hasAction,
    });
    const sources = sourcesFor(item.key);
    const anchor = sources[0] ??
      panel ?? {
        left: VIEWPORT_MARGIN,
        top: viewport.height / 2 - 80,
        width: 220,
        height: 160,
      };
    const panelRight = panel ? panel.left + panel.width : 16;
    const candidates: Rect[] = [
      {
        left: anchor.left + anchor.width + CALLOUT_GAP,
        top: anchor.top,
        ...size,
      },
      {
        left: anchor.left + anchor.width + CALLOUT_GAP,
        top: anchor.top + anchor.height / 2 - size.height / 2,
        ...size,
      },
      {
        left: viewport.width - size.width - 24,
        top: anchor.top,
        ...size,
      },
      {
        left: anchor.left - CALLOUT_GAP - size.width,
        top: anchor.top,
        ...size,
      },
      {
        left: anchor.left,
        top: anchor.top + anchor.height + CALLOUT_GAP,
        ...size,
      },
      {
        left: anchor.left,
        top: anchor.top - CALLOUT_GAP - size.height,
        ...size,
      },
      {
        left: panelRight + CALLOUT_GAP,
        top: 96 + index * (size.height + 12),
        ...size,
      },
    ];

    let chosen: Rect | null = null;
    for (const raw of candidates) {
      const next = clampCallout(raw, viewport);
      const blocked = [...obstacles, ...placed].some((obstacle) =>
        rectsOverlap(next, obstacle, 10)
      );
      if (!blocked) {
        chosen = next;
        break;
      }
    }
    if (!chosen) {
      chosen = clampCallout(
        {
          left: viewport.width - size.width - 24,
          top: 80 + index * (size.height + 12),
          ...size,
        },
        viewport
      );
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const blocked = [...obstacles, ...placed].some((obstacle) =>
          rectsOverlap(chosen!, obstacle, 8)
        );
        if (!blocked) break;
        chosen = clampCallout(
          { ...chosen, top: chosen.top + size.height + 8 },
          viewport
        );
      }
    }
    placed.push({ key: item.key, ...chosen });
    obstacles.push(chosen);
  });

  const connectors: Connector[] = [];
  for (const callout of placed) {
    const toward = centerOf(callout);
    for (const box of sourcesFor(callout.key)) {
      const slot = Math.max(0, box.copyKeys.indexOf(callout.key));
      const from = edgePoint(box, toward, box.shape, slot, box.copyKeys.length);
      const to = edgePoint(callout, from, 'rect');
      connectors.push({ copyKey: callout.key, from, to });
    }
  }

  return { callouts: placed, connectors };
}

export function curvePath(
  from: { x: number; y: number },
  to: { x: number; y: number }
): string {
  const midX = from.x + (to.x - from.x) * 0.5;
  return `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} C ${midX.toFixed(1)} ${from.y.toFixed(1)}, ${midX.toFixed(1)} ${to.y.toFixed(1)}, ${to.x.toFixed(1)} ${to.y.toFixed(1)}`;
}

export function calloutKeysFor(boxes: MergedSpotlight[]): string[] {
  return uniqueStrings(boxes.flatMap((box) => box.copyKeys));
}

export function calloutKeySignature(callouts: { key: string }[]): string {
  return callouts.map((callout) => callout.key).join('|');
}

function shuffledIndices(length: number, random: () => number): number[] {
  const indices = Array.from({ length }, (_, i) => i);
  for (let i = length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const current = indices[i]!;
    indices[i] = indices[j]!;
    indices[j] = current;
  }
  return indices;
}

export function pairCalloutMoves(
  from: CalloutAnchor[],
  to: CalloutAnchor[],
  random: () => number = Math.random
): CalloutMovePlan {
  if (from.length === 0) {
    return { moves: [], appear: [...to], disappear: [] };
  }
  if (to.length === 0) {
    return { moves: [], appear: [], disappear: [...from] };
  }

  const fromOrder = shuffledIndices(from.length, random);
  const toOrder = shuffledIndices(to.length, random);
  const pairCount = Math.min(from.length, to.length);
  const usedFrom = new Set<number>();
  const usedTo = new Set<number>();
  const moves: CalloutMovePlan['moves'] = [];

  for (let i = 0; i < pairCount; i += 1) {
    const fromIndex = fromOrder[i]!;
    const toIndex = toOrder[i]!;
    moves.push({ from: from[fromIndex]!, to: to[toIndex]! });
    usedFrom.add(fromIndex);
    usedTo.add(toIndex);
  }

  return {
    moves,
    appear: to.filter((_, index) => !usedTo.has(index)),
    disappear: from.filter((_, index) => !usedFrom.has(index)),
  };
}
