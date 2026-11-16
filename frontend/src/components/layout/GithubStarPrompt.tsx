import { ArrowUpRight, X } from 'lucide-react';
import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { useTranslation } from 'react-i18next';

import dimoLogo from '@/assets/app-logo-light-default.png';
import { Button } from '@/components/ui/button';
import { StartupOverlayContext } from '@/contexts/StartupOverlayContext';
import { openInSystemBrowser } from '@/hooks/useOpenLink';
import { persistFrontendPreference } from '@/lib/frontendPreferences';
import { readLocalStorage, writeLocalStorage } from '@/lib/safeStorage';

export const GITHUB_STAR_PROMPT_KEY = 'dimo:github-star-prompt' as const;
export const GITHUB_STAR_THRESHOLD_MS = 5 * 60 * 1000;
export const GITHUB_STAR_REPO_URL = 'https://github.com/DimoADE/Dimo';

const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_TICK_GAP_MS = 30_000;

export type GithubStarPromptStatus = 'pending' | 'dismissed' | 'starred';

export interface GithubStarPromptState {
  activeMs: number;
  status: GithubStarPromptStatus;
}

const DEFAULT_STATE: GithubStarPromptState = {
  activeMs: 0,
  status: 'pending',
};

function isValidStatus(value: unknown): value is GithubStarPromptStatus {
  return value === 'pending' || value === 'dismissed' || value === 'starred';
}

export function parseGithubStarPromptState(
  raw: string | null | undefined
): GithubStarPromptState {
  if (!raw) return DEFAULT_STATE;
  try {
    const parsed = JSON.parse(raw) as Partial<GithubStarPromptState> | null;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_STATE;
    const activeMs =
      typeof parsed.activeMs === 'number' &&
      Number.isFinite(parsed.activeMs) &&
      parsed.activeMs >= 0
        ? parsed.activeMs
        : 0;
    const status = isValidStatus(parsed.status) ? parsed.status : 'pending';
    return { activeMs, status };
  } catch {
    return DEFAULT_STATE;
  }
}

export function readGithubStarPromptState(): GithubStarPromptState {
  return parseGithubStarPromptState(readLocalStorage(GITHUB_STAR_PROMPT_KEY));
}

export function writeGithubStarPromptState(
  state: GithubStarPromptState,
  options: { syncRemote?: boolean } = {}
): void {
  const normalized: GithubStarPromptState = {
    activeMs: Math.max(0, Math.round(state.activeMs)),
    status: state.status,
  };
  writeLocalStorage(GITHUB_STAR_PROMPT_KEY, JSON.stringify(normalized));
  if (options.syncRemote !== false) {
    persistFrontendPreference(GITHUB_STAR_PROMPT_KEY, {
      activeMs: normalized.activeMs,
      status: normalized.status,
    });
  }
}

