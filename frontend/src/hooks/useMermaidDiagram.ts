import { useEffect, useId, useMemo, useState } from 'react';
import { renderMermaidDiagram } from '@/lib/mermaid/mermaidRuntime';
import { createMermaidDiagramId } from '@/lib/mermaid/utils';
import { useMermaidTheme } from '@/hooks/useMermaidTheme';

export type MermaidDiagramState =
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
  | { status: 'error'; message: string };

export function useMermaidDiagram(source: string): MermaidDiagramState {
  const reactId = useId();
  const theme = useMermaidTheme();
  const diagramId = useMemo(
    () => createMermaidDiagramId(reactId, source),
    [reactId, source]
  );
  const [state, setState] = useState<MermaidDiagramState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      setState((current) =>
        current.status === 'ready' ? current : { status: 'loading' }
      );

      try {
        const { svg } = await renderMermaidDiagram(diagramId, source, theme);
        if (!cancelled) {
          setState({ status: 'ready', svg });
        }
      } catch (error) {
        if (!cancelled) {
          setState({
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
  }, [diagramId, source, theme]);

  return state;
}
