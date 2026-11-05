import { Check, Loader2 } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import type { AgentOperationState } from '@/features/agent-management';

const operationStages: Record<AgentOperationState['kind'], readonly string[]> =
  {
    install: [
      'stageEnvCheck',
      'stageAcpCheck',
      'stagePrepare',
      'stageInstall',
      'stageVerify',
      'stageComplete',
    ],
    update: [
      'stageEnvCheck',
      'stageAcpCheck',
      'stagePrepare',
      'stageUpdate',
      'stageVerify',
      'stageComplete',
    ],
    repair: [
      'stageEnvCheck',
      'stageAcpCheck',
      'stagePrepare',
      'stageRepair',
      'stageVerify',
      'stageComplete',
    ],
    rollback: ['stagePrepare', 'stageRollback', 'stageVerify', 'stageComplete'],
    uninstall: [
      'stagePrepare',
      'stageUninstall',
      'stageCleanup',
      'stageComplete',
    ],
    remove: ['stagePrepare', 'stageRemove', 'stageCleanup', 'stageComplete'],
    check: ['stagePrepare', 'stageCheck', 'stageSummary', 'stageComplete'],
  };

function stageIndexForProgress(progress: number, stageCount: number) {
  if (stageCount === 6) {
    if (progress >= 100) return 5;
    if (progress >= 80) return 4;
    if (progress >= 45) return 3;
    if (progress >= 30) return 2;
    if (progress >= 15) return 1;
    return 0;
  }
  if (progress >= 100) return 3;
  if (progress >= 75) return 2;
  if (progress >= 20) return 1;
  return 0;
}

function operationMessage(
  t: TFunction<'settings'>,
  language: string | undefined,
  operation: AgentOperationState
): string {
  if (!language?.startsWith('en') && operation.message?.trim()) {
    return operation.message;
  }
  if (operation.status === 'succeeded') return t('agents.operationComplete');
  if (operation.status === 'failed') return t('agents.operationFailed');
  if (operation.status === 'canceled') return t('agents.operationCanceled');
  if (operation.status === 'interrupted') {
    return t('agents.operationInterrupted');
  }
  if (operation.status === 'queued') return t('agents.operationQueued');
  return t(`agents.operationProgress.${operation.kind}`);
}

function localizedOperationLogLine(
  t: TFunction<'settings'>,
  language: string | undefined,
  line: string
): string {
  if (!language?.startsWith('en')) return line;
  const key = {
    正在进行基础环境检查: 'envCheck',
    '正在进行 ACP 检查': 'acpCheck',
    正在进行安装准备: 'prepare',
    正在解析已锁定的安装方案: 'resolvePlan',
    '正在安装 ACP': 'installAcp',
    '正在验证 ACP 握手': 'verifyAcp',
    正在绑定用户环境命令: 'publishCommand',
    正在发布本地终端命令: 'publishCommand',
    安装完成: 'complete',
    '安装与 ACP 验证完成': 'complete',
    操作已取消: 'canceled',
    正在取消操作: 'canceling',
  }[line] as
    | 'envCheck'
    | 'acpCheck'
    | 'prepare'
    | 'resolvePlan'
    | 'installRuntime'
    | 'installAcp'
    | 'verifyAcp'
    | 'publishCommand'
    | 'complete'
    | 'canceled'
    | 'canceling'
    | undefined;
  return key ? t(`agents.operationLog.${key}`) : line;
}

export function AgentOperationProgress({
  operation,
  onCancel,
}: {
  operation: AgentOperationState;
  onCancel?: () => void;
}) {
  const { t, i18n } = useTranslation('settings');
  const logRef = useRef<HTMLDivElement>(null);
  const progress = Math.min(100, Math.max(0, operation.progressPercent ?? 0));
  const stages = operationStages[operation.kind].map((stage) =>
    t(`agents.${stage}`)
  );
  const currentStageIndex = stageIndexForProgress(progress, stages.length);
  const localizedOperationMessage = operationMessage(
    t,
    i18n.resolvedLanguage,
    operation
  );
  const logLines =
    operation.logs && operation.logs.length > 0
      ? operation.logs
      : operation.message?.trim()
        ? [operation.message.trim()]
        : [`$ vibex agent ${operation.kind}`];

  useEffect(() => {
    const element = logRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [logLines.length]);

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="agent-operation-progress"
    >
      <div className="agent-operation-progress-heading">
        <div className="agent-operation-progress-copy">
          <Loader2
            aria-hidden="true"
            className="agent-operation-progress-spinner"
          />
          <div className="min-w-0">
            <strong>
              {progress >= 100
                ? t('agents.operationComplete')
                : t('agents.stageInProgress', {
                    stage: stages[currentStageIndex],
                  })}
            </strong>
            <span>{localizedOperationMessage}</span>
          </div>
        </div>
        {onCancel ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0"
            onClick={onCancel}
          >
            {t('agents.cancelOperation')}
          </Button>
        ) : null}
      </div>
      <ol
        aria-label={t('agents.operationStages')}
        className="agent-operation-stages"
      >
        {stages.map((stage, index) => {
          const state =
            index < currentStageIndex
              ? 'complete'
              : index === currentStageIndex
                ? 'current'
                : 'upcoming';
          return (
            <li
              aria-current={state === 'current' ? 'step' : undefined}
              data-state={state}
              key={stage}
            >
              <span aria-hidden="true" className="agent-operation-stage-bar" />
              <span
                aria-hidden="true"
                className="agent-operation-stage-indicator"
              >
                {state === 'complete' ? (
                  <Check className="h-2.5 w-2.5 stroke-[3]" />
                ) : state === 'current' ? (
                  <span className="agent-operation-stage-dot" />
                ) : (
                  index + 1
                )}
              </span>
              {stage}
            </li>
          );
        })}
      </ol>
      <div
        ref={logRef}
        aria-label={t('agents.installLog')}
        className="agent-operation-log"
        role="log"
      >
        {logLines.map((line, index) => (
          <div key={`${index}:${line}`}>
            {localizedOperationLogLine(t, i18n.resolvedLanguage, line)}
          </div>
        ))}
      </div>
    </div>
  );
}
