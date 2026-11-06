import { useEffect, useState } from 'react';

type Environment = {
  pluginId?: string;
  surfaceId?: string;
  slot?: string;
  workspaceId?: string | null;
  projectId?: string | null;
  windowLabel?: string | null;
  invoke: (
    handler: string,
    input?: Record<string, unknown> | null,
  ) => Promise<unknown>;
};

type RuntimeStatus = {
  state?: string;
  origin?: string;
  dataDir?: string;
  lastError?: string;
};

type ConnectorPreviewItem = {
  id: string;
  name: string;
  category: string;
  description: string;
  status: 'connected' | 'included' | 'available';
};

const FEATURED_CONNECTORS: readonly ConnectorPreviewItem[] = [
  {
    id: 'composio',
    name: 'Composio',
    category: '开发者工具',
    description: 'Composio enables AI Agents and workflows to authenticate and act across SaaS apps.',
    status: 'included',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: '开发者工具',
    description: '议题、拉取请求和代码仓库管理',
    status: 'available',
  },
  {
    id: 'supabase',
    name: 'Supabase',
    category: '开发者工具',
    description: 'Supabase is an open-source backend-as-a-service platform.',
    status: 'available',
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    category: '开发者工具',
    description: 'Firecrawl automates web crawling and structured extraction for AI agents.',
    status: 'available',
  },
  {
    id: 'serpapi',
    name: 'SerpApi',
    category: '分析',
    description: 'SerpApi provides a real-time API to access search engine results.',
    status: 'available',
  },
  {
    id: 'exa',
    name: 'Exa',
    category: '分析',
    description: 'Exa focuses on neural search and data extraction for AI.',
    status: 'available',
  },
];

function stateLabel(state?: string) {
  if (state === 'running') return '运行中';
  if (state === 'starting') return '启动中';
  if (state === 'unhealthy') return '未就绪';
  return '待命（按需唤醒）';
}

function renderConnectorContainer(
  root: HTMLElement,
  status: RuntimeStatus | null,
  environment?: Environment,
  searchQuery = '',
) {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleItems = FEATURED_CONNECTORS.filter(
    (item) =>
      !normalizedQuery ||
      item.name.toLowerCase().includes(normalizedQuery) ||
      item.category.toLowerCase().includes(normalizedQuery) ||
      item.description.toLowerCase().includes(normalizedQuery),
  );

  const runtimeBadge = stateLabel(status?.state);
  const cardsHtml = visibleItems
    .map(
      (item) => `
      <div data-connector-id="${item.id}" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:12px;border:1px solid rgba(128,128,128,0.16);background:rgba(128,128,128,0.04);">
        <div style="min-width:0;flex:1;">
          <div style="font-size:13px;font-weight:600;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${item.name}</div>
          <div style="font-size:11px;opacity:0.7;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">${item.description}</div>
        </div>
        <button
          type="button"
          data-open-marketplace="${item.id}"
          style="flex-shrink:0;padding:4px 12px;border-radius:999px;border:1px solid rgba(128,128,128,0.2);background:${item.status === 'included' ? 'rgba(128,128,128,0.12)' : 'rgba(255,255,255,0.9)'};color:#1d2530;font-size:12px;font-weight:500;cursor:pointer;"
        >${item.status === 'included' ? '已包含' : item.status === 'connected' ? '已连接' : '连接'}</button>
      </div>`,
    )
    .join('');

  root.innerHTML = `
    <section data-testid="open-connector-marketplace-surface" style="box-sizing:border-box;height:100%;display:flex;flex-direction:column;gap:12px;padding:16px;background:transparent;">
      <header style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
        <div>
          <h1 style="margin:0;font-size:16px;font-weight:600;line-height:1.3;">应用</h1>
          <p style="margin:4px 0 0;font-size:12px;opacity:0.75;">只需连接一次应用或你自己的 MCP 服务器，再选择哪些机器人可以使用。</p>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          <span data-testid="open-connector-runtime-badge" style="font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid rgba(128,128,128,0.2);opacity:0.85;">${runtimeBadge}</span>
          <button type="button" data-action="open-full-marketplace" style="padding:4px 10px;border-radius:999px;border:1px solid rgba(128,128,128,0.24);background:transparent;font-size:12px;cursor:pointer;">MCP 服务器</button>
        </div>
      </header>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;overflow:auto;">
        ${cardsHtml}
      </div>
    </section>
  `;

  const triggerOpenMarket = (connectorId?: string) => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('vibex:open-connector-marketplace', {
          detail: {
            source: 'vibex.open-connector',
            slot: environment?.slot ?? 'status.after-mcp',
            connectorId: connectorId ?? null,
          },
        }),
      );
    }
  };

  root
    .querySelector('[data-action="open-full-marketplace"]')
    ?.addEventListener('click', () => triggerOpenMarket());
  for (const btn of root.querySelectorAll<HTMLButtonElement>('[data-open-marketplace]')) {
    btn.addEventListener('click', () => {
      triggerOpenMarket(btn.dataset.openMarketplace);
    });
  }
}

