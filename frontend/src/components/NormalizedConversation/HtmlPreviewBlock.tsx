import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';
import { ExternalLink, Globe, Maximize2, Minimize2, RotateCw } from 'lucide-react';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { fileTreeApi } from '@/lib/api';
import { buildGeneratedHtmlPreviewPath } from '@/lib/conversation-rendering/splitMessageHtmlBlocks';

const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups';
const DEFAULT_PREVIEW_HEIGHT_PX = 380;
const MIN_PREVIEW_HEIGHT_PX = 240;
const MAX_COLLAPSED_PREVIEW_HEIGHT_PX = 460;

function isCompleteHtmlDocument(code: string): boolean {
  return /^\s*(<!DOCTYPE\s+html|<html[\s>])/i.test(code);
}

function buildHeightReporterScript(previewId?: string): string {
  if (!previewId) return '';
  const safeId = JSON.stringify(previewId);
  return `<script>(function(){var id=${safeId};function report(){try{var doc=document.documentElement;var body=document.body;var h=Math.max(doc?doc.scrollHeight:0,doc?doc.offsetHeight:0,body?body.scrollHeight:0,body?body.offsetHeight:0);if(h>0&&window.parent){window.parent.postMessage({type:'vibex-html-preview-height',previewId:id,height:h},'*');}}catch(e){}}window.addEventListener('load',report);window.addEventListener('resize',report);if(typeof ResizeObserver!=='undefined'){try{new ResizeObserver(report).observe(document.documentElement);}catch(e){}}setTimeout(report,60);setTimeout(report,280);})();</script>`;
}

export function wrapHtmlPreviewDocument(
  code: string,
  previewId?: string
): string {
  const body = code.trim();
  const reporter = buildHeightReporterScript(previewId);
  if (!body) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${reporter}</body></html>`;
  }
  if (isCompleteHtmlDocument(body)) {
    if (!reporter) return body;
    if (/<\/body>/i.test(body)) {
      return body.replace(/<\/body>/i, `${reporter}</body>`);
    }
    return `${body}${reporter}`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:12px;font-family:system-ui,-apple-system,sans-serif;}</style></head><body>${body}${reporter}</body></html>`;
}

export function isHtmlPreviewLanguage(language?: string | null): boolean {
  const normalized = language?.trim().toLowerCase();
  return normalized === 'html' || normalized === 'htm';
}

export type HtmlPreviewBlockProps = {
  code?: string;
  filePath?: string;
  displayPath?: string;
  title?: string;
  workspacePath?: string | null;
  isStreaming?: boolean;
  standalone?: boolean;
};

