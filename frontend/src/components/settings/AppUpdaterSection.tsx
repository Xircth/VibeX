import { useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { DownloadCloud, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SettingsSection } from '@/pages/settings/SettingsUi';

type UpdaterState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'ready'
  | 'error';

/**
 * In-app auto-updater (P1-6): check the signed release feed, download + install
 * the update with progress, then relaunch. Update artifacts must be signed with
 * the maintainer's private key (see docs/desktop-updater.md); the feed endpoint
 * and public key are configured in tauri.conf.json.
 */
export function AppUpdaterSection() {
  const [state, setState] = useState<UpdaterState>('idle');
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState('');

  const checkForUpdate = async () => {
    setState('checking');
    setMessage('');
    try {
      const found = await check();
      if (found) {
        setUpdate(found);
        setState('available');
      } else {
        setState('up-to-date');
      }
    } catch (error) {
      setState('error');
      setMessage(String(error));
    }
  };

  const downloadAndInstall = async () => {
    if (!update) return;
    setState('downloading');
    setProgress(0);
    let total = 0;
    let downloaded = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          setProgress(total > 0 ? Math.round((downloaded / total) * 100) : 0);
        } else if (event.event === 'Finished') {
          setProgress(100);
        }
      });
      setState('ready');
    } catch (error) {
      setState('error');
      setMessage(String(error));
    }
  };

  const restart = async () => {
    await relaunch();
  };

  return (
    <SettingsSection
      icon={DownloadCloud}
      title="应用更新"
      description="从签名的发布源检查更新，下载并安装后重启。"
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void checkForUpdate()}
            disabled={state === 'checking' || state === 'downloading'}
          >
            {state === 'checking' ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-4 w-4" />
            )}
            检查更新
          </Button>
          {state === 'up-to-date' ? (
            <span className="text-xs text-muted-foreground">已是最新版本。</span>
          ) : null}
        </div>

        {state === 'available' && update ? (
          <div className="space-y-2 rounded-[10px] border border-border p-3">
            <div className="text-sm font-medium">
              发现新版本 {update.version}
            </div>
            {update.body ? (
              <p className="max-h-32 overflow-y-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                {update.body}
              </p>
            ) : null}
            <Button size="sm" onClick={() => void downloadAndInstall()}>
              下载并安装
            </Button>
          </div>
        ) : null}

        {state === 'downloading' ? (
          <div className="space-y-1.5">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              下载中… {progress}%
            </p>
          </div>
        ) : null}

        {state === 'ready' ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              更新已安装，重启后生效。
            </span>
            <Button size="sm" onClick={() => void restart()}>
              立即重启
            </Button>
          </div>
        ) : null}

        {state === 'error' ? (
          <p className="text-xs text-destructive">更新失败：{message}</p>
        ) : null}
      </div>
    </SettingsSection>
  );
}
