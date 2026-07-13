import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, FileWarning, Loader2, RotateCw } from 'lucide-react';
import { officeApi } from '@/lib/api';
import { useOfficecliInstall } from '@/hooks/useOfficecliInstall';
import { useDocumentPreview } from '@/hooks/useFileContent';
import { ReadonlyDocumentPreview } from '@/components/previews/ReadonlyDocumentPreview';

// Machine code the backend returns when the officecli binary is missing
// (mirrors `WatchError::NotInstalled.code()` in src-tauri/src/office_watch.rs).
const NOT_INSTALLED = 'NOT_INSTALLED';

function isDocxPath(path: string) {
  return /\.docx$/i.test(path);
}

/**
 * Preview a .docx/.xlsx/.pptx file via a long-lived `officecli watch` server.
 *
 * The backend spawns one `officecli watch <file> --port N` process per file
 * (shared across panels by ref-count) and we point an iframe at its loopback
 * HTTP server. officecli drives live refresh over its own SSE channel, so the
 * preview and an agent's edits never contend for the file on disk.
 *
 * The iframe gets its real loopback origin (≠ the app's origin), so it keeps
 * `allow-same-origin` — it needs same-origin to talk to its own SSE channel,
 * and it still can't read the app's storage (different origin).
 *
 * When officecli is not installed, .docx files fall back to the built-in
 * content-only document pipeline; .xlsx/.pptx show an install prompt with a
 * streamed installer log.
 */
export function OfficePreview({ filePath }: { filePath: string }) {
  const { t } = useTranslation(['panels', 'common']);
  const [port, setPort] = useState<number | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const install = useOfficecliInstall();

  // Start the watch server on mount (and on retry); stop it on unmount. The
  // component is keyed by file path upstream, so a different file remounts
  // fresh.
  useEffect(() => {
    let cancelled = false;
    // Whether *our* start committed a ref-count. Drives exactly-one release so
    // an unmount-before-start race neither leaks a ref nor over-releases a
    // watch another panel still shares.
    let acquired = false;
    if (!filePath) {
      return;
    }
    officeApi
      .startWatch(filePath)
      .then((res) => {
        if (res.port != null) {
          acquired = true;
        }
        if (cancelled) {
          if (acquired) {
            void officeApi.stopWatch(filePath).catch(() => {});
          }
          return;
        }
        if (res.port != null) {
          setPort(res.port);
          setErrorCode(null);
          setErrorMessage(null);
        } else {
          setErrorCode(res.errorCode ?? 'START_FAILED');
          setErrorMessage(res.errorMessage);
        }
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setErrorCode('START_FAILED');
        setErrorMessage(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      if (acquired) {
        void officeApi.stopWatch(filePath).catch(() => {});
      }
    };
  }, [filePath, retryKey]);

  const watchUrl = useMemo(
    () => (port == null ? null : `http://127.0.0.1:${port}/`),
    [port]
  );

  const retry = useCallback(() => {
    setErrorCode(null);
    setErrorMessage(null);
    setPort(null);
    setRetryKey((k) => k + 1);
  }, []);

  // A finished install means officecli just became resolvable — retry the
  // watch automatically instead of asking the user to click again.
  useEffect(() => {
    if (install.status === 'completed' && errorCode === NOT_INSTALLED) {
      retry();
    }
  }, [install.status, errorCode, retry]);

  if (errorCode === NOT_INSTALLED) {
    const installControls = (
      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          disabled={install.status === 'installing'}
          onClick={() => {
            void install.start();
          }}
          className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-60"
        >
          {install.status === 'installing' ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('officePreview.installing')}
            </>
          ) : (
            <>
              <Download className="h-3.5 w-3.5" />
              {t('officePreview.install')}
            </>
          )}
        </button>
        {install.status === 'failed' && install.error && (
          <p className="max-w-md break-words text-xs text-[hsl(var(--destructive))]">
            {install.error}
          </p>
        )}
        {install.logs.length > 0 && (
          <pre className="max-h-40 w-full max-w-md overflow-auto rounded-md border border-border bg-muted/30 p-2 text-left text-[10px] leading-4 text-muted-foreground">
            {install.logs.slice(-40).join('\n')}
          </pre>
        )}
      </div>
    );

    // docx: keep the user productive with the built-in content-only preview
    // while offering the full-fidelity upgrade.
    if (isDocxPath(filePath)) {
      return (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-background px-4 py-3">
            <p className="text-xs text-muted-foreground">
              {t('officePreview.docxFallbackNotice')}
            </p>
            {installControls}
          </div>
          <div className="min-h-0 flex-1">
            <DocxFallbackPreview filePath={filePath} />
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <FileWarning className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t('officePreview.notInstalledTitle')}
        </p>
        <p className="max-w-sm text-xs text-muted-foreground">
          {t('officePreview.notInstalledHint')}
        </p>
        {installControls}
      </div>
    );
  }

  if (errorCode) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <FileWarning className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t('officePreview.watchFailedTitle')}
        </p>
        {errorMessage && (
          <p className="max-w-sm break-words text-xs text-muted-foreground">
            {errorMessage}
          </p>
        )}
        <button
          type="button"
          onClick={retry}
          className="mt-1 flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          <RotateCw className="h-3.5 w-3.5" />
          {t('officePreview.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      {watchUrl == null ? (
        <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('officePreview.loading')}
        </div>
      ) : (
        <iframe
          title={t('officePreview.title')}
          src={watchUrl}
          // Loopback keeps its real origin so officecli's own same-origin SSE
          // works; it still can't read the app's storage (different origin).
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full border-0 bg-white"
        />
      )}
    </div>
  );
}

/** Built-in content-only docx rendering, fetched only when actually shown. */
function DocxFallbackPreview({ filePath }: { filePath: string }) {
  const { t } = useTranslation(['panels', 'common']);
  const { data, isLoading, error } = useDocumentPreview(filePath);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        {t('officePreview.loading')}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
        <FileWarning className="h-8 w-8 opacity-50" />
        <p className="text-xs">
          {error instanceof Error ? error.message : String(error)}
        </p>
      </div>
    );
  }
  return (
    <ReadonlyDocumentPreview
      content={data?.content ?? ''}
      format={data?.format ?? 'text'}
    />
  );
}

export default OfficePreview;
