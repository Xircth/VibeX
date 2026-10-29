import { useRef, useState } from 'react';
import { MiniMap } from '@xyflow/react';

export function DraggableMiniMap() {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{
    x: number;
    y: number;
    ox: number;
    oy: number;
  } | null>(null);
  return (
    <div
      className="absolute bottom-16 right-3 z-10"
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
    >
      <div
        className="mb-1 flex h-5 cursor-grab items-center justify-center rounded-md bg-card/90 text-[9px] text-muted-foreground active:cursor-grabbing"
        onPointerDown={(event) => {
          event.preventDefault();
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            ox: offset.x,
            oy: offset.y,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          setOffset({
            x: drag.current.ox + event.clientX - drag.current.x,
            y: drag.current.oy + event.clientY - drag.current.y,
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
      >
        ∷
      </div>
      <MiniMap
        pannable
        zoomable
        className="!relative !bottom-auto !right-auto !m-0 !border !bg-card"
      />
    </div>
  );
}
