interface ReviewCommentsPreviewProps {
  reviewMarkdown: string | null;
}

export function ReviewCommentsPreview({
  reviewMarkdown,
}: ReviewCommentsPreviewProps) {
  if (!reviewMarkdown) return null;

  return (
    <div className="mb-4">
      <div className="text-sm whitespace-pre-wrap break-words rounded-md border bg-muted p-3">
        {reviewMarkdown}
      </div>
    </div>
  );
}
