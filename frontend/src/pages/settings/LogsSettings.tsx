import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText,
  FolderOpen,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  desktopApi,
  type LogLevel,
  type LogRecord,
  type TargetDirective,
} from '@/lib/api';
import { applyLogBatch } from './logBuffer';
import { SettingsPageHeader, SettingsSection } from './SettingsUi';

const CAPTURE_LEVELS: LogLevel[] = [
  'all',
  'off',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
];
const VIEW_LEVELS = ['all', 'error', 'warn', 'info', 'debug', 'trace'] as const;
const DISPLAY_LIMIT = 2000;
const LOG_MODULES = [
  'agents',
  'application',
  'artifacts',
  'automation',
  'browser_cef',
  'browser_runtime',
  'conversations',
  'db',
  'delegation',
  'delegation_proto',
  'deployment',
  'executors',
  'git',
  'local_deployment',
  'plugins',
  'remote_protocol',
  'server',
  'services',
  'tool_runtime',
  'utils',
  'vibex',
  'workflows',
] as const;

const LEVEL_RANK: Record<string, number> = {
  ERROR: 5,
  WARN: 4,
  INFO: 3,
  DEBUG: 2,
  TRACE: 1,
};
const MIN_RANK: Record<string, number> = {
  all: 0,
  trace: 1,
  debug: 2,
  info: 3,
  warn: 4,
  error: 5,
};

function validTargets(targets: TargetDirective[]): TargetDirective[] {
  return targets.filter((t) => t.target.trim() !== '');
}

function unusedModule(targets: TargetDirective[]): string | undefined {
  const used = new Set(targets.map((t) => t.target));
  return LOG_MODULES.find((module) => !used.has(module));
}

function moduleOptions(current: string, targets: TargetDirective[]): string[] {
  const used = new Set(
    targets.filter((t) => t.target !== current).map((t) => t.target)
  );
  const options = LOG_MODULES.filter((module) => !used.has(module));
  return current && !options.includes(current)
    ? [current, ...options]
    : [...options];
}

function matchesFilter(
  record: LogRecord,
  minLevel: string,
  search: string
): boolean {
  if (
    (LEVEL_RANK[record.level.toUpperCase()] ?? 0) < (MIN_RANK[minLevel] ?? 0)
  ) {
    return false;
  }
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return (
    record.message.toLowerCase().includes(q) ||
    record.target.toLowerCase().includes(q)
  );
}

