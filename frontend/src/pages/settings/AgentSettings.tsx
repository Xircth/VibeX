/**
 * Agent Settings page.
 *
 * Displays a vertical list of agent cards.
 * Each card expands on selection to show configuration and preflight checks.
 */

import { useState, useCallback, useEffect } from 'react';
import { AlertCircle, Loader2, RotateCw } from 'lucide-react';
import { AgentCard } from '@/components/settings/AgentCard';
import { useUserSystem } from '@/components/ConfigProvider';
import { Button } from '@/components/ui/button';
import { agentSettingsApi } from '@/lib/api';
import type { AgentSettingInfo } from '@/lib/api';

const DEFAULT_LOAD_ERROR = '加载编码代理设置失败。';

function getLoadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return DEFAULT_LOAD_ERROR;
}

export function AgentSettings() {
  const [agents, setAgents] = useState<AgentSettingInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const { reloadSystem } = useUserSystem();

  const loadAgents = useCallback(
    async (options?: { showLoading?: boolean }) => {
      const showLoading = options?.showLoading !== false;
      if (showLoading) {
        setIsLoading(true);
      }
      setLoadError(null);

      try {
        const list = await agentSettingsApi.list();
        setAgents(list);
        setSelectedType((prev) =>
          list.some((agent) => agent.agent_type === prev) ? prev : null
        );
      } catch (error) {
        setAgents([]);
        setSelectedType(null);
        setLoadError(getLoadErrorMessage(error));
      } finally {
        if (showLoading) {
          setIsLoading(false);
        }
      }
    },
    []
  );

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const reloadAgentSettingsAndRuntime = useCallback(async () => {
    await loadAgents({ showLoading: false });
    await reloadSystem();
  }, [loadAgents, reloadSystem]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-6 px-4">
      <div className="mb-4">
        <h2 className="text-base font-semibold">编码代理</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          管理 AI 编码代理的配置、环境变量和原生配置文件。
        </p>
      </div>

      {loadError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 text-destructive" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">无法加载编码代理设置</div>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                {loadError}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void loadAgents()}
            >
              <RotateCw className="mr-1 h-3.5 w-3.5" />
              重试
            </Button>
          </div>
        </div>
      ) : agents.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <div className="text-sm font-medium">当前没有可用的编码代理</div>
          <p className="mt-1 text-xs text-muted-foreground">
            默认代理条目会自动补齐。请重试刷新当前页面。
          </p>
          <Button
            className="mt-4"
            size="sm"
            variant="outline"
            onClick={() => void loadAgents()}
          >
            <RotateCw className="mr-1 h-3.5 w-3.5" />
            重试
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {agents.map((agent) => (
            <AgentCard
              key={agent.agent_type}
              agent={agent}
              selected={selectedType === agent.agent_type}
              onSelect={() =>
                setSelectedType((prev) =>
                  prev === agent.agent_type ? null : agent.agent_type
                )
              }
              onSave={() => {}}
              onReload={reloadAgentSettingsAndRuntime}
            />
          ))}
        </div>
      )}
    </div>
  );
}
