import { memo, useLayoutEffect, useRef, useState } from 'react';
import { ZoomableViewport } from '@/components/ui/zoomable-viewport';
import type { ViewportSize } from '@/hooks/useZoomableViewport';

type MermaidDiagramViewerProps = {
  svg: string;
};

function measureSvgSize(svg: SVGSVGElement): ViewportSize {
  const viewBox = svg.viewBox?.baseVal;
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
    return { width: viewBox.width, height: viewBox.height };
  }

  try {
    const bbox = svg.getBBox();
    if (bbox.width > 0 && bbox.height > 0) {
      return { width: bbox.width, height: bbox.height };
    }
  } catch {
    // getBBox can throw before the SVG is fully laid out.
  }

  const rect = svg.getBoundingClientRect();
  return {
    width: rect.width || 640,
    height: rect.height || 360,
  };
}

export const MermaidDiagramViewer = memo(function MermaidDiagramViewer({
  svg,
}: MermaidDiagramViewerProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [contentSize, setContentSize] = useState<ViewportSize>({
    width: 0,
    height: 0,
  });

  useLayoutEffect(() => {
    const svgElement = contentRef.current?.querySelector('svg');
    if (!svgElement) {
      setContentSize({ width: 0, height: 0 });
      return undefined;
    }

    const updateSize = () => {
      setContentSize(measureSvgSize(svgElement));
    };

    updateSize();

    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver(updateSize);
    observer.observe(svgElement);
    return () => observer.disconnect();
  }, [svg]);

  return (
    <ZoomableViewport
      contentSize={contentSize}
      options={{ resetKey: svg }}
      ariaLabel={'Mermaid \u56fe\u8868'}
      className="conv-md-mermaid-viewer"
      viewportClassName="conv-md-mermaid-viewport"
      surfaceClassName="conv-md-mermaid-surface"
    >
      <div
        ref={contentRef}
        className="conv-md-mermaid-svg"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </ZoomableViewport>
  );
});
