import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  useSyncExternalStore,
  type FocusEvent,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Info,
  Loader2,
  X,
} from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';

import './toast.css';

export type ToastId = string | number;
export type ToastKind = 'success' | 'info' | 'warning' | 'error' | 'loading';

export type ToastAction = {
  label: ReactNode;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
};

export type ToastDetail = {
  title?: ReactNode;
  description: ReactNode;
  mono?: boolean;
};

export type ToastOptions = {
  id?: ToastId;
  description?: ReactNode;
  details?: ToastDetail[];
  detailsLabel?: ReactNode;
  duration?: number;
  action?: ToastAction;
  cancel?: ToastAction;
  closeButton?: boolean;
  /** Determinate progress from 0 to 1. Renders a bar under the copy. */
  progress?: number;
};

const DEFAULT_DURATION: Record<Exclude<ToastKind, 'loading'>, number> = {
  success: 4_000,
  info: 5_000,
  warning: 8_000,
  error: 8_000,
};

type ToastItem = {
  id: ToastId;
  kind: ToastKind;
  message: ReactNode;
  options: ToastOptions;
  duration: number;
};

let nextToastId = 1;
let toastItems: readonly ToastItem[] = [];
const listeners = new Set<() => void>();
const timers = new Map<ToastId, number>();

function emitChange() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return toastItems;
}

function clearToastTimer(id: ToastId) {
  const timer = timers.get(id);
  if (timer == null) return;
  window.clearTimeout(timer);
  timers.delete(id);
}

function removeToast(id: ToastId) {
  clearToastTimer(id);
  const next = toastItems.filter((item) => item.id !== id);
  if (next.length === toastItems.length) return;
  toastItems = next;
  emitChange();
}

function scheduleToast(item: ToastItem) {
  clearToastTimer(item.id);
  if (!Number.isFinite(item.duration) || item.duration <= 0) return;
  timers.set(
    item.id,
    window.setTimeout(() => removeToast(item.id), item.duration)
  );
}

function holdToast(id: ToastId) {
  clearToastTimer(id);
}

function resumeToast(id: ToastId) {
  const item = toastItems.find((candidate) => candidate.id === id);
  if (item) scheduleToast(item);
}

function collectDetailRows(options: ToastOptions): ToastDetail[] {
  const rows: ToastDetail[] = [];
  if (options.description != null) {
    rows.push({ description: options.description });
  }
  if (options.details?.length) {
    rows.push(...options.details);
  }
  return rows;
}

// Rust and Windows I/O errors end in a parenthetical such as "(os error 32)".
// That suffix is the diagnostic; the sentence before it is the title.
const TRAILING_DETAIL = /^(.*?)[ \t]*[（(]([^()（）\n]+)[)）]\s*$/;

function technicalDetail(inner: string): string | null {
  const text = inner.trim();
  if (!text || /[\u3400-\u9fff]/.test(text)) return null;
  if (/os error\s+\d+/i.test(text)) return text;
  if (/\berror\b/i.test(text) && /\d/.test(text)) return text;
  if (/[\\/]/.test(text)) return text;
  if (/\d/.test(text)) return text;
  if (/^[A-Z][A-Z0-9_.:-]{2,}$/.test(text)) return text;
  return null;
}

function splitTechnicalDetail(
  message: ReactNode
): { title: string; detail: string } | null {
  if (typeof message !== 'string') return null;
  const match = message.match(TRAILING_DETAIL);
  if (!match) return null;
  const title = match[1].trim();
  const detail = technicalDetail(match[2]);
  if (!title || !detail) return null;
  return { title, detail };
}

function presentToast(
  kind: ToastKind,
  message: ReactNode,
  options: ToastOptions
): { message: ReactNode; detailRows: ToastDetail[] } {
  const detailRows = collectDetailRows(options);
  if (kind !== 'error' && kind !== 'warning') {
    return { message, detailRows };
  }
  const split = splitTechnicalDetail(message);
  if (!split) return { message, detailRows };
  return {
    message: split.title,
    detailRows: [{ description: split.detail, mono: true }, ...detailRows],
  };
}

function toastButtonCopy(
  label: ReactNode | undefined,
  fallback: string
): { label: string; children?: ReactNode } {
  if (typeof label === 'string') {
    return { label };
  }
  if (typeof label === 'number') {
    return { label: String(label) };
  }
  if (label == null) {
    return { label: fallback };
  }
  return { label: fallback, children: label };
}

