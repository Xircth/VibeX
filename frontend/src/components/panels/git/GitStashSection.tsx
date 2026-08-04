import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/components/ui/toast';
import { Archive, ChevronDown, ChevronRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { attemptsApi } from '@/lib/api/attempts';
import type { StashEntry } from 'shared/types';

interface GitStashSectionProps {
  workspaceId: string;
  repoId: string;
  hasChanges: boolean;
  /** Refresh git status after a stash operation mutates the working tree. */
  onChanged: () => void;
}

/**
 * Self-contained stash controls: stash the working tree, list the stack, and
 * apply / pop / drop entries. Kept collapsed by default so it doesn't compete
 * with the staging area.
 */
export function GitStashSection({
  workspaceId,
  repoId,
  hasChanges,
  onChanged,
}: GitStashSectionProps) {
  const { t } = useTranslation(['panels', 'common']);
  const [expanded, setExpanded] = useState(false);
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStashes(await attemptsApi.listStashes(workspaceId, repoId));
    } catch (error) {
      toast.error(t('gitStash.readFailed', { error: String(error) }));
    }
  }, [workspaceId, repoId, t]);

  useEffect(() => {
    if (expanded) void refresh();
  }, [expanded, refresh]);

  const run = useCallback(
    async (action: () => Promise<unknown>, ok: string) => {
      setBusy(true);
      try {
        await action();
        toast.success(ok);
        await refresh();
        onChanged();
      } catch (error) {
        toast.error(t('gitStash.operationFailed', { error: String(error) }));
      } finally {
        setBusy(false);
      }
    },
    [refresh, onChanged, t]
  );

  const onStash = () =>
    run(async () => {
      const stashed = await attemptsApi.stash(
        workspaceId,
        repoId,
        message.trim() || null,
        true
      );
      if (!stashed) throw new Error(t('gitStash.nothingToStash'));
      setMessage('');
    }, t('gitStash.stashedChanges'));

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        <Archive className="h-3.5 w-3.5" />
        {t('gitStash.title')}
        {stashes.length > 0 ? (
          <span className="ml-1 rounded bg-muted px-1.5 text-[10px]">
            {stashes.length}
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div className="space-y-2 px-3 pb-3">
          <div className="flex gap-2">
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t('gitStash.notePlaceholder')}
              className="h-8 text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0 text-xs"
              disabled={busy || !hasChanges}
              onClick={onStash}
            >
              {t('gitStash.stashButton')}
            </Button>
          </div>

          {stashes.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {t('gitStash.empty')}
            </p>
          ) : (
            <ul className="space-y-1">
              {stashes.map((s) => (
                <li
                  key={s.index}
                  className="flex items-center justify-between gap-2 rounded-[6px] border border-border px-2 py-1.5"
                >
                  <span
                    className="min-w-0 flex-1 truncate text-[11px]"
                    title={s.message}
                  >
                    <span className="text-muted-foreground">
                      stash@{'{'}
                      {s.index}
                      {'}'}
                    </span>{' '}
                    {s.message}
                  </span>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () =>
                            attemptsApi.popStash(workspaceId, repoId, s.index),
                          t('gitStash.popped')
                        )
                      }
                    >
                      {t('gitStash.pop')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px]"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () =>
                            attemptsApi.applyStash(
                              workspaceId,
                              repoId,
                              s.index
                            ),
                          t('gitStash.applied')
                        )
                      }
                    >
                      {t('gitStash.apply')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-[11px] text-destructive"
                      disabled={busy}
                      onClick={() =>
                        run(
                          () =>
                            attemptsApi.dropStash(workspaceId, repoId, s.index),
                          t('gitStash.dropped')
                        )
                      }
                    >
                      {t('common:delete')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
