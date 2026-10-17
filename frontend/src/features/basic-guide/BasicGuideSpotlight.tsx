import { useEffect, useMemo, useRef, useState } from 'react';

import { GuideCopy } from './GuideCopy';
import {
  BASIC_GUIDE_IDLE_MS,
  CALLOUT_MOVE_MS,
  calloutKeySignature,
  calloutKeysFor,
  curvePath,
  layoutCallouts,
  mergeOverlapping,
  pairCalloutMoves,
  type CalloutAnchor,
  type CalloutMovePlan,
  type MeasuredTarget,
  type MergedSpotlight,
  type Rect,
  type SpotlightTarget,
} from './spotlightGeometry';

type VisualCallout = {
  id: string;
  kind: 'move' | 'appear' | 'disappear' | 'idle';
  key: string;
  text: string;
  left: number;
  top: number;
  width: number;
  opacity: number;
};

type Flight = {
  phase: 'from' | 'to';
  framesFrom: VisualCallout[];
  framesTo: VisualCallout[];
};

function prefersReducedMotion(): boolean {
  return (
    window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
  );
}

function withText(
  callouts: {
    key: string;
    left: number;
    top: number;
    width: number;
    height: number;
  }[],
  copyItems: { key: string; text: string }[]
): CalloutAnchor[] {
  return callouts.map((callout) => ({
    ...callout,
    text: copyItems.find((item) => item.key === callout.key)?.text ?? '',
  }));
}

function idleFrames(callouts: CalloutAnchor[]): VisualCallout[] {
  return callouts.map((callout) => ({
    id: callout.key,
    kind: 'idle' as const,
    key: callout.key,
    text: callout.text,
    left: callout.left,
    top: callout.top,
    width: callout.width,
    opacity: 1,
  }));
}

function framesFor(
  plan: CalloutMovePlan,
  phase: 'from' | 'to'
): VisualCallout[] {
  const atTo = phase === 'to';
  return [
    ...plan.moves.map((move, index) => ({
      id: `move-${index}`,
      kind: 'move' as const,
      key: move.to.key,
      text: move.to.text,
      left: atTo ? move.to.left : move.from.left,
      top: atTo ? move.to.top : move.from.top,
      width: atTo ? move.to.width : move.from.width,
      opacity: 1,
    })),
    ...plan.appear.map((callout, index) => ({
      id: `appear-${index}`,
      kind: 'appear' as const,
      key: callout.key,
      text: callout.text,
      left: callout.left,
      top: callout.top,
      width: callout.width,
      opacity: atTo ? 1 : 0,
    })),
    ...plan.disappear.map((callout, index) => ({
      id: `disappear-${index}`,
      kind: 'disappear' as const,
      key: callout.key,
      text: callout.text,
      left: callout.left,
      top: callout.top,
      width: callout.width,
      opacity: atTo ? 0 : 1,
    })),
  ];
}

