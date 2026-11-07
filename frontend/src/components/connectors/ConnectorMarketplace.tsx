import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Flame,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Snowflake,
  Sparkles,
  Store,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import {
  type LocalMcpServer,
  type McpAppType,
  type McpMarketplaceInstallOption,
  type McpMarketplaceItem,
  type McpMarketplaceServerDetail,
  mcpMarketApi,
} from '@/lib/api';
import {
  type ManagedAgentOption,
  useManagedAgentOptions,
} from '@/features/agent-management';
import { cn } from '@/lib/utils';
import type { JsonValue } from 'shared/types';
import { notifyLocalMcpServersChanged } from '@/components/layout/StatusBarMcp';
import {
  ALL_CONNECTOR_CATEGORIES,
  type ConnectorCatalogEntry,
  type ConnectorCategoryId,
  MORE_CONNECTOR_CATEGORIES,
  PRIMARY_CONNECTOR_CATEGORIES,
  mergeConnectorCatalog,
} from './connectorCatalog';

const DEFAULT_CUSTOM_SERVER_SPEC: Record<string, JsonValue> = {
  type: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/path'],
};

export interface ConnectorMarketplaceOpenEventDetail {
  connectorId?: string;
  searchQuery?: string;
  category?: ConnectorCategoryId | 'all';
  openCustomMcp?: boolean;
}

export const OPEN_CONNECTOR_MARKETPLACE_EVENT =
  'vibex:open-connector-marketplace';

export function dispatchOpenConnectorMarketplace(
  detail?: ConnectorMarketplaceOpenEventDetail
): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<ConnectorMarketplaceOpenEventDetail>(
      OPEN_CONNECTOR_MARKETPLACE_EVENT,
      { detail }
    )
  );
}

export interface ConnectorMarketplaceProps {
  mode?: 'dialog' | 'page';
  onClose?: () => void;
  installedServers?: LocalMcpServer[];
  onInstalledServersChange?: (servers: LocalMcpServer[]) => void;
  onSelectLocalServer?: (serverId: string) => void;
  initialSearchQuery?: string;
  initialCategory?: ConnectorCategoryId | 'all';
}

