import { memo } from 'react';

interface ImageDiffCardProps {
  path: string;
  status: string;
  oldImageData?: string | null;
  newImageData?: string | null;
  isSelected?: boolean;
}

function getExtension(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
}

function getMimeType(ext: string): string {
  const mimes: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
  };
  return mimes[ext] ?? 'image/png';
}

function toDataUri(data: string, path: string): string {
  const ext = getExtension(path);
  const mime = getMimeType(ext);
  return `data:${mime};base64,${data}`;
}

function ImageLabel({
  label,
  className,
}: {
  label: string;
  className: string;
}) {
  return (
    <span
      className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${className}`}
    >
      {label}
    </span>
  );
}

export const ImageDiffCard = memo(function ImageDiffCard({
  path,
  status,
  oldImageData,
  newImageData,
  isSelected,
}: ImageDiffCardProps) {
  const fileName = path.split('/').pop() ?? path;

  // Determine display mode
  const isAdded = status === 'A';
  const isDeleted = status === 'D';
  const isModified = !isAdded && !isDeleted;

  return (
    <div
      className={`rounded border overflow-hidden ${
        isSelected ? 'border-ring' : 'border-border/50'
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-accent/30 text-xs">
        <span className="font-mono text-muted-foreground truncate">
          {fileName}
        </span>
        {isAdded && (
          <ImageLabel
            label="Added"
            className="bg-green-500/20 text-green-400"
          />
        )}
        {isDeleted && (
          <ImageLabel label="Deleted" className="bg-red-500/20 text-red-400" />
        )}
        {isModified && (
          <ImageLabel
            label="Modified"
            className="bg-yellow-500/20 text-yellow-400"
          />
        )}
      </div>

      {/* Image content */}
      <div className="p-3 bg-background/50">
        {isAdded && newImageData && (
          <div className="flex justify-center">
            <img
              src={toDataUri(newImageData, path)}
              alt={`Added: ${fileName}`}
              className="max-w-full max-h-64 object-contain rounded border border-green-500/30"
            />
          </div>
        )}

        {isDeleted && oldImageData && (
          <div className="flex justify-center">
            <img
              src={toDataUri(oldImageData, path)}
              alt={`Deleted: ${fileName}`}
              className="max-w-full max-h-64 object-contain rounded border border-red-500/30 opacity-60"
            />
          </div>
        )}

        {isModified && (
          <div className="flex items-start gap-4 justify-center">
            {oldImageData && (
              <div className="flex flex-col items-center gap-1">
                <span className="text-[10px] text-red-400 font-medium">
                  Before
                </span>
                <img
                  src={toDataUri(oldImageData, path)}
                  alt={`Before: ${fileName}`}
                  className="max-w-[45%] max-h-48 object-contain rounded border border-red-500/30"
                />
              </div>
            )}
            {newImageData && (
              <div className="flex flex-col items-center gap-1">
                <span className="text-[10px] text-green-400 font-medium">
                  After
                </span>
                <img
                  src={toDataUri(newImageData, path)}
                  alt={`After: ${fileName}`}
                  className="max-w-[45%] max-h-48 object-contain rounded border border-green-500/30"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