export function GithubStarPrompt() {
  const { t } = useTranslation('common');
  const hasStartupOverlay = Boolean(useContext(StartupOverlayContext));
  const [promptState, setPromptState] = useState<GithubStarPromptState>(() =>
    readGithubStarPromptState()
  );
  const [trackingRevision, setTrackingRevision] = useState(0);
  const stateRef = useRef<GithubStarPromptState>(promptState);
  stateRef.current = promptState;

  const lastTickAtRef = useRef<number | null>(null);

  const flushElapsed = useCallback((now: number, syncRemote: boolean) => {
    const current = stateRef.current;
    if (current.status !== 'pending') {
      lastTickAtRef.current = null;
      return current;
    }

    const lastTick = lastTickAtRef.current;
    lastTickAtRef.current = now;
    if (lastTick === null) {
      return current;
    }

    const rawDelta = Math.max(0, now - lastTick);
    const delta = Math.min(rawDelta, MAX_TICK_GAP_MS);
    if (delta === 0) {
      return current;
    }

    const nextActiveMs = Math.min(
      GITHUB_STAR_THRESHOLD_MS,
      current.activeMs + delta
    );
    if (nextActiveMs === current.activeMs) {
      return current;
    }

    const nextState: GithubStarPromptState = {
      activeMs: nextActiveMs,
      status: 'pending',
    };
    stateRef.current = nextState;
    setPromptState(nextState);
    writeGithubStarPromptState(nextState, { syncRemote });
    return nextState;
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== GITHUB_STAR_PROMPT_KEY) return;
      const next = readGithubStarPromptState();
      stateRef.current = next;
      setPromptState(next);
      setTrackingRevision((prev) => prev + 1);
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const shouldTrack =
    !hasStartupOverlay &&
    promptState.status === 'pending' &&
    promptState.activeMs < GITHUB_STAR_THRESHOLD_MS;

  useEffect(() => {
    if (!shouldTrack) {
      lastTickAtRef.current = null;
      return;
    }

    let heartbeatId: number | null = null;
    let thresholdId: number | null = null;

    const clearTimers = () => {
      if (heartbeatId !== null) {
        window.clearInterval(heartbeatId);
        heartbeatId = null;
      }
      if (thresholdId !== null) {
        window.clearTimeout(thresholdId);
        thresholdId = null;
      }
    };

    const startTrackingIfVisible = () => {
      clearTimers();
      if (
        document.visibilityState === 'hidden' ||
        stateRef.current.status !== 'pending'
      ) {
        lastTickAtRef.current = null;
        return;
      }

      const remainingMs = Math.max(
        0,
        GITHUB_STAR_THRESHOLD_MS - stateRef.current.activeMs
      );
      if (remainingMs === 0) {
        lastTickAtRef.current = null;
        return;
      }

      lastTickAtRef.current = Date.now();
      heartbeatId = window.setInterval(() => {
        const next = flushElapsed(Date.now(), true);
        if (next.activeMs >= GITHUB_STAR_THRESHOLD_MS) {
          clearTimers();
          lastTickAtRef.current = null;
        }
      }, HEARTBEAT_INTERVAL_MS);

      thresholdId = window.setTimeout(() => {
        flushElapsed(Date.now(), true);
        clearTimers();
        lastTickAtRef.current = null;
      }, remainingMs);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushElapsed(Date.now(), true);
        clearTimers();
        lastTickAtRef.current = null;
      } else {
        startTrackingIfVisible();
      }
    };

    const handlePageHide = () => {
      flushElapsed(Date.now(), false);
      clearTimers();
      lastTickAtRef.current = null;
    };

    startTrackingIfVisible();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handlePageHide);
    window.addEventListener('beforeunload', handlePageHide);

    return () => {
      clearTimers();
      if (document.visibilityState !== 'hidden') {
        flushElapsed(Date.now(), false);
      }
      lastTickAtRef.current = null;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handlePageHide);
      window.removeEventListener('beforeunload', handlePageHide);
    };
  }, [flushElapsed, shouldTrack, trackingRevision]);

  const finishPrompt = useCallback((status: 'dismissed' | 'starred') => {
    lastTickAtRef.current = null;
    const nextState: GithubStarPromptState = {
      activeMs: Math.max(stateRef.current.activeMs, GITHUB_STAR_THRESHOLD_MS),
      status,
    };
    stateRef.current = nextState;
    setPromptState(nextState);
    writeGithubStarPromptState(nextState, { syncRemote: true });
  }, []);

  const handleDismiss = useCallback(() => {
    finishPrompt('dismissed');
  }, [finishPrompt]);

  const handleStarClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      finishPrompt('starred');
      void openInSystemBrowser(GITHUB_STAR_REPO_URL);
    },
    [finishPrompt]
  );

  const isVisible =
    !hasStartupOverlay &&
    promptState.status === 'pending' &&
    promptState.activeMs >= GITHUB_STAR_THRESHOLD_MS;

  if (!isVisible) {
    return null;
  }

  const closeLabel = t('close', { defaultValue: '关闭' });

  return (
    <div className="pointer-events-none absolute right-3 top-3 z-30 flex justify-end">
      <aside
        data-testid="github-star-prompt"
        role="dialog"
        aria-label={t('githubStarPrompt.ariaLabel', {
          defaultValue: 'GitHub Star 邀请',
        })}
        className="pointer-events-auto w-[312px] max-w-[calc(100vw-2rem)] rounded-[var(--radius,12px)] border border-border bg-popover p-3.5 text-popover-foreground shadow-[0_10px_28px_rgba(0,0,0,0.16)]"
      >
        <div className="flex items-start justify-between gap-2.5">
          <div className="flex min-w-0 items-start gap-2.5">
            <img
              src={dimoLogo}
              alt="Dimo Logo"
              className="mt-0.5 h-6 w-6 shrink-0 rounded-[6px] object-contain"
            />
            <p className="m-0 text-[13px] font-medium leading-[1.45] text-foreground">
              {t('githubStarPrompt.message', {
                defaultValue: '如果 Dimo 帮助到了您，不如在 GitHub 点上 Star？',
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            title={closeLabel}
            aria-label={closeLabel}
            className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mt-2.5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleDismiss}
            className="inline-flex h-7 items-center rounded-[7px] px-2 text-xs font-normal text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            {t('githubStarPrompt.later', { defaultValue: '以后再说' })}
          </button>
          <Button
            variant="primary"
            size="xs"
            asChild
            className="h-7 gap-1.5 rounded-[8px] px-2.5 text-xs font-semibold shadow-none"
          >
            <a
              href={GITHUB_STAR_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleStarClick}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                className="shrink-0"
              >
                <path d="M12 .5C5.65.5.5 5.65.5 12a11.5 11.5 0 0 0 7.86 10.91c.58.11.79-.25.79-.56v-2c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.11 3.06.74.8 1.19 1.83 1.19 3.08 0 4.41-2.69 5.39-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
              </svg>
              <span>
                {t('githubStarPrompt.cta', {
                  defaultValue: '前往 GitHub 点 Star',
                })}
              </span>
              <ArrowUpRight className="h-3 w-3 shrink-0" />
            </a>
          </Button>
        </div>
      </aside>
    </div>
  );
}
