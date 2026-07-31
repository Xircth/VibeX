import { Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type {
  AgentDiagnosticView,
  AgentNativeConfigPatchRequest,
  AgentNativeConfigView,
  AgentPreflightView,
  AgentRegistryView,
  AgentRegistryViewRow,
  AgentUpdateCheckView,
} from 'shared/types';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  useAgentManagement,
} from '@/features/agent-management';

import { AgentBar } from './AgentBar';
import { AgentConfigurationAndDiagnostics } from './AgentConfigurationAndDiagnostics';
import { AgentDetail } from './AgentDetail';
import { AgentRegistryViewPanel } from './AgentRegistryView';

export function AgentSettings() {
  const management = useAgentManagement();
  const [registryOpen, setRegistryOpen] = useState(false);
  const [registry, setRegistry] = useState<AgentRegistryView | null>(null);
  const [registryLoading, setRegistryLoading] = useState(false);
  const [addingAgentId, setAddingAgentId] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<AgentPreflightView | null>(null);
  const [checking, setChecking] = useState(false);
  const [config, setConfig] = useState<AgentNativeConfigView | null>(null);
  const [diagnostics, setDiagnostics] = useState<AgentDiagnosticView[]>([]);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configConflict, setConfigConflict] = useState<{
    message: string;
    request: AgentNativeConfigPatchRequest;
  } | null>(null);
  const [updateCheck, setUpdateCheck] = useState<AgentUpdateCheckView | null>(
    null
  );
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const selectedAgent = management.selectedAgent;
  const selectedAgentId = selectedAgent?.agent_id ?? null;
  const refreshManagement = management.refresh;

  const loadRegistry = useCallback(async (forceRefresh = false) => {
    setRegistryLoading(true);
    try {
      const cached = await agentManagementApi.registry();
      setRegistry(cached);
      if (forceRefresh || !cached.fresh) {
        const refreshed = await agentManagementApi.refreshRegistry();
        setRegistry(refreshed);
        if (refreshed.refresh_error) {
          toast.warning('注册表刷新失败，已继续使用上次成功缓存。');
        }
      }
    } catch (error) {
      toast.error(errorMessage(error, '无法读取 ACP 注册表'));
    } finally {
      setRegistryLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!registryOpen || registry) return;
    void loadRegistry();
  }, [loadRegistry, registry, registryOpen]);

  useEffect(() => {
    if (!selectedAgentId || registryOpen) return;
    let active = true;
    setPreflight(null);
    setConfig(null);
    setConfigConflict(null);
    setUpdateCheck(null);
    void Promise.allSettled([
      agentManagementApi.readConfig(selectedAgentId),
      agentManagementApi.diagnostics(selectedAgentId),
    ]).then(([configResult, diagnosticResult]) => {
      if (!active) return;
      if (configResult.status === 'fulfilled') {
        setConfig(configResult.value);
        void refreshManagement().catch(() => undefined);
      }
      if (diagnosticResult.status === 'fulfilled') {
        setDiagnostics(diagnosticResult.value);
      }
    });
    return () => {
      active = false;
    };
  }, [refreshManagement, registryOpen, selectedAgentId]);

  useEffect(() => {
    if (!management.error) return;
    toast.error(errorMessage(management.error, '无法读取 Agent 列表'));
  }, [management.error]);

  const addAgent = useCallback(
    async (row: AgentRegistryViewRow) => {
      setAddingAgentId(row.agent_id);
      try {
        await management.addAndInstall(row);
        setRegistryOpen(false);
        setRegistry((current) =>
          current
            ? {
                ...current,
                installed: [
                  ...current.installed,
                  { ...row, added: true, installed: true },
                ],
                uninstalled: current.uninstalled.filter(
                  (item) => item.agent_id !== row.agent_id
                ),
              }
            : current
        );
        toast.success(`${row.display_name} 已加入列表，正在安装。`);
      } catch (error) {
        toast.error(errorMessage(error, '添加 Agent 失败'));
      } finally {
        setAddingAgentId(null);
      }
    },
    [management]
  );

  const runPreflight = useCallback(async () => {
    if (!selectedAgentId) return;
    setChecking(true);
    try {
      setPreflight(await agentManagementApi.preflight(selectedAgentId));
      await management.refresh();
      toast.success('预检查完成');
    } catch (error) {
      toast.error(errorMessage(error, '预检查失败'));
    } finally {
      setChecking(false);
    }
  }, [management, selectedAgentId]);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      if (!selectedAgentId) return;
      try {
        management.mergeAgent(
          await agentManagementApi.setEnabled(selectedAgentId, enabled)
        );
      } catch (error) {
        toast.error(errorMessage(error, '更新启用状态失败'));
      }
    },
    [management, selectedAgentId]
  );

  const move = useCallback(
    async (direction: -1 | 1) => {
      if (!selectedAgentId) return;
      const order = management.state.agents.map((agent) => agent.agent_id);
      const index = order.indexOf(selectedAgentId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= order.length) return;
      [order[index], order[target]] = [order[target], order[index]];
      try {
        await agentManagementApi.reorder(order);
        await management.refresh();
      } catch (error) {
        toast.error(errorMessage(error, '调整顺序失败'));
      }
    },
    [management, selectedAgentId]
  );

  const queueRepair = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      await agentManagementApi.repair(selectedAgentId);
      toast.success('已开始修复');
    } catch (error) {
      toast.error(errorMessage(error, '无法开始操作'));
    }
  }, [selectedAgentId]);

  const checkUpdate = useCallback(async () => {
    if (!selectedAgentId) return;
    setCheckingUpdate(true);
    try {
      const comparison = await agentManagementApi.checkUpdate(selectedAgentId);
      setUpdateCheck(comparison);
      toast.success(
        comparison.update_available ? '发现可用更新' : '当前已是最新版本'
      );
    } catch (error) {
      toast.error(errorMessage(error, '检查更新失败'));
    } finally {
      setCheckingUpdate(false);
    }
  }, [selectedAgentId]);

  const applyUpdate = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      await agentManagementApi.applyUpdate(selectedAgentId);
      toast.success('已开始安装确认的更新');
    } catch (error) {
      toast.error(errorMessage(error, '无法开始更新'));
    }
  }, [selectedAgentId]);

  const uninstall = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      management.mergeAgent(
        await agentManagementApi.uninstall(selectedAgentId)
      );
      toast.success('Agent 已卸载，本地列表仍保留。');
    } catch (error) {
      toast.error(errorMessage(error, '卸载失败'));
    }
  }, [management, selectedAgentId]);

  const rollback = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      management.mergeAgent(await agentManagementApi.rollback(selectedAgentId));
      toast.success('已切换到上一版本；新会话将使用回滚后的安装。');
    } catch (error) {
      toast.error(errorMessage(error, '回滚失败'));
    }
  }, [management, selectedAgentId]);

  const cancelOperation = useCallback(async () => {
    if (!selectedAgentId) return;
    const operation = management.state.operations[selectedAgentId];
    if (!operation) return;
    try {
      await agentManagementApi.cancelOperation(
        selectedAgentId,
        operation.operationId
      );
      toast.success('正在取消 Agent 操作。');
    } catch (error) {
      toast.error(errorMessage(error, '取消操作失败'));
    }
  }, [management.state.operations, selectedAgentId]);

  const remove = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      await agentManagementApi.remove(selectedAgentId);
      await management.refresh();
      toast.success('Agent 已从列表移除。');
    } catch (error) {
      toast.error(errorMessage(error, '移除失败'));
    }
  }, [management, selectedAgentId]);

  const saveConfig = useCallback(
    async (request: AgentNativeConfigPatchRequest) => {
      setSavingConfig(true);
      try {
        setConfig(await agentManagementApi.writeConfig(request));
        setConfigConflict(null);
        toast.success('配置已保存，将从下一个会话生效。');
        await management.refresh();
      } catch (error) {
        if (isConfigConflict(error)) {
          const external = await agentManagementApi.readConfig(
            request.agent_id
          );
          setConfig(external);
          setConfigConflict({
            message: errorMessage(error, '配置文件已被外部修改'),
            request,
          });
          toast.warning('检测到外部配置修改，请选择处理方式。');
        } else {
          toast.error(errorMessage(error, '配置保存失败'));
        }
      } finally {
        setSavingConfig(false);
      }
    },
    [management]
  );

  const reloadConflict = useCallback(async () => {
    if (!selectedAgentId) return;
    try {
      setConfig(await agentManagementApi.readConfig(selectedAgentId));
      toast.success('已重新读取外部配置');
    } catch (error) {
      toast.error(errorMessage(error, '重新加载配置失败'));
    }
  }, [selectedAgentId]);

  const overwriteConflict = useCallback(async () => {
    if (!configConflict || !config) return;
    const revisions = Object.fromEntries(
      config.fields
        .filter((field) => field.id in configConflict.request.fields)
        .map((field) => [field.id, field.revision])
    );
    setSavingConfig(true);
    try {
      setConfig(
        await agentManagementApi.writeConfig({
          ...configConflict.request,
          base_field_revisions: revisions,
        })
      );
      setConfigConflict(null);
      toast.success('已明确覆盖外部修改');
      await management.refresh();
    } catch (error) {
      toast.error(errorMessage(error, '覆盖外部修改失败'));
    } finally {
      setSavingConfig(false);
    }
  }, [config, configConflict, management]);

  const exportDiagnostics = useCallback(() => {
    if (!selectedAgentId) return;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            agent_id: selectedAgentId,
            exported_at: new Date().toISOString(),
            diagnostics,
          },
          null,
          2
        ),
      ],
      { type: 'application/json' }
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${selectedAgentId}-diagnostics.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success('诊断记录已导出');
  }, [diagnostics, selectedAgentId]);

  if (management.loading && management.state.agents.length === 0) {
    return (
      <div className="space-y-4" aria-label="正在读取 Agent">
        <div className="agent-management-bar h-[54px] animate-pulse" />
        <div className="settings-surface flex min-h-40 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <div className="flex shrink-0 items-center gap-2">
        <AgentBar
          agents={management.state.agents}
          selectedAgentId={management.state.selectedAgentId}
          registryOpen={registryOpen}
          onSelect={(agentId) => {
            management.select(agentId);
            setRegistryOpen(false);
          }}
          onOpenRegistry={() => setRegistryOpen(true)}
        />
        <Button
          size="sm"
          variant="ghost"
          className="h-9 w-9 shrink-0 p-0"
          aria-label="刷新 Agent 状态"
          aria-busy={management.loading}
          disabled={management.loading}
          onClick={() => void management.refreshFresh().catch(() => undefined)}
        >
          <RefreshCw
            aria-hidden="true"
            className={`h-3.5 w-3.5 ${
              management.loading ? 'animate-spin' : ''
            }`}
          />
        </Button>
      </div>

      {registryOpen ? (
        <AgentRegistryViewPanel
          view={registry}
          loading={registryLoading}
          addingAgentId={addingAgentId}
          onRefresh={() => void loadRegistry(true)}
          onAdd={(row) => void addAgent(row)}
        />
      ) : selectedAgent ? (
        <div className="space-y-4">
          <AgentDetail
            agent={selectedAgent}
            operation={
              management.state.operations[selectedAgent.agent_id] ?? null
            }
            preflight={preflight}
            checking={checking}
            checkingUpdate={checkingUpdate}
            updateCheck={updateCheck}
            onSetEnabled={(enabled) => void setEnabled(enabled)}
            onMove={(direction) => void move(direction)}
            onPreflight={() => void runPreflight()}
            onRepair={() => void queueRepair()}
            onCheckUpdate={() => void checkUpdate()}
            onApplyUpdate={() => void applyUpdate()}
            onRollback={() => void rollback()}
            onCancelOperation={() => void cancelOperation()}
            onUninstall={() => void uninstall()}
            onRemove={() => void remove()}
            onExportDiagnostics={exportDiagnostics}
          />
          <AgentConfigurationAndDiagnostics
            config={config}
            saving={savingConfig}
            conflictMessage={configConflict?.message}
            onSave={(request) => void saveConfig(request)}
            onReloadConflict={() => void reloadConflict()}
            onAdoptExternal={() => setConfigConflict(null)}
            onOverwriteConflict={() => void overwriteConflict()}
          />
        </div>
      ) : (
        <section className="settings-surface flex min-h-44 items-center justify-center px-6 text-center text-sm text-muted-foreground">
          暂无 Agent。点击列表末尾的“+”从 ACP 注册表添加。
        </section>
      )}
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.trim()
  ) {
    return error.message;
  }
  return fallback;
}

function isConfigConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'config_conflict'
  );
}