function levelClass(level: string): string {
  switch (level.toUpperCase()) {
    case 'ERROR':
      return 'text-destructive';
    case 'WARN':
      return 'text-amber-500';
    case 'INFO':
      return 'text-primary';
    default:
      return 'text-muted-foreground';
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const LogRow = memo(function LogRow({ record }: { record: LogRecord }) {
  const fieldEntries = Object.entries(record.fields ?? {});
  const hasDetail = fieldEntries.length > 0;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-border/40 px-2 py-1 hover:bg-muted/40">
      <div className="flex gap-2">
        {hasDetail ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-3 shrink-0 text-muted-foreground"
            aria-expanded={expanded}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {formatTime(record.timestamp_ms)}
        </span>
        <span
          className={`w-12 shrink-0 font-semibold uppercase ${levelClass(record.level)}`}
        >
          {record.level}
        </span>
        <span
          className="max-w-[12rem] shrink-0 truncate text-muted-foreground/80"
          title={record.target}
        >
          {record.target}
        </span>
        <span className="whitespace-pre-wrap break-all text-foreground/90">
          {record.message}
        </span>
      </div>
      {expanded && hasDetail ? (
        <div className="grid grid-cols-[auto_1fr] gap-x-3 py-1 pl-7 text-xs text-muted-foreground">
          {fieldEntries.map(([key, value]) => (
            <span key={key} className="contents">
              <span>{key}</span>
              <span className="break-all text-foreground/80">{value}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
});

export function LogsSettings() {
  const { t } = useTranslation('settings');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [captureLevel, setCaptureLevel] = useState<LogLevel>('info');
  const [targets, setTargets] = useState<TargetDirective[]>([]);
  const [envLocked, setEnvLocked] = useState(false);
  const [records, setRecords] = useState<LogRecord[]>([]);
  const [search, setSearch] = useState('');
  const [viewLevel, setViewLevel] = useState<string>('all');
  const [liveTail, setLiveTail] = useState(true);

  const settingsRef = useRef({
    level: 'info' as LogLevel,
    targets: [] as TargetDirective[],
  });
  const saveChainRef = useRef(Promise.resolve());
  const inFlightRef = useRef(0);
  const pendingRef = useRef<LogRecord[]>([]);
  const rafRef = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);

  const queueSave = useCallback(() => {
    inFlightRef.current += 1;
    setSaving(true);
    saveChainRef.current = saveChainRef.current.then(async () => {
      try {
        await desktopApi.setLogSettings({
          level: settingsRef.current.level,
          targets: validTargets(settingsRef.current.targets),
        });
      } catch {
        toast.error(t('logs.saveFailed'));
      } finally {
        inFlightRef.current -= 1;
        if (inFlightRef.current === 0) setSaving(false);
      }
    });
  }, [t]);

  const updateTargets = useCallback((next: TargetDirective[]) => {
    settingsRef.current = { ...settingsRef.current, targets: next };
    setTargets(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [settings, recent] = await Promise.all([
          desktopApi.getLogSettings(),
          desktopApi.getRecentLogs(DISPLAY_LIMIT),
        ]);
        if (cancelled) return;
        setCaptureLevel(settings.level);
        setTargets(settings.targets ?? []);
        settingsRef.current = {
          level: settings.level,
          targets: settings.targets ?? [],
        };
        setEnvLocked(settings.env_locked);
        setRecords(recent);
      } catch {
        if (!cancelled) setRecords([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void desktopApi
      .subscribeLogSettingsChanged((settings) => {
        setCaptureLevel(settings.level);
        setTargets(settings.targets ?? []);
        settingsRef.current = {
          level: settings.level,
          targets: settings.targets ?? [],
        };
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!liveTail) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const flush = () => {
      rafRef.current = null;
      const batch = pendingRef.current;
      if (batch.length === 0) return;
      pendingRef.current = [];
      setRecords((prev) => applyLogBatch(prev, batch, DISPLAY_LIMIT));
    };
    void desktopApi
      .subscribeLogAppended((record) => {
        pendingRef.current.push(record);
        if (rafRef.current == null) {
          rafRef.current = requestAnimationFrame(flush);
        }
      })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      });
    return () => {
      disposed = true;
      unlisten?.();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      pendingRef.current = [];
    };
  }, [liveTail]);

  const visible = useMemo(
    () => records.filter((r) => matchesFilter(r, viewLevel, search)),
    [records, viewLevel, search]
  );

  useEffect(() => {
    const el = listRef.current;
    if (!el || !liveTail || !nearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [visible, liveTail]);

  const handleLevelChange = (value: string) => {
    const level = value as LogLevel;
    settingsRef.current = { ...settingsRef.current, level };
    setCaptureLevel(level);
    queueSave();
  };

  const openFolder = async () => {
    try {
      const dir = await desktopApi.getLogsDir();
      await desktopApi.revealInFileManager(dir);
    } catch {
      toast.error(t('logs.openFolderFailed'));
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
          icon={SlidersHorizontal}
          title={t('logs.levelTitle')}
          description={t('logs.levelDescription')}
        >
          <div className="settings-row">
            <Label>{t('logs.captureLabel')}</Label>
            <div className="flex items-center gap-2">
              <Select
                value={captureLevel}
                onValueChange={handleLevelChange}
                disabled={envLocked}
              >
                <SelectTrigger
                  className="h-8 min-w-32 text-sm"
                  disabled={saving}
                  aria-label={t('logs.captureLabel')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CAPTURE_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {t(`logs.levels.${level}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : null}
            </div>
          </div>
          {envLocked ? (
            <p className="settings-row__description text-amber-500">
              {t('logs.envLocked')}
            </p>
          ) : null}
          <div className="settings-row">
            <div>
              <Label>{t('logs.targetsTitle')}</Label>
              <p className="settings-row__description">
                {t('logs.targetsDescription')}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const module = unusedModule(settingsRef.current.targets);
                if (!module) return;
                updateTargets([
                  ...settingsRef.current.targets,
                  { target: module, level: 'debug' },
                ]);
                queueSave();
              }}
              disabled={envLocked || unusedModule(targets) == null}
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('logs.targetsAdd')}
            </Button>
          </div>
          {targets.length > 0 ? (
            <div className="space-y-1.5">
              {targets.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Select
                    value={row.target}
                    onValueChange={(value) => {
                      updateTargets(
                        settingsRef.current.targets.map((item, i) =>
                          i === index ? { ...item, target: value } : item
                        )
                      );
                      queueSave();
                    }}
                    disabled={envLocked}
                  >
                    <SelectTrigger
                      className="h-8 min-w-0 flex-1 text-sm"
                      aria-label={t('logs.targetsModule')}
                    >
                      <SelectValue placeholder={t('logs.targetsModule')} />
                    </SelectTrigger>
                    <SelectContent>
                      {moduleOptions(row.target, targets).map((module) => (
                        <SelectItem key={module} value={module}>
                          {module}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={row.level}
                    onValueChange={(value) => {
                      updateTargets(
                        settingsRef.current.targets.map((item, i) =>
                          i === index
                            ? { ...item, level: value as LogLevel }
                            : item
                        )
                      );
                      queueSave();
                    }}
                    disabled={envLocked}
                  >
                    <SelectTrigger
                      className="h-8 w-28 text-sm"
                      aria-label={t('logs.targetsLevel')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CAPTURE_LEVELS.map((level) => (
                        <SelectItem key={level} value={level}>
                          {t(`logs.levels.${level}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 shrink-0"
                    onClick={() => {
                      updateTargets(
                        settingsRef.current.targets.filter(
                          (_, i) => i !== index
                        )
                      );
                      queueSave();
                    }}
                    disabled={envLocked}
                    aria-label={t('logs.targetsRemove')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </SettingsSection>

        <SettingsSection
          icon={FileText}
          title={t('logs.viewerTitle')}
          description={t('logs.viewerDescription')}
          action={
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={liveTail ? 'default' : 'outline'}
                onClick={() => setLiveTail((v) => !v)}
              >
                {liveTail ? (
                  <Pause className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                )}
                {liveTail ? t('logs.pause') : t('logs.resume')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void desktopApi
                    .getRecentLogs(DISPLAY_LIMIT)
                    .then(setRecords)
                    .catch(() => undefined);
                }}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {t('logs.refresh')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setRecords([])}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                {t('logs.clear')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void openFolder()}
              >
                <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                {t('logs.openFolder')}
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('logs.searchPlaceholder')}
                className="h-8 min-w-0 flex-1 text-sm"
              />
              <div className="flex shrink-0 items-center gap-2">
                <Select value={viewLevel} onValueChange={setViewLevel}>
                  <SelectTrigger
                    className="h-8 w-32 text-sm"
                    aria-label={t('logs.viewLevels.all')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VIEW_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {t(`logs.viewLevels.${level}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="whitespace-nowrap text-sm text-muted-foreground">
                  {t('logs.shownCount', {
                    shown: visible.length,
                    total: records.length,
                  })}
                </span>
              </div>
            </div>
            <div
              ref={listRef}
              onScroll={(event) => {
                const el = event.currentTarget;
                nearBottomRef.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
              className="max-h-[60vh] overflow-auto rounded-md border bg-background/50 font-mono text-xs leading-5"
            >
              {loading ? (
                <p className="flex items-center justify-center px-3 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </p>
              ) : visible.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  {t('logs.empty')}
                </p>
              ) : (
                visible.map((record) => (
                  <LogRow key={record.seq} record={record} />
                ))
              )}
            </div>
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
