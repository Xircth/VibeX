import { useMemo } from 'react';
import { DiffView, DiffModeEnum } from '@git-diff-view/react';
import { generateDiffFile } from '@git-diff-view/file';
/* diff-style-overrides.css and edit-diff-overrides.css imported by parent FileChangeRenderer */
import { cn } from '@/lib/utils';

type Props = {
  content: string;
  lang: string | null;
  theme?: 'light' | 'dark';
  originalContent?: string | null;
  diffMode?: 'unified' | 'split';
  emptyMessage?: string;
  className?: string;
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
}: Props) {
  // Uses the syntax highlighter from @git-diff-view/react without any diff-related features.
  // This allows uniform styling with EditDiffRenderer.
  const baseContent = originalContent ?? '';
  const isComparisonMode = originalContent !== undefined;

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

  return diffFile ? (
    <div className={cn('overflow-hidden', className)}>
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
}

export default FileContentView;
