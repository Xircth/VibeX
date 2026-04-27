import { useEffect, useMemo, useState } from 'react';
import {
  Bug,
  FileCode2,
  Globe,
  Layers3,
  Logs,
  Radio,
  SquareTerminal,
  Terminal,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ClickedElementChipData } from '@/contexts/ClickedElementsProvider';
import ProcessLogsViewer from '@/components/tasks/TaskDetails/ProcessLogsViewer';
import { getDevServerWorkingDir } from '@/lib/devServerUtils';
import { cn } from '@/lib/utils';
import type {
  PreviewConsolePayload,
  PreviewNetworkPayload,
} from '@/utils/previewBridge';
import type { ExecutionProcess } from 'shared/types';

type InspectorTab = 'elements' | 'console' | 'network' | 'logs' | 'page';

export type PreviewConsoleEntry = PreviewConsolePayload & { id: string };
export type PreviewNetworkEntry = PreviewNetworkPayload & { id: string };

interface PreviewInspectorPaneProps {
  clickedElement: ClickedElementChipData | null;
  consoleEntries: PreviewConsoleEntry[];
  networkEntries: PreviewNetworkEntry[];
  devServerProcesses: ExecutionProcess[];
  currentUrl?: string;
  rawUrl?: string;
  proxiedUrl?: string | null;
  previewLoaded: boolean;
  companionReady: boolean;
  toolbarBridgeReady: boolean;
  isSelectModeEnabled: boolean;
  onClearConsole: () => void;
  onClearNetwork: () => void;
  onClose: () => void;
}

const copy = {
  inspector: '\u9884\u89c8\u68c0\u67e5\u5668',
  closeInspector: '\u5173\u95ed\u9884\u89c8\u68c0\u67e5\u5668',
  elements: '\u5143\u7d20',
  console: '\u63a7\u5236\u53f0',
  network: '\u7f51\u7edc',
  logs: '\u65e5\u5fd7',
  page: '\u9875\u9762',
  noSource: '\u65e0\u6e90\u7801\u4f4d\u7f6e',
  hierarchy: '\u7ec4\u4ef6\u5c42\u7ea7',
  current: '\u5f53\u524d',
  parent: '\u4e0a\u5c42',
  elementHtml: '\u5143\u7d20 HTML',
  emptyElements:
    '\u4f7f\u7528\u9876\u90e8\u201c\u9009\u62e9\u5143\u7d20\u4f5c\u4e3a\u5185\u5bb9\u201d\u540e\uff0c\u8fd9\u91cc\u4f1a\u663e\u793a\u5f53\u524d\u9875\u9762\u5143\u7d20\u7684\u7ec4\u4ef6\u4fe1\u606f\u3002',
  emptyConsole:
    '\u5c1a\u672a\u6355\u83b7\u5230\u63a7\u5236\u53f0\u8f93\u51fa\u3002',
  emptyNetwork: '\u5c1a\u672a\u6355\u83b7\u5230\u7f51\u7edc\u8bf7\u6c42\u3002',
  clear: '\u6e05\u7a7a',
  noLogs: '\u5f53\u524d\u6ca1\u6709\u53ef\u7528\u7684\u5f00\u53d1\u670d\u52a1\u5668\u65e5\u5fd7\u3002',
  previewStatus: '\u9884\u89c8\u72b6\u6001',
  toolbarBridge: '\u5de5\u5177\u680f\u6865\u63a5',
  selectMode: '\u5143\u7d20\u9009\u62e9\u6a21\u5f0f',
  currentUrl: '\u5f53\u524d\u5730\u5740',
  proxyUrl: '\u4ee3\u7406\u9884\u89c8\u5730\u5740',
  loaded: '\u5df2\u52a0\u8f7d',
  loading: '\u52a0\u8f7d\u4e2d',
  connected: '\u5df2\u8fde\u63a5',
  disconnected: '\u672a\u8fde\u63a5',
  ready: '\u5df2\u5c31\u7eea',
  notReady: '\u672a\u5c31\u7eea',
  enabled: '\u5df2\u5f00\u542f',
  disabled: '\u5df2\u5173\u95ed',
  unavailable: '\u4e0d\u53ef\u7528',
  nativeDevtoolsNote:
    '\u539f\u751f\u6d4f\u89c8\u5668 DevTools \u65e0\u6cd5\u505c\u9760\u5230 Tauri \u9762\u677f\u5185\u90e8\uff0c\u8fd9\u91cc\u5c55\u793a\u7684\u662f\u5e94\u7528\u5185\u7f6e\u7684\u9884\u89c8\u68c0\u67e5\u5668\u3002',
};

