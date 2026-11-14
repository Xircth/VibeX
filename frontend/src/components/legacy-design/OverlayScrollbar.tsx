import { useEffect, useRef } from 'react';
import { attachOverlayScrollbars } from './scrollbarOverlay';

export function OverlayScrollbar() {
  const verticalRef = useRef<HTMLDivElement>(null);
  const horizontalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const vertical = verticalRef.current;
    const horizontal = horizontalRef.current;
    if (!vertical || !horizontal) return undefined;
    return attachOverlayScrollbars(document, { vertical, horizontal });
  }, []);

  return (
    <>
      <div
        ref={verticalRef}
        className="overlay-scrollbar-thumb overlay-scrollbar-thumb--y"
        aria-hidden="true"
      />
      <div
        ref={horizontalRef}
        className="overlay-scrollbar-thumb overlay-scrollbar-thumb--x"
        aria-hidden="true"
      />
    </>
  );
}
