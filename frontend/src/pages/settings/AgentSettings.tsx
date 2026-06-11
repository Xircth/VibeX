import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw, Settings2 } from 'lucide-react';
import { agentsApi } from '@/features/agents/api';
import type {
  AgentConfigSurface,
  AgentInstallPlan,
  AgentMcpSurface,
  AgentRegistryEntry,
  AgentSkillsSurface,
} from '@/features/agents/types';
import { Button } from '@/components/ui/button';

const DEFAULT_LOAD_ERROR = 'Failed to load agent registry.';

type AgentSettingsState = {
  registry: AgentRegistryEntry[];
  config: AgentConfigSurface[];
  mcp: AgentMcpSurface[];
  skills: AgentSkillsSurface[];
  installs: AgentInstallPlan[];
};

function getLoadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return DEFAULT_LOAD_ERROR;
}

function distributionLabel(entry: AgentRegistryEntry): string {
  const distribution = entry.distribution;
  switch (distribution.kind) {
    case 'npx':
      return `npx ${distribution.package}`;
    case 'binary':
      return distribution.cmd;
    case 'uvx':
      return `uvx ${distribution.package}`;
    case 'system':
      return distribution.cmd;
  }
}

export function AgentSettings() {
  const [state, setState] = useState<AgentSettingsState>({
    registry: [],
    config: [],
    mcp: [],
    skills: [],
    installs: [],
  });
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);

    try {
      const [registry, config, mcp, skills, installs] = await Promise.all([
        agentsApi.listRegistry(),
        agentsApi.listConfigSurfaces(),
        agentsApi.listMcpSurfaces(),
        agentsApi.listSkillsSurfaces(),
        agentsApi.listInstallPlans(),
      ]);
      setState({ registry, config, mcp, skills, installs });
    } catch (error) {
      setState({ registry: [], config: [], mcp: [], skills: [], installs: [] });
      setLoadError(getLoadErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const rows = useMemo(
    () =>
      state.registry.map((entry) => {
        const config = state.config.find(
          (surface) => surface.agent_type === entry.agent_type
        );
        const mcp = state.mcp.find(
          (surface) => surface.agent_type === entry.agent_type
        );
        const skills = state.skills.find(
          (surface) => surface.agent_type === entry.agent_type
        );
        const install = state.installs.find(
          (plan) => plan.agent_type === entry.agent_type
        );

        return { entry, config, mcp, skills, install };
      }),
    [state]
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Agents</h2>
        </div>
        <Button size="sm" variant="outline" onClick={() => void loadAgents()}>
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {loadError ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4 text-destructive" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">Agent registry unavailable</div>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                {loadError}
              </p>
            </div>
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <div className="text-sm font-medium">No agents registered</div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <div className="grid grid-cols-[1.2fr_1fr_1fr_1fr] border-b bg-muted/40 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <span>Agent</span>
            <span>Install</span>
            <span>Config</span>
            <span>MCP / Skills</span>
          </div>
          <div className="divide-y">
            {rows.map(({ entry, config, mcp, skills, install }) => (
              <div
                key={entry.registry_id}
                data-testid={`agent-registry-row-${entry.agent_type}`}
                className="grid grid-cols-[1.2fr_1fr_1fr_1fr] gap-3 px-3 py-3 text-sm"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-medium">
                    <Settings2 className="h-4 w-4 text-muted-foreground" />
                    <span>{entry.name}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {entry.agent_type}
                  </div>
                </div>
                <div className="min-w-0 text-xs">
                  <div className="truncate">{distributionLabel(entry)}</div>
                  <div className="mt-1 truncate text-muted-foreground">
                    {install?.required_tools.join(', ') || 'No prerequisite'}
                  </div>
                </div>
                <div className="min-w-0 text-xs">
                  <div>{config?.strategy ?? 'unsupported'}</div>
                  <div className="mt-1 truncate text-muted-foreground">
                    {config?.config_paths[0]?.windows ??
                      config?.config_paths[0]?.unix ??
                      'No config path'}
                  </div>
                </div>
                <div className="min-w-0 text-xs">
                  <div>{mcp?.strategy ?? 'unsupported'}</div>
                  <div className="mt-1 text-muted-foreground">
                    {skills?.strategy ?? 'unsupported'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
