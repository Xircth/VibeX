import { disposePluginRegistrations, globalServices } from '@vibex/plugin-sdk';
import { Component, type ErrorInfo, type ReactNode } from 'react';

export const CRASH_QUARANTINE_THRESHOLD = 3;
export const CRASH_WINDOW_MS = 60_000;

interface CrashRecord {
  timestamps: number[];
  quarantined: boolean;
  lastError: Error | null;
}

const crashLedger = new Map<string, CrashRecord>();
let globalQuarantineHandler: ((pluginId: string, error: Error) => void) | null =
  null;

export function setPluginQuarantineHandler(
  handler: ((pluginId: string, error: Error) => void) | null
): void {
  globalQuarantineHandler = handler;
}

export function isPluginQuarantined(pluginId: string): boolean {
  return crashLedger.get(pluginId)?.quarantined ?? false;
}

export function getPluginCrashCount(pluginId: string): number {
  return crashLedger.get(pluginId)?.timestamps.length ?? 0;
}

export function clearPluginCrashState(pluginId?: string): void {
  if (pluginId) {
    crashLedger.delete(pluginId);
  } else {
    crashLedger.clear();
  }
}

export function recordPluginCrash(
  pluginId: string,
  error: Error,
  now = Date.now()
): { count: number; quarantined: boolean } {
  const existing = crashLedger.get(pluginId) ?? {
    timestamps: [],
    quarantined: false,
    lastError: null,
  };
  const recent = existing.timestamps.filter(
    (timestamp) => now - timestamp <= CRASH_WINDOW_MS
  );
  recent.push(now);
  const quarantined =
    existing.quarantined || recent.length >= CRASH_QUARANTINE_THRESHOLD;
  crashLedger.set(pluginId, {
    timestamps: recent,
    quarantined,
    lastError: error,
  });

  if (quarantined && !existing.quarantined) {
    disposePluginRegistrations(pluginId);
    globalServices.disposePlugin(pluginId);
    try {
      globalQuarantineHandler?.(pluginId, error);
    } catch {
      // Never allow quarantine notification errors to propagate.
    }
  }

  return { count: recent.length, quarantined };
}

export interface PluginBoundaryFallbackProps {
  pluginId: string;
  slot?: string;
  error: Error;
  quarantined: boolean;
  crashCount: number;
  retry: () => void;
}

export interface PluginBoundaryProps {
  pluginId: string;
  slot?: string;
  slotName?: string;
  children: ReactNode;
  fallback?: ReactNode | ((props: PluginBoundaryFallbackProps) => ReactNode);
  onRetry?: () => void;
  onQuarantine?: (pluginId: string, error: Error) => void;
}

interface PluginBoundaryState {
  error: Error | null;
  quarantined: boolean;
  crashCount: number;
}

export class PluginBoundary extends Component<
  PluginBoundaryProps,
  PluginBoundaryState
> {
  state: PluginBoundaryState = {
    error: null,
    quarantined: isPluginQuarantined(this.props.pluginId),
    crashCount: getPluginCrashCount(this.props.pluginId),
  };

  static getDerivedStateFromError(
    error: unknown
  ): Partial<PluginBoundaryState> {
    const normalized =
      error instanceof Error
        ? error
        : new Error(String(error ?? 'Unknown error'));
    return { error: normalized };
  }

  componentDidCatch(error: Error, _errorInfo: ErrorInfo): void {
    const result = recordPluginCrash(this.props.pluginId, error);
    this.setState({
      error,
      quarantined: result.quarantined,
      crashCount: result.count,
    });
    if (result.quarantined) {
      this.props.onQuarantine?.(this.props.pluginId, error);
    }
  }

  private handleRetry = (): void => {
    if (this.state.quarantined) {
      clearPluginCrashState(this.props.pluginId);
    }
    this.setState({
      error: null,
      quarantined: false,
      crashCount: getPluginCrashCount(this.props.pluginId),
    });
    this.props.onRetry?.();
  };

  render(): ReactNode {
    const quarantined =
      this.state.quarantined || isPluginQuarantined(this.props.pluginId);
    const error =
      this.state.error ??
      (quarantined
        ? (crashLedger.get(this.props.pluginId)?.lastError ??
          new Error('Plugin quarantined after repeated crashes'))
        : null);

    if (error || quarantined) {
      const fallbackProps: PluginBoundaryFallbackProps = {
        pluginId: this.props.pluginId,
        slot: this.props.slot ?? this.props.slotName,
        error: error ?? new Error('Plugin render error'),
        quarantined,
        crashCount: this.state.crashCount,
        retry: this.handleRetry,
      };
      if (typeof this.props.fallback === 'function') {
        return this.props.fallback(fallbackProps);
      }
      if (this.props.fallback !== undefined) {
        return this.props.fallback;
      }
      return (
        <div
          role="alert"
          data-testid="plugin-boundary-fallback"
          data-plugin-id={this.props.pluginId}
          data-quarantined={quarantined ? 'true' : 'false'}
          className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <div className="min-w-0 flex-1 truncate">
            <span className="font-medium">{this.props.pluginId}</span>
            {': '}
            <span>
              {quarantined
                ? `Auto-quarantined after ${CRASH_QUARANTINE_THRESHOLD} crashes (${fallbackProps.error.message})`
                : fallbackProps.error.message}
            </span>
          </div>
          <button
            type="button"
            data-testid="plugin-boundary-retry"
            onClick={this.handleRetry}
            className="shrink-0 rounded border border-destructive/40 bg-background px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent"
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