export function mount(root: HTMLElement, environment?: Environment) {
  let cancelled = false;
  let currentStatus: RuntimeStatus | null = null;

  const paint = async () => {
    if (cancelled) return;
    renderConnectorContainer(root, currentStatus, environment);
    if (!environment) return;
    try {
      const status = (await environment.invoke('runtime.status')) as RuntimeStatus;
      if (cancelled) return;
      currentStatus = status ?? null;
      renderConnectorContainer(root, currentStatus, environment);
    } catch (error) {
      if (cancelled) return;
      currentStatus = {
        state: 'unhealthy',
        lastError: error instanceof Error ? error.message : String(error),
      };
      renderConnectorContainer(root, currentStatus, environment);
    }
  };

  void paint();
  return () => {
    cancelled = true;
    root.replaceChildren();
  };
}

export default function OpenConnectorMarketplaceView({
  environment,
}: {
  environment?: Environment;
}) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    if (!environment) return undefined;
    void environment
      .invoke('runtime.status')
      .then((res) => {
        if (!cancelled && res && typeof res === 'object') {
          setStatus(res as RuntimeStatus);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setStatus({
            state: 'unhealthy',
            lastError: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [environment]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems = FEATURED_CONNECTORS.filter(
    (item) =>
      !normalizedQuery ||
      item.name.toLowerCase().includes(normalizedQuery) ||
      item.category.toLowerCase().includes(normalizedQuery) ||
      item.description.toLowerCase().includes(normalizedQuery),
  );

  const emitOpenMarketplace = (connectorId?: string, action?: string) => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('vibex:open-connector-marketplace', {
          detail: {
            source: 'vibex.open-connector',
            slot: environment?.slot ?? 'status.after-mcp',
            connectorId: connectorId ?? null,
            action: action ?? 'open',
          },
        }),
      );
    }
  };

  return (
    <section
      data-testid="open-connector-marketplace-surface"
      className="flex h-full min-h-0 w-full flex-col gap-3 p-4"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="m-0 text-base font-semibold leading-tight">应用</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            只需连接一次应用或你自己的 MCP 服务器，再选择哪些机器人可以使用。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            data-testid="open-connector-runtime-badge"
            className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            {stateLabel(status?.state)}
          </span>
          <button
            type="button"
            onClick={() => emitOpenMarketplace(undefined, 'new-mcp')}
            className="rounded-full border border-border px-3 py-1 text-xs font-medium hover:bg-accent/60"
          >
            MCP 服务器
          </button>
        </div>
      </header>

      <div className="flex items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索应用"
          aria-label="搜索应用"
          className="h-8 w-full rounded-full border border-border bg-muted/40 px-3 text-xs outline-none"
        />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
        {visibleItems.map((item) => (
          <div
            key={item.id}
            data-connector-id={item.id}
            className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-card/60 px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-semibold">{item.name}</div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {item.description}
              </div>
            </div>
            <button
              type="button"
              onClick={() => emitOpenMarketplace(item.id, 'connect')}
              className="shrink-0 rounded-full border border-border px-3 py-1 text-xs font-medium hover:bg-accent"
            >
              {item.status === 'included'
                ? '已包含'
                : item.status === 'connected'
                  ? '已连接'
                  : '连接'}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
