import { useEffect, useState } from 'react';

type Box = { top: number; left: number; width: number; height: number };

function measureTargets(ids: readonly string[]): Box[] {
  const boxes: Box[] = [];
  for (const id of ids) {
    const nodes = document.querySelectorAll<HTMLElement>(
      `[data-basic-guide="${id}"]`
    );
    nodes.forEach((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      boxes.push({
        top: rect.top - 4,
        left: rect.left - 4,
        width: rect.width + 8,
        height: rect.height + 8,
      });
    });
  }
  return boxes;
}

function mergeBoxes(boxes: Box[]): Box[] {
  return boxes;
}

export function BasicGuideSpotlight({
  targetIds,
  panelSelector,
}: {
  targetIds: readonly string[];
  panelSelector: string;
}) {
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (targetIds.length === 0) {
      setBoxes([]);
      setOrigin(null);
      return;
    }

    const update = () => {
      setBoxes(mergeBoxes(measureTargets(targetIds)));
      const panel = document.querySelector<HTMLElement>(panelSelector);
      if (!panel) {
        setOrigin(null);
        return;
      }
      const rect = panel.getBoundingClientRect();
      setOrigin({ x: rect.right, y: rect.top + rect.height / 2 });
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
  }, [panelSelector, targetIds]);

  if (boxes.length === 0) return null;

  return (
    <>
      {boxes.map((box, index) => (
        <div
          key={`${box.left}-${box.top}-${index}`}
          className="basic-guide-spotlight"
          style={{
            top: box.top,
            left: box.left,
            width: box.width,
            height: box.height,
          }}
        />
      ))}
      {origin ? (
        <svg className="basic-guide-connectors" aria-hidden="true">
          {boxes.map((box, index) => {
            const x2 = box.left;
            const y2 = box.top + box.height / 2;
            const midX = origin.x + Math.max(24, (x2 - origin.x) / 2);
            return (
              <path
                key={`line-${index}`}
                d={`M ${origin.x} ${origin.y} C ${midX} ${origin.y}, ${midX} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="hsl(var(--primary) / 0.7)"
                strokeWidth="1.5"
              />
            );
          })}
        </svg>
      ) : null}
    </>
  );
}
