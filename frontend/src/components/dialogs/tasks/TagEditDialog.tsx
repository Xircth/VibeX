import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import { tagsApi } from '@/lib/api';
import type { Tag, CreateTag, UpdateTag } from 'shared/types';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import { defineModal, getErrorMessage } from '@/lib/modals';

export interface TagEditDialogProps {
  tag?: Tag | null; // null for create mode
}

export type TagEditResult = 'saved' | 'canceled';

const TagEditDialogImpl = NiceModal.create<TagEditDialogProps>(({ tag }) => {
  const modal = useModal();
  const [formData, setFormData] = useState({
    tag_name: '',
    content: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tagNameError, setTagNameError] = useState<string | null>(null);

  const isEditMode = Boolean(tag);

  useEffect(() => {
    if (tag) {
      setFormData({
        tag_name: tag.tag_name,
        content: tag.content,
      });
    } else {
      setFormData({
        tag_name: '',
        content: '',
      });
    }
    setError(null);
    setTagNameError(null);
  }, [tag]);

  const handleSave = async () => {
    if (!formData.tag_name.trim()) {
      setError('标签名称是必需的');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (isEditMode && tag) {
        const updateData: UpdateTag = {
          tag_name: formData.tag_name,
          content: formData.content || null, // null means "don't update"
        };
        await tagsApi.update(tag.id, updateData);
      } else {
        const createData: CreateTag = {
          tag_name: formData.tag_name,
          content: formData.content,
        };
        await tagsApi.create(createData);
      }

      modal.resolve('saved' as TagEditResult);
      modal.hide();
    } catch (err: unknown) {
      setError(getErrorMessage(err) || '保存标签失败');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    modal.resolve('canceled' as TagEditResult);
    modal.hide();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      // Reset form data when dialog closes
      setFormData({
        tag_name: '',
        content: '',
      });
      setError(null);
      handleCancel();
    }
  };

  return (
    <Dialog open={modal.visible} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{isEditMode ? '编辑标签' : '创建标签'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div>
            <Label htmlFor="tag-name">
              {'标签名称'} <span className="text-destructive">{'*'}</span>
            </Label>
            <p className="text-xs text-muted-foreground mb-1.5">
              {`在任务描述中使用 # 加此名称：#${formData.tag_name || 'tag_name'}`}
            </p>
            <Input
              id="tag-name"
              value={formData.tag_name}
              onChange={(e) => {
                const value = e.target.value;
                setFormData({ ...formData, tag_name: value });

                // Validate in real-time for spaces
                if (value.includes(' ')) {
                  setTagNameError(
                    '标签名称不能包含空格。请使用下划线代替（例如：my_tag）'
                  );
                } else {
                  setTagNameError(null);
                }
              }}
              placeholder={'例如：bug_fix、test_plan、api_docs'}
              disabled={saving}
              autoFocus
              aria-invalid={!!tagNameError}
              className={tagNameError ? 'border-destructive' : undefined}
            />
            {tagNameError && (
              <p className="text-sm text-destructive">{tagNameError}</p>
            )}
          </div>
          <div>
            <Label htmlFor="tag-content">
              {'内容'} <span className="text-destructive">{'*'}</span>
            </Label>
            <p className="text-xs text-muted-foreground mb-1.5">
              {`当您在任务描述中使用 #${formData.tag_name || 'tag_name'} 时将插入的文本`}
            </p>
            <Textarea
              id="tag-content"
              value={formData.content}
              onChange={(e) => {
                const value = e.target.value;
                setFormData({ ...formData, content: value });
              }}
              placeholder={'输入使用此标签时将插入的文本'}
              rows={6}
              disabled={saving}
            />
          </div>
          {error && <Alert variant="destructive">{error}</Alert>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel} disabled={saving}>
            {'取消'}
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !!tagNameError || !formData.content.trim()}
          >
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isEditMode ? '更新' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const TagEditDialog = defineModal<TagEditDialogProps, TagEditResult>(
  TagEditDialogImpl
);
