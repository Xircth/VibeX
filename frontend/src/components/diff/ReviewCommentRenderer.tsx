import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { InlineMarkdownComposer } from '@/components/ui/inline-markdown-composer';
import { AstryxMarkdown } from '@/components/NormalizedConversation/AstryxMarkdown';
import { useReview, type ReviewComment } from '@/contexts/ReviewProvider';

interface ReviewCommentRendererProps {
  comment: ReviewComment;
  projectId?: string;
}

export function ReviewCommentRenderer({
  comment,
  projectId,
}: ReviewCommentRendererProps) {
  const { deleteComment, updateComment } = useReview();
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(comment.text);

  const handleDelete = () => {
    deleteComment(comment.id);
  };

  const handleEdit = () => {
    setEditText(comment.text);
    setIsEditing(true);
  };

  const handleSave = () => {
    if (editText.trim()) {
      updateComment(comment.id, editText.trim());
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditText(comment.text);
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <div className="border-y bg-background p-4">
        <InlineMarkdownComposer
          value={editText}
          onChange={setEditText}
          placeholder="Edit comment... (type # to search tags or files)"
          className="w-full bg-background text-foreground text-sm font-mono min-h-[60px]"
          projectId={projectId}
          onSubmit={handleSave}
          autoFocus
        />
        <div className="mt-2 flex gap-2">
          <Button size="xs" onClick={handleSave} disabled={!editText.trim()}>
            Save changes
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={handleCancel}
            className="text-secondary-foreground"
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-y bg-background p-4">
      <AstryxMarkdown value={comment.text} className="text-sm" />
      <div className="mt-2 flex gap-2">
        <Button size="xs" variant="ghost" onClick={handleEdit}>
          Edit
        </Button>
        <Button size="xs" variant="ghost" onClick={handleDelete}>
          Delete
        </Button>
      </div>
    </div>
  );
}
