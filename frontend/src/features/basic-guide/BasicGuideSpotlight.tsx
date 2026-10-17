import { useEffect, useMemo, useRef, useState } from 'react';

import { GuideCopy } from './GuideCopy';
import {
  BASIC_GUIDE_IDLE_MS,
  calloutKeysFor,
  curvePath,
  layoutCallouts,
  mergeOverlapping,
  type MeasuredTarget,
  type MergedSpotlight,
  type Rect,
  type SpotlightTarget,
} from './spotlightGeometry';

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

  if (copyItems.length === 0 && boxes.length === 0) return null;

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
      {plan.callouts.map((callout) => {
        const text =
          copyItems.find((item) => item.key === callout.key)?.text ?? '';
        return (
          <div
            key={callout.key}
            className="basic-guide-callout"
            data-basic-guide-callout={callout.key}
            style={{
              top: callout.top,
              left: callout.left,
              width: callout.width,
            }}
          >
            <GuideCopy className="basic-guide-callout__copy" text={text} />
          </div>
        );
      })}
      {plan.connectors.length > 0 ? (
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
