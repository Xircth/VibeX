import {
  useId,
  useState,
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
}: {
  id: ToastId;
  kind: ToastKind;
  message: ReactNode;
  options: ToastOptions;
}) {
  const detailsId = useId();
  const [expanded, setExpanded] = useState(false);
  const detailRows = collectDetailRows(options);
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

  return (
    <article
      className="vu-toast-surface"
      data-kind={kind}
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
          <div className="vu-toast-title">{message}</div>
        </div>
        {hasDetails || hasActions || showClose ? (
          <div className="vu-toast-end">
            {hasDetails ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                label={
                  expanded ? i18n.t('app:toast.hideDetails') : detailsCopy.label
                }
                aria-expanded={expanded}
                aria-controls={detailsId}
                onClick={toggleDetails}
              >
                {expanded ? undefined : detailsCopy.children}
              </Button>
            ) : null}
            {options.cancel ? (
              <ToastActionButton
                action={options.cancel}
                variant="secondary"
                onClick={runAction(options.cancel)}
              />
            ) : null}
            {options.action ? (
              <ToastActionButton
                action={options.action}
                variant="primary"
                onClick={runAction(options.action)}
              />
            ) : null}
            {showClose ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                isIconOnly
                icon={<X aria-hidden="true" />}
                label={i18n.t('app:toast.close')}
                onClick={() => removeToast(id)}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {hasDetails && expanded ? (
        <div id={detailsId} className="vu-toast-details">
          {detailRows.map((detail, index) => (
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

  return (
    <section
      className="vu-toast-viewport"
      aria-label={t('toast.region')}
      aria-live="polite"
      aria-relevant="additions text"
    >
      {items.map((item) => (
        <div className="vu-toast-host" key={item.id}>
          <ToastCard {...item} />
        </div>
      ))}
    </section>
  );
}
