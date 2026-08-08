import { useCallback, type MouseEvent } from 'react';
import { Markdown, type MarkdownProps } from '@astryxdesign/core/Markdown';
import { ImagePreviewDialog } from '@/components/dialogs/wysiwyg/ImagePreviewDialog';
import { useImageMetadata } from '@/hooks/useImageMetadata';

function VibeMarkdownImage({
  src,
  alt,
  taskAttemptId,
  taskId,
}: {
  src: string;
  alt: string;
  taskAttemptId?: string;
  taskId?: string;
}) {
  const isVibeImage = src.startsWith('.vibe-images/');
  const { data: metadata } = useImageMetadata(taskAttemptId, src, taskId);
  const imageUrl = isVibeImage ? metadata?.proxy_url : src;

  const handleClick = useCallback(
    (event: MouseEvent<HTMLImageElement>) => {
      if (!imageUrl) return;
      event.preventDefault();
      event.stopPropagation();
      ImagePreviewDialog.show({
        imageUrl,
        altText: alt,
        fileName: metadata?.file_name ?? undefined,
        format: metadata?.format ?? undefined,
        sizeBytes: metadata?.size_bytes,
      });
    },
    [alt, imageUrl, metadata]
  );

  if (isVibeImage && !imageUrl) return null;
  return <img src={imageUrl ?? src} alt={alt} onClick={handleClick} />;
}

/**
 * Astryx Markdown with VibeX render adapters:
 * - `.vibe-images/` paths resolve through `useImageMetadata` (proxy_url) and
 *   open `ImagePreviewDialog` on click.
 * KaTeX / Mermaid / TagReferenceChip adapters land in stage 3.
 */
export function AstryxMarkdown({
  children,
  taskAttemptId,
  taskId,
  ...props
}: {
  children: string;
  taskAttemptId?: string;
  taskId?: string;
} & Omit<MarkdownProps, 'children'>) {
  return (
    <Markdown
      display="block"
      components={{
        image: (imageProps) => (
          <VibeMarkdownImage
            {...imageProps}
            taskAttemptId={taskAttemptId}
            taskId={taskId}
          />
        ),
      }}
      {...props}
    >
      {children}
    </Markdown>
  );
}
