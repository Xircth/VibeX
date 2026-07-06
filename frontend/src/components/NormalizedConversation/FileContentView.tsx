import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DiffView, DiffModeEnum } from '@git-diff-view/react';
import { generateDiffFile } from '@git-diff-view/file';
import { MessageSquarePlus } from 'lucide-react';
/* diff-style-overrides.css and edit-diff-overrides.css imported by parent FileChangeRenderer */
import { cn } from '@/lib/utils';
import { useComposerSelectionStore } from '@/stores/useComposerSelectionStore';
import { computeLineRange } from '@/utils/codeSelection';

type Props = {
  content: string;
  lang: string | null;
  theme?: 'light' | 'dark';
  originalContent?: string | null;
  diffMode?: 'unified' | 'split';
  emptyMessage?: string;
  className?: string;
  /**
   * Repo-relative path of the file. When set, selecting text in the view shows
   * an "add to chat" action that inserts a `path:start-end` reference into the
   * composer (P2-4). Omit to disable the selection affordance.
   */
  filePath?: string;
};

/**
 * View syntax highlighted file content.
 */
function FileContentView({
  content,
  lang,
  theme,
  originalContent,
  diffMode = 'unified',
  emptyMessage = 'No differences to show.',
  className,
  filePath,
}: Props) {
  // Uses the syntax highlighter from @git-diff-view/react without any diff-related features.
  // This allows uniform styling with EditDiffRenderer.
  const { t } = useTranslation(['conversation', 'common']);
  const baseContent = originalContent ?? '';
  const isComparisonMode = originalContent !== undefined;

  const requestInsert = useComposerSelectionStore((s) => s.requestInsert);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [selectionRange, setSelectionRange] = useState<{
    startLine: number;
    endLine: number;
  } | null>(null);

  const handleSelectionChange = useCallback(() => {
    if (!filePath) return;
    const selection = window.getSelection();
    const text = selection?.toString() ?? '';
    // Only act when the selection lives inside this view.
    const anchor = selection?.anchorNode;
    if (!text.trim() || !anchor || !rootRef.current?.contains(anchor)) {
      setSelectionRange(null);
      return;
    }
    setSelectionRange(computeLineRange(content, text));
  }, [filePath, content]);

  const addSelectionToChat = useCallback(() => {
    if (!filePath || !selectionRange) return;
    requestInsert({ filePath, ...selectionRange });
    setSelectionRange(null);
    window.getSelection()?.removeAllRanges();
  }, [filePath, selectionRange, requestInsert]);

  const diffFile = useMemo(() => {
    try {
      const instance = generateDiffFile(
        '', // old file
        baseContent,
        '', // new file
        content, // new content
        '', // old lang
        lang || 'plaintext' // new lang
      );
      instance.initRaw();
      return instance;
    } catch {
      return null;
    }
  }, [baseContent, content, lang]);

  if (isComparisonMode && baseContent === content) {
    return (
      <div className={cn('px-4 py-3 text-xs text-muted-foreground', className)}>
        {emptyMessage}
      </div>
    );
  }

  const body = diffFile ? (
    <div className={cn('min-h-full overflow-visible', className)}>
      <DiffView
        diffFile={diffFile}
        diffViewWrap={false}
        diffViewTheme={theme}
        diffViewHighlight
        diffViewMode={
          diffMode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified
        }
        diffViewFontSize={12}
      />
    </div>
  ) : (
    <pre
      className={cn(
        'text-xs font-mono overflow-x-auto whitespace-pre',
        className
      )}
    >
      {content}
    </pre>
  );

  if (!filePath) return body;

  return (
    <div
      ref={rootRef}
      className="relative"
      onMouseUp={handleSelectionChange}
      onKeyUp={handleSelectionChange}
    >
      {body}
      {selectionRange ? (
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={addSelectionToChat}
          className="tahoe-popover sticky bottom-2 left-2 z-10 ml-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-foreground shadow"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          {t('fileContentView.addLinesToChat', {
            range:
              selectionRange.endLine !== selectionRange.startLine
                ? `${selectionRange.startLine}–${selectionRange.endLine}`
                : `${selectionRange.startLine}`,
          })}
        </button>
      ) : null}
    </div>
  );
}

export default FileContentView;
