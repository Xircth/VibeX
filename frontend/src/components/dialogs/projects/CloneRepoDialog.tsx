import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation(['dialogs', 'common']);
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
      setError(t('cloneRepo.urlRequired'));
      return;
    }
    if (!parentDir) {
      setError(t('cloneRepo.dirRequired'));
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
      setError(getErrorMessage(err) || t('cloneRepo.cloneFailed'));
    } finally {
      setCloning(false);
    }
  };

  return (
    <Dialog open={modal.visible} onOpenChange={(o) => !o && cancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('cloneRepo.title')}</DialogTitle>
          <DialogDescription>{t('cloneRepo.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('cloneRepo.urlLabel')}
            </label>
            <Input
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              placeholder={t('cloneRepo.urlPlaceholder')}
              autoFocus
              disabled={cloning}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('cloneRepo.cloneToLabel')}
            </label>
            <div className="flex gap-2">
              <Input
                value={parentDir}
                onChange={(e) => setParentDir(e.target.value)}
                placeholder={t('cloneRepo.parentDirPlaceholder')}
                disabled={cloning}
              />
              <Button
                variant="outline"
                className="shrink-0"
                onClick={() => void pickDir()}
                disabled={cloning}
              >
                {t('cloneRepo.browse')}
              </Button>
            </div>
            {targetPath ? (
              <p className="text-[11px] text-muted-foreground">
                {t('cloneRepo.willCloneTo', { path: targetPath })}
              </p>
            ) : null}
          </div>

          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={cancel} disabled={cloning}>
            {t('common:cancel')}
          </Button>
          <Button
            onClick={() => void clone()}
            disabled={cloning || !url.trim() || !parentDir}
          >
            {cloning ? t('cloneRepo.cloning') : t('cloneRepo.clone')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});

export const CloneRepoDialog = defineModal<void, CloneRepoDialogResult>(
  CloneRepoDialogImpl
);
