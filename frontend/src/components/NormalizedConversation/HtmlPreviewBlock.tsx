import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Copy, ExternalLink, Maximize2, Minimize2 } from 'lucide-react';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import { fileTreeApi } from '@/lib/api';
import { buildGeneratedHtmlPreviewPath } from '@/lib/conversation-rendering/splitMessageHtmlBlocks';
import { writeClipboardViaBridge } from '@/vscode/bridge';

const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups';
const DEFAULT_PREVIEW_HEIGHT_PX = 380;
const MIN_PREVIEW_HEIGHT_PX = 240;
const MAX_COLLAPSED_PREVIEW_HEIGHT_PX = 460;

function isCompleteHtmlDocument(code: string): boolean {
  return /^\s*(<!DOCTYPE\s+html|<html[\s>])/i.test(code);
}

function buildPreviewBridgeScript(previewId?: string): string {
  if (!previewId) return '';
  const safeId = JSON.stringify(previewId);
  return `<script>(function(){var id=${safeId};function report(){try{var doc=document.documentElement;var body=document.body;var h=Math.max(doc?doc.scrollHeight:0,doc?doc.offsetHeight:0,body?body.scrollHeight:0,body?body.offsetHeight:0);if(h>0&&window.parent){window.parent.postMessage({type:'vibex-html-preview-height',previewId:id,height:h},'*');}}catch(e){}}window.addEventListener('load',report);window.addEventListener('resize',report);window.addEventListener('contextmenu',function(ev){try{ev.preventDefault();if(window.parent){window.parent.postMessage({type:'vibex-html-preview-contextmenu',previewId:id,clientX:ev.clientX,clientY:ev.clientY},'*');}}catch(e){}});window.addEventListener('mousedown',function(ev){if(ev.button===0&&window.parent){try{window.parent.postMessage({type:'vibex-html-preview-dismiss-menu',previewId:id},'*');}catch(e){}}});if(typeof ResizeObserver!=='undefined'){try{new ResizeObserver(report).observe(document.documentElement);}catch(e){}}setTimeout(report,60);setTimeout(report,280);})();</script>`;
}

