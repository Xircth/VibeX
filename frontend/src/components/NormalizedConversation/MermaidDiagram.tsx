import { memo, useEffect, useId, useMemo, useState } from 'react';

type MermaidDiagramProps = {
  value: string;
};

type RenderState =
  | { status: 'loading' }
  | { status: 'ready'; src: string }
  | { status: 'error'; message: string };

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function sanitizeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '') || 'diagram';
}

function svgToDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function getMermaidTheme(): 'default' | 'dark' {
  if (typeof document === 'undefined') {
    return 'default';
  }

  return document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'default';
}

function useMermaidTheme(): 'default' | 'dark' {
  const [theme, setTheme] = useState(getMermaidTheme);

  useEffect(() => {
    if (
      typeof document === 'undefined' ||
      typeof MutationObserver === 'undefined'
    ) {
      return undefined;
    }

    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setTheme(getMermaidTheme());
    });

    observer.observe(root, {
      attributes: true,
      attributeFilter: ['class'],
    });

    return () => observer.disconnect();
  }, []);

  return theme;
}

export const MermaidDiagram = memo(function MermaidDiagram({
  value,
}: MermaidDiagramProps) {
  const reactId = useId();
  const theme = useMermaidTheme();
  const diagramId = useMemo(
    () => `mermaid-${sanitizeDomId(reactId)}-${hashString(value)}`,
    [reactId, value]
  );
  const [renderState, setRenderState] = useState<RenderState>({
    status: 'loading',
  });

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      setRenderState((current) =>
        current.status === 'ready' ? current : { status: 'loading' }
      );

      try {
        const { default: mermaid } = await import('mermaid');
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme,
          fontFamily: 'IBM Plex Sans, Noto Emoji, sans-serif',
        });

        const { svg } = await mermaid.render(diagramId, value);

        if (!cancelled) {
          setRenderState({ status: 'ready', src: svgToDataUrl(svg) });
        }
      } catch (error) {
        if (!cancelled) {
          setRenderState({
            status: 'error',
            message:
              error instanceof Error && error.message
                ? error.message
                : '\u672a\u77e5\u7684 Mermaid \u6e32\u67d3\u9519\u8bef',
          });
        }
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [diagramId, theme, value]);

  return (
    <figure className="conv-md-mermaid">
      {renderState.status === 'loading' ? (
        <div
          className="conv-md-mermaid-status"
          role="status"
          aria-live="polite"
        >
          {'\u6b63\u5728\u6e32\u67d3\u56fe\u8868...'}
        </div>
      ) : null}

      {renderState.status === 'ready' ? (
        <img
          className="conv-md-mermaid-image"
          src={renderState.src}
          alt={'Mermaid \u56fe\u8868'}
          loading="lazy"
        />
      ) : null}

      {renderState.status === 'error' ? (
        <div className="conv-md-mermaid-error" role="alert">
          <div className="conv-md-mermaid-error-title">
            {'\u56fe\u8868\u6e32\u67d3\u5931\u8d25'}
          </div>
          <div className="conv-md-mermaid-error-detail">
            {renderState.message}
          </div>
          <pre className="conv-md-mermaid-source">
            <code>{value}</code>
          </pre>
        </div>
      ) : null}
    </figure>
  );
});
