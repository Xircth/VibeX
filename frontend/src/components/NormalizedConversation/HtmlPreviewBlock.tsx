import { memo, useMemo, useState } from 'react';
import { CodeBlock } from './CodeBlock';

const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups';

function isCompleteHtmlDocument(code: string): boolean {
  return /^\s*(<!DOCTYPE\s+html|<html[\s>])/i.test(code);
}

export function wrapHtmlPreviewDocument(code: string): string {
  const body = code.trim();
  if (!body) {
    return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>';
  }
  if (isCompleteHtmlDocument(body)) {
    return body;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:12px;font-family:system-ui,sans-serif;}</style></head><body>${body}</body></html>`;
}

export function isHtmlPreviewLanguage(language?: string | null): boolean {
  const normalized = language?.trim().toLowerCase();
  return normalized === 'html' || normalized === 'htm';
}

export const HtmlPreviewBlock = memo(function HtmlPreviewBlock({
  code,
  isStreaming,
}: {
  code: string;
  isStreaming?: boolean;
}) {
  const [showSource, setShowSource] = useState(false);
  const srcDoc = useMemo(() => wrapHtmlPreviewDocument(code), [code]);

  if (isStreaming && !code.trim()) {
    return (
      <div className="conv-md-html-preview-status" role="status">
        正在渲染 HTML 预览...
      </div>
    );
  }

  return (
    <figure className="conv-md-html-preview">
      <div className="conv-md-html-preview-bar">
        <span className="conv-md-html-preview-label">HTML 预览</span>
        <button
          type="button"
          className="conv-md-html-preview-toggle"
          onClick={() => setShowSource((current) => !current)}
        >
          {showSource ? '预览' : '源码'}
        </button>
      </div>
      {showSource ? (
        <CodeBlock
          className="language-html"
          value={code}
          isStreaming={isStreaming}
        />
      ) : (
        <iframe
          title="HTML 预览"
          sandbox={PREVIEW_SANDBOX}
          srcDoc={srcDoc}
          className="conv-md-html-preview-frame"
        />
      )}
    </figure>
  );
});
