import { useCallback, useEffect, useState } from 'react';
import { FileText, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { desktopApi } from '@/lib/api';
import { SettingsPageHeader, SettingsSection } from './SettingsUi';

const LINE_OPTIONS = [200, 500, 1000, 2000] as const;

/**
 * In-app log viewer (P2-8): a static tail of the newest rotating app log file
 * with refresh, a line-count selector, and an "open folder" action. Not a live
 * streaming console.
 */
export function LogsSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const [lines, setLines] = useState<string[]>([]);
  const [maxLines, setMaxLines] = useState<number>(500);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (count: number) => {
    setLoading(true);
    try {
      setLines(await desktopApi.getAppLogs(count));
    } catch {
      setLines([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(maxLines);
  }, [refresh, maxLines]);

  const openFolder = async () => {
    try {
      const dir = await desktopApi.getLogsDir();
      await desktopApi.revealInFileManager(dir);
    } catch {
      // best-effort
    }
  };

  return (
    <div className="settings-content">
      <SettingsPageHeader
        title={t('logs.title')}
        description={t('logs.description')}
      />
      <div className="settings-sections">
        <SettingsSection
          icon={FileText}
          title={t('logs.title')}
          description={t('logs.description')}
          action={
            <div className="flex items-center gap-2">
              <Select
                value={String(maxLines)}
                onValueChange={(value) => setMaxLines(Number(value))}
              >
                <SelectTrigger className="h-7 w-28 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {LINE_OPTIONS.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {t('logs.lines', { count: option })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => void refresh(maxLines)}
                disabled={loading}
              >
                {loading ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1 h-3.5 w-3.5" />
                )}
                {t('logs.refresh')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => void openFolder()}
              >
                <FolderOpen className="mr-1 h-3.5 w-3.5" />
                {t('logs.openFolder')}
              </Button>
            </div>
          }
        >
          <div className="overflow-hidden">
            {lines.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {t('logs.empty')}
              </p>
            ) : (
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[11px] font-mono leading-5">
                {lines.join('\n')}
              </pre>
            )}
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
