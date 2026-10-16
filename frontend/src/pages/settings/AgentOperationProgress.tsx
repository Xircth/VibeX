import { Loader2 } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import type { AgentOperationState } from '@/features/agent-management';

const operationStages: Record<
  AgentOperationState['kind'],
  readonly [string, string, string, string]
> = {
  install: ['stagePrepare', 'stageInstall', 'stageVerify', 'stageComplete'],
  update: ['stagePrepare', 'stageUpdate', 'stageVerify', 'stageComplete'],
  repair: ['stagePrepare', 'stageRepair', 'stageVerify', 'stageComplete'],
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

function stageIndexForProgress(progress: number) {
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
  const progress = Math.min(100, Math.max(0, operation.progressPercent ?? 0));
  const stages = operationStages[operation.kind].map((stage) =>
    t(`agents.${stage}`)
  );
  const currentStageIndex = stageIndexForProgress(progress);
  const localizedOperationMessage = operationMessage(
    t,
    i18n.resolvedLanguage,
    operation
  );

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
        <span className="agent-operation-progress-value">{progress}%</span>
      </div>
      <Progress
        aria-label={
          localizedOperationMessage ?? t('agents.processingInstallation')
        }
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-valuetext={`${stages[currentStageIndex]} · ${progress}%`}
        className="agent-operation-track"
        value={progress}
      />
      {operation.logs && operation.logs.length > 1 ? (
        <div
          aria-label={t('agents.installLog')}
          className="agent-operation-log"
          role="log"
        >
          {operation.logs.map((line, index) => (
            <div key={`${index}:${line}`}>
              {localizedOperationLogLine(t, i18n.resolvedLanguage, line)}
            </div>
          ))}
        </div>
      ) : null}
      <div className="agent-operation-progress-footer">
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
              <li data-state={state} key={stage}>
                <span aria-hidden="true" />
                {stage}
              </li>
            );
          })}
        </ol>
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
    </div>
  );
}
