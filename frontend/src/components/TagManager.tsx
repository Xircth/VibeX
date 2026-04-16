import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2, Loader2 } from 'lucide-react';
import { tagsApi } from '@/lib/api';
import { TagEditDialog } from '@/components/dialogs/tasks/TagEditDialog';
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
    } catch (err) {
      console.error('Failed to fetch tags:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTags();
  }, [fetchTags]);

  const handleOpenDialog = useCallback(
    async (tag?: Tag) => {
      try {
        const result = await TagEditDialog.show({
          tag: tag || null,
        });

        if (result === 'saved') {
          await fetchTags();
        }
      } catch {
        // User cancelled - do nothing
      }
    },
    [fetchTags]
  );

  const handleDelete = useCallback(
    async (tag: Tag) => {
      if (!confirm(`您确定要删除提示词 ${tag.tag_name} 吗？`)) {
        return;
      }

      try {
        await tagsApi.delete(tag.id);
        await fetchTags();
      } catch (err) {
        console.error('Failed to delete tag:', err);
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
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-lg font-semibold">固定提示词</h3>
        <Button variant="outline" onClick={() => handleOpenDialog()}>
          <Plus className="mr-2 h-4 w-4" />
          新增提示词
        </Button>
      </div>

      {tags.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          还没有固定提示词。为常见任务描述创建可重用的文本片段，在任何任务中使用{' '}
          #tag_name 插入。
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <div className="max-h-[400px] overflow-auto">
            <table className="w-full">
              <thead className="border-b bg-muted/50 sticky top-0">
                <tr>
                  <th className="text-left p-2 text-sm font-medium">名称</th>
                  <th className="text-left p-2 text-sm font-medium">内容</th>
                  <th className="text-right p-2 text-sm font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {tags.map((tag) => (
                  <tr
                    key={tag.id}
                    className="border-b hover:bg-muted/30 transition-colors"
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
                          title="编辑提示词"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="delete"
                          onClick={() => handleDelete(tag)}
                          title="删除提示词"
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
