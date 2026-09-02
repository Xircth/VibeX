import { memo } from 'react';
import { useMermaidDiagram } from '@/hooks/useMermaidDiagram';
import { MermaidDiagramViewer } from './MermaidDiagramViewer';

type MermaidDiagramProps = {
  value: string;
};

export const MermaidDiagram = memo(function MermaidDiagram({
  value,
}: MermaidDiagramProps) {
  const state = useMermaidDiagram(value);

  return (
    <figure className="conv-md-mermaid">
      {state.status === 'loading' ? (
        <div
          className="conv-md-mermaid-status"
          role="status"
          aria-live="polite"
        >
          {'\u6b63\u5728\u6e32\u67d3\u56fe\u8868...'}
        </div>
      ) : null}

      {state.status === 'ready' ? (
        <MermaidDiagramViewer svg={state.svg} />
      ) : null}

      {state.status === 'error' ? (
        <div className="conv-md-mermaid-error" role="alert">
          <div className="conv-md-mermaid-error-title">
            {'\u56fe\u8868\u6e32\u67d3\u5931\u8d25'}
          </div>
          <div className="conv-md-mermaid-error-detail">{state.message}</div>
          <pre className="conv-md-mermaid-source">
            <code>{value}</code>
          </pre>
        </div>
      ) : null}
    </figure>
  );
});
