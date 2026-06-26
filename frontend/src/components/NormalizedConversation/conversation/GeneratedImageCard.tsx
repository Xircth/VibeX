import { useMemo } from 'react';
import { Download, ImageIcon, Loader2 } from 'lucide-react';
import type { ImageData } from 'shared/types';
import { ImagePreviewDialog } from '@/components/dialogs/wysiwyg/ImagePreviewDialog';

/**
 * A generated image in the unified ACP timeline. Renders the real image block
 * (data URL or hosted uri) as a clickable preview, surfaces the model's revised
 * prompt, and offers a download — instead of a bare, un-actionable `<img>`. All
 * fields come straight from the `image_generation` content block.
 */
export function GeneratedImageCard({
  image,
  revisedPrompt,
}: {
  image: ImageData | null;
  revisedPrompt: string | null;
}) {
  const src = useMemo(() => {
    if (!image) return null;
    return image.uri ?? `data:${image.mime_type};base64,${image.data}`;
  }, [image]);

  if (!image || !src) {
    return (
      <div className="conv-tool-card conv-tool-card-pending inline-flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        正在生成图片…
      </div>
    );
  }

  const altText = revisedPrompt ?? '生成的图片';
  const fileName = fileNameFor(image);

  return (
    <div className="conv-entry-item overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
        <ImageIcon className="h-3.5 w-3.5" />
        <span className="font-medium text-foreground">生成的图片</span>
        <a
          href={src}
          download={fileName}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
          title="下载图片"
        >
          <Download className="h-3.5 w-3.5" />
          下载
        </a>
      </div>
      <button
        type="button"
        className="block w-full bg-muted/30 p-2 text-left"
        onClick={() =>
          ImagePreviewDialog.show({ imageUrl: src, altText, fileName })
        }
        aria-label="预览生成图片"
        title="预览生成图片"
      >
        <img
          src={src}
          alt={altText}
          className="mx-auto max-h-72 max-w-full rounded object-contain"
        />
      </button>
      {revisedPrompt ? (
        <div className="border-t border-border/60 px-3 py-2 text-xs">
          <div className="mb-0.5 font-medium text-muted-foreground">
            修订提示词
          </div>
          <div className="whitespace-pre-wrap break-words text-foreground/90">
            {revisedPrompt}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function fileNameFor(image: ImageData): string {
  const ext = image.mime_type?.split('/')[1] ?? 'png';
  return `generated-image.${ext}`;
}
