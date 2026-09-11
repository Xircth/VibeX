import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/components/ui/toast';
import { resolveFileTreeAbsolutePath } from '@/components/file-tree/file-tree-utils';
import { usePanelActions } from '@/hooks/usePanelActions';
import { subscribeFileTreeChanges } from '@/lib/fileTreeChangeStream';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { isAutoPreviewPath } from '@/utils/filePreviewKind';

/**
 * How many previews one change batch may open on its own. A build that emits a
 * directory of pages should not bury the tabs the user was working in.
 */
export const MAX_AUTO_OPENED_PREVIEWS = 3;

interface AutoOpenCreatedFilePreviewsOptions {
  /** False while the user is somewhere the file tree is not the subject. */
  enabled: boolean;
}

/**
 * Opens the preview of a newly created SVG or HTML file as it lands in the
 * workspace, so a rendered artifact an agent produced does not have to be
 * hunted down in the tree.
 *
 * Nothing is subscribed while `enabled` is false — the point is to act only
 * while the workspace page is on screen, not to collect changes in the
 * background and replay them on arrival.
 */
export function useAutoOpenCreatedFilePreviews({
  enabled,
}: AutoOpenCreatedFilePreviewsOptions): void {
  const rootPath = useFileTreeStore((state) => state.rootPath);
  const { openFilePreview } = usePanelActions();
  const { t } = useTranslation(['panels', 'common']);

  // Held in refs so the subscription is torn down and rebuilt only when the
  // things it actually watches change — an unstable identity here would
  // resubscribe on every render.
  const openFilePreviewRef = useRef(openFilePreview);
  openFilePreviewRef.current = openFilePreview;
  const translateRef = useRef(t);
  translateRef.current = t;

  // A preview is opened once per file: the user closing the tab is an answer,
  // and a later write to the same file must not overrule it.
  const openedRef = useRef<{ rootPath: string | null; paths: Set<string> }>({
    rootPath: null,
    paths: new Set(),
  });

  useEffect(() => {
    if (!enabled || !rootPath) {
      return;
    }

    if (openedRef.current.rootPath !== rootPath) {
      openedRef.current = { rootPath, paths: new Set() };
    }
    const opened = openedRef.current.paths;

    return subscribeFileTreeChanges(rootPath, (change) => {
      const candidates = (change.added_paths ?? [])
        .filter(isAutoPreviewPath)
        .map((relativePath) =>
          resolveFileTreeAbsolutePath(rootPath, relativePath)
        )
        .filter((absolutePath) => !opened.has(absolutePath));

      if (candidates.length === 0) {
        return;
      }

      const opening = candidates.slice(0, MAX_AUTO_OPENED_PREVIEWS);

      opening.forEach((absolutePath, index) => {
        // Only the first takes the focus; the rest arrive as background tabs.
        const result = openFilePreviewRef.current(absolutePath, {
          activate: index === 0,
        });
        if (result !== 'unavailable') {
          opened.add(absolutePath);
        }
      });

      const skipped =
        candidates.length -
        opening.length +
        (change.added_paths_truncated ? 1 : 0);
      if (skipped > 0) {
        toast.info(
          translateRef.current('fileTreePanel.autoOpenSkipped', {
            count: skipped,
          })
        );
      }
    });
  }, [enabled, rootPath]);
}
