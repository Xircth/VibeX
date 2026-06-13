/**
 * MCP Settings page — dual-panel layout matching SkillsSettings.
 *
 * Left panel: agent list + MCP server list for selected agent.
 * Right panel: selected server detail / JSON editor / preconfigured servers.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import {
  Loader2,
  Search,
  PlugZap,
  Server,
  FileJson,
  Plus,
  Save,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Settings2,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { JSONEditor } from '@/components/ui/json-editor';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '@/components/ui/carousel';
import type { BaseCodingAgent, JsonValue } from 'shared/types';
import type { AgentMcpConfig } from '@/lib/api/config';
import { useUserSystem } from '@/components/ConfigProvider';
import { mcpServersApi } from '@/lib/api';
import { McpConfigStrategyGeneral } from '@/lib/mcpStrategies';
import { getSupportedAgents, AGENT_DISPLAY_NAMES } from '@/constants/agents';

/* ── types ───────────────────────────────────────────────── */

interface McpServerEntry {
  name: string;
  config: Record<string, JsonValue>;
}

type JsonObject = Record<string, JsonValue>;

function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/* ── main component ──────────────────────────────────────── */

export function McpSettings() {
  const { config, profiles } = useUserSystem();

  // Agent selection
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  // MCP state for selected agent
  const [mcpConfig, setMcpConfig] = useState<AgentMcpConfig | null>(null);
  const [mcpServers, setMcpServers] = useState('{}');
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpConfigPath, setMcpConfigPath] = useState('');
  const [mcpApplying, setMcpApplying] = useState(false);
  const [success, triggerSuccess] = useTemporaryFlag(3000);

  // Search & selection
  const [search, setSearch] = useState('');
  const [selectedServer, setSelectedServer] = useState<string | null>(null);

  // Available agents from the backend's real executor profiles.
  const agents = useMemo(() => getSupportedAgents(profiles), [profiles]);

  // Auto-select first agent or current executor
  useEffect(() => {
    if (selectedAgent) return;
    const defaultExecutor = config?.executor_profile?.executor;
    if (defaultExecutor && agents.includes(defaultExecutor)) {
      setSelectedAgent(defaultExecutor);
    } else if (agents.length > 0) {
      setSelectedAgent(agents[0]);
    }
  }, [agents, config?.executor_profile?.executor, selectedAgent]);

  // Load MCP config when agent changes
  useEffect(() => {
    if (!selectedAgent) return;

    const loadMcp = async () => {
      setMcpLoading(true);
      setMcpError(null);
      setMcpConfigPath('');
      setSelectedServer(null);

      try {
        const result = await mcpServersApi.load({
          executor: selectedAgent as BaseCodingAgent,
        });
        setMcpConfig(result.mcp_config);
        const fullConfig = McpConfigStrategyGeneral.createFullConfig(
          result.mcp_config
        );
        setMcpServers(JSON.stringify(fullConfig, null, 2));
        setMcpConfigPath(result.config_path);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.message.includes('does not support MCP')
        ) {
          setMcpError(err.message);
        } else {
          setMcpError(err instanceof Error ? err.message : '加载 MCP 配置失败');
        }
      } finally {
        setMcpLoading(false);
      }
    };

    loadMcp();
  }, [selectedAgent]);

  // Parse server list from current JSON
  const serverEntries = useMemo<McpServerEntry[]>(() => {
    if (!mcpConfig || !mcpServers.trim()) return [];
    try {
      const parsed = JSON.parse(mcpServers);
      const servers = extractServers(mcpConfig, parsed);
      if (!servers) return [];
      return Object.entries(servers).map(([name, cfg]) => ({
        name,
        config: isJsonObject(cfg) ? (cfg as Record<string, JsonValue>) : {},
      }));
    } catch {
      return [];
    }
  }, [mcpServers, mcpConfig]);

  // Filtered servers
  const filteredServers = useMemo(() => {
    if (!search.trim()) return serverEntries;
    const q = search.toLowerCase();
    return serverEntries.filter((s) => s.name.toLowerCase().includes(q));
  }, [serverEntries, search]);

  // Auto-select first server
  useEffect(() => {
    if (
      selectedServer &&
      filteredServers.some((s) => s.name === selectedServer)
    )
      return;
    setSelectedServer(filteredServers[0]?.name ?? null);
  }, [filteredServers, selectedServer]);

  const selectedServerEntry = useMemo(
    () => serverEntries.find((s) => s.name === selectedServer) ?? null,
    [serverEntries, selectedServer]
  );

  // Handlers
  const handleMcpServersChange = (value: string) => {
    setMcpServers(value);
    setMcpError(null);

    if (value.trim() && mcpConfig) {
      try {
        const parsedConfig = JSON.parse(value);
        McpConfigStrategyGeneral.validateFullConfig(mcpConfig, parsedConfig);
      } catch (err) {
        if (err instanceof SyntaxError) {
          setMcpError('无效的 JSON 格式');
        } else {
          setMcpError(err instanceof Error ? err.message : '验证错误');
        }
      }
    }
  };

  const handleSave = async () => {
    if (!selectedAgent || !mcpConfig) return;

    setMcpApplying(true);
    setMcpError(null);

    try {
      if (mcpServers.trim()) {
        const fullConfig = JSON.parse(mcpServers);
        McpConfigStrategyGeneral.validateFullConfig(mcpConfig, fullConfig);
        const mcpServersConfig = McpConfigStrategyGeneral.extractServersForApi(
          mcpConfig,
          fullConfig
        );

        await mcpServersApi.save(
          { executor: selectedAgent as BaseCodingAgent },
          { servers: mcpServersConfig }
        );

        triggerSuccess();
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        setMcpError('无效的 JSON 格式');
      } else {
        setMcpError(err instanceof Error ? err.message : '保存 MCP 服务器失败');
      }
    } finally {
      setMcpApplying(false);
    }
  };

  const addServer = (key: string) => {
    if (!mcpConfig) return;
    try {
      const existing = mcpServers.trim() ? JSON.parse(mcpServers) : {};
      const updated = McpConfigStrategyGeneral.addPreconfiguredToConfig(
        mcpConfig,
        existing,
        key
      );
      setMcpServers(JSON.stringify(updated, null, 2));
      setMcpError(null);
      setSelectedServer(key);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : '添加预配置服务器失败');
    }
  };

  const removeServer = (key: string) => {
    if (!mcpConfig) return;
    try {
      const existing = mcpServers.trim() ? JSON.parse(mcpServers) : {};
      const fullConfig = structuredClone(existing) as Record<string, unknown>;
      let current: Record<string, unknown> | null = fullConfig;

      for (const part of mcpConfig.servers_path.slice(0, -1)) {
        const next: unknown = current?.[part];
        current =
          next && typeof next === 'object' && !Array.isArray(next)
            ? (next as Record<string, unknown>)
            : null;
      }

      const lastKey = mcpConfig.servers_path.at(-1);
      if (!current || !lastKey) return;

      const servers = current[lastKey];
      if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
        delete (servers as Record<string, unknown>)[key];
      }

      setMcpServers(JSON.stringify(fullConfig, null, 2));
      setSelectedServer(null);
      setMcpError(null);
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : '删除 MCP 服务器失败');
    }
  };

  // Preconfigured servers
  const preconfigured = useMemo(() => {
    if (!mcpConfig?.preconfigured)
      return {
        servers: {} as Record<string, unknown>,
        meta: {} as Record<
          string,
          { name?: string; description?: string; url?: string; icon?: string }
        >,
      };
    const obj = mcpConfig.preconfigured as Record<string, unknown>;
    const meta = (
      typeof obj.meta === 'object' && obj.meta !== null ? obj.meta : {}
    ) as Record<
      string,
      { name?: string; description?: string; url?: string; icon?: string }
    >;
    const servers = Object.fromEntries(
      Object.entries(obj).filter(([k]) => k !== 'meta')
    );
    return { servers, meta };
  }, [mcpConfig?.preconfigured]);

  if (!config) {
    return (
      <div className="py-8">
        <Alert variant="destructive">
          <AlertDescription>加载配置失败。</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden flex h-full">
      {/* ── Left Panel ──────────────────────────────────── */}
      <div className="w-56 shrink-0 flex h-full flex-col border-r">
        {/* Header */}
        <div className="shrink-0 border-b px-4 py-3">
          <h2 className="text-sm font-semibold text-foreground">MCP 服务器</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            为每个代理配置 MCP 工具
          </p>
        </div>

        {/* Agent List */}
        <div className="shrink-0 border-b">
          <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
            <Settings2 className="h-3 w-3 text-muted-foreground" />
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              代理 ({agents.length})
            </span>
          </div>
          <div className="px-2 pb-2 space-y-0.5">
            {agents.map((agentKey) => (
              <button
                key={agentKey}
                type="button"
                onClick={() => setSelectedAgent(agentKey)}
                className={`
                  w-full text-left rounded-md px-2.5 py-1.5 transition-colors
                  ${
                    selectedAgent === agentKey
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-muted/50 text-foreground'
                  }
                `}
              >
                <div className="flex items-center gap-2">
                  <PlugZap className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-xs font-medium truncate">
                    {(AGENT_DISPLAY_NAMES as Record<string, string>)[
                      agentKey
                    ] ?? agentKey}
                  </span>
                  {selectedAgent === agentKey && (
                    <ChevronRight className="h-3 w-3 ml-auto shrink-0 text-muted-foreground" />
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Search */}
        <div className="shrink-0 px-3 py-2 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="搜索服务器..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7 text-xs pl-8"
            />
          </div>
        </div>

        {/* Server List */}
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
          {mcpLoading && (
            <div className="flex items-center gap-2 py-6 justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-xs">加载中...</span>
            </div>
          )}

          {mcpError && mcpError.includes('does not support MCP') && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-xs text-amber-600 dark:text-amber-400">
                此代理不支持 MCP 服务器。
              </p>
            </div>
          )}

          {!mcpLoading && !mcpError && filteredServers.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Server className="h-6 w-6 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">
                {search ? '无匹配结果' : '暂无 MCP 服务器'}
              </p>
            </div>
          )}

          {!mcpLoading &&
            filteredServers.map((server) => (
              <button
                key={server.name}
                type="button"
                onClick={() => setSelectedServer(server.name)}
                className={`
                w-full text-left rounded-md px-2.5 py-1.5 transition-colors
                ${
                  selectedServer === server.name
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-muted/50 text-foreground'
                }
              `}
              >
                <div className="flex items-center gap-2">
                  <Server className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <code className="text-[11px] font-mono font-medium truncate flex-1">
                    {server.name}
                  </code>
                </div>
                {server.config.command && (
                  <p className="text-[10px] text-muted-foreground mt-0.5 truncate pl-5">
                    {String(server.config.command)}
                  </p>
                )}
              </button>
            ))}
        </div>
      </div>

      {/* ── Right Panel ──────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex h-full flex-col overflow-y-auto">
        {/* Status alerts */}
        {mcpError && !mcpError.includes('does not support MCP') && (
          <div className="shrink-0 px-6 pt-4">
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{mcpError}</AlertDescription>
            </Alert>
          </div>
        )}
        {success && (
          <div className="shrink-0 px-6 pt-4">
            <Alert variant="success">
              <CheckCircle2 className="h-4 w-4" />
              <AlertDescription className="font-medium">
                MCP 配置保存成功
              </AlertDescription>
            </Alert>
          </div>
        )}

        {selectedAgent &&
        !mcpLoading &&
        !mcpError?.includes('does not support MCP') ? (
          <div className="p-6 space-y-6">
            {/* Agent Header */}
            <div>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/5 border">
                  <PlugZap className="h-5 w-5 text-blue-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold text-foreground">
                    {(AGENT_DISPLAY_NAMES as Record<string, string>)[
                      selectedAgent
                    ] ?? selectedAgent}
                  </h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {serverEntries.length} 个 MCP 服务器已配置
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={mcpApplying || mcpLoading || !!mcpError || success}
                >
                  {mcpApplying ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : success ? (
                    <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                  ) : (
                    <Save className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  {success ? '已保存' : '保存'}
                </Button>
              </div>
            </div>

            {/* Selected Server Detail */}
            {selectedServerEntry && (
              <div className="rounded-lg border bg-card p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <Server className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground">
                    {selectedServerEntry.name}
                  </span>
                  <span className="rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider bg-blue-500/10 text-blue-600 dark:text-blue-400">
                    {String(selectedServerEntry.config.type ?? 'stdio')}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 text-xs text-destructive hover:text-destructive"
                    onClick={() => removeServer(selectedServerEntry.name)}
                  >
                    删除
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {selectedServerEntry.config.command && (
                    <MetaItem
                      label="命令"
                      value={String(selectedServerEntry.config.command)}
                    />
                  )}
                  {selectedServerEntry.config.url && (
                    <MetaItem
                      label="URL"
                      value={String(selectedServerEntry.config.url)}
                    />
                  )}
                  {selectedServerEntry.config.args &&
                    Array.isArray(selectedServerEntry.config.args) && (
                      <MetaItem
                        label="参数"
                        value={(
                          selectedServerEntry.config.args as string[]
                        ).join(' ')}
                      />
                    )}
                  {selectedServerEntry.config.env && (
                    <MetaItem
                      label="环境变量"
                      value={`${Object.keys(selectedServerEntry.config.env as Record<string, unknown>).length} 个`}
                    />
                  )}
                </div>
              </div>
            )}

            {/* JSON Editor */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <FileJson className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground">
                  完整配置（JSON）
                </span>
              </div>
              <JSONEditor
                id="mcp-servers"
                placeholder={
                  mcpLoading
                    ? '加载中...'
                    : '{\n  "server-name": {\n    "type": "stdio",\n    "command": "your-command"\n  }\n}'
                }
                value={mcpLoading ? '加载中...' : mcpServers}
                onChange={handleMcpServersChange}
                disabled={mcpLoading}
                minHeight={250}
              />
              <div className="text-xs text-muted-foreground">
                {mcpConfigPath && (
                  <span>
                    配置文件：<span className="font-mono">{mcpConfigPath}</span>
                  </span>
                )}
              </div>
            </div>

            {/* Preconfigured Servers */}
            {Object.keys(preconfigured.servers).length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Plus className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground">
                    热门服务器
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  点击卡片将该 MCP 服务器添加到配置中。
                </p>
                <div className="relative overflow-hidden rounded-lg border bg-background">
                  <Carousel className="w-full px-4 py-3">
                    <CarouselContent>
                      {Object.entries(preconfigured.servers).map(([key]) => {
                        const metaObj = preconfigured.meta[key] ?? {};
                        const name = metaObj.name ?? key;
                        const description = metaObj.description ?? '';
                        const icon = metaObj.icon ? `/${metaObj.icon}` : null;

                        return (
                          <CarouselItem
                            key={key}
                            className="sm:basis-1/3 lg:basis-1/4"
                          >
                            <button
                              type="button"
                              onClick={() => addServer(key)}
                              className="group w-full text-left outline-none"
                            >
                              <Card className="h-28 rounded-lg border hover:shadow-md transition">
                                <CardHeader className="pb-0 px-3 pt-3">
                                  <div className="flex items-center gap-2">
                                    <div className="w-5 h-5 rounded border bg-muted grid place-items-center overflow-hidden shrink-0">
                                      {icon ? (
                                        <img
                                          src={icon}
                                          alt=""
                                          className="w-full h-full object-cover"
                                        />
                                      ) : (
                                        <span className="text-[10px] font-semibold">
                                          {name.slice(0, 1).toUpperCase()}
                                        </span>
                                      )}
                                    </div>
                                    <CardTitle className="text-xs font-medium truncate">
                                      {name}
                                    </CardTitle>
                                  </div>
                                </CardHeader>
                                <CardContent className="pt-1.5 px-3">
                                  <p className="text-[10px] text-muted-foreground line-clamp-2">
                                    {description}
                                  </p>
                                </CardContent>
                              </Card>
                            </button>
                          </CarouselItem>
                        );
                      })}
                    </CarouselContent>
                    <CarouselPrevious className="left-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full border bg-background/80 shadow-sm backdrop-blur hover:bg-background" />
                    <CarouselNext className="right-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full border bg-background/80 shadow-sm backdrop-blur hover:bg-background" />
                  </Carousel>
                </div>
              </div>
            )}
          </div>
        ) : mcpError?.includes('does not support MCP') ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center text-muted-foreground max-w-xs">
              <AlertCircle className="mx-auto h-10 w-10 opacity-30" />
              <p className="mt-3 text-sm font-medium">不支持 MCP</p>
              <p className="mt-1 text-xs">
                {(AGENT_DISPLAY_NAMES as Record<string, string>)[
                  selectedAgent ?? ''
                ] ?? selectedAgent}{' '}
                不支持 MCP 服务器。请选择其他代理。
              </p>
            </div>
          </div>
        ) : !selectedAgent ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-center text-muted-foreground">
              <PlugZap className="mx-auto h-10 w-10 opacity-30" />
              <p className="mt-3 text-sm">选择一个代理查看 MCP 配置</p>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    </div>
  );
}

/* ── helpers ──────────────────────────────────────────────── */

function extractServers(
  mcpConfig: AgentMcpConfig,
  parsed: unknown
): JsonObject | null {
  if (!isJsonObject(parsed)) return null;
  let current: unknown = parsed;
  for (const key of mcpConfig.servers_path) {
    if (!isJsonObject(current)) return null;
    current = (current as JsonObject)[key];
    if (current === undefined) return null;
  }
  return isJsonObject(current) ? (current as JsonObject) : null;
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
        {label}
      </span>
      <span
        className="text-xs font-medium text-foreground truncate"
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
