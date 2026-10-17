import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, ImageIcon, Loader2 } from 'lucide-react';
import type { ImageData } from 'shared/types';
import { useOpenImagePreview } from '@/hooks/useOpenImagePreview';
import { useDecodedTimelineImage } from '../TimelineDecodedImage';

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
  const { t } = useTranslation(['conversation', 'common']);
  const openImagePreview = useOpenImagePreview();
  const [open, setOpen] = useState(true);
  const hosted =
    image?.uri && /^https?:\/\//i.test(image.uri) ? image.uri : null;
  const decoded = useDecodedTimelineImage({
    imageKey: image?.uri || image?.data.slice(0, 24) || 'generated',
    enabled: open && !hosted && Boolean(image),
    data: image?.data ?? '',
    mimeType: image?.mime_type || 'image/png',
    uri: image?.uri ?? null,
  });
  const src = open ? (hosted ?? decoded) : null;

  if (!image || (!image.data && !image.uri)) {
    return (
      <div className="conv-tool-card conv-tool-card-pending inline-flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t('generatedImageCard.generating')}
      </div>
    );
  }

  const altText = revisedPrompt ?? t('generatedImageCard.title');
  const fileName = fileNameFor(image);
  const downloadHref = hosted ?? src;

  return (
    <div className="conv-entry-item overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
        <ImageIcon className="h-3.5 w-3.5" />
        <span className="font-medium text-foreground">
          {t('generatedImageCard.title')}
        </span>
        <button
          type="button"
          className="rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t('timelineImage.hide') : t('timelineImage.show')}
        </button>
        {downloadHref ? (
          <a
            href={downloadHref}
            download={fileName}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted hover:text-foreground"
            title={t('generatedImageCard.downloadTooltip')}
          >
            <Download className="h-3.5 w-3.5" />
            {t('generatedImageCard.download')}
          </a>
        ) : null}
      </div>
      {src ? (
        <button
          type="button"
          className="block w-full bg-muted/30 p-2 text-left"
          onClick={() => openImagePreview({ imageUrl: src, altText, fileName })}
          aria-label={t('generatedImageCard.previewLabel')}
          title={t('generatedImageCard.previewLabel')}
        >
          <img
            src={src}
            alt={altText}
            className="mx-auto max-h-72 max-w-full rounded object-contain"
          />
        </button>
      ) : null}
      {revisedPrompt ? (
        <div className="border-t border-border/60 px-3 py-2 text-xs">
          <div className="mb-0.5 font-medium text-muted-foreground">
            {t('generatedImageCard.revisedPrompt')}
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
