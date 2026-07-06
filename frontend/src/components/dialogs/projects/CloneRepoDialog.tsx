import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import NiceModal, { useModal } from '@ebay/nice-modal-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { defineModal, getErrorMessage } from '@/lib/modals';
import { repoApi } from '@/lib/api/repos';
import type { Repo } from 'shared/types';

export type CloneRepoDialogResult =
  | { status: 'cloned'; repo: Repo }
  | { status: 'canceled' };

/** Derive a folder name from a clone URL (`.../foo.git` → `foo`). */
function repoNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  const last = trimmed.split(/[/:]/).pop() ?? '';
  return last.replace(/\.git$/i, '');
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return `${dir.replace(/[/\\]+$/, '')}${sep}${name}`;
}

const CloneRepoDialogImpl = NiceModal.create<Record<string, never>>(() => {
  const modal = useModal();
  const [url, setUrl] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);

  const derivedName = repoNameFromUrl(url);
  const targetPath =
    parentDir && derivedName ? joinPath(parentDir, derivedName) : '';

  const pickDir = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === 'string') {
      setParentDir(picked);
      setError(null);
    }
  };

  const cancel = () => {
    modal.resolve({ status: 'canceled' } as CloneRepoDialogResult);
    modal.hide();
  };

  const clone = async () => {
    if (!url.trim()) {
      setError('请填写仓库地址');
      return;
    }
    if (!parentDir) {
      setError('请选择克隆到的目录');
      return;
    }
    setCloning(true);
    setError(null);
    try {
      const repo = await repoApi.clone({
        clone_url: url.trim(),
        target_path: targetPath,
      });
      modal.resolve({ status: 'cloned', repo } as CloneRepoDialogResult);
      modal.hide();
    } catch (err) {
      setError(getErrorMessage(err) || '克隆失败');
    } finally {
      setCloning(false);
    }
  };

  return (
    <Dialog open={modal.visible} onOpenChange={(o) => !o && cancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>克隆仓库</DialogTitle>
          <DialogDescription>
            输入 Git 仓库地址并选择本地目录，克隆完成后自动加入工作区。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">仓库地址</label>
            <Input
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              placeholder="https://github.com/owner/repo.git 或 git@..."
              autoFocus
              disabled={cloning}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">克隆到</label>
            <div className="flex gap-2">
              <Input
                value={parentDir}
                onChange={(e) => setParentDir(e.target.value)}
                placeholder="选择父目录"
                disabled={cloning}
              />
              <Button
                variant="outline"
                className="shrink-0"
                onClick={() => void pickDir()}
                disabled={cloning}
              >
                浏览…
              </Button>
            </div>
            {targetPath ? (
              <p className="text-[11px] text-muted-foreground">
                将克隆到：{targetPath}
              </p>
            ) : null}
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={cancel} disabled={cloning}>
            取消
          </Button>
          <Button
            onClick={() => void clone()}
            disabled={cloning || !url.trim() || !parentDir}
          >
            {cloning ? '克隆中…' : '克隆'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const CloneRepoDialog = defineModal<void, CloneRepoDialogResult>(
  CloneRepoDialogImpl
);