function ToastActionButton({
  action,
  variant,
  onClick,
}: {
  action: ToastAction;
  variant: 'primary' | 'secondary';
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const copy = toastButtonCopy(action.label, '');
  return (
    <Button
      type="button"
      variant={variant}
      size="sm"
      label={copy.label}
      onClick={onClick}
    >
      {copy.children}
    </Button>
  );
}

function ToastStatusIcon({ kind }: { kind: ToastKind }) {
  const className = 'vu-toast-status-icon';

  switch (kind) {
    case 'success':
      return <CheckCircle2 className={className} aria-hidden="true" />;
    case 'info':
      return <Info className={className} aria-hidden="true" />;
    case 'warning':
      return <AlertTriangle className={className} aria-hidden="true" />;
    case 'error':
      return <CircleAlert className={className} aria-hidden="true" />;
    case 'loading':
      return (
        <Loader2
          className={`${className} vu-toast-status-icon-loading`}
          aria-hidden="true"
        />
      );
  }
}

function ToastCard({
  id,
  kind,
  message,
  options,
  duration,
}: {
  id: ToastId;
  kind: ToastKind;
  message: ReactNode;
  options: ToastOptions;
  duration: number;
}) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const presented = presentToast(kind, message, options);
  const detailRows = presented.detailRows;
  const hasDetails = detailRows.length > 0;
  const showClose = options.closeButton !== false && kind !== 'loading';
  const hasActions = Boolean(options.cancel || options.action);
  const detailsCopy = toastButtonCopy(
    options.detailsLabel,
    i18n.t('app:toast.showDetails')
  );

  const runAction =
    (action: ToastAction) => (event: React.MouseEvent<HTMLButtonElement>) => {
      try {
        action.onClick(event);
      } finally {
        removeToast(id);
      }
    };

  const toggleDetails = () => {
    setExpanded((current) => {
      const next = !current;
      if (next) holdToast(id);
      else resumeToast(id);
      return next;
    });
  };

  const handleBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget) && !expanded) {
      resumeToast(id);
    }
  };

  const hasActions = Boolean(options.cancel || options.action);
  const progress =
    typeof options.progress === 'number' && Number.isFinite(options.progress)
      ? Math.min(1, Math.max(0, options.progress))
      : null;
  const layout =
    hasDescription || hasDetails || hasActions || progress != null
      ? 'card'
      : 'capsule';
  const countdown =
    Number.isFinite(duration) && duration > 0 && kind !== 'loading'
      ? ({ '--vu-toast-duration': `${duration}ms` } as CSSProperties)
      : undefined;

  return (
    <article
      className="vu-toast-surface"
      data-kind={kind}
      data-layout={layout}
      data-held={expanded ? 'true' : undefined}
      data-closable={showClose ? 'true' : 'false'}
      role={kind === 'error' ? 'alert' : 'status'}
      aria-atomic="true"
      onMouseEnter={() => holdToast(id)}
      onMouseLeave={() => {
        if (!expanded) resumeToast(id);
      }}
      onFocusCapture={() => holdToast(id)}
      onBlurCapture={handleBlur}
    >
      <div className="vu-toast-heading">
        <span className="vu-toast-icon">
          <ToastStatusIcon kind={kind} />
        </span>
        <div className="vu-toast-copy">
          {layout === 'capsule' ? (
            <>
              <span className="vu-toast-sr-only">{fallbackTitle(kind)}</span>
              <div className="vu-toast-title">{message}</div>
            </>
          ) : (
            <>
              <div className="vu-toast-title">{title}</div>
              <div className="vu-toast-summary">{summary}</div>
            </>
          )}
        </div>
        {showClose ? (
          <button
            type="button"
            className="vu-toast-close"
            aria-label={i18n.t('app:toast.close')}
            onClick={() => removeToast(id)}
          >
            {countdown ? (
              <svg
                className="vu-toast-countdown"
                viewBox="0 0 28 28"
                aria-hidden="true"
                style={countdown}
              >
                <circle
                  className="vu-toast-countdown-track"
                  cx="14"
                  cy="14"
                  r="12"
                />
                <circle
                  className="vu-toast-countdown-ring"
                  cx="14"
                  cy="14"
                  r="12"
                />
              </svg>
            ) : null}
            <X aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {progress != null ? (
        <div
          className="vu-toast-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <span style={{ transform: `scaleX(${progress})` }} />
        </div>
      ) : null}

      {hasDetails ? (
        <div className="vu-toast-details-section">
          <button
            type="button"
            className="vu-toast-disclosure"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={toggleDetails}
          >
            <span>
              {options.detailsLabel ?? i18n.t('app:toast.showDetails')}
            </span>
            <ChevronDown
              className={expanded ? 'is-expanded' : undefined}
              aria-hidden="true"
            />
          </button>
          {expanded ? (
            <div id={detailsId} className="vu-toast-details">
              {options.details?.map((detail, index) => (
                <div className="vu-toast-detail-row" key={index}>
                  {detail.title ? (
                    <div className="vu-toast-detail-title">{detail.title}</div>
                  ) : null}
                  <div
                    className={
                      detail.mono
                        ? 'vu-toast-detail-copy vu-toast-detail-copy-mono'
                        : 'vu-toast-detail-copy'
                    }
                  >
                    {detail.description}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {hasActions ? (
        <div className="vu-toast-actions">
          {options.cancel ? (
            <button
              type="button"
              className="vu-toast-action vu-toast-action-secondary"
              onClick={runAction(options.cancel)}
            >
              {options.cancel.label}
            </button>
          ) : null}
          {options.action ? (
            <button
              type="button"
              className="vu-toast-action vu-toast-action-primary"
              onClick={runAction(options.action)}
            >
              {options.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function showToast(
  kind: ToastKind,
  message: ReactNode,
  options: ToastOptions = {}
) {
  const duration =
    options.duration ??
    (kind === 'loading' ? Infinity : DEFAULT_DURATION[kind]);
  const id = options.id ?? nextToastId++;
  const item: ToastItem = { id, kind, message, options, duration };
  const existingIndex = toastItems.findIndex(
    (candidate) => candidate.id === id
  );

  if (existingIndex >= 0) {
    toastItems = toastItems.map((candidate) =>
      candidate.id === id ? item : candidate
    );
  } else {
    const next = [...toastItems, item];
    const removed = next.slice(0, Math.max(0, next.length - 3));
    removed.forEach((candidate) => clearToastTimer(candidate.id));
    toastItems = next.slice(-3);
  }

  emitChange();
  scheduleToast(item);
  return id;
}

type ToastMethod = (message: ReactNode, options?: ToastOptions) => ToastId;

export const toast: Record<ToastKind, ToastMethod> & {
  dismiss: (id?: ToastId) => ToastId | undefined;
} = {
  success: (message, options) => showToast('success', message, options),
  info: (message, options) => showToast('info', message, options),
  warning: (message, options) => showToast('warning', message, options),
  error: (message, options) => showToast('error', message, options),
  loading: (message, options) => showToast('loading', message, options),
  dismiss: (id) => {
    if (id != null) {
      removeToast(id);
      return id;
    }
    toastItems.forEach((item) => clearToastTimer(item.id));
    toastItems = [];
    emitChange();
    return undefined;
  },
};

export function Toaster({
  theme: _theme,
}: {
  theme?: 'light' | 'dark' | 'system';
}) {
  const items = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { t } = useTranslation('app');
  const viewportRef = useRef<HTMLElement>(null);
  const newestId = items.at(-1)?.id;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const stackExpanded = items.length > 1 && (hovered || focused);

  // Collapsed stack: older toasts peek behind the newest one, sized to it.
  useEffect(() => {
    const viewport = viewportRef.current;
    const front = viewport?.querySelector<HTMLElement>(
      '.vu-toast-host[data-stack-index="0"]'
    );
    if (!viewport || !front || typeof ResizeObserver === 'undefined') return;
    const sync = () => {
      const surface = front.firstElementChild as HTMLElement | null;
      viewport.style.setProperty(
        '--vu-toast-front-height',
        `${front.offsetHeight}px`
      );
      viewport.style.setProperty(
        '--vu-toast-front-width',
        `${surface?.offsetWidth ?? front.offsetWidth}px`
      );
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(front);
    return () => observer.disconnect();
  }, [newestId, items.length]);

  return (
    <section
      ref={viewportRef}
      data-expanded={stackExpanded ? 'true' : 'false'}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocused(false);
      }}
      className="vu-toast-viewport"
      data-count={items.length}
      aria-label={t('toast.region')}
      aria-live="polite"
      aria-relevant="additions text"
    >
      {items.map((item, position) => (
        <div
          className="vu-toast-host"
          key={item.id}
          data-stack-index={items.length - 1 - position}
        >
          <ToastCard {...item} />
        </div>
      ))}
    </section>
  );
}