const tabs: Array<{
  id: InspectorTab;
  label: string;
  icon: LucideIcon;
}> = [
  { id: 'elements', label: copy.elements, icon: FileCode2 },
  { id: 'console', label: copy.console, icon: Terminal },
  { id: 'network', label: copy.network, icon: Radio },
  { id: 'logs', label: copy.logs, icon: Logs },
  { id: 'page', label: copy.page, icon: Globe },
];

function getProcessLabel(process: ExecutionProcess, index: number): string {
  const workingDir = getDevServerWorkingDir(process);
  if (!workingDir) {
    return `Dev Server ${index + 1}`;
  }

  const parts = workingDir.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? workingDir;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function consoleLevelClass(level: PreviewConsoleEntry['level']): string {
  switch (level) {
    case 'error':
      return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300';
    case 'warn':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
    case 'info':
      return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300';
    case 'debug':
      return 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300';
    default:
      return 'border-border/60 bg-muted/20 text-foreground';
  }
}

function networkStatusClass(entry: PreviewNetworkEntry): string {
  if (entry.error) {
    return 'text-red-600 dark:text-red-300';
  }
  if (entry.status == null) {
    return 'text-muted-foreground';
  }
  if (entry.status >= 400) {
    return 'text-red-600 dark:text-red-300';
  }
  if (entry.status >= 300) {
    return 'text-amber-600 dark:text-amber-300';
  }
  return 'text-emerald-600 dark:text-emerald-300';
}

function StatusRow({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'warning';
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-medium',
          tone === 'success' && 'text-emerald-600 dark:text-emerald-400',
          tone === 'warning' && 'text-amber-600 dark:text-amber-300'
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function PreviewInspectorPane({
  clickedElement,
  consoleEntries,
  networkEntries,
  devServerProcesses,
  currentUrl,
  rawUrl,
  proxiedUrl,
  previewLoaded,
  companionReady,
  toolbarBridgeReady,
  isSelectModeEnabled,
  onClearConsole,
  onClearNetwork,
  onClose,
}: PreviewInspectorPaneProps) {
  const [activeTab, setActiveTab] = useState<InspectorTab>('elements');
  const [activeProcessId, setActiveProcessId] = useState<string | null>(null);

  useEffect(() => {
    if (clickedElement) {
      setActiveTab('elements');
    }
  }, [clickedElement]);

  useEffect(() => {
    if (
      activeProcessId &&
      devServerProcesses.some((process) => process.id === activeProcessId)
    ) {
      return;
    }

    setActiveProcessId(devServerProcesses[0]?.id ?? null);
  }, [activeProcessId, devServerProcesses]);

  const activeProcess = useMemo(
    () =>
      devServerProcesses.find((process) => process.id === activeProcessId) ??
      devServerProcesses[0] ??
      null,
    [activeProcessId, devServerProcesses]
  );

  const componentChain = clickedElement?.componentChain ?? [];

  return (
    <aside className="flex h-full w-[380px] min-w-[340px] max-w-[460px] shrink-0 flex-col border-l border-border bg-background/95 backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Bug className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">
            {copy.inspector}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label={copy.closeInspector}
          title={copy.closeInspector}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-2 py-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isSelected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors',
                isSelected
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'elements' ? (
          <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
            {clickedElement ? (
              <>
                <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <FileCode2 className="h-4 w-4 text-muted-foreground" />
                    {clickedElement.componentName}
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {clickedElement.filePath || copy.noSource}
                  </div>
                </div>

                <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <Layers3 className="h-3.5 w-3.5" />
                    {copy.hierarchy}
                  </div>
                  <div className="space-y-1">
                    {componentChain.map((name, index) => (
                      <div
                        key={`${name}-${index}`}
                        className={cn(
                          'rounded-md border border-border/50 px-2 py-1 text-xs',
                          index === 0
                            ? 'bg-accent/40 text-foreground'
                            : 'bg-background text-muted-foreground'
                        )}
                      >
                        {index === 0
                          ? copy.current
                          : `${copy.parent} ${index}`}{' '}
                        - {name}
                      </div>
                    ))}
                  </div>
                </div>

                {clickedElement.htmlPreview ? (
                  <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {copy.elementHtml}
                    </div>
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border/50 bg-background p-2 font-mono text-[11px] leading-5 text-foreground">
                      {clickedElement.htmlPreview}
                    </pre>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
                <FileCode2 className="h-8 w-8 opacity-60" />
                <p>{copy.emptyElements}</p>
              </div>
            )}
          </div>
        ) : null}

        {activeTab === 'console' ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-xs text-muted-foreground">
                {consoleEntries.length} entries
              </span>
              <button
                type="button"
                onClick={onClearConsole}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Trash2 className="h-3 w-3" />
                {copy.clear}
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {consoleEntries.length > 0 ? (
                consoleEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className={cn(
                      'rounded-md border px-2 py-1.5 font-mono text-[11px] leading-5',
                      consoleLevelClass(entry.level)
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="uppercase">{entry.level}</span>
                      <span className="text-muted-foreground">
                        {formatTime(entry.timestamp)}
                      </span>
                    </div>
                    <div className="whitespace-pre-wrap break-words">
                      {entry.message}
                    </div>
                    {entry.source ? (
                      <div className="mt-1 truncate text-muted-foreground">
                        {entry.source}
                        {entry.line ? `:${entry.line}` : ''}
                        {entry.column ? `:${entry.column}` : ''}
                      </div>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
                  <Terminal className="h-8 w-8 opacity-60" />
                  <p>{copy.emptyConsole}</p>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {activeTab === 'network' ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-xs text-muted-foreground">
                {networkEntries.length} requests
              </span>
              <button
                type="button"
                onClick={onClearNetwork}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Trash2 className="h-3 w-3" />
                {copy.clear}
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
              {networkEntries.length > 0 ? (
                networkEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className="space-y-1 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="rounded bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {entry.method}
                        </span>
                        <span
                          className={cn(
                            'font-mono text-[11px] font-semibold',
                            networkStatusClass(entry)
                          )}
                        >
                          {entry.error ? 'ERR' : (entry.status ?? 'PENDING')}
                        </span>
                      </div>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {entry.durationMs != null ? `${entry.durationMs}ms` : ''}
                      </span>
                    </div>
                    <div className="break-all font-mono text-[11px] text-foreground">
                      {entry.url}
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span>{entry.kind.toUpperCase()}</span>
                      <span>{formatTime(entry.timestamp)}</span>
                    </div>
                    {entry.error ? (
                      <div className="text-[11px] text-red-600 dark:text-red-300">
                        {entry.error}
                      </div>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
                  <Radio className="h-8 w-8 opacity-60" />
                  <p>{copy.emptyNetwork}</p>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {activeTab === 'logs' ? (
          <div className="flex h-full min-h-0 flex-col">
            {devServerProcesses.length > 0 ? (
              <>
                {devServerProcesses.length > 1 ? (
                  <div className="flex border-b border-border bg-muted/20 px-2">
                    {devServerProcesses.map((process, index) => (
                      <button
                        key={process.id}
                        type="button"
                        onClick={() => setActiveProcessId(process.id)}
                        className={cn(
                          'border-b-2 px-3 py-2 text-xs transition-colors',
                          activeProcess?.id === process.id
                            ? 'border-primary text-foreground'
                            : 'border-transparent text-muted-foreground hover:text-foreground'
                        )}
                        title={getDevServerWorkingDir(process) ?? undefined}
                      >
                        {getProcessLabel(process, index)}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="min-h-0 flex-1">
                  {activeProcess ? (
                    <ProcessLogsViewer processId={activeProcess.id} />
                  ) : null}
                </div>
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
                <SquareTerminal className="h-8 w-8 opacity-60" />
                <p>{copy.noLogs}</p>
              </div>
            )}
          </div>
        ) : null}

        {activeTab === 'page' ? (
          <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
            <StatusRow
              label={copy.previewStatus}
              value={previewLoaded ? copy.loaded : copy.loading}
              tone={previewLoaded ? 'success' : 'warning'}
            />
            <StatusRow
              label="Web Companion"
              value={companionReady ? copy.connected : copy.disconnected}
              tone={companionReady ? 'success' : 'warning'}
            />
            <StatusRow
              label={copy.toolbarBridge}
              value={toolbarBridgeReady ? copy.ready : copy.notReady}
              tone={toolbarBridgeReady ? 'success' : 'warning'}
            />
            <StatusRow
              label={copy.selectMode}
              value={isSelectModeEnabled ? copy.enabled : copy.disabled}
              tone={isSelectModeEnabled ? 'success' : 'default'}
            />

            <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {copy.currentUrl}
              </div>
              <div className="break-all font-mono text-xs text-foreground">
                {currentUrl || copy.unavailable}
              </div>
            </div>

            {proxiedUrl && proxiedUrl !== rawUrl ? (
              <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {copy.proxyUrl}
                </div>
                <div className="break-all font-mono text-xs text-foreground">
                  {proxiedUrl}
                </div>
              </div>
            ) : null}

            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground">
              {copy.nativeDevtoolsNote}
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
