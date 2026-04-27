import { useCallback, useEffect, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { tagsApi } from '@/lib/api';
import { TagEditDialog } from '@/components/dialogs/tasks/TagEditDialog';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import type { Tag } from 'shared/types';

export function TagManager() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTags = useCallback(async () => {
    setLoading(true);
    try {
      const data = await tagsApi.list();
      setTags(data);
    } catch (error) {
      console.error('Failed to fetch tags:', error);
      toast.error('Failed to load tags');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTags();
  }, [fetchTags]);

  const handleOpenDialog = useCallback(
    async (tag?: Tag) => {
      try {
        const result = await TagEditDialog.show({
          tag: tag ?? null,
        });

        if (result === 'saved') {
          await fetchTags();
        }
      } catch {
        // Modal cancelled.
      }
    },
    [fetchTags]
  );

  const handleDelete = useCallback(
    async (tag: Tag) => {
      const result = await ConfirmDialog.show({
        title: `Delete tag #${tag.tag_name}?`,
        message: 'This action cannot be undone.',
        confirmText: 'Delete',
        cancelText: 'Cancel',
        variant: 'destructive',
      });

      if (result !== 'confirmed') {
        return;
      }

      try {
        await tagsApi.delete(tag.id);
        await fetchTags();
        toast.success('Tag deleted');
      } catch (error) {
        console.error('Failed to delete tag:', error);
        toast.error('Failed to delete tag');
      }
    },
    [fetchTags]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">标签</h3>
        <Button variant="outline" size="sm" onClick={() => handleOpenDialog()}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          新建标签
        </Button>
      </div>

      {tags.length === 0 ? (
        <div className="py-6 text-center text-xs text-muted-foreground">
          暂无已保存的标签。创建可复用片段后，可在任务中用 `#tag_name` 插入。
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div className="max-h-[400px] overflow-auto">
            <table className="w-full">
              <thead className="sticky top-0 border-b bg-muted/50">
                <tr>
                  <th className="p-2 text-left text-sm font-medium">名称</th>
                  <th className="p-2 text-left text-sm font-medium">内容</th>
                  <th className="p-2 text-right text-sm font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {tags.map((tag) => (
                  <tr
                    key={tag.id}
                    className="border-b transition-colors hover:bg-muted/30"
                  >
                    <td className="p-2 text-sm font-medium">#{tag.tag_name}</td>
                    <td className="p-2 text-sm">
                      <div
                        className="max-w-[400px] truncate"
                        title={tag.content || ''}
                      >
                        {tag.content || (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </div>
                    </td>
                    <td className="p-2">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="edit"
                          onClick={() => handleOpenDialog(tag)}
                          title="Edit tag"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="delete"
                          onClick={() => handleDelete(tag)}
                          title="Delete tag"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