export function wrapHtmlPreviewDocument(
  code: string,
  previewId?: string
): string {
  const body = code.trim();
  const reporter = buildPreviewBridgeScript(previewId);
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

type ContextMenuPosition = {
  x: number;
  y: number;
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
  const containerRef = useRef<HTMLElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const [loadedFileCode, setLoadedFileCode] = useState<string | null>(null);
  const [fileLoadError, setFileLoadError] = useState(false);
  const persistedInlineKeyRef = useRef<string | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(
    null
  );

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
  }, [
    suppliedCode,
    suppliedDisplayPath,
    suppliedFilePath,
    suppliedTitle,
    workspacePath,
  ]);

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
  }, [suppliedCode, suppliedFilePath]);

  const effectiveCode = suppliedCode ?? loadedFileCode ?? '';

  const openContextMenuAt = useCallback((localX: number, localY: number) => {
    const host = containerRef.current;
    if (!host) {
      setContextMenu({ x: Math.max(8, localX), y: Math.max(8, localY) });
      return;
    }
    const rect = host.getBoundingClientRect();
    const menuWidth = 168;
    const menuHeight = 116;
    const maxX = Math.max(8, (rect.width || 320) - menuWidth - 8);
    const maxY = Math.max(8, (rect.height || 240) - menuHeight - 8);
    setContextMenu({
      x: Math.min(Math.max(8, localX), maxX),
      y: Math.min(Math.max(8, localY), maxY),
    });
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        previewId?: string;
        height?: unknown;
        clientX?: unknown;
        clientY?: unknown;
      } | null;
      if (!data || data.previewId !== previewId) {
        return;
      }
      if (
        data.type === 'vibex-html-preview-height' &&
        typeof data.height === 'number' &&
        Number.isFinite(data.height)
      ) {
        const clamped = Math.max(MIN_PREVIEW_HEIGHT_PX, Math.ceil(data.height));
        setMeasuredHeight((prev) => (prev === clamped ? prev : clamped));
        return;
      }
      if (data.type === 'vibex-html-preview-contextmenu') {
        const cx = typeof data.clientX === 'number' ? data.clientX : 24;
        const cy = typeof data.clientY === 'number' ? data.clientY : 24;
        openContextMenuAt(cx, cy);
        return;
      }
      if (data.type === 'vibex-html-preview-dismiss-menu') {
        setContextMenu(null);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [openContextMenuAt, previewId]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = () => setContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
      }
    };
    window.addEventListener('mousedown', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  const ensureInlineFilePersisted = useCallback(async () => {
    const targetPath = resolvedMeta.filePath;
    if (!targetPath) return '';
    if (suppliedCode !== undefined && !suppliedFilePath) {
      const persistenceKey = `${targetPath}\0${suppliedCode}`;
      if (persistedInlineKeyRef.current !== persistenceKey) {
        try {
          await fileTreeApi.saveFile(
            targetPath,
            wrapHtmlPreviewDocument(suppliedCode)
          );
          persistedInlineKeyRef.current = persistenceKey;
        } catch {
          // Proceed even if background persistence is unsupported in test/mocked environments.
        }
      }
    }
    return targetPath;
  }, [resolvedMeta.filePath, suppliedCode, suppliedFilePath]);

  const handleOpenInTab = useCallback(async () => {
    setContextMenu(null);
    const targetPath = await ensureInlineFilePersisted();
    if (!targetPath) return;

    panelActions?.openFilePreview(targetPath, {
      displayPath: resolvedMeta.displayPath,
      title: resolvedMeta.displayPath,
    });
  }, [ensureInlineFilePersisted, panelActions, resolvedMeta.displayPath]);

  const handleCopyAbsolutePath = useCallback(async () => {
    setContextMenu(null);
    const targetPath = await ensureInlineFilePersisted();
    if (!targetPath) return;
    await writeClipboardViaBridge(targetPath);
  }, [ensureInlineFilePersisted]);

  const handleToggleExpand = useCallback(() => {
    setContextMenu(null);
    setExpanded((current) => !current);
  }, []);

  const handleContainerContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const host = containerRef.current;
      if (!host) {
        setContextMenu({ x: 16, y: 16 });
        return;
      }
      const rect = host.getBoundingClientRect();
      openContextMenuAt(event.clientX - rect.left, event.clientY - rect.top);
    },
    [openContextMenuAt]
  );

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
        <div className="conv-md-html-preview-status" role="status">
          正在渲染 HTML 预览...
        </div>
      </div>
    );
  }

  if (fileLoadError && !effectiveCode.trim()) {
    return null;
  }

  const frameHeight = expanded
    ? Math.max(
        measuredHeight ?? DEFAULT_PREVIEW_HEIGHT_PX,
        DEFAULT_PREVIEW_HEIGHT_PX
      )
    : Math.min(
        measuredHeight ?? DEFAULT_PREVIEW_HEIGHT_PX,
        MAX_COLLAPSED_PREVIEW_HEIGHT_PX
      );

  return (
    <figure
      ref={containerRef}
      className="conv-md-html-preview conv-md-html-preview-standalone"
      data-testid="standalone-html-preview"
      data-file-path={resolvedMeta.filePath}
      data-expanded={expanded ? 'true' : 'false'}
      onContextMenu={handleContainerContextMenu}
    >
      <iframe
        ref={iframeRef}
        title="HTML 预览"
        sandbox={PREVIEW_SANDBOX}
        srcDoc={srcDoc}
        style={{ height: `${frameHeight}px` }}
        className="conv-md-html-preview-frame"
      />

      {contextMenu ? (
        <div
          role="menu"
          aria-label="HTML 预览操作菜单"
          data-testid="html-preview-context-menu"
          className="conv-md-html-preview-context-menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            data-testid="html-preview-open-tab"
            className="conv-md-html-preview-context-item"
            onClick={() => void handleOpenInTab()}
          >
            <ExternalLink
              className="conv-md-html-preview-context-icon"
              aria-hidden="true"
            />
            <span>在标签页打开</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="html-preview-copy-path"
            className="conv-md-html-preview-context-item"
            onClick={() => void handleCopyAbsolutePath()}
          >
            <Copy
              className="conv-md-html-preview-context-icon"
              aria-hidden="true"
            />
            <span>复制绝对路径</span>
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="html-preview-toggle-expand"
            className="conv-md-html-preview-context-item"
            onClick={handleToggleExpand}
          >
            {expanded ? (
              <>
                <Minimize2
                  className="conv-md-html-preview-context-icon"
                  aria-hidden="true"
                />
                <span>收起</span>
              </>
            ) : (
              <>
                <Maximize2
                  className="conv-md-html-preview-context-icon"
                  aria-hidden="true"
                />
                <span>展开</span>
              </>
            )}
          </button>
        </div>
      ) : null}
    </figure>
  );
});
