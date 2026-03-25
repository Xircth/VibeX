/**
 * Agent Settings page.
 *
 * Displays a vertical list of agent cards.
 * Each card expands on selection to show configuration and preflight checks.
 */

import { useState, useCallback, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { AgentCard } from '@/components/settings/AgentCard';
import { agentSettingsApi } from '@/lib/api';
import type { AgentSettingInfo } from '@/lib/api';

export function AgentSettings() {
  const [agents, setAgents] = useState<AgentSettingInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedType, setSelectedType] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    try {
      const list = await agentSettingsApi.list();
      setAgents(list);
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

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
        <p className="text-xs text-muted-foreground mt-1">
          管理 AI 编码代理的配置、环境变量和启用状态。
        </p>
      </div>

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
            onReload={loadAgents}
          />
        ))}
      </div>
    </div>
  );
}
