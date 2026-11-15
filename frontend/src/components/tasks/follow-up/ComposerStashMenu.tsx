import { memo, useCallback, useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Image as ImageIcon,
  Layers,
  Plus,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  clearComposerDraftStash,
  composerStashStorageKey,
  formatComposerStashPreview,
  formatComposerStashRelativeTime,
  loadComposerDraftStash,
  popComposerDraftStash,
  pushComposerDraftStash,
  removeComposerDraftStash,
  reorderComposerDraftStash,
  type ComposerStashedDraft,
} from './composerDraftStash';

export interface ComposerStashMenuProps {
  scopeId?: string | null;
  draftValue?: string;
  hasDraft?: boolean;
  getDraftValue?: () => string;
  attachmentCount?: number;
  attachmentPaths?: string[];
  getAttachmentPaths?: () => string[];
  isEditable?: boolean;
  onStashDraft: () => void;
  onRestoreDraft: (text: string, images?: string[]) => void;
}

export const ComposerStashMenu = memo(function ComposerStashMenu({
  scopeId,
  draftValue,
  hasDraft,
  getDraftValue,
  attachmentCount = 0,
  attachmentPaths,
  getAttachmentPaths,
  isEditable = true,
  onStashDraft,
  onRestoreDraft,
}: ComposerStashMenuProps) {
  const { t } = useTranslation('conversation');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ComposerStashedDraft[]>(() =>
    loadComposerDraftStash(scopeId)
  );
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setItems(loadComposerDraftStash(scopeId));
  }, [scopeId]);

  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    const expectedKey = composerStashStorageKey(scopeId);
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === expectedKey) {
        setItems(loadComposerDraftStash(scopeId));
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [scopeId]);

  const resolveDraftValue = useCallback(
    () => (getDraftValue ? getDraftValue() : (draftValue ?? '')),
    [draftValue, getDraftValue]
  );

  const resolveAttachmentPaths = useCallback(
    () =>
      getAttachmentPaths
        ? getAttachmentPaths()
        : attachmentPaths
          ? [...attachmentPaths]
          : undefined,
    [attachmentPaths, getAttachmentPaths]
  );

  const effectiveAttachmentCount =
    attachmentPaths !== undefined ? attachmentPaths.length : attachmentCount;

  const canStash =
    isEditable &&
    ((hasDraft ?? (draftValue?.trim().length ?? 0) > 0) ||
      effectiveAttachmentCount > 0);

  const handleStashCurrent = useCallback(() => {
    const currentDraft = resolveDraftValue();
    const currentImages = resolveAttachmentPaths();
    const count = currentImages ? currentImages.length : attachmentCount;
    if (!isEditable || (!currentDraft.trim() && count === 0)) return;
    const next = pushComposerDraftStash(scopeId, {
      text: currentDraft,
      attachmentCount: count,
      images: currentImages,
    });
    setItems(next);
    onStashDraft();
  }, [
    attachmentCount,
    isEditable,
    onStashDraft,
    resolveAttachmentPaths,
    resolveDraftValue,
    scopeId,
  ]);

  const handleRestoreItem = useCallback(
    (id?: string) => {
      if (!isEditable) return;
      const { popped, items: remaining } = popComposerDraftStash(scopeId, id);
      if (!popped) return;

      const currentDraft = resolveDraftValue();
      const currentImages = resolveAttachmentPaths();
      const currentCount = currentImages
        ? currentImages.length
        : attachmentCount;
      const hasCurrentContent =
        Boolean(currentDraft.trim()) ||
        Boolean(currentImages && currentImages.length > 0);
      const poppedImages = popped.images ?? [];
      const sameImages =
        (currentImages?.length ?? 0) === poppedImages.length &&
        (currentImages ?? []).every((img, idx) => img === poppedImages[idx]);
      let nextItems = remaining;
      if (hasCurrentContent && (currentDraft !== popped.text || !sameImages)) {
        nextItems = pushComposerDraftStash(scopeId, {
          text: currentDraft,
          attachmentCount: currentCount,
          images: currentImages,
        });
      }
      setItems(nextItems);
      if (popped.images !== undefined) {
        onRestoreDraft(popped.text, popped.images);
      } else {
        onRestoreDraft(popped.text);
      }
      if (nextItems.length === 0) {
        setOpen(false);
      }
    },
    [
      attachmentCount,
      isEditable,
      onRestoreDraft,
      resolveAttachmentPaths,
      resolveDraftValue,
      scopeId,
    ]
  );

  useEffect(() => {
    if (!isEditable) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !event.altKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.shiftKey ||
        event.key.toLowerCase() !== 's'
      ) {
        return;
      }
      const currentImages = resolveAttachmentPaths();
      const hasActiveAttachments = currentImages
        ? currentImages.length > 0
        : effectiveAttachmentCount > 0;
      if (resolveDraftValue().trim() || hasActiveAttachments) {
        event.preventDefault();
        handleStashCurrent();
      } else if (loadComposerDraftStash(scopeId).length > 0) {
        event.preventDefault();
        handleRestoreItem();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    effectiveAttachmentCount,
    handleRestoreItem,
    handleStashCurrent,
    isEditable,
    resolveAttachmentPaths,
    resolveDraftValue,
    scopeId,
  ]);

  const handleDelete = (id: string) => {
    const next = removeComposerDraftStash(scopeId, id);
    setItems(next);
    if (next.length === 0) {
      setOpen(false);
    }
  };

  const handleMove = (fromIndex: number, toIndex: number) => {
    setItems(reorderComposerDraftStash(scopeId, fromIndex, toIndex));
  };

  const handleClearAll = () => {
    setItems(clearComposerDraftStash(scopeId));
    setOpen(false);
  };

  if (items.length === 0 && !canStash) {
    return null;
  }

  if (items.length === 0) {
    const stashLabel = t('composerStash.stashDraft');
    return (
      <Button
        type="button"
        onClick={handleStashCurrent}
        disabled={!canStash}
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0"
        title={`${stashLabel} (Ctrl+Alt+S)`}
        aria-label={stashLabel}
        data-testid="composer-stash-push-button"
      >
        <Layers className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    );
  }

  const menuLabel = t('composerStash.menuLabel', { count: items.length });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          disabled={!isEditable}
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-1.5 text-xs tabular-nums"
          title={`${menuLabel} (Ctrl+Alt+S)`}
          aria-label={menuLabel}
          data-testid="composer-stash-menu-trigger"
        >
          <Layers className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="tabular-nums">{items.length}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-80 p-2"
        data-testid="composer-stash-popover"
      >
        <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
          <span className="text-xs font-medium text-foreground">
            {t('composerStash.title')}
          </span>
          <div className="flex items-center gap-1">
            {canStash ? (
              <button
                type="button"
                onClick={handleStashCurrent}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-primary transition-colors hover:bg-muted"
                data-testid="composer-stash-push-in-menu"
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                <span>{t('composerStash.stashDraft')}</span>
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleClearAll}
              className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              data-testid="composer-stash-clear-all"
            >
              {t('composerStash.clearAll')}
            </button>
          </div>
        </div>
        <div
          className="max-h-64 space-y-1 overflow-y-auto overscroll-contain"
          role="list"
        >
          {items.map((item, index) => {
            const preview =
              formatComposerStashPreview(item.text, 50) ||
              item.images?.[0]?.split(/[\\/]/).pop() ||
              t('composerStash.stashDraft');
            const relTime = formatComposerStashRelativeTime(
              item.createdAt,
              now,
              {
                justNow: t('composerStash.justNow'),
                minutesAgo: (count) =>
                  t('composerStash.minutesAgo', { count }),
                hoursAgo: (count) => t('composerStash.hoursAgo', { count }),
                daysAgo: (count) => t('composerStash.daysAgo', { count }),
              }
            );
            return (
              <div
                key={item.id}
                role="listitem"
                draggable
                onDragStart={() => setDragIndex(index)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (dragIndex !== null && dragIndex !== index) {
                    handleMove(dragIndex, index);
                  }
                  setDragIndex(null);
                }}
                onDragEnd={() => setDragIndex(null)}
                className="group flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-muted/70"
                data-testid="composer-stash-item"
              >
                <button
                  type="button"
                  onClick={() => handleRestoreItem(item.id)}
                  title={t('composerStash.restore')}
                  className="min-w-0 flex-1 text-left"
                  data-testid="composer-stash-restore"
                >
                  <div className="truncate font-normal text-foreground">
                    {preview}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
                    <span>{relTime}</span>
                    {item.attachmentCount > 0 ? (
                      <span
                        className="inline-flex items-center gap-0.5 tabular-nums"
                        data-testid="composer-stash-attachments"
                      >
                        <ImageIcon className="h-3 w-3" aria-hidden="true" />
                        {item.attachmentCount}
                      </span>
                    ) : null}
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
                  {items.length > 1 ? (
                    <>
                      <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => handleMove(index, index - 1)}
                        aria-label={t('composerStash.moveUp')}
                        className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                        data-testid="composer-stash-move-up"
                      >
                        <ArrowUp className="h-3 w-3" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        disabled={index === items.length - 1}
                        onClick={() => handleMove(index, index + 1)}
                        aria-label={t('composerStash.moveDown')}
                        className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                        data-testid="composer-stash-move-down"
                      >
                        <ArrowDown className="h-3 w-3" aria-hidden="true" />
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => handleDelete(item.id)}
                    aria-label={t('composerStash.delete')}
                    className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                    data-testid="composer-stash-delete"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
});