export const HtmlPreviewBlock = memo(function HtmlPreviewBlock({
  code: suppliedCode,
  filePath: suppliedFilePath,
  displayPath: suppliedDisplayPath,
  title: suppliedTitle,
  workspacePath,
  isStreaming,
}: HtmlPreviewBlockProps) {
  const previewId = useId();
  const panelActions = useOptionalPanelActionsContext();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const [loadedFileCode, setLoadedFileCode] = useState<string | null>(null);
  const [fileLoadError, setFileLoadError] = useState(false);
  const [persistedInlineFile, setPersistedInlineFile] = useState(false);

  const resolvedMeta = useMemo(() => {
    if (suppliedFilePath) {
      const display = suppliedDisplayPath ?? suppliedFilePath;
      const fileName = display.split(/[\\/]/).pop() ?? display;
      return {
        filePath: suppliedFilePath,
        displayPath: display,
        title: suppliedTitle ?? fileName,
      };
    }
    return buildGeneratedHtmlPreviewPath(suppliedCode ?? '', workspacePath);
  }, [suppliedCode, suppliedDisplayPath, suppliedFilePath, suppliedTitle, workspacePath]);

  useEffect(() => {
    if (suppliedCode !== undefined || !suppliedFilePath) {
      setLoadedFileCode(null);
      setFileLoadError(false);
      return;
    }
    let cancelled = false;
    setFileLoadError(false);
    void fileTreeApi
      .readFile(suppliedFilePath)
      .then((content) => {
        if (!cancelled) {
          setLoadedFileCode(content);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFileLoadError(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [suppliedCode, suppliedFilePath, reloadNonce]);

  const effectiveCode = suppliedCode ?? loadedFileCode ?? '';

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        previewId?: string;
        height?: unknown;
      } | null;
      if (
        !data ||
        data.type !== 'vibex-html-preview-height' ||
        data.previewId !== previewId ||
        typeof data.height !== 'number' ||
        !Number.isFinite(data.height)
      ) {
        return;
      }
      const clamped = Math.max(MIN_PREVIEW_HEIGHT_PX, Math.ceil(data.height));
      setMeasuredHeight((prev) => (prev === clamped ? prev : clamped));
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [previewId]);

  const handleOpenInTab = useCallback(async () => {
    const targetPath = resolvedMeta.filePath;
    if (!targetPath) return;

    if (suppliedCode !== undefined && !suppliedFilePath && !persistedInlineFile) {
      try {
        await fileTreeApi.saveFile(
          targetPath,
          wrapHtmlPreviewDocument(suppliedCode)
        );
        setPersistedInlineFile(true);
      } catch {
        // Proceed to openFilePreview even if background persistence is unsupported in test/mocked environments.
      }
    }

    panelActions?.openFilePreview(targetPath, {
      displayPath: resolvedMeta.displayPath,
      title: resolvedMeta.displayPath,
    });
  }, [
    panelActions,
    persistedInlineFile,
    resolvedMeta.displayPath,
    resolvedMeta.filePath,
    suppliedCode,
    suppliedFilePath,
  ]);

  const srcDoc = useMemo(
    () => wrapHtmlPreviewDocument(effectiveCode, previewId),
    [effectiveCode, previewId]
  );

  if (isStreaming && !effectiveCode.trim()) {
    return (
      <div
        className="conv-md-html-preview conv-md-html-preview-standalone"
        data-testid="standalone-html-preview"
      >
        <div className="conv-md-html-preview-bar">
          <span className="conv-md-html-preview-label">
            <Globe className="conv-md-html-preview-icon" aria-hidden="true" />
            <span>{resolvedMeta.displayPath}</span>
          </span>
        </div>
        <div className="conv-md-html-preview-status" role="status">
          正在渲染 HTML 预览...
        </div>
      </div>
    );
  }

  if (fileLoadError && !effectiveCode.trim()) {
    return null;
  }

  const canExpand =
    measuredHeight !== null && measuredHeight > MAX_COLLAPSED_PREVIEW_HEIGHT_PX;
  const frameHeight = expanded
    ? (measuredHeight ?? DEFAULT_PREVIEW_HEIGHT_PX)
    : Math.min(
        measuredHeight ?? DEFAULT_PREVIEW_HEIGHT_PX,
        MAX_COLLAPSED_PREVIEW_HEIGHT_PX
      );

  return (
    <figure
      className="conv-md-html-preview conv-md-html-preview-standalone"
      data-testid="standalone-html-preview"
    >
      <div className="conv-md-html-preview-bar">
        <button
          type="button"
          className="conv-md-html-preview-path-btn"
          data-testid="html-preview-open-tab"
          onClick={() => void handleOpenInTab()}
          title={`在标签页中打开 ${resolvedMeta.filePath}`}
        >
          <Globe className="conv-md-html-preview-icon" aria-hidden="true" />
          <span className="conv-md-html-preview-path-text">
            {resolvedMeta.displayPath}
          </span>
          <ExternalLink
            className="conv-md-html-preview-external-icon"
            aria-hidden="true"
          />
        </button>

        <div className="conv-md-html-preview-actions">
          {canExpand ? (
            <button
              type="button"
              className="conv-md-html-preview-action-btn"
              onClick={() => setExpanded((current) => !current)}
              title={expanded ? '收起预览高度' : '展开完整高度'}
            >
              {expanded ? (
                <>
                  <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>收起</span>
                </>
              ) : (
                <>
                  <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>展开全部</span>
                </>
              )}
            </button>
          ) : null}
          <button
            type="button"
            className="conv-md-html-preview-action-btn"
            onClick={() => setReloadNonce((n) => n + 1)}
            title="重新加载预览"
            aria-label="重新加载预览"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <iframe
        key={reloadNonce}
        title="HTML 预览"
        sandbox={PREVIEW_SANDBOX}
        srcDoc={srcDoc}
        style={{ height: `${frameHeight}px` }}
        className="conv-md-html-preview-frame"
      />
    </figure>
  );
});
