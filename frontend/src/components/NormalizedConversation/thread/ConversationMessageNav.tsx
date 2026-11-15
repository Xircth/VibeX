import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ConversationMessageNavEntry } from './messageNavEntries';
import { findActiveConversationMessageNavEntry } from './messageNavEntries';

export function resolveScrubEntryIndex({
  clientY,
  rectTop,
  rectHeight,
  entryCount,
}: {
  clientY: number;
  rectTop: number;
  rectHeight: number;
  entryCount: number;
}): number {
  if (entryCount <= 0) return -1;
  if (entryCount === 1 || rectHeight <= 0) return 0;
  const ratio = Math.min(
    0.999999,
    Math.max(0, (clientY - rectTop) / rectHeight)
  );
  return Math.min(
    entryCount - 1,
    Math.max(0, Math.floor(ratio * entryCount))
  );
}

type PointerScrubSession = {
  pointerId: number;
  startY: number;
  rectTop: number;
  rectHeight: number;
  scrollHeight: number;
  didDrag: boolean;
};

export function ConversationMessageNav({
  entries,
  activeIndex,
  onSelect,
}: {
  entries: ConversationMessageNavEntry[];
  activeIndex: number | null;
  onSelect: (index: number) => void;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pointerSessionRef = useRef<PointerScrubSession | null>(null);
  const pendingClientYRef = useRef<number | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastScrubbedIndexRef = useRef<number | null>(null);
  const suppressNextClickRef = useRef(false);
  const [scrubState, setScrubState] = useState<{
    entryIndex: number;
    offsetY: number;
  } | null>(null);

  const cancelPendingRaf = useCallback(() => {
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  useEffect(() => () => cancelPendingRaf(), [cancelPendingRaf]);

  const applyScrubAtClientY = useCallback(
    (clientY: number, session: PointerScrubSession) => {
      if (entries.length === 0) return;

      let entryIndex = resolveScrubEntryIndex({
        clientY,
        rectTop: session.rectTop,
        rectHeight: session.rectHeight,
        entryCount: entries.length,
      });

      if (session.rectHeight <= 0 && typeof document.elementFromPoint === 'function') {
        const hit = document.elementFromPoint(0, clientY);
        const button = hit?.closest<HTMLElement>('[data-nav-entry-index]');
        const parsed = button ? Number(button.dataset.navEntryIndex) : Number.NaN;
        if (Number.isInteger(parsed) && parsed >= 0 && parsed < entries.length) {
          entryIndex = parsed;
        }
      }

      if (entryIndex < 0 || entryIndex >= entries.length) return;

      const listEl = listRef.current;
      if (
        listEl &&
        session.rectHeight > 0 &&
        session.scrollHeight > session.rectHeight
      ) {
        const ratio = Math.min(
          1,
          Math.max(0, (clientY - session.rectTop) / session.rectHeight)
        );
        listEl.scrollTop = ratio * (session.scrollHeight - session.rectHeight);
      }

      const clampedOffsetY =
        session.rectHeight > 0
          ? Math.min(
              session.rectHeight,
              Math.max(0, clientY - session.rectTop)
            )
          : 0;

      setScrubState((prev) =>
        prev?.entryIndex === entryIndex &&
        Math.abs(prev.offsetY - clampedOffsetY) < 0.5
          ? prev
          : { entryIndex, offsetY: clampedOffsetY }
      );

      if (lastScrubbedIndexRef.current !== entryIndex) {
        lastScrubbedIndexRef.current = entryIndex;
        const target = entries[entryIndex];
        if (target) {
          onSelect(target.index);
        }
      }
    },
    [entries, onSelect]
  );

  const endScrubSession = useCallback(
    (pointerId?: number) => {
      const session = pointerSessionRef.current;
      if (!session) return;
      if (pointerId !== undefined && session.pointerId !== pointerId) return;

      cancelPendingRaf();
      if (session.didDrag && pendingClientYRef.current !== null) {
        applyScrubAtClientY(pendingClientYRef.current, session);
      }
      if (session.didDrag) {
        suppressNextClickRef.current = true;
        window.setTimeout(() => {
          suppressNextClickRef.current = false;
        }, 0);
      }

      pointerSessionRef.current = null;
      pendingClientYRef.current = null;
      lastScrubbedIndexRef.current = null;
      setScrubState(null);
    },
    [applyScrubAtClientY, cancelPendingRaf]
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || entries.length === 0) return;
    const listEl = listRef.current;
    if (!listEl) return;

    const rect = listEl.getBoundingClientRect();
    pointerSessionRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      rectTop: rect.top,
      rectHeight: rect.height,
      scrollHeight: listEl.scrollHeight,
      didDrag: false,
    };
    pendingClientYRef.current = null;
    lastScrubbedIndexRef.current = null;

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Ignore synthetic events in non-browser test environments
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;

    if (!session.didDrag && Math.abs(event.clientY - session.startY) < 2) {
      return;
    }

    session.didDrag = true;
    pendingClientYRef.current = event.clientY;

    if (rafIdRef.current !== null) return;
    rafIdRef.current = window.requestAnimationFrame(() => {
      rafIdRef.current = null;
      const activeSession = pointerSessionRef.current;
      const latestY = pendingClientYRef.current;
      if (!activeSession || latestY === null) return;
      applyScrubAtClientY(latestY, activeSession);
    });
  };

  const handlePointerUpOrCancel = (
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    const session = pointerSessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore synthetic events
    }
    endScrubSession(event.pointerId);
  };

  if (entries.length === 0) return null;

  const activeEntry = findActiveConversationMessageNavEntry(
    entries,
    activeIndex
  );
  const scrubbedEntry =
    scrubState !== null ? (entries[scrubState.entryIndex] ?? null) : null;

  return (
    <nav
      className={cn(
        'conv-message-nav-rail',
        scrubbedEntry && 'is-scrubbing'
      )}
      aria-label={t('messageNav.railLabel')}
    >
      <TooltipProvider delayDuration={80} skipDelayDuration={120}>
        <div
          ref={listRef}
          className="conv-message-nav-list touch-none select-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUpOrCancel}
          onPointerCancel={handlePointerUpOrCancel}
          onLostPointerCapture={(event) => endScrubSession(event.pointerId)}
          data-testid="conv-message-nav-list"
        >
          {entries.map((entry, entryIdx) => {
            const isActive = activeEntry?.key === entry.key;
            const isScrubbed = scrubbedEntry?.key === entry.key;
            return (
              <Tooltip key={entry.key}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-nav-entry-index={entryIdx}
                    className={cn(
                      'conv-message-nav-tick',
                      isActive && 'is-active',
                      isScrubbed && 'is-scrubbed'
                    )}
                    onClick={(event) => {
                      if (suppressNextClickRef.current) {
                        suppressNextClickRef.current = false;
                        event.preventDefault();
                        return;
                      }
                      onSelect(entry.index);
                    }}
                    aria-current={isActive ? 'true' : undefined}
                    aria-label={t('messageNav.jumpToMessage', {
                      ordinal: entry.ordinal,
                    })}
                  />
                </TooltipTrigger>
                {!scrubbedEntry ? (
                  <TooltipContent
                    className="conv-message-nav-preview"
                    side="left"
                    align="center"
                    sideOffset={8}
                    collisionPadding={8}
                  >
                    {entry.preview}
                  </TooltipContent>
                ) : null}
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>
      {scrubbedEntry && scrubState ? (
        <div
          role="status"
          aria-live="off"
          className="conv-message-nav-scrub-preview pointer-events-none"
          style={{
            transform: `translate3d(0, ${scrubState.offsetY}px, 0) translateY(-50%)`,
          }}
          data-testid="conv-message-nav-scrub-preview"
        >
          <span className="conv-message-nav-scrub-ordinal tabular-nums">
            #{scrubbedEntry.ordinal}
          </span>
          <span className="conv-message-nav-scrub-role">
            {scrubbedEntry.role === 'assistant'
              ? t('messageNav.assistantRole')
              : t('messageNav.userRole')}
          </span>
          <span className="conv-message-nav-scrub-text truncate">
            {scrubbedEntry.preview.replace(/\s+/g, ' ').trim()}
          </span>
        </div>
      ) : null}
    </nav>
  );
}
