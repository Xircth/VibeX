import { useState, useEffect, useCallback } from 'react';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import {
  Play,
  Square,
  AlertCircle,
  CheckCircle,
  Clock,
  Cog,
  ArrowLeft,
} from 'lucide-react';
import { executionProcessesApi } from '@/lib/api';
import { ProfileVariantBadge } from '@/components/common/ProfileVariantBadge.tsx';
import { useExecutionProcesses } from '@/hooks/useExecutionProcesses';
import { useLogStream } from '@/hooks/useLogStream';
import { extractProfileFromAction } from '@/utils/executor';
import { ProcessLogsViewerContent } from './ProcessLogsViewer';
import type { ExecutionProcessStatus, ExecutionProcess } from 'shared/types';

import { useProcessSelection } from '@/contexts/ProcessSelectionContext';
import { useRetryUi } from '@/contexts/RetryUiContext';

interface ProcessesTabProps {
  sessionId?: string;
}

function ProcessesTab({ sessionId }: ProcessesTabProps) {
  const {
    executionProcesses,
    executionProcessesById,
    isLoading: processesLoading,
    isConnected,
    error: processesError,
  } = useExecutionProcesses(sessionId ?? '', { showSoftDeleted: true });
  const { selectedProcessId, setSelectedProcessId } = useProcessSelection();
  const [loadingProcessId, setLoadingProcessId] = useState<string | null>(null);
  const [localProcessDetails, setLocalProcessDetails] = useState<
    Record<string, ExecutionProcess>
  >({});
  const [copied, triggerCopied] = useTemporaryFlag(2000);

  const selectedProcess = selectedProcessId
    ? localProcessDetails[selectedProcessId] ||
      executionProcessesById[selectedProcessId]
    : null;

  const { logs, error: logsError } = useLogStream(selectedProcess?.id ?? '');

  useEffect(() => {
    setLocalProcessDetails({});
    setLoadingProcessId(null);
  }, [sessionId]);

  const handleCopyLogs = useCallback(async () => {
    if (logs.length === 0) return;

    const text = logs.map((entry) => entry.content).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      triggerCopied();
    } catch (err) {
      console.warn('Copy to clipboard failed:', err);
    }
  }, [logs, triggerCopied]);

  const getStatusIcon = (status: ExecutionProcessStatus) => {
    switch (status) {
      case 'running':
        return <Play className="h-4 w-4 text-primary" />;
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-[hsl(var(--success))]" />;
      case 'failed':
        return <AlertCircle className="h-4 w-4 text-destructive" />;
      case 'killed':
        return <Square className="h-4 w-4 text-muted-foreground" />;
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getStatusColor = (status: ExecutionProcessStatus) => {
    switch (status) {
      case 'running':
        return 'border-[hsl(var(--primary)/0.28)] bg-[hsl(var(--primary)/0.08)] text-primary';
      case 'completed':
        return 'border-[hsl(var(--success)/0.28)] bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]';
      case 'failed':
        return 'border-[hsl(var(--destructive)/0.28)] bg-[hsl(var(--destructive)/0.08)] text-destructive';
      case 'killed':
        return 'border-border bg-muted/40 text-muted-foreground';
      default:
        return 'border-border bg-muted/40 text-muted-foreground';
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const fetchProcessDetails = useCallback(async (processId: string) => {
    try {
      setLoadingProcessId(processId);
      const result = await executionProcessesApi.getDetails(processId);

      if (result !== undefined) {
        setLocalProcessDetails((prev) => ({
          ...prev,
          [processId]: result,
        }));
      }
    } catch (err) {
      console.error('Failed to fetch process details:', err);
    } finally {
      setLoadingProcessId((current) =>
        current === processId ? null : current
      );
    }
  }, []);

  // Automatically fetch process details when selectedProcessId changes
  useEffect(() => {
    if (!sessionId || !selectedProcessId) {
      return;
    }

    if (
      !localProcessDetails[selectedProcessId] &&
      loadingProcessId !== selectedProcessId
    ) {
      fetchProcessDetails(selectedProcessId);
    }
  }, [
    sessionId,
    selectedProcessId,
    localProcessDetails,
    loadingProcessId,
    fetchProcessDetails,
  ]);

  const handleProcessClick = async (process: ExecutionProcess) => {
    setSelectedProcessId(process.id);

    // If we don't have details for this process, fetch them
    if (!localProcessDetails[process.id]) {
      await fetchProcessDetails(process.id);
    }
  };

  const { isProcessGreyed } = useRetryUi();

  if (!sessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <Cog className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>{'选择尝试以查看执行进程。'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {!selectedProcessId ? (
        <div className="flex-1 overflow-auto px-4 pb-20 pt-4">
          {processesError && (
            <div className="mb-3 text-sm text-destructive">
              {'加载进程的实时更新失败。'}
              {!isConnected && ` ${'重新连接中...'}`}
            </div>
          )}
          {processesLoading && executionProcesses.length === 0 ? (
            <div className="flex items-center justify-center text-muted-foreground py-10">
              <p>{'加载执行进程中...'}</p>
            </div>
          ) : executionProcesses.length === 0 ? (
            <div className="flex items-center justify-center text-muted-foreground py-10">
              <div className="text-center">
                <Cog className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>{'未找到此尝试的执行进程。'}</p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {executionProcesses.map((process) => (
                <div
                  key={process.id}
                  className={`border rounded-lg p-4 hover:bg-muted/30 cursor-pointer transition-colors ${
                    loadingProcessId === process.id
                      ? 'opacity-50 cursor-wait'
                      : isProcessGreyed(process.id)
                        ? 'opacity-50'
                        : ''
                  }`}
                  onClick={() => handleProcessClick(process)}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-3 min-w-0">
                      {getStatusIcon(process.status)}
                      <div className="min-w-0">
                        <h3 className="font-medium text-sm">
                          {process.run_reason}
                        </h3>
                        <p
                          className="text-sm text-muted-foreground mt-1 truncate"
                          title={process.id}
                        >
                          {`进程 ID：${process.id}`}
                        </p>
                        {process.dropped && (
                          <span
                            className="mt-1 inline-block rounded-full border border-[hsl(var(--warning)/0.28)] bg-[hsl(var(--warning)/0.08)] px-1.5 py-0.5 text-[10px] text-[hsl(var(--warning))]"
                            title={
                              '因恢复而删除：时间轴已恢复到检查点，后续执行已被移除'
                            }
                          >
                            {'已删除'}
                          </span>
                        )}
                        {
                          <p className="text-sm text-muted-foreground mt-1">
                            {'代理：'}{' '}
                            {(() => {
                              const profileVariant = extractProfileFromAction(
                                process.executor_action ?? null
                              );

                              return profileVariant ? (
                                <ProfileVariantBadge
                                  profileVariant={profileVariant}
                                />
                              ) : null;
                            })()}
                          </p>
                        }
                      </div>
                    </div>
                    <div className="text-right">
                      <span
                        className={`inline-block px-2 py-1 text-xs font-medium border rounded-full ${getStatusColor(
                          process.status
                        )}`}
                      >
                        {process.status}
                      </span>
                      {process.exit_code !== null && (
                        <p className="text-xs text-muted-foreground mt-1">
                          {`退出：${process.exit_code.toString()}`}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 text-xs text-muted-foreground">
                    <div className="flex justify-between">
                      <span>{`开始：${formatDate(process.started_at)}`}</span>
                      {process.completed_at && (
                        <span>
                          {`完成：${formatDate(process.completed_at)}`}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between px-4 py-2 border-b flex-shrink-0">
            <h2 className="text-lg font-semibold">{'进程详情'}</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopyLogs}
                disabled={logs.length === 0}
                className={`flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md border border-border transition-colors ${
                  copied
                    ? 'text-success'
                    : logs.length === 0
                      ? 'text-muted-foreground opacity-50 cursor-not-allowed'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }`}
              >
                {copied ? '已复制！' : '复制日志'}
              </button>
              <button
                onClick={() => setSelectedProcessId(null)}
                className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md border border-border transition-colors"
              >
                <ArrowLeft className="h-4 w-4" />
                {'返回列表'}
              </button>
            </div>
          </div>
          <div className="flex-1">
            {selectedProcess ? (
              <ProcessLogsViewerContent logs={logs} error={logsError} />
            ) : loadingProcessId === selectedProcessId ? (
              <div className="text-center text-muted-foreground">
                <p>{'加载进程详情中...'}</p>
              </div>
            ) : (
              <div className="text-center text-muted-foreground">
                <p>{'加载进程详情失败。请重试。'}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ProcessesTab;
