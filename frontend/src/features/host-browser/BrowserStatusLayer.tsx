import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Check,
  Download,
  FolderOpen,
  ShieldAlert,
  X,
} from 'lucide-react';

import {
  dismissBrowserDownload,
  getBrowserDownloads,
  getBrowserNotice,
  setBrowserNotice,
  subscribeBrowserChrome,
} from './browserChromeStore';
import { open } from '@tauri-apps/plugin-shell';
import { requestBrowserTabOpen } from './openBrowserTab';

export function BrowserNoticeBar({ tabId }: { tabId: string | null }) {
  const { t } = useTranslation('panels');
  const notice = useSyncExternalStore(
    subscribeBrowserChrome,
    () => (tabId ? getBrowserNotice(tabId) : null),
    () => null
  );
  if (!tabId || !notice) return null;
  const host = notice.url.replace(/^https?:\/\//, '') || notice.url;
  const text =
    notice.kind === 'popup-denied'
      ? t('browserPanel.popupDenied', { host })
      : t('browserPanel.navigationBlocked', { host });
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 text-xs">
      <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-600" />
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {notice.kind === 'popup-denied' && notice.reason !== 'blocked-host' ? (
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/8"
          onClick={() => {
            requestBrowserTabOpen({ url: notice.url, sourceTabId: tabId });
            setBrowserNotice(tabId, null);
          }}
        >
          {t('browserPanel.popupOpenAnyway')}
        </button>
      ) : null}
      <button
        type="button"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-primary/8"
        aria-label={t('browserPanel.dismiss')}
        onClick={() => setBrowserNotice(tabId, null)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function BrowserDownloadBar({ tabId }: { tabId: string | null }) {
  const { t } = useTranslation('panels');
  const items = useSyncExternalStore(
    subscribeBrowserChrome,
    () => getBrowserDownloads(tabId ?? ''),
    () => getBrowserDownloads('')
  );
  if (!tabId || items.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col border-b border-border/60 bg-muted/40">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex h-8 items-center gap-2 px-3 text-xs"
        >
          {item.state === 'completed' ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
          ) : item.state === 'failed' ? (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
          ) : (
            <Download className="h-3.5 w-3.5 shrink-0 animate-pulse text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate" title={item.path || item.fileName}>
            {item.fileName}
          </span>
          {item.state === 'completed' && item.path ? (
            <button
              type="button"
              className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/8"
              onClick={() => {
                void open(item.path as string);
              }}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t('browserPanel.downloadReveal')}
            </button>
          ) : null}
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-primary/8"
            aria-label={t('browserPanel.dismiss')}
            onClick={() => dismissBrowserDownload(tabId, item.id)}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
