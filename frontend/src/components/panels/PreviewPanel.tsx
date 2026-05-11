import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Wrench, X } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { ScriptFixerDialog } from '@/components/dialogs/scripts/ScriptFixerDialog';
import {
  buildClickedElementData,
  useClickedElements,
} from '@/contexts/ClickedElementsProvider';
import { useProject } from '@/contexts/ProjectContext';
import { useTaskAttemptWithSession } from '@/hooks/useTaskAttempt';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useDevServer } from '@/hooks/useDevServer';
import { useDevserverPreview } from '@/hooks/useDevserverPreview';
import { useDevserverUrlFromLogs } from '@/hooks/useDevserverUrl';
import { useHasDevServerScript } from '@/hooks/useHasDevServerScript';
import { usePreviewSettings } from '@/hooks/usePreviewSettings';
import { useLogStream } from '@/hooks/useLogStream';
import { desktopApi } from '@/lib/api';
import { DevServerLogsView } from '@/components/tasks/TaskDetails/preview/DevServerLogsView';
import { NoServerContent } from '@/components/tasks/TaskDetails/preview/NoServerContent';
import { ReadyContent } from '@/components/tasks/TaskDetails/preview/ReadyContent';
import {
  PreviewInspectorPane,
  type PreviewConsoleEntry,
  type PreviewNetworkEntry,
} from '@/components/tasks/TaskDetails/preview/PreviewInspectorPane';
import { installWebCompanion } from '@/utils/installWebCompanion';
import {
  ClickToComponentListener,
  type OpenInEditorPayload,
} from '@/utils/previewBridge';

type CompanionInstallFeedback = {
  type: 'success' | 'error';
  message: string;
};

const MAX_PREVIEW_CONSOLE_ENTRIES = 200;
const MAX_PREVIEW_NETWORK_ENTRIES = 200;

function normalizePreviewUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `http://${trimmed}`;
}

