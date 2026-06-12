import { useMemo, type CSSProperties, type MouseEvent } from 'react';
import { X } from 'lucide-react';
import { ZoomableImagePreview } from '@/components/previews/ZoomableImagePreview';
import {
  getShikiTokenStyle,
  languageFromPath,
  normalizeShikiLanguage,
  useShikiTokens,
  type ShikiTokenLines,
} from '@/utils/shikiHighlighter';

type FilePreviewPopoverProps = {
  path: string;
  absolutePath: string;
  content: string;
  truncated: boolean;
  previewKind?: 'text' | 'image';
  imageSrc?: string | null;
  selection: { start: number; end: number } | null;
  onSelectLine: (index: number, event: MouseEvent<HTMLButtonElement>) => void;
  onLineMouseDown?: (
    index: number,
    event: MouseEvent<HTMLButtonElement>
  ) => void;
  onLineMouseEnter?: (
    index: number,
    event: MouseEvent<HTMLButtonElement>
  ) => void;
  onLineMouseUp?: (index: number, event: MouseEvent<HTMLButtonElement>) => void;
  onClearSelection: () => void;
  onAddSelection: () => void;
  onClose: () => void;
  selectionHints?: string[];
  style?: CSSProperties;
  isLoading?: boolean;
  error?: string | null;
};

function renderLineTokens(tokens: ShikiTokenLines[number]) {
  if (tokens.length === 0) {
    return '\u00a0';
  }

  return tokens.map((token, tokenIndex) => (
    <span
      className="file-preview-token"
      key={`${token.offset}-${tokenIndex}`}
      style={getShikiTokenStyle(token)}
    >
      {token.content}
    </span>
  ));
}

export function FilePreviewPopover({
  path,
  absolutePath: _absolutePath,
  content,
  truncated,
  previewKind = 'text',
  imageSrc = null,
  selection,
  onSelectLine,
  onLineMouseDown,
  onLineMouseEnter,
  onLineMouseUp,
  onClearSelection,
  onAddSelection,
  onClose,
  selectionHints = [],
  style,
  isLoading = false,
  error = null,
}: FilePreviewPopoverProps) {
  const isImagePreview = previewKind === 'image';
  const lines = useMemo(
    () => (isImagePreview ? [] : content.split('\n')),
    [content, isImagePreview]
  );
  const previewLanguage = useMemo(() => languageFromPath(path), [path]);
  const shikiLanguage = useMemo(
    () => normalizeShikiLanguage(previewLanguage),
    [previewLanguage]
  );
  const tokenLines = useShikiTokens(
    isImagePreview ? '' : content,
    shikiLanguage
  );
  const selectionLabel = selection
    ? `Lines ${selection.start + 1}-${selection.end + 1}`
    : isImagePreview
      ? '\u56fe\u7247\u9884\u89c8'
      : '\u672a\u9009\u62e9\u884c';

  return (
    <div className="file-preview-popover popover-surface" style={style}>
      <div className="file-preview-header">
        <div className="file-preview-title">
          <span className="file-preview-path">{path}</span>
          {truncated && <span className="file-preview-warning">Truncated</span>}
        </div>
        <button
          type="button"
          className="icon-button file-preview-close"
          onClick={onClose}
          aria-label={'\u5173\u95ed\u9884\u89c8'}
          title={'\u5173\u95ed\u9884\u89c8'}
        >
          <X size={14} aria-hidden />
        </button>
      </div>
      {isLoading ? (
        <div className="file-preview-status">
          {'\u6b63\u5728\u52a0\u8f7d\u6587\u4ef6...'}
        </div>
      ) : error ? (
        <div className="file-preview-status file-preview-error">{error}</div>
      ) : isImagePreview ? (
        <div className="file-preview-body file-preview-body--image">
          <div className="file-preview-toolbar">
            <span className="file-preview-selection">{selectionLabel}</span>
          </div>
          {imageSrc ? (
            <div className="file-preview-image">
              <ZoomableImagePreview
                src={imageSrc}
                alt={path}
                className="h-[360px] w-full"
              />
            </div>
          ) : (
            <div className="file-preview-status file-preview-error">
              {'\u56fe\u7247\u9884\u89c8\u4e0d\u53ef\u7528'}
            </div>
          )}
        </div>
      ) : (
        <div className="file-preview-body">
          <div className="file-preview-toolbar">
            <div className="file-preview-selection-group">
              <span className="file-preview-selection">{selectionLabel}</span>
              {selectionHints.length > 0 ? (
                <div
                  className="file-preview-hints"
                  aria-label={'\u9009\u62e9\u63d0\u793a'}
                >
                  {selectionHints.map((hint) => (
                    <span key={hint} className="file-preview-hint">
                      {hint}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="file-preview-actions">
              <button
                type="button"
                className="ghost file-preview-action"
                onClick={onClearSelection}
                disabled={!selection}
              >
                {'\u6e05\u9664\u9009\u62e9'}
              </button>
              <button
                type="button"
                className="primary file-preview-action file-preview-action--add"
                onClick={onAddSelection}
                disabled={!selection}
              >
                {'\u6dfb\u52a0\u5230\u804a\u5929'}
              </button>
            </div>
          </div>
          <div className="file-preview-lines" role="list">
            {lines.map((_, index) => {
              const isSelected =
                selection && index >= selection.start && index <= selection.end;
              const isStart = isSelected && selection?.start === index;
              const isEnd = isSelected && selection?.end === index;

              return (
                <button
                  key={`line-${index}`}
                  type="button"
                  className={`file-preview-line${
                    isSelected ? ' is-selected' : ''
                  }${isStart ? ' is-start' : ''}${isEnd ? ' is-end' : ''}`}
                  onClick={(event) => onSelectLine(index, event)}
                  onMouseDown={(event) => onLineMouseDown?.(index, event)}
                  onMouseEnter={(event) => onLineMouseEnter?.(index, event)}
                  onMouseUp={(event) => onLineMouseUp?.(index, event)}
                >
                  <span className="file-preview-line-number">{index + 1}</span>
                  <span className="file-preview-line-text">
                    {renderLineTokens(tokenLines[index] ?? [])}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