function sanitizeInferredServerId(raw: string): string {
  return raw
    .trim()
    .replace(/^@[^/]+\//, '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/^server-/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function inferServerIdFromUrl(url: URL): string {
  const pathSegments = url.pathname
    .split('/')
    .map((segment) => segment.trim())
    .filter(
      (segment) =>
        segment &&
        !['mcp', 'sse', 'v1', 'v2', 'api', 'stream'].includes(
          segment.toLowerCase()
        )
    );
  if (pathSegments.length > 0) {
    const fromPath = sanitizeInferredServerId(
      pathSegments[pathSegments.length - 1]
    );
    if (fromPath) return fromPath;
  }
  const hostParts = url.hostname
    .split('.')
    .filter(
      (part) =>
        part &&
        ![
          'www',
          'mcp',
          'api',
          'com',
          'org',
          'net',
          'io',
          'ai',
          'dev',
          'sh',
          'app',
        ].includes(part.toLowerCase())
    );
  if (hostParts.length > 0) {
    const fromHost = sanitizeInferredServerId(hostParts[0]);
    if (fromHost) return fromHost;
  }
  return sanitizeInferredServerId(url.hostname) || 'remote-mcp';
}

function inferServerIdFromCommandTokens(
  command: string,
  args: string[]
): string {
  const candidates = [command, ...args];
  for (const token of candidates) {
    const trimmed = token.trim();
    if (!trimmed || trimmed.startsWith('-')) continue;
    if (
      [
        'npx',
        'pnpx',
        'bunx',
        'uvx',
        'node',
        'python',
        'python3',
        'docker',
        'run',
        'exec',
        'deno',
      ].includes(trimmed.toLowerCase())
    ) {
      continue;
    }
    if (trimmed.includes('=') && !trimmed.startsWith('@')) continue;
    const withoutVersion = trimmed.replace(/(.+)@[^/]+$/, '$1');
    const inferred = sanitizeInferredServerId(withoutVersion);
    if (inferred) return inferred;
  }
  return sanitizeInferredServerId(command) || 'custom-mcp';
}

function tokenizeCliCommand(input: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? '';
    tokens.push(value.replace(/\\(["'\\])/g, '$1'));
  }
  return tokens;
}

function normalizeSpecRecord(
  specObj: Record<string, JsonValue>
): Record<string, JsonValue> {
  const next: Record<string, JsonValue> = { ...specObj };
  if (typeof next.type !== 'string' || !next.type.trim()) {
    if (typeof next.url === 'string' && next.url.trim()) {
      try {
        const parsedUrl = new URL(next.url.trim());
        next.type = parsedUrl.pathname.toLowerCase().endsWith('/sse')
          ? 'sse'
          : 'http';
      } catch {
        next.type = 'http';
      }
    } else if (typeof next.command === 'string' && next.command.trim()) {
      next.type = 'stdio';
    }
  }
  return next;
}

export interface ParsedCustomMcpInput {
  serverId?: string;
  spec: Record<string, JsonValue>;
}

/**
 * Smart parser aligned with OpenMausBot Custom MCP Server input formats:
 * 1. Remote HTTP/SSE URL (`https://...` or `http://...`)
 * 2. CLI command (`claude mcp add ...`, `npx ...`, `uvx ...`, `docker run ...`, etc.)
 * 3. JSON (`{ "mcpServers": { "id": { ... } } }`, `"id": { ... }`, or direct spec object)
 */
export function parseCustomMcpInput(
  rawInput: string
): ParsedCustomMcpInput | null {
  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  // 1. Single-line HTTP(S) URL
  if (/^https?:\/\/\S+$/i.test(trimmed)) {
    try {
      const parsedUrl = new URL(trimmed);
      const transport = parsedUrl.pathname.toLowerCase().endsWith('/sse')
        ? 'sse'
        : 'http';
      return {
        serverId: inferServerIdFromUrl(parsedUrl),
        spec: {
          type: transport,
          url: parsedUrl.toString(),
        },
      };
    } catch {
      // Fall through
    }
  }

  // 2. JSON object or `"server-name": { ... }` snippet
  const jsonCandidate =
    !trimmed.startsWith('{') &&
    /^["'][^"']+["']\s*:\s*\{[\s\S]*\}\s*,?$/.test(trimmed)
      ? `{${trimmed.replace(/,\s*$/, '')}}`
      : trimmed;

  if (jsonCandidate.startsWith('{')) {
    try {
      const parsed = JSON.parse(jsonCandidate) as JsonValue;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const record = parsed as Record<string, JsonValue>;

        // Case 2a: { "mcpServers": { "my-server": { ... } } } or VS Code { "servers": { "my-server": { ... } } }
        const serversWrapper =
          record.mcpServers &&
          typeof record.mcpServers === 'object' &&
          !Array.isArray(record.mcpServers)
            ? (record.mcpServers as Record<string, JsonValue>)
            : record.servers &&
                typeof record.servers === 'object' &&
                !Array.isArray(record.servers)
              ? (record.servers as Record<string, JsonValue>)
              : null;
        if (serversWrapper) {
          const firstEntry = Object.entries(serversWrapper).find(
            ([, v]) => v && typeof v === 'object' && !Array.isArray(v)
          );
          if (firstEntry) {
            const [entryId, entrySpec] = firstEntry;
            return {
              serverId: entryId.trim() || undefined,
              spec: normalizeSpecRecord(entrySpec as Record<string, JsonValue>),
            };
          }
        }

        // Case 2b: Direct spec object ({ command, args, ... } or { type, url, ... })
        if (
          typeof record.command === 'string' ||
          typeof record.url === 'string' ||
          typeof record.type === 'string'
        ) {
          const normalized = normalizeSpecRecord(record);
          let inferredId: string | undefined;
          if (typeof normalized.url === 'string') {
            try {
              inferredId = inferServerIdFromUrl(new URL(normalized.url));
            } catch {
              // ignore
            }
          } else if (typeof normalized.command === 'string') {
            const args = Array.isArray(normalized.args)
              ? normalized.args.filter(
                  (a): a is string => typeof a === 'string'
                )
              : [];
            inferredId = inferServerIdFromCommandTokens(
              normalized.command,
              args
            );
          }
          return {
            serverId: inferredId,
            spec: normalized,
          };
        }

        // Case 2c: { "my-server": { "command": "...", "args": [...] } }
        const entries = Object.entries(record);
        if (entries.length === 1) {
          const [key, val] = entries[0];
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            const inner = val as Record<string, JsonValue>;
            if (
              typeof inner.command === 'string' ||
              typeof inner.url === 'string' ||
              typeof inner.type === 'string'
            ) {
              return {
                serverId: key.trim() || undefined,
                spec: normalizeSpecRecord(inner),
              };
            }
          }
        }

        return {
          spec: normalizeSpecRecord(record),
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  // 3. CLI command (`claude mcp add ...`, `npx ...`, `uvx ...`, `docker ...`, etc.)
  const normalizedLine = trimmed.replace(/\\\r?\n/g, ' ').trim();
  if (normalizedLine.includes('\n')) return null;

  const tokens = tokenizeCliCommand(normalizedLine);
  if (tokens.length === 0) return null;

  const env: Record<string, string> = {};
  let cursor = 0;

  if (tokens[cursor] === 'env') {
    cursor += 1;
  }
  while (
    cursor < tokens.length &&
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[cursor])
  ) {
    const eqIdx = tokens[cursor].indexOf('=');
    env[tokens[cursor].slice(0, eqIdx)] = tokens[cursor].slice(eqIdx + 1);
    cursor += 1;
  }

  const remaining = tokens.slice(cursor);
  if (remaining.length === 0) return null;

  // Handle `claude mcp add [options] <name> <commandOrUrl> [args...]`
  if (
    remaining[0] === 'claude' &&
    remaining[1] === 'mcp' &&
    remaining[2] === 'add'
  ) {
    let idx = 3;
    let explicitTransport: 'http' | 'sse' | 'stdio' | undefined;
    const headers: Record<string, string> = {};

    while (idx < remaining.length) {
      const tok = remaining[idx];
      if (tok === '--') {
        idx += 1;
        break;
      }
      if (tok === '--transport' || tok === '-t') {
        const val = remaining[idx + 1]?.toLowerCase();
        if (val === 'http' || val === 'sse' || val === 'stdio') {
          explicitTransport = val;
        }
        idx += 2;
        continue;
      }
      if (tok === '--scope' || tok === '-s') {
        idx += 2;
        continue;
      }
      if (tok === '--env' || tok === '-e') {
        const pair = remaining[idx + 1] ?? '';
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          env[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
        idx += 2;
        continue;
      }
      if (tok === '--header' || tok === '-H') {
        const rawHeader = remaining[idx + 1] ?? '';
        const colonIdx = rawHeader.indexOf(':');
        if (colonIdx > 0) {
          headers[rawHeader.slice(0, colonIdx).trim()] = rawHeader
            .slice(colonIdx + 1)
            .trim();
        }
        idx += 2;
        continue;
      }
      if (tok.startsWith('-')) {
        idx += 1;
        continue;
      }
      break;
    }

    const serverName = remaining[idx];
    let targetStart = idx + 1;
    if (remaining[targetStart] === '--') {
      targetStart += 1;
    }
    const targetTokens = remaining.slice(targetStart);
    if (!serverName || targetTokens.length === 0) return null;

    const firstTarget = targetTokens[0];
    if (
      explicitTransport === 'http' ||
      explicitTransport === 'sse' ||
      /^https?:\/\//i.test(firstTarget)
    ) {
      let transport: 'http' | 'sse' =
        explicitTransport === 'sse' ? 'sse' : 'http';
      try {
        const parsedUrl = new URL(firstTarget);
        if (
          !explicitTransport &&
          parsedUrl.pathname.toLowerCase().endsWith('/sse')
        ) {
          transport = 'sse';
        }
      } catch {
        // ignore
      }
      const spec: Record<string, JsonValue> = {
        type: transport,
        url: firstTarget,
      };
      if (Object.keys(headers).length > 0) {
        spec.headers = headers;
      }
      return {
        serverId: sanitizeInferredServerId(serverName) || serverName,
        spec,
      };
    }

    const [cmd, ...cmdArgs] = targetTokens;
    const spec: Record<string, JsonValue> = {
      type: 'stdio',
      command: cmd,
      args: cmdArgs,
    };
    if (Object.keys(env).length > 0) {
      spec.env = env;
    }
    return {
      serverId: sanitizeInferredServerId(serverName) || serverName,
      spec,
    };
  }

  // Handle direct CLI commands (`npx ...`, `uvx ...`, `docker ...`, `node ...`, `python ...`, etc.)
  const [command, ...args] = remaining;
  if (!command) return null;

  const spec: Record<string, JsonValue> = {
    type: 'stdio',
    command,
    args,
  };
  if (Object.keys(env).length > 0) {
    spec.env = env;
  }

  return {
    serverId: inferServerIdFromCommandTokens(command, args),
    spec,
  };
}

export function ConnectorBrandIcon({
  entry,
  size = 'md',
}: {
  entry: ConnectorCatalogEntry;
  size?: 'sm' | 'md' | 'lg';
}) {
  const [imgFailed, setImgFailed] = useState(false);

  const sizeClasses =
    size === 'lg'
      ? 'h-11 w-11 rounded-xl text-base'
      : size === 'sm'
        ? 'h-8 w-8 rounded-lg text-xs'
        : 'h-10 w-10 rounded-xl text-sm';

  if (entry.iconUrl && !imgFailed) {
    return (
      <img
        src={entry.iconUrl}
        alt={entry.name}
        onError={() => setImgFailed(true)}
        className={cn(
          sizeClasses,
          'shrink-0 border border-border/40 bg-background object-contain p-1.5'
        )}
      />
    );
  }

  const glyph = entry.brandGlyph;
  const bgStyle = entry.brandColor
    ? { backgroundColor: entry.brandColor }
    : undefined;

  if (glyph === 'github') {
    return (
      <div
        style={bgStyle}
        className={cn(
          sizeClasses,
          'flex shrink-0 items-center justify-center bg-[#181717] text-white shadow-2xs'
        )}
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
          <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.09 3.29 9.4 7.86 10.92.58.1.79-.25.79-.56v-2.01c-3.2.7-3.88-1.38-3.88-1.38-.52-1.33-1.28-1.68-1.28-1.68-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11.05 11.05 0 0 1 5.78 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.24 2.75.12 3.04.74.81 1.18 1.83 1.18 3.09 0 4.41-2.7 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
        </svg>
      </div>
    );
  }

  if (glyph === 'supabase') {
    return (
      <div
        style={bgStyle}
        className={cn(
          sizeClasses,
          'flex shrink-0 items-center justify-center bg-[#171717] text-[#3ecf8e] shadow-2xs'
        )}
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
          <path d="M13.7 21.8c-.5.6-1.5.2-1.5-.6v-7.4h7.5c.9 0 1.4 1 .8 1.7l-6.8 6.3ZM10.3 2.2c.5-.6 1.5-.2 1.5.6v7.4H4.3c-.9 0-1.4-1-.8-1.7l6.8-6.3Z" />
        </svg>
      </div>
    );
  }

  if (glyph === 'firecrawl') {
    return (
      <div
        style={bgStyle}
        className={cn(
          sizeClasses,
          'flex shrink-0 items-center justify-center border border-orange-500/20 bg-orange-500/10 text-orange-500 shadow-2xs'
        )}
      >
        <Flame className="h-5 w-5 fill-current" />
      </div>
    );
  }

  if (glyph === 'snowflake') {
    return (
      <div
        style={bgStyle}
        className={cn(
          sizeClasses,
          'flex shrink-0 items-center justify-center bg-[#0ea5e9] text-white shadow-2xs'
        )}
      >
        <Snowflake className="h-5 w-5" />
      </div>
    );
  }

  if (glyph === 'composio' || glyph === 'aiwyn') {
    return (
      <div
        style={bgStyle}
        className={cn(
          sizeClasses,
          'flex shrink-0 items-center justify-center text-white shadow-2xs'
        )}
      >
        <Sparkles className="h-5 w-5" />
      </div>
    );
  }

  const initials = entry.name
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

  return (
    <div
      style={bgStyle}
      className={cn(
        sizeClasses,
        'flex shrink-0 items-center justify-center font-semibold text-white shadow-2xs',
        !entry.brandColor && 'bg-slate-700 dark:bg-slate-600'
      )}
    >
      {initials || entry.name.charAt(0).toUpperCase() || 'M'}
    </div>
  );
}

function AgentTargetSelector({
  global,
  apps,
  options,
  disabled,
  onToggleGlobal,
  onToggleApp,
}: {
  global: boolean;
  apps: McpAppType[];
  options: ManagedAgentOption[];
  disabled?: boolean;
  onToggleGlobal: (next: boolean) => void;
  onToggleApp: (app: McpAppType, next: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <div className="space-y-2.5">
      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm">
        <Checkbox
          checked={global}
          disabled={disabled}
          onCheckedChange={(v) => onToggleGlobal(Boolean(v))}
        />
        <span className="font-medium text-foreground">
          {t('mcp.globalToggle')}
        </span>
      </label>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {options.map((app) => {
          const checked = global || apps.includes(app.value);
          return (
            <label
              key={app.value}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                checked
                  ? 'border-border bg-muted/50 text-foreground'
                  : 'border-border/40 bg-transparent text-muted-foreground'
              )}
            >
              <Checkbox
                checked={checked}
                disabled={disabled || global}
                onCheckedChange={(v) => onToggleApp(app.value, Boolean(v))}
              />
              <span className="truncate">{app.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

export function ConnectorMarketplace({
  mode = 'page',
  onClose,
  installedServers: externalServers,
  onInstalledServersChange,
  onSelectLocalServer,
  initialSearchQuery = '',
  initialCategory = 'all',
}: ConnectorMarketplaceProps) {
  const { t } = useTranslation('settings');
  const agentOptions = useManagedAgentOptions('native_mcp');
  const allAppIds = useMemo(
    () => agentOptions.map((item) => item.value),
    [agentOptions]
  );

  const [internalServers, setInternalServers] = useState<LocalMcpServer[]>([]);
  const installedServers = externalServers ?? internalServers;

  const updateInstalledServers = useCallback(
    (next: LocalMcpServer[]) => {
      setInternalServers(next);
      onInstalledServersChange?.(next);
      notifyLocalMcpServersChanged();
    },
    [onInstalledServersChange]
  );

  const [onlineItems, setOnlineItems] = useState<McpMarketplaceItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [activeCategory, setActiveCategory] = useState<
    ConnectorCategoryId | 'all'
  >(initialCategory);
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [browseAllInAllTab, setBrowseAllInAllTab] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(60);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSearchQuery(initialSearchQuery);
  }, [initialSearchQuery]);

  useEffect(() => {
    setActiveCategory(initialCategory);
  }, [initialCategory]);

  useEffect(() => {
    setVisibleLimit(60);
  }, [activeCategory, searchQuery, connectedOnly, browseAllInAllTab]);

  // Connect / Install modal state
  const [connectingEntry, setConnectingEntry] =
    useState<ConnectorCatalogEntry | null>(null);
  const [connectDetail, setConnectDetail] =
    useState<McpMarketplaceServerDetail | null>(null);
  const [connectLoadingDetail, setConnectLoadingDetail] = useState(false);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [parameterValues, setParameterValues] = useState<
    Record<string, JsonValue>
  >({});
  const [connectGlobal, setConnectGlobal] = useState(true);
  const [connectApps, setConnectApps] = useState<McpAppType[]>([]);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  // Custom MCP Server creation modal state
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [customServerId, setCustomServerId] = useState('');
  const [customSpecText, setCustomSpecText] = useState(() =>
    JSON.stringify(DEFAULT_CUSTOM_SERVER_SPEC, null, 2)
  );
  const [customGlobal, setCustomGlobal] = useState(true);
  const [customApps, setCustomApps] = useState<McpAppType[]>([]);
  const [customBusy, setCustomBusy] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);

  const loadMarketAndLocal = useCallback(
    async (queryOverride?: string) => {
      setLoading(true);
      setError(null);
      try {
        const [localResult, marketResult] = await Promise.allSettled([
          externalServers ? Promise.resolve(externalServers) : mcpMarketApi.scanLocal(),
          mcpMarketApi.search({
            providerId: 'connector_catalog',
            query: (queryOverride ?? searchQuery).trim() || null,
            category: activeCategory === 'all' ? null : activeCategory,
            limit: 2000,
          }),
        ]);

        if (localResult.status === 'fulfilled' && !externalServers) {
          setInternalServers(localResult.value);
        }
        if (marketResult.status === 'fulfilled') {
          setOnlineItems(marketResult.value);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [activeCategory, externalServers, searchQuery]
  );

  useEffect(() => {
    void loadMarketAndLocal('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const handlePointerDown = ( event: MouseEvent) => {
      if (
        moreMenuRef.current &&
        !moreMenuRef.current.contains(event.target as Node)
      ) {
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [moreMenuOpen]);

  const installedIdSet = useMemo(() => {
    const set = new Set<string>();
    for (const s of installedServers) {
      set.add(s.id.toLowerCase());
    }
    return set;
  }, [installedServers]);

  const catalogEntries = useMemo(() => {
    return mergeConnectorCatalog(onlineItems);
  }, [onlineItems]);

  const getEntryStatus = useCallback(
    (
      entry: ConnectorCatalogEntry
    ): 'connected' | 'included' | 'available' => {
      if (
        installedIdSet.has(entry.id.toLowerCase()) ||
        installedIdSet.has(entry.serverId.toLowerCase())
      ) {
        return 'connected';
      }
      if (entry.status === 'included') {
        return 'included';
      }
      return 'available';
    },
    [installedIdSet]
  );

  const getCategoryLabel = useCallback(
    (categoryId: ConnectorCategoryId): string => {
      const defaults: Record<ConnectorCategoryId, string> = {
        developer_tools: '开发者工具',
        analytics: '分析',
        model_context_protocol: 'model context protocol',
        marketing_automation: 'marketing automation',
        social: '社交',
        productivity: '生产力',
        communication: '通信',
        design: '设计',
      };
      return t(
        `mcp.marketplace.categories.${categoryId}`,
        defaults[categoryId]
      );
    },
    [t]
  );

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return catalogEntries.filter((entry) => {
      const status = getEntryStatus(entry);
      if (connectedOnly && status === 'available') {
        return false;
      }
      if (activeCategory !== 'all' && entry.category !== activeCategory) {
        return false;
      }
      if (q) {
        const categoryText = getCategoryLabel(entry.category).toLowerCase();
        const matches =
          entry.name.toLowerCase().includes(q) ||
          entry.description.toLowerCase().includes(q) ||
          entry.serverId.toLowerCase().includes(q) ||
          categoryText.includes(q);
        if (!matches) return false;
      }
      return true;
    });
  }, [
    catalogEntries,
    getEntryStatus,
    connectedOnly,
    activeCategory,
    searchQuery,
    getCategoryLabel,
  ]);

  const connectedCount = useMemo(() => {
    return catalogEntries.filter((e) => getEntryStatus(e) !== 'available')
      .length;
  }, [catalogEntries, getEntryStatus]);

  const categoryCounts = useMemo(() => {
    const counts: Record<ConnectorCategoryId, number> = {
      developer_tools: 0,
      analytics: 0,
      model_context_protocol: 0,
      marketing_automation: 0,
      social: 0,
      productivity: 0,
      communication: 0,
      design: 0,
    };
    const q = searchQuery.trim().toLowerCase();
    for (const entry of catalogEntries) {
      const status = getEntryStatus(entry);
      if (connectedOnly && status === 'available') continue;
      if (q) {
        const categoryText = getCategoryLabel(entry.category).toLowerCase();
        const matches =
          entry.name.toLowerCase().includes(q) ||
          entry.description.toLowerCase().includes(q) ||
          entry.serverId.toLowerCase().includes(q) ||
          categoryText.includes(q);
        if (!matches) continue;
      }
      counts[entry.category] = (counts[entry.category] ?? 0) + 1;
    }
    return counts;
  }, [catalogEntries, getEntryStatus, connectedOnly, searchQuery, getCategoryLabel]);

  const isGroupedView =
    activeCategory === 'all' &&
    !searchQuery.trim() &&
    !connectedOnly &&
    !browseAllInAllTab;

  const groupedSections = useMemo(() => {
    if (!isGroupedView) return [];
    return ALL_CONNECTOR_CATEGORIES.map((categoryId) => {
      const items = filteredEntries.filter((e) => e.category === categoryId);
      return {
        categoryId,
        label: getCategoryLabel(categoryId),
        items,
      };
    }).filter((section) => section.items.length > 0);
  }, [isGroupedView, filteredEntries, getCategoryLabel]);

  const visibleEntries = useMemo(() => {
    return filteredEntries.slice(0, visibleLimit);
  }, [filteredEntries, visibleLimit]);

  const hasMoreEntries = !isGroupedView && visibleLimit < filteredEntries.length;

  const handleStreamScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!hasMoreEntries) return;
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight <= 160) {
        setVisibleLimit((prev) => Math.min(prev + 60, filteredEntries.length));
      }
    },
    [hasMoreEntries, filteredEntries.length]
  );

  const openConnectDialog = useCallback(
    async (entry: ConnectorCatalogEntry) => {
      setConnectingEntry(entry);
      setConnectDetail(null);
      setSelectedOptionId(null);
      setParameterValues({});
      setConnectGlobal(true);
      setConnectApps([...allAppIds]);
      setConnectError(null);

      if (entry.requiresApiKey) {
        setParameterValues({ [entry.requiresApiKey.key]: '' });
      }

      if (entry.providerId && entry.providerId !== 'builtin') {
        setConnectLoadingDetail(true);
        try {
          const detail = await mcpMarketApi.detail({
            providerId: entry.providerId,
            serverId: entry.serverId,
          });
          setConnectDetail(detail);
          const optionId =
            detail.default_option_id ?? detail.install_options[0]?.id ?? null;
          setSelectedOptionId(optionId);
          const option =
            detail.install_options.find((item) => item.id === optionId) ??
            detail.install_options[0];
          if (option && option.parameters.length > 0) {
            const defaults: Record<string, JsonValue> = {};
            for (const param of option.parameters) {
              if (
                param.default_value !== null &&
                param.default_value !== undefined
              ) {
                defaults[param.key] = param.default_value;
              } else if (param.kind === 'boolean') {
                defaults[param.key] = false;
              } else {
                defaults[param.key] = '';
              }
            }
            setParameterValues(defaults);
          }
        } catch {
          // Graceful fallback to builtin defaultSpec when offline or mocked
          setConnectDetail(null);
        } finally {
          setConnectLoadingDetail(false);
        }
      }
    },
    [allAppIds]
  );

  const selectedInstallOption: McpMarketplaceInstallOption | null =
    useMemo(() => {
      if (!connectDetail) return null;
      return (
        connectDetail.install_options.find((o) => o.id === selectedOptionId) ??
        connectDetail.install_options[0] ??
        null
      );
    }, [connectDetail, selectedOptionId]);

  const handleConfirmConnect = useCallback(async () => {
    if (!connectingEntry) return;
    if (!connectGlobal && connectApps.length === 0) {
      setConnectError(t('mcp.validation.selectAgent'));
      return;
    }

    if (selectedInstallOption) {
      const missingRequired = selectedInstallOption.parameters.find((param) => {
        if (!param.required) return false;
        const val = parameterValues[param.key];
        if (val === null || val === undefined) return true;
        if (typeof val === 'string') return val.trim().length === 0;
        return false;
      });
      if (missingRequired) {
        setConnectError(
          t('mcp.validation.fillRequired', { label: missingRequired.label })
        );
        return;
      }
    }

    setConnectBusy(true);
    setConnectError(null);
    try {
      let nextServers: LocalMcpServer[];
      if (connectDetail) {
        nextServers = await mcpMarketApi.install({
          providerId: connectDetail.provider_id,
          serverId: connectDetail.server_id,
          global: connectGlobal,
          apps: connectGlobal ? [] : connectApps,
          optionId: selectedInstallOption?.id ?? null,
          parameterValues,
        });
      } else {
        const baseSpec: Record<string, JsonValue> = {
          ...((connectingEntry.defaultSpec as Record<string, JsonValue>) ?? {
            type: 'stdio',
            command: 'npx',
            args: ['-y', connectingEntry.serverId],
          }),
        };
        if (connectingEntry.requiresApiKey) {
          const rawKey = String(
            parameterValues[connectingEntry.requiresApiKey.key] ?? ''
          ).trim();
          if (rawKey && connectingEntry.requiresApiKey.envKey) {
            const existingEnv =
              typeof baseSpec.env === 'object' &&
              baseSpec.env !== null &&
              !Array.isArray(baseSpec.env)
                ? (baseSpec.env as Record<string, JsonValue>)
                : {};
            baseSpec.env = {
              ...existingEnv,
              [connectingEntry.requiresApiKey.envKey]: rawKey,
            };
          }
        }
        nextServers = await mcpMarketApi.upsertLocal({
          serverId: connectingEntry.serverId,
          spec: baseSpec,
          global: connectGlobal,
          apps: connectGlobal ? [] : connectApps,
        });
      }
      updateInstalledServers(nextServers);
      setConnectingEntry(null);
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectBusy(false);
    }
  }, [
    connectingEntry,
    connectGlobal,
    connectApps,
    selectedInstallOption,
    parameterValues,
    connectDetail,
    updateInstalledServers,
    t,
  ]);

  const handleDisconnectServer = useCallback(
    async (serverId: string) => {
      setConnectBusy(true);
      setConnectError(null);
      try {
        const nextServers = await mcpMarketApi.uninstall(serverId);
        updateInstalledServers(nextServers);
        setConnectingEntry(null);
      } catch (err) {
        setConnectError(err instanceof Error ? err.message : String(err));
      } finally {
        setConnectBusy(false);
      }
    },
    [updateInstalledServers]
  );

  const handleCustomSpecPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const pasted = e.clipboardData?.getData('text/plain')?.trim();
      if (!pasted) return;
      const textarea = e.currentTarget;
      const currentVal = textarea.value;
      const selectionStart = textarea.selectionStart ?? 0;
      const selectionEnd = textarea.selectionEnd ?? currentVal.length;
      const nextRaw =
        currentVal.slice(0, selectionStart) +
        pasted +
        currentVal.slice(selectionEnd);

      const parsed = parseCustomMcpInput(nextRaw.trim());
      if (!parsed) return;

      e.preventDefault();
      setCustomError(null);
      setCustomSpecText(JSON.stringify(parsed.spec, null, 2));
      if (!customServerId.trim() && parsed.serverId) {
        setCustomServerId(parsed.serverId);
      }
    },
    [customServerId]
  );

  const handleCreateCustomServer = useCallback(async () => {
    const parsedInput = parseCustomMcpInput(customSpecText);
    const trimmedId =
      customServerId.trim() || parsedInput?.serverId?.trim() || '';
    if (!trimmedId) {
      setCustomError(t('mcp.validation.enterServerId'));
      return;
    }
    if (!customGlobal && customApps.length === 0) {
      setCustomError(t('mcp.validation.selectAgent'));
      return;
    }
    let parsedSpec: Record<string, JsonValue>;
    if (parsedInput) {
      parsedSpec = parsedInput.spec;
    } else {
      try {
        const parsed = JSON.parse(customSpecText);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          setCustomError(t('mcp.validation.specObject'));
          return;
        }
        parsedSpec = parsed as Record<string, JsonValue>;
      } catch (err) {
        setCustomError(
          t('mcp.validation.jsonSyntax', {
            message: err instanceof Error ? err.message : String(err),
          })
        );
        return;
      }
    }

    setCustomBusy(true);
    setCustomError(null);
    try {
      const nextServers = await mcpMarketApi.upsertLocal({
        serverId: trimmedId,
        spec: parsedSpec,
        global: customGlobal,
        apps: customGlobal ? [] : customApps,
      });
      updateInstalledServers(nextServers);
      setCustomModalOpen(false);
      setCustomServerId('');
      setCustomSpecText(JSON.stringify(DEFAULT_CUSTOM_SERVER_SPEC, null, 2));
      onSelectLocalServer?.(trimmedId);
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : String(err));
    } finally {
      setCustomBusy(false);
    }
  }, [
    customServerId,
    customGlobal,
    customApps,
    customSpecText,
    updateInstalledServers,
    onSelectLocalServer,
    t,
  ]);

  const isMoreCategorySelected =
    activeCategory !== 'all' &&
    MORE_CONNECTOR_CATEGORIES.includes(activeCategory);

  const renderConnectorCard = (entry: ConnectorCatalogEntry) => {
    const status = getEntryStatus(entry);
    const isIncluded = status === 'included';
    const isConnected = status === 'connected';

    return (
      <div
        key={entry.id}
        data-testid={`connector-card-${entry.id}`}
        className="group flex items-center justify-between gap-3 rounded-xl border border-border/50 bg-muted/35 p-3 transition-colors hover:border-border hover:bg-muted/60"
      >
        <div className="flex min-w-0 items-center gap-3">
          <ConnectorBrandIcon entry={entry} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">
                {entry.name}
              </span>
              {isIncluded && (
                <ShieldCheck
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
              )}
            </div>
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              {entry.description}
            </p>
          </div>
        </div>

        {isIncluded ? (
          <span className="inline-flex h-7 shrink-0 items-center rounded-full bg-muted px-3 text-xs font-medium text-muted-foreground">
            {t('mcp.marketplace.statusIncluded', '已包含')}
          </span>
        ) : isConnected ? (
          <button
            type="button"
            onClick={() => {
              if (onSelectLocalServer) {
                onSelectLocalServer(entry.serverId);
              } else {
                void openConnectDialog(entry);
              }
            }}
            aria-label={`${entry.name} ${t('mcp.marketplace.statusConnected', '已连接')}`}
            className="!my-0 inline-flex !h-auto !min-h-0 shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-600 transition-colors hover:bg-emerald-500/20 dark:text-emerald-400"
          >
            <Check className="h-3 w-3" />
            <span>{t('mcp.marketplace.statusConnected', '已连接')}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void openConnectDialog(entry)}
            aria-label={`${t('mcp.marketplace.connectAction', '连接')} ${entry.name}`}
            className="!my-0 inline-flex !h-auto !min-h-0 shrink-0 items-center rounded-full border border-border/80 bg-background px-3.5 py-1 text-xs font-medium text-foreground shadow-2xs transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            {t('mcp.marketplace.connectAction', '连接')}
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      className={cn(
        'dsh-connector-marketplace flex min-h-0 flex-1 flex-col overflow-hidden w-full text-foreground',
        mode === 'page' && 'h-full'
      )}
    >
      {/* Dialog Header (matches reference screenshot 1:1) */}
      {mode === 'dialog' && (
        <div className="flex shrink-0 items-start justify-between gap-4 px-6 pt-5 pb-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {t('mcp.marketplace.dialogTitle', '应用')}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t(
                'mcp.marketplace.dialogSubtitle',
                '只需连接一次应用或你自己的 MCP 服务器，再选择哪些机器人可以使用。'
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => setConnectedOnly((prev) => !prev)}
              className={cn(
                'inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors',
                connectedOnly
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <span>{t('mcp.marketplace.connectedFilter', '已连接')}</span>
              {connectedCount > 0 && (
                <span className="rounded-full bg-muted/80 px-1.5 py-0.2 text-[10px] text-foreground">
                  {connectedCount}
                </span>
              )}
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void loadMarketAndLocal(searchQuery)}
              aria-label={t('mcp.refresh', '刷新')}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <RefreshCw
                className={cn('h-4 w-4', loading && 'animate-spin')}
              />
            </button>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label={t('mcp.marketplace.close', '关闭')}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Search & Custom MCP Server Toolbar */}
      <div
        className={cn(
          'flex shrink-0 flex-col gap-3',
          mode === 'dialog' ? 'px-6 pb-3' : 'px-0 pt-1 pb-3'
        )}
      >
        <div className="flex items-center gap-2.5">
          <div className="relative flex-1">
            <Search
              className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void loadMarketAndLocal(searchQuery);
                }
              }}
              placeholder={t('mcp.marketplace.searchPlaceholder', '搜索应用')}
              aria-label={t('mcp.marketplace.searchPlaceholder', '搜索应用')}
              className="h-9 w-full rounded-full border border-border/70 bg-muted/40 pr-4 pl-9 text-sm text-foreground placeholder:text-muted-foreground focus:border-foreground/30 focus:bg-background focus:outline-none"
            />
          </div>

          {mode === 'page' && (
            <>
              <button
                type="button"
                onClick={() => setConnectedOnly((prev) => !prev)}
                className={cn(
                  'inline-flex h-9 shrink-0 items-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors',
                  connectedOnly
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border/70 bg-muted/30 text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <span>{t('mcp.marketplace.connectedFilter', '已连接')}</span>
                {connectedCount > 0 && (
                  <span className="rounded-full bg-muted/80 px-1.5 py-0.2 text-[10px] text-foreground">
                    {connectedCount}
                  </span>
                )}
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void loadMarketAndLocal(searchQuery)}
                aria-label={t('mcp.refresh', '刷新')}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted/30 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <RefreshCw
                  className={cn('h-4 w-4', loading && 'animate-spin')}
                />
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => {
              setCustomError(null);
              setCustomModalOpen(true);
            }}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border bg-background px-3.5 text-xs font-medium text-foreground shadow-2xs transition-colors hover:bg-muted/60"
          >
            <Server className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{t('mcp.marketplace.customMcpButton', 'MCP 服务器')}</span>
          </button>
        </div>

        {/* Category Pills Bar */}
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              setActiveCategory('all');
              setBrowseAllInAllTab(false);
            }}
            aria-label={t('mcp.marketplace.categoryAll', '全部')}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-full px-3 text-xs transition-colors',
              activeCategory === 'all'
                ? 'bg-foreground font-medium text-background shadow-2xs'
                : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
            )}
          >
            <span>{t('mcp.marketplace.categoryAll', '全部')}</span>
            <span className="opacity-70">({catalogEntries.length})</span>
          </button>

          {PRIMARY_CONNECTOR_CATEGORIES.map((catId) => {
            const active = activeCategory === catId;
            return (
              <button
                key={catId}
                type="button"
                onClick={() => {
                  setActiveCategory(catId);
                  setBrowseAllInAllTab(false);
                }}
                aria-label={getCategoryLabel(catId)}
                className={cn(
                  'inline-flex h-7 items-center gap-1 rounded-full px-3 text-xs transition-colors',
                  active
                    ? 'bg-foreground font-medium text-background shadow-2xs'
                    : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
              >
                <span>{getCategoryLabel(catId)}</span>
                <span className="opacity-70">({categoryCounts[catId] ?? 0})</span>
              </button>
            );
          })}

          {isMoreCategorySelected && (
            <button
              type="button"
              onClick={() => {
                setActiveCategory(activeCategory);
                setBrowseAllInAllTab(false);
              }}
              aria-label={getCategoryLabel(activeCategory as ConnectorCategoryId)}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-foreground px-3 text-xs font-medium text-background shadow-2xs"
            >
              <span>
                {getCategoryLabel(activeCategory as ConnectorCategoryId)}
              </span>
              <span className="opacity-70">
                ({categoryCounts[activeCategory as ConnectorCategoryId] ?? 0})
              </span>
            </button>
          )}

          {/* More Categories Dropdown */}
          <div ref={moreMenuRef} className="relative">
            <button
              type="button"
              onClick={() => setMoreMenuOpen((prev) => !prev)}
              className={cn(
                'inline-flex h-7 items-center gap-1 rounded-full px-3 text-xs transition-colors',
                moreMenuOpen
                  ? 'bg-muted text-foreground'
                  : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <span>{t('mcp.marketplace.moreCategories', '更多')}</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </button>

            {moreMenuOpen && (
              <div className="absolute top-full left-0 z-50 mt-1.5 min-w-[160px] rounded-xl border border-border bg-popover p-1 shadow-md">
                {MORE_CONNECTOR_CATEGORIES.map((catId) => {
                  const selected = activeCategory === catId;
                  return (
                    <button
                      key={catId}
                      type="button"
                      onClick={() => {
                        setActiveCategory(catId);
                        setBrowseAllInAllTab(false);
                        setMoreMenuOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
                        selected
                          ? 'bg-accent font-medium text-accent-foreground'
                          : 'text-popover-foreground hover:bg-muted'
                      )}
                    >
                      <span>{getCategoryLabel(catId)}</span>
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <span>({categoryCounts[catId] ?? 0})</span>
                        {selected && <Check className="h-3.5 w-3.5" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div
          className={cn(
            'mb-2 shrink-0 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive',
            mode === 'dialog' ? 'mx-6' : 'mx-0'
          )}
        >
          {error}
        </div>
      )}

      {/* Scrollable Connector Stream */}
      <div
        onScroll={handleStreamScroll}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto pb-6',
          mode === 'dialog' ? 'px-6' : 'px-0'
        )}
      >
        {isGroupedView ? (
          <div className="space-y-5 pt-1">
            {groupedSections.map((section) => (
              <section key={section.categoryId} className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-medium text-muted-foreground">
                    {section.label} ({section.items.length})
                  </h3>
                  <button
                    type="button"
                    onClick={() => setActiveCategory(section.categoryId)}
                    className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {t('mcp.marketplace.viewAll', '查看全部')} ({section.items.length})
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                  {section.items.slice(0, 4).map(renderConnectorCard)}
                </div>
              </section>
            ))}

            {filteredEntries.length > 0 && (
              <div className="flex justify-center pt-2">
                <button
                  type="button"
                  onClick={() => setBrowseAllInAllTab(true)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-muted/40 px-4 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                >
                  <span>
                    {t('mcp.marketplace.browseAllConnectors', '浏览全部连接器')} ({filteredEntries.length})
                  </span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3 pt-1">
            {(activeCategory !== 'all' || browseAllInAllTab) && (
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {activeCategory === 'all'
                    ? `${t('mcp.marketplace.categoryAll', '全部')} (${filteredEntries.length})`
                    : `${getCategoryLabel(activeCategory)} (${filteredEntries.length})`}
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    setActiveCategory('all');
                    setBrowseAllInAllTab(false);
                  }}
                  className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  {t('mcp.marketplace.categoryAll', '全部')}
                </button>
              </div>
            )}

            {filteredEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 py-12 text-center text-sm text-muted-foreground">
                {t('mcp.noMarketItems', '未找到匹配的应用或 MCP 服务')}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
                  {visibleEntries.map(renderConnectorCard)}
                </div>
                {hasMoreEntries && (
                  <div className="flex justify-center pt-3">
                    <button
                      type="button"
                      onClick={() =>
                        setVisibleLimit((prev) =>
                          Math.min(prev + 60, filteredEntries.length)
                        )
                      }
                      className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-muted/40 px-4 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                    >
                      <span>
                        {t('mcp.marketplace.loadMore', '加载更多')} ({visibleEntries.length}/{filteredEntries.length})
                      </span>
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Connect / Install Connector Modal */}
      <Dialog
        open={Boolean(connectingEntry)}
        onOpenChange={(open) => {
          if (!open) setConnectingEntry(null);
        }}
      >
        <DialogContent className="max-w-lg">
          {connectingEntry && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <ConnectorBrandIcon entry={connectingEntry} size="lg" />
                  <div className="min-w-0">
                    <DialogTitle className="flex items-center gap-2 text-base">
                      <span className="truncate">{connectingEntry.name}</span>
                      {connectingEntry.homepage && (
                        <a
                          href={connectingEntry.homepage}
                          target="_blank"
                          rel="noreferrer"
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </DialogTitle>
                    <DialogDescription className="line-clamp-2 text-xs">
                      {connectingEntry.description}
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>

              <div className="space-y-4 py-2">
                {connectLoadingDetail && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>{t('mcp.loadingDetail')}</span>
                  </div>
                )}

                {connectDetail && connectDetail.install_options.length > 1 && (
                  <div className="space-y-1.5">
                    <Label>{t('mcp.installMethod')}</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {connectDetail.install_options.map((opt) => (
                        <Button
                          key={opt.id}
                          type="button"
                          size="sm"
                          variant={
                            selectedInstallOption?.id === opt.id
                              ? 'default'
                              : 'outline'
                          }
                          onClick={() => setSelectedOptionId(opt.id)}
                        >
                          {opt.label}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}

                {selectedInstallOption &&
                selectedInstallOption.parameters.length > 0 ? (
                  <div className="space-y-3">
                    {selectedInstallOption.parameters.map((param) => {
                      const val = parameterValues[param.key];
                      const stringVal =
                        typeof val === 'string'
                          ? val
                          : val === null || val === undefined
                            ? ''
                            : String(val);
                      return (
                        <div key={param.key} className="space-y-1.5">
                          <Label className="text-xs">
                            {param.label}
                            {param.required && (
                              <span className="ml-1 text-destructive">*</span>
                            )}
                          </Label>
                          <Input
                            type={param.secret ? 'password' : 'text'}
                            value={stringVal}
                            placeholder={param.placeholder ?? param.key}
                            onChange={(e) =>
                              setParameterValues((prev) => ({
                                ...prev,
                                [param.key]: e.target.value,
                              }))
                            }
                          />
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  connectingEntry.requiresApiKey && (
                    <div className="space-y-1.5">
                      <Label className="text-xs">
                        {connectingEntry.requiresApiKey.label}
                      </Label>
                      <Input
                        type="password"
                        value={String(
                          parameterValues[connectingEntry.requiresApiKey.key] ??
                            ''
                        )}
                        placeholder={
                          connectingEntry.requiresApiKey.placeholder ?? ''
                        }
                        onChange={(e) =>
                          setParameterValues((prev) => ({
                            ...prev,
                            [connectingEntry.requiresApiKey!.key]:
                              e.target.value,
                          }))
                        }
                      />
                    </div>
                  )
                )}

                <div className="space-y-1.5">
                  <Label className="text-xs">{t('mcp.installTo')}</Label>
                  <AgentTargetSelector
                    options={agentOptions}
                    global={connectGlobal}
                    apps={connectApps}
                    disabled={connectBusy}
                    onToggleGlobal={(next) => {
                      setConnectGlobal(next);
                      if (next) setConnectApps([...allAppIds]);
                    }}
                    onToggleApp={(app, next) => {
                      setConnectApps((prev) =>
                        next
                          ? Array.from(new Set([...prev, app]))
                          : prev.filter((a) => a !== app)
                      );
                    }}
                  />
                </div>

                {connectError && (
                  <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {connectError}
                  </div>
                )}
              </div>

              <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
                {getEntryStatus(connectingEntry) === 'connected' ? (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={connectBusy}
                    onClick={() =>
                      void handleDisconnectServer(connectingEntry.serverId)
                    }
                  >
                    <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                    {t('mcp.uninstall')}
                  </Button>
                ) : (
                  <div />
                )}
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={connectBusy}
                    onClick={() => setConnectingEntry(null)}
                  >
                    {t('mcp.cancelAction')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={connectBusy}
                    onClick={() => void handleConfirmConnect()}
                  >
                    {connectBusy && (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    )}
                    {t('mcp.marketplace.connectAction', '连接')}
                  </Button>
                </div>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Custom MCP Server Modal */}
      <Dialog open={customModalOpen} onOpenChange={setCustomModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('mcp.createDialogTitle', '新建 MCP 服务器')}</DialogTitle>
            <DialogDescription className="text-xs">
              {t('mcp.newServerHint')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('mcp.serverIdLabel')}</Label>
              <Input
                value={customServerId}
                onChange={(e) => setCustomServerId(e.target.value)}
                placeholder={t('mcp.serverIdPlaceholder')}
                disabled={customBusy}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{t('mcp.targetAgents')}</Label>
              <AgentTargetSelector
                options={agentOptions}
                global={customGlobal}
                apps={customApps}
                disabled={customBusy}
                onToggleGlobal={(next) => {
                  setCustomGlobal(next);
                  if (next) setCustomApps([...allAppIds]);
                }}
                onToggleApp={(app, next) => {
                  setCustomApps((prev) =>
                    next
                      ? Array.from(new Set([...prev, app]))
                      : prev.filter((a) => a !== app)
                  );
                }}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{t('mcp.jsonConfig')}</Label>
              <Textarea
                rows={7}
                className="font-mono text-xs"
                value={customSpecText}
                onChange={(e) => setCustomSpecText(e.target.value)}
                onPaste={handleCustomSpecPaste}
                disabled={customBusy}
              />
            </div>

            {customError && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {customError}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={customBusy}
              onClick={() => setCustomModalOpen(false)}
            >
              {t('mcp.cancelAction')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={customBusy}
              onClick={() => void handleCreateCustomServer()}
            >
              {customBusy ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="mr-1.5 h-3.5 w-3.5" />
              )}
              {t('mcp.createAction')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function StatusBarConnectorButton() {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState(false);
  const [initialSearchQuery, setInitialSearchQuery] = useState('');
  const [initialCategory, setInitialCategory] = useState<
    ConnectorCategoryId | 'all'
  >('all');

  useEffect(() => {
    const handleOpenEvent = (event: Event) => {
      const customEvent =
        event as CustomEvent<ConnectorMarketplaceOpenEventDetail>;
      if (customEvent.detail?.searchQuery !== undefined) {
        setInitialSearchQuery(customEvent.detail.searchQuery);
      } else if (customEvent.detail?.connectorId) {
        setInitialSearchQuery(customEvent.detail.connectorId);
      } else {
        setInitialSearchQuery('');
      }
      if (customEvent.detail?.category) {
        setInitialCategory(customEvent.detail.category);
      } else {
        setInitialCategory('all');
      }
      setOpen(true);
    };

    window.addEventListener(OPEN_CONNECTOR_MARKETPLACE_EVENT, handleOpenEvent);
    return () => {
      window.removeEventListener(
        OPEN_CONNECTOR_MARKETPLACE_EVENT,
        handleOpenEvent
      );
    };
  }, []);

  const label = t('mcp.marketplace.statusBarButtonTitle', '连接器市场');

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="status-bar__icon-btn inline-flex h-4 w-4 items-center justify-center rounded-sm text-secondary-foreground opacity-80 transition-opacity hover:bg-accent/70 hover:opacity-100"
          title={label}
          aria-label={label}
        >
          <Store className="h-3 w-3" strokeWidth={1.6} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="flex max-h-[min(78vh,640px)] w-[min(740px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-background p-0 shadow-xl backdrop-blur-none"
      >
        <ConnectorMarketplace
          mode="dialog"
          onClose={() => setOpen(false)}
          initialSearchQuery={initialSearchQuery}
          initialCategory={initialCategory}
        />
      </PopoverContent>
    </Popover>
  );
}
