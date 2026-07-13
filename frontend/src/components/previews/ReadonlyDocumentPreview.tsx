import { useMemo } from 'react';
import DOMPurify from 'dompurify';
import { useTranslation } from 'react-i18next';

/**
 * Content-only readonly rendering of an extracted document (the built-in
 * docx/doc pipeline behind `read_document_preview`). Shared by the preview
 * panel's `document` kind and the Office preview's not-installed fallback.
 */
export function ReadonlyDocumentPreview({
  content,
  format,
}: {
  content: string;
  format: 'text' | 'html';
}) {
  const { t } = useTranslation(['panels', 'common']);
  const sanitizedHtml = useMemo(
    () => (format === 'html' ? DOMPurify.sanitize(content) : ''),
    [content, format]
  );

  return (
    <div className="h-full overflow-auto bg-muted/10 px-4 py-5">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <div className="rounded-lg border border-border bg-background/90 px-4 py-2 text-xs text-muted-foreground shadow-sm">
          {t('dockPreviewPanel.contentOnlyNotice')}
        </div>
        <div className="rounded-xl border border-border bg-background p-6 shadow-sm">
          {content.trim().length > 0 ? (
            format === 'html' ? (
              <div
                className="doc-preview-html text-foreground"
                dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
              />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-foreground">
                {content}
              </pre>
            )
          ) : (
            <p className="text-sm text-muted-foreground">
              This document does not contain previewable text content.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