function createBridgeToken(): string {
  return (
    window.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
}

type ProxyDetectedComponentPayload = {
  framework?: string;
  component?: string;
  htmlPreview?: string;
  file?: string;
  line?: number;
  column?: number;
  stack?: Array<{
    name?: string;
    file?: string;
  }>;
};

function parseSourceLocation(input?: string): {
  path: string;
  fileName: string;
  lineNumber: number;
  columnNumber: number;
} {
  if (!input) {
    return {
      path: '',
      fileName: '',
      lineNumber: 1,
      columnNumber: 1,
    };
  }

  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(input.trim());
  const fileName = match?.[1] ?? input;
  return {
    path: input,
    fileName,
    lineNumber: match?.[2] ? Number(match[2]) : 1,
    columnNumber: match?.[3] ? Number(match[3]) : 1,
  };
}

function createClickedElementPayload(
  payload: ProxyDetectedComponentPayload
): OpenInEditorPayload {
  const fallbackPath = payload.file
    ? `${payload.file}${payload.line ? `:${payload.line}` : ''}${payload.column ? `:${payload.column}` : ''}`
    : '';
  const selectedLocation = parseSourceLocation(
    fallbackPath || payload.stack?.[0]?.file
  );

  const components = (payload.stack ?? [])
    .filter((entry) => entry.file)
    .map((entry) => {
      const location = parseSourceLocation(entry.file);
      return {
        name: entry.name ?? payload.component ?? 'Unknown',
        props: {},
        source: {
          fileName: location.fileName,
          lineNumber: location.lineNumber,
          columnNumber: location.columnNumber,
        },
        pathToSource: location.path,
      };
    });

  return {
    selected: {
      editor: 'vscode',
      url: '',
      name: payload.component ?? components[0]?.name ?? 'Unknown',
      props: {},
      source: {
        fileName: selectedLocation.fileName,
        lineNumber: selectedLocation.lineNumber,
        columnNumber: selectedLocation.columnNumber,
      },
      pathToSource: selectedLocation.path,
    },
    components,
    trigger: 'context-menu',
    clickedElement: payload.htmlPreview
      ? {
          tag: payload.framework ?? 'component',
          dataset: {
            preview: payload.htmlPreview,
          },
        }
      : undefined,
  };
}

export function PreviewPanel() {
  const [iframeError, setIframeError] = useState(false);
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [companionReady, setCompanionReady] = useState(false);
  const [loadingTimeFinished, setLoadingTimeFinished] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [refreshKey] = useState(0);
  const [showLogs, setShowLogs] = useState(false);
  const [isSelectModeEnabled, setIsSelectModeEnabled] = useState(false);
  const [isToolbarBridgeReady, setIsToolbarBridgeReady] = useState(false);
  const [proxiedPreviewUrl, setProxiedPreviewUrl] = useState<string | null>(
    null
  );
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [isCompanionHelpDismissed, setIsCompanionHelpDismissed] =
    useState(false);
  const [companionInstallFeedback, setCompanionInstallFeedback] =
    useState<CompanionInstallFeedback | null>(null);
  const [devServerStartError, setDevServerStartError] = useState<string | null>(
    null
  );
  const [consoleEntries, setConsoleEntries] = useState<PreviewConsoleEntry[]>(
    []
  );
  const [networkEntries, setNetworkEntries] = useState<PreviewNetworkEntry[]>(
    []
  );
  const [sessionPreviewUrl, setSessionPreviewUrl] = useState<string | null>(
    null
  );
  const listenerRef = useRef<ClickToComponentListener | null>(null);
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeBootstrapTimerRef = useRef<number | null>(null);
  const bridgeTokenRef = useRef<string | null>(createBridgeToken());
  const requestedSelectModeRef = useRef<boolean | null>(null);
  const companionReadyRef = useRef(false);
  const toolbarBridgeReadyRef = useRef(false);
  const { project, projectId } = useProject();
  const { workspaceId } = useParams<{ workspaceId?: string }>();

  const attemptId = workspaceId;
  const { data: attempt } = useTaskAttemptWithSession(attemptId);
  const {
    overrideUrl: customUrl,
    setOverrideUrl,
    clearOverride,
  } = usePreviewSettings(attemptId);
  const { data: projectHasDevScript = false } =
    useHasDevServerScript(projectId);
  const { repos } = useAttemptRepo(attemptId);

  const {
    start: startDevServer,
    stop: stopDevServer,
    isStarting: isStartingDevServer,
    isStopping: isStoppingDevServer,
    runningDevServers,
    devServerProcesses,
  } = useDevServer(attemptId, {
    onStartError: (error) => {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : '启动开发服务器失败';
      setDevServerStartError(message);
    },
  });

  const primaryDevServer = runningDevServers[0];
  const logStream = useLogStream(primaryDevServer?.id ?? '');
  const lastKnownUrl = useDevserverUrlFromLogs(logStream.logs);

  const previewState = useDevserverPreview(attemptId, {
    projectHasDevScript,
    projectId: projectId!,
    lastKnownUrl,
  });

  const rawPreviewUrl = sessionPreviewUrl ?? customUrl ?? previewState.url;
  const effectiveUrl = proxiedPreviewUrl ?? rawPreviewUrl;
  const supportsNativeInspect = Boolean(
    rawPreviewUrl && proxiedPreviewUrl && proxiedPreviewUrl !== rawPreviewUrl
  );
  const {
    addElement,
    elements: clickedElements,
    workspaceRoot,
  } = useClickedElements();
  const latestClickedElement = clickedElements[clickedElements.length - 1];
  const previewInspectorElement = useMemo(
    () =>
      latestClickedElement
        ? buildClickedElementData(latestClickedElement, workspaceRoot)
        : null,
    [latestClickedElement, workspaceRoot]
  );

  const appendConsoleEntry = useCallback((entry: PreviewConsoleEntry) => {
    setConsoleEntries((previous) =>
      [...previous, entry].slice(-MAX_PREVIEW_CONSOLE_ENTRIES)
    );
  }, []);

  const appendNetworkEntry = useCallback((entry: PreviewNetworkEntry) => {
    setNetworkEntries((previous) =>
      [...previous, entry].slice(-MAX_PREVIEW_NETWORK_ENTRIES)
    );
  }, []);

  const handleCopyUrl = async () => {
    const urlToCopy = rawPreviewUrl ?? effectiveUrl;
    if (urlToCopy) {
      await navigator.clipboard.writeText(urlToCopy);
    }
  };

  const handlePreviewUrlChange = useCallback(
    (url: string | null) => {
      if (!url) {
        setSessionPreviewUrl(null);
        void clearOverride();
        return;
      }

      const normalized = normalizePreviewUrl(url);
      if (!normalized) return;

      setSessionPreviewUrl(normalized);
      void setOverrideUrl(normalized);
    },
    [clearOverride, setOverrideUrl]
  );

  useEffect(() => {
    setSessionPreviewUrl(null);
  }, [customUrl]);

  useEffect(() => {
    let cancelled = false;

    if (!rawPreviewUrl) {
      setProxiedPreviewUrl(null);
      return;
    }

    bridgeTokenRef.current = createBridgeToken();
    setProxiedPreviewUrl(null);

    desktopApi
      .getPreviewProxyUrl(rawPreviewUrl, bridgeTokenRef.current)
      .then((url) => {
        if (!cancelled) {
          setProxiedPreviewUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProxiedPreviewUrl(rawPreviewUrl);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [rawPreviewUrl]);

  const clearBridgeBootstrap = useCallback(() => {
    if (bridgeBootstrapTimerRef.current !== null) {
      window.clearInterval(bridgeBootstrapTimerRef.current);
      bridgeBootstrapTimerRef.current = null;
    }
  }, []);

  const handleIframeError = () => {
    clearBridgeBootstrap();
    previewIframeRef.current = null;
    requestedSelectModeRef.current = null;
    companionReadyRef.current = false;
    toolbarBridgeReadyRef.current = false;
    setIframeError(true);
    setPreviewLoaded(false);
    setCompanionReady(false);
    setIsToolbarBridgeReady(false);
    setIsSelectModeEnabled(false);
  };

  const bootstrapPreviewBridge = useCallback(
    (iframe: HTMLIFrameElement | null) => {
      previewIframeRef.current = iframe;

      if (!iframe) {
        return;
      }

      clearBridgeBootstrap();

      let attempts = 0;
      const syncBridge = () => {
        const listener = listenerRef.current;
        const activeIframe = previewIframeRef.current;
        if (!listener || !activeIframe) {
          clearBridgeBootstrap();
          return;
        }

        listener.enableButton(
          activeIframe,
          bridgeTokenRef.current ?? undefined
        );

        if (requestedSelectModeRef.current !== null) {
          listener.setTargetingEnabled(
            activeIframe,
            requestedSelectModeRef.current,
            bridgeTokenRef.current ?? undefined
          );
        }

        attempts += 1;
        if (
          attempts >= 12 ||
          (companionReadyRef.current &&
            (toolbarBridgeReadyRef.current ||
              requestedSelectModeRef.current === null))
        ) {
          clearBridgeBootstrap();
        }
      };

      syncBridge();
      bridgeBootstrapTimerRef.current = window.setInterval(syncBridge, 250);
    },
    [clearBridgeBootstrap]
  );

  const handleIframeLoad = (iframe: HTMLIFrameElement | null) => {
    previewIframeRef.current = iframe;
    setIframeError(false);
    setPreviewLoaded(true);
    setShowHelp(false);
    // Always bootstrap the companion bridge so element selection works
    // regardless of whether the URL is proxied through Tauri or not.
    bootstrapPreviewBridge(iframe);
  };

  useEffect(() => {
    const listener = new ClickToComponentListener(
      {
        onOpenInEditor: (payload) => {
          addElement(payload);
          requestedSelectModeRef.current = false;
          setIsSelectModeEnabled(false);
          setIsInspectorOpen(true);
        },
        onReady: () => {
          companionReadyRef.current = true;
          setCompanionReady(true);
          setShowLogs(false);
          setShowHelp(false);
          bootstrapPreviewBridge(previewIframeRef.current);
        },
        onToolbarBridgeReady: () => {
          toolbarBridgeReadyRef.current = true;
          setIsToolbarBridgeReady(true);

          if (
            requestedSelectModeRef.current !== null &&
            previewIframeRef.current !== null
          ) {
            listener.setTargetingEnabled(
              previewIframeRef.current,
              requestedSelectModeRef.current,
              bridgeTokenRef.current ?? undefined
            );
          }
        },
        onConsole: (payload) => {
          appendConsoleEntry({
            id: `${payload.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
            ...payload,
          });
        },
        onNetwork: (payload) => {
          appendNetworkEntry({
            id: `${payload.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
            ...payload,
          });
        },
      },
      () => bridgeTokenRef.current
    );

    listener.start();
    listenerRef.current = listener;

    return () => {
      listener.stop();
      listenerRef.current = null;
      clearBridgeBootstrap();
    };
  }, [
    addElement,
    appendConsoleEntry,
    appendNetworkEntry,
    bootstrapPreviewBridge,
    clearBridgeBootstrap,
  ]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Validate by message format instead of event.source reference, because
      // cross-origin iframe contentWindow proxy comparison fails in Tauri's
      // webview when the preview URL goes through the HTTP proxy.
      if (!event.data || event.data.source !== 'click-to-component') {
        return;
      }

      const currentBridgeToken = bridgeTokenRef.current;
      if (
        event.data.type !== 'ready' &&
        (!currentBridgeToken || event.data.bridgeToken !== currentBridgeToken)
      ) {
        return;
      }

      if (event.data.type !== 'component-detected') {
        return;
      }

      if (event.data.version === 2 && event.data.payload) {
        addElement(createClickedElementPayload(event.data.payload));
        requestedSelectModeRef.current = false;
        setIsSelectModeEnabled(false);
        setIsInspectorOpen(true);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [addElement]);

  useEffect(() => {
    clearBridgeBootstrap();
    previewIframeRef.current = null;
    requestedSelectModeRef.current = null;
    companionReadyRef.current = false;
    toolbarBridgeReadyRef.current = false;
    setPreviewLoaded(false);
    setCompanionReady(false);
    setIsToolbarBridgeReady(false);
    setIsSelectModeEnabled(false);
    setIframeError(false);
    setShowHelp(false);
    setIsCompanionHelpDismissed(false);
    setDevServerStartError(null);
    setConsoleEntries([]);
    setNetworkEntries([]);
  }, [clearBridgeBootstrap, effectiveUrl, primaryDevServer?.id]);

  useEffect(() => {
    // Sync select mode state via the companion bridge when it changes
    const listener = listenerRef.current;
    const iframe = previewIframeRef.current;
    if (listener && iframe) {
      listener.setTargetingEnabled(
        iframe,
        isSelectModeEnabled,
        bridgeTokenRef.current ?? undefined
      );
    }
  }, [isSelectModeEnabled]);

  function startTimer() {
    setLoadingTimeFinished(false);
    setTimeout(() => {
      setLoadingTimeFinished(true);
    }, 5000);
  }

  useEffect(() => {
    startTimer();
  }, []);

  const hasRunningDevServer = runningDevServers.length > 0;

  const failedDevServerProcess = devServerProcesses.find(
    (process) =>
      process.status === 'failed' ||
      (process.status === 'completed' &&
        process.exit_code !== null &&
        process.exit_code !== 0n)
  );
  const hasFailedDevServer = Boolean(failedDevServerProcess);

  useEffect(() => {
    if (
      loadingTimeFinished &&
      !previewLoaded &&
      devServerProcesses.length > 0 &&
      hasRunningDevServer
    ) {
      setShowHelp(true);
      setShowLogs(true);
      setLoadingTimeFinished(false);
    }
  }, [
    loadingTimeFinished,
    previewLoaded,
    devServerProcesses.length,
    hasRunningDevServer,
  ]);

  const installCompanionMutation = useMutation({
    onMutate: () => {
      setCompanionInstallFeedback(null);
    },
    mutationFn: async () => {
      if (!attemptId) {
        throw new Error('当前工作区不存在');
      }

      return installWebCompanion({
        workspaceId: attemptId,
        attempt,
        repos,
        runningDevServers,
      });
    },
    onSuccess: (result) => {
      setCompanionInstallFeedback({
        type: 'success',
        message: `Web Companion 已安装并接入 ${result.repoName}（${result.entryPath}）。将自动重启开发服务器。`,
      });
      clearBridgeBootstrap();
      previewIframeRef.current = null;
      requestedSelectModeRef.current = null;
      companionReadyRef.current = false;
      toolbarBridgeReadyRef.current = false;
      setIsCompanionHelpDismissed(true);
      setCompanionReady(false);
      setIsToolbarBridgeReady(false);
      setPreviewLoaded(false);
      setIsSelectModeEnabled(false);
      setShowHelp(false);

      if (hasRunningDevServer) {
        stopDevServer(undefined, {
          onSuccess: () => {
            startTimer();
            startDevServer();
          },
        });
      }
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : '安装 Web Companion 失败';
      setCompanionInstallFeedback({
        type: 'error',
        message,
      });
    },
  });

  const isPreviewReady = Boolean(rawPreviewUrl);
  const isPreviewReadyWithoutError = isPreviewReady && !iframeError;
  const showCompanionHelp =
    hasRunningDevServer &&
    previewLoaded &&
    !supportsNativeInspect &&
    !companionReady &&
    !iframeError &&
    !isCompanionHelpDismissed;
  const mode = iframeError
    ? 'error'
    : isPreviewReadyWithoutError
      ? 'ready'
      : hasRunningDevServer
        ? 'searching'
        : 'noServer';

  const toggleLogs = () => {
    setShowLogs((value) => !value);
  };

  const handleToggleSelectMode = (iframe: HTMLIFrameElement | null) => {
    const activeIframe = iframe ?? previewIframeRef.current;
    const nextEnabled = !isSelectModeEnabled;
    requestedSelectModeRef.current = nextEnabled;
    setIsSelectModeEnabled(nextEnabled);

    if (activeIframe) {
      previewIframeRef.current = activeIframe;
      bootstrapPreviewBridge(activeIframe);
    }

    if (companionReady && !isToolbarBridgeReady) {
      setCompanionInstallFeedback({
        type: 'success',
        message:
          'Detected an older Web Companion integration. Upgrading it now so the top toolbar selection button can control page targeting.',
      });

      if (!installCompanionMutation.isPending) {
        installCompanionMutation.mutate();
      }
    }
  };

  const handleStartDevServer = () => {
    clearBridgeBootstrap();
    previewIframeRef.current = null;
    requestedSelectModeRef.current = null;
    companionReadyRef.current = false;
    toolbarBridgeReadyRef.current = false;
    setLoadingTimeFinished(false);
    startDevServer();
    startTimer();
    setShowHelp(false);
    setPreviewLoaded(false);
    setCompanionReady(false);
    setIsToolbarBridgeReady(false);
    setIsSelectModeEnabled(false);
    setDevServerStartError(null);
  };

  const handleStopAndEdit = () => {
    stopDevServer(undefined, {
      onSuccess: () => {
        setShowHelp(false);
      },
    });
  };

  const handleFixDevScript = () => {
    if (!attemptId || repos.length === 0) return;

    const sessionId = devServerProcesses[0]?.session_id;

    ScriptFixerDialog.show({
      scriptType: 'dev_server',
      repos,
      workspaceId: attemptId,
      sessionId,
      initialRepoId: repos.length === 1 ? repos[0].id : undefined,
    });
  };

  const canFixDevScript = Boolean(attemptId && repos.length > 0);

  if (!attemptId) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="text-center text-muted-foreground">
          <p className="text-lg font-medium">{'预览'}</p>
          <p className="text-sm mt-2">{'选择工作区后即可查看开发预览。'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-1 flex flex-col min-h-0">
        {companionInstallFeedback && (
          <Alert
            variant={
              companionInstallFeedback.type === 'error'
                ? 'destructive'
                : 'default'
            }
            className="space-y-2"
          >
            <div className="flex items-start justify-between gap-2">
              <p className="flex-1 text-sm">
                {companionInstallFeedback.message}
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setCompanionInstallFeedback(null)}
                className="h-6 w-6 p-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </Alert>
        )}

        {mode === 'ready' ? (
          <ReadyContent
            url={effectiveUrl}
            displayUrl={rawPreviewUrl}
            iframeKey={`${effectiveUrl}-${refreshKey}`}
            onIframeError={handleIframeError}
            onIframeLoad={handleIframeLoad}
            onCopyUrl={handleCopyUrl}
            onStop={hasRunningDevServer ? stopDevServer : undefined}
            isStopping={isStoppingDevServer}
            onToggleSelectMode={handleToggleSelectMode}
            isSelectModeEnabled={isSelectModeEnabled}
            onToggleInspector={() => setIsInspectorOpen((open) => !open)}
            isInspectorOpen={isInspectorOpen}
            onUrlChange={handlePreviewUrlChange}
            hasUrlOverride={customUrl !== null}
            onClearUrlOverride={() => handlePreviewUrlChange(null)}
            inspectorPane={
              <PreviewInspectorPane
                clickedElement={previewInspectorElement}
                consoleEntries={consoleEntries}
                networkEntries={networkEntries}
                devServerProcesses={devServerProcesses}
                currentUrl={effectiveUrl ?? undefined}
                rawUrl={rawPreviewUrl ?? undefined}
                proxiedUrl={proxiedPreviewUrl}
                previewLoaded={previewLoaded}
                companionReady={companionReady}
                toolbarBridgeReady={isToolbarBridgeReady}
                isSelectModeEnabled={isSelectModeEnabled}
                onClearConsole={() => setConsoleEntries([])}
                onClearNetwork={() => setNetworkEntries([])}
                onClose={() => setIsInspectorOpen(false)}
              />
            }
          />
        ) : (
          <NoServerContent
            projectHasDevScript={projectHasDevScript}
            runningDevServer={hasRunningDevServer}
            isStartingDevServer={isStartingDevServer}
            startDevServer={handleStartDevServer}
            stopDevServer={stopDevServer}
            project={project}
            hasFailedDevServer={hasFailedDevServer}
            onFixDevScript={canFixDevScript ? handleFixDevScript : undefined}
            installWebCompanion={() => installCompanionMutation.mutate()}
            isInstallingCompanion={installCompanionMutation.isPending}
            startError={devServerStartError}
            onPreviewUrlSubmit={handlePreviewUrlChange}
          />
        )}

        {showCompanionHelp && (
          <Alert className="space-y-2 border-border bg-background/95">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1 text-sm">
                <p className="font-medium">{'预览已正常打开'}</p>
                <p className="text-muted-foreground">
                  {
                    '若需点击页面元素回到编辑器，请安装并接入 Web Companion。安装完成后会自动重启开发服务器。'
                  }
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => installCompanionMutation.mutate()}
                  disabled={installCompanionMutation.isPending}
                >
                  {installCompanionMutation.isPending
                    ? 'Installing…'
                    : '安装 Companion'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsCompanionHelpDismissed(true)}
                  className="h-6 w-6 p-0"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </Alert>
        )}

        {showHelp && (
          <Alert variant="destructive" className="space-y-2">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 space-y-2">
                <p className="font-bold">
                  {'我们在预览您的应用程序时遇到问题：'}
                </p>
                <ol className="list-decimal list-inside space-y-2">
                  <li>
                    {
                      '开发服务器是否成功启动？可能有一个您需要解决的错误，或者可能需要安装依赖项。'
                    }
                  </li>
                  <li>
                    {'您的开发服务器是否以格式打印 URL 和端口到终端 '}
                    <code>http://localhost:3000</code>
                    {' ？（这就是我们如何知道它正在运行）'}
                  </li>
                </ol>
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    onClick={handleStopAndEdit}
                    disabled={isStoppingDevServer}
                  >
                    {isStoppingDevServer && (
                      <Loader2 className="mr-2 animate-spin" />
                    )}
                    {'停止开发服务器并解决问题'}
                  </Button>
                  {canFixDevScript && (
                    <Button
                      variant="outline"
                      onClick={handleFixDevScript}
                      className="gap-1"
                    >
                      <Wrench className="h-4 w-4" />
                      {'修复开发脚本'}
                    </Button>
                  )}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowHelp(false)}
                className="h-6 w-6 p-0"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </Alert>
        )}

        <DevServerLogsView
          devServerProcesses={devServerProcesses}
          showLogs={showLogs}
          onToggle={toggleLogs}
          showToggleText
        />
      </div>
    </div>
  );
}