function measurePanel(selector: string): Rect | null {
  const panel = document.querySelector<HTMLElement>(selector);
  if (!panel) return null;
  const rect = panel.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function measureTargets(targets: readonly SpotlightTarget[]): MeasuredTarget[] {
  const boxes: MeasuredTarget[] = [];
  for (const target of targets) {
    if (!target.id) continue;
    const nodes = document.querySelectorAll<HTMLElement>(
      `[data-basic-guide="${target.id}"]`
    );
    nodes.forEach((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      boxes.push({
        ...target,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      });
    });
  }
  return boxes;
}

export function BasicGuideSpotlight({
  targets,
  resolveCopy,
  panelSelector,
}: {
  targets: readonly SpotlightTarget[];
  resolveCopy: (key: string) => string;
  panelSelector: string;
}) {
  const [boxes, setBoxes] = useState<MergedSpotlight[]>([]);
  const [panel, setPanel] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState({
    width: typeof window === 'undefined' ? 1280 : window.innerWidth,
    height: typeof window === 'undefined' ? 800 : window.innerHeight,
  });
  const [idle, setIdle] = useState(false);
  const [flight, setFlight] = useState<Flight | null>(null);
  const prevCalloutsRef = useRef<CalloutAnchor[]>([]);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const targetKey = targets
    .map((item) => `${item.id}:${item.copyKey}`)
    .join(',');

  useEffect(() => {
    const update = () => {
      setBoxes(mergeOverlapping(measureTargets(targetsRef.current)));
      setPanel(measurePanel(panelSelector));
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    update();
    const interval = window.setInterval(update, 250);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [panelSelector, targetKey]);

  useEffect(() => {
    setIdle(false);
    let timer = window.setTimeout(() => setIdle(true), BASIC_GUIDE_IDLE_MS);
    const ping = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), BASIC_GUIDE_IDLE_MS);
    };
    window.addEventListener('pointerdown', ping, true);
    window.addEventListener('keydown', ping, true);
    window.addEventListener('wheel', ping, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', ping, true);
      window.removeEventListener('keydown', ping, true);
      window.removeEventListener('wheel', ping, true);
    };
  }, [targetKey]);

  const copyItems = useMemo(() => {
    const keys = calloutKeysFor(boxes);
    return keys
      .map((key) => ({ key, text: resolveCopy(key) }))
      .filter((item) => item.text.trim().length > 0);
  }, [boxes, resolveCopy]);

  const plan = useMemo(
    () =>
      layoutCallouts({
        boxes,
        callouts: copyItems,
        panel,
        viewport,
      }),
    [boxes, copyItems, panel, viewport]
  );

  useEffect(() => {
    if (plan.callouts.length === 0) return;
    const next = withText(plan.callouts, copyItems);
    const prev = prevCalloutsRef.current;
    const prevKeys = calloutKeySignature(prev);
    const nextKeys = calloutKeySignature(next);
    if (
      prev.length > 0 &&
      next.length > 0 &&
      prevKeys !== nextKeys &&
      !prefersReducedMotion()
    ) {
      const pairing = pairCalloutMoves(prev, next);
      setFlight({
        phase: 'from',
        framesFrom: framesFor(pairing, 'from'),
        framesTo: framesFor(pairing, 'to'),
      });
    }
    prevCalloutsRef.current = next;
  }, [plan, copyItems]);

  useEffect(() => {
    if (!flight) return;
    if (flight.phase === 'from') {
      const play = window.setTimeout(() => {
        setFlight((current) =>
          current?.phase === 'from' ? { ...current, phase: 'to' } : current
        );
      }, 0);
      return () => window.clearTimeout(play);
    }
    const done = window.setTimeout(() => setFlight(null), CALLOUT_MOVE_MS);
    return () => window.clearTimeout(done);
  }, [flight]);

  const nextAnchors = withText(plan.callouts, copyItems);
  const previousAnchors = prevCalloutsRef.current;
  const pendingMove =
    !flight &&
    previousAnchors.length > 0 &&
    nextAnchors.length > 0 &&
    calloutKeySignature(previousAnchors) !== calloutKeySignature(nextAnchors) &&
    !prefersReducedMotion();
  const visualCallouts: VisualCallout[] = flight
    ? flight.phase === 'from'
      ? flight.framesFrom
      : flight.framesTo
    : pendingMove
      ? idleFrames(previousAnchors)
      : idleFrames(nextAnchors);
  const hideConnectors = Boolean(flight || pendingMove);

  if (
    !flight &&
    !pendingMove &&
    boxes.length === 0 &&
    nextAnchors.length === 0
  ) {
    return null;
  }

  return (
    <>
      {boxes.map((box, index) => (
        <div
          key={`${box.sourceIds.join('-')}-${index}`}
          className={`basic-guide-spotlight${
            box.shape === 'circle' ? ' basic-guide-spotlight--circle' : ''
          }${idle ? ' is-idle' : ''}`}
          data-basic-guide-spotlight={box.sourceIds.join(',')}
          data-shape={box.shape}
          style={{
            top: box.top,
            left: box.left,
            width: box.width,
            height: box.height,
          }}
        />
      ))}
      {visualCallouts.map((callout) => (
        <div
          key={callout.id}
          className={`basic-guide-callout${flight ? ' is-moving' : ''}`}
          data-basic-guide-callout={callout.key}
          data-callout-kind={callout.kind}
          style={{
            top: callout.top,
            left: callout.left,
            width: callout.width,
            opacity: callout.opacity,
          }}
        >
          <GuideCopy
            className="basic-guide-callout__copy"
            text={callout.text}
          />
        </div>
      ))}
      {!hideConnectors && plan.connectors.length > 0 ? (
        <svg
          className="basic-guide-connectors"
          aria-hidden="true"
          data-basic-guide-connectors=""
          width={viewport.width}
          height={viewport.height}
          viewBox={`0 0 ${viewport.width} ${viewport.height}`}
        >
          {plan.connectors.map((line, index) => (
            <path
              key={`${line.copyKey}-${index}`}
              d={curvePath(line.from, line.to)}
              fill="none"
              stroke="#111"
              strokeWidth="1.5"
            />
          ))}
        </svg>
      ) : null}
    </>
  );
}
