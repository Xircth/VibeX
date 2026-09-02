import { memo, useEffect, useId, useMemo, useState } from 'react';
import { sanitizeMermaidSvg } from '@/lib/conversation-rendering/mermaidSvg';

type MermaidDiagramProps = {
  value: string;
};

type RenderState =
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
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

// mermaid.initialize sets global singleton config; only re-run it when the theme
// actually changes rather than on every diagram value update.
let lastMermaidTheme: 'default' | 'dark' | null = null;

async function loadMermaid(theme: 'default' | 'dark') {
  const { default: mermaid } = await import('mermaid');
  if (lastMermaidTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // Inline SVG can paint foreignObject HTML labels; the data-URL <img>
      // path could not. Keep htmlLabels on so node text stays complete.
      htmlLabels: true,
      theme,
      fontFamily:
        'Noto Sans SC Variable, Source Han Sans SC, Source Han Sans CN, Noto Sans CJK SC, Noto Sans SC, 思源黑体, sans-serif',
    });
    lastMermaidTheme = theme;
  }
  return mermaid;
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
        const mermaid = await loadMermaid(theme);
        const { svg } = await mermaid.render(diagramId, value);
        const sanitized = sanitizeMermaidSvg(svg);
        if (!sanitized) {
          throw new Error(
            '\u56fe\u8868 SVG \u65e0\u6cd5\u5b89\u5168\u6e32\u67d3'
          );
        }

        if (!cancelled) {
          setRenderState({ status: 'ready', svg: sanitized });
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
        <div
          className="conv-md-mermaid-svg"
          role="img"
          aria-label={'Mermaid \u56fe\u8868'}
          dangerouslySetInnerHTML={{ __html: renderState.svg }}
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
