import type { McpMarketplaceItem } from '@/lib/api';

export type ConnectorCategoryId =
  | 'developer_tools'
  | 'analytics'
  | 'model_context_protocol'
  | 'marketing_automation'
  | 'social'
  | 'productivity'
  | 'communication'
  | 'design';

export interface ConnectorCatalogEntry {
  id: string;
  providerId: string;
  serverId: string;
  name: string;
  description: string;
  category: ConnectorCategoryId;
  kind: 'mcp' | 'connector' | 'builtin';
  status?: 'connected' | 'included' | 'available';
  verified?: boolean;
  remote?: boolean;
  homepage?: string | null;
  iconUrl?: string | null;
  brandColor?: string;
  brandGlyph?: string;
  defaultSpec?: Record<string, unknown>;
  requiresApiKey?: {
    key: string;
    label: string;
    placeholder?: string;
    envKey?: string;
    headerKey?: string;
  };
}

export const PRIMARY_CONNECTOR_CATEGORIES: readonly ConnectorCategoryId[] = [
  'developer_tools',
  'analytics',
  'model_context_protocol',
  'marketing_automation',
  'social',
];

export const MORE_CONNECTOR_CATEGORIES: readonly ConnectorCategoryId[] = [
  'productivity',
  'communication',
  'design',
];

export const ALL_CONNECTOR_CATEGORIES: readonly ConnectorCategoryId[] = [
  ...PRIMARY_CONNECTOR_CATEGORIES,
  ...MORE_CONNECTOR_CATEGORIES,
];

export const BUILTIN_CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  // Developer Tools
  {
    id: 'composio',
    providerId: 'builtin',
    serverId: 'composio',
    name: 'Composio',
    description:
      'Composio enables AI Agents and workflows to authenticate and act across SaaS apps.',
    category: 'developer_tools',
    kind: 'builtin',
    verified: true,
    remote: true,
    brandColor: '#0f172a',
    brandGlyph: 'composio',
  },
  {
    id: 'github',
    providerId: 'official_registry',
    serverId: 'github',
    name: 'GitHub',
    description: '议题、拉取请求和代码',
    category: 'developer_tools',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#181717',
    brandGlyph: 'github',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
    },
    requiresApiKey: {
      key: 'GITHUB_PERSONAL_ACCESS_TOKEN',
      label: 'GitHub Personal Access Token',
      placeholder: 'ghp_...',
      envKey: 'GITHUB_PERSONAL_ACCESS_TOKEN',
    },
  },
  {
    id: 'supabase',
    providerId: 'official_registry',
    serverId: 'supabase',
    name: 'Supabase',
    description:
      'Supabase is an open-source backend-as-a-service platform with Postgres, Auth, and Edge Functions.',
    category: 'developer_tools',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#171717',
    brandGlyph: 'supabase',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@supabase/mcp-server-supabase@latest'],
    },
    requiresApiKey: {
      key: 'SUPABASE_ACCESS_TOKEN',
      label: 'Supabase Access Token',
      placeholder: 'sbp_...',
      envKey: 'SUPABASE_ACCESS_TOKEN',
    },
  },
  {
    id: 'firecrawl',
    providerId: 'official_registry',
    serverId: 'firecrawl',
    name: 'Firecrawl',
    description:
      'Firecrawl automates web crawling and structured extraction for AI agents.',
    category: 'developer_tools',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#fff7ed',
    brandGlyph: 'firecrawl',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'firecrawl-mcp'],
    },
    requiresApiKey: {
      key: 'FIRECRAWL_API_KEY',
      label: 'Firecrawl API Key',
      placeholder: 'fc-...',
      envKey: 'FIRECRAWL_API_KEY',
    },
  },
  {
    id: 'gitlab',
    providerId: 'official_registry',
    serverId: 'gitlab',
    name: 'GitLab',
    description: 'Manage GitLab repositories, merge requests, pipelines, and issues.',
    category: 'developer_tools',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#fc6d26',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-gitlab'],
    },
    requiresApiKey: {
      key: 'GITLAB_PERSONAL_ACCESS_TOKEN',
      label: 'GitLab Personal Access Token',
      placeholder: 'glpat-...',
      envKey: 'GITLAB_PERSONAL_ACCESS_TOKEN',
    },
  },
  {
    id: 'sentry',
    providerId: 'official_registry',
    serverId: 'sentry',
    name: 'Sentry',
    description: 'Inspect application errors, stack traces, and release health in Sentry.',
    category: 'developer_tools',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#362d59',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@sentry/mcp-server'],
    },
    requiresApiKey: {
      key: 'SENTRY_AUTH_TOKEN',
      label: 'Sentry Auth Token',
      placeholder: 'sntrys_...',
      envKey: 'SENTRY_AUTH_TOKEN',
    },
  },
  {
    id: 'cloudflare',
    providerId: 'official_registry',
    serverId: 'cloudflare',
    name: 'Cloudflare',
    description: 'Manage Cloudflare Workers, KV, D1 databases, and R2 storage.',
    category: 'developer_tools',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#f38020',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@cloudflare/mcp-server-cloudflare'],
    },
  },
  {
    id: 'vercel',
    providerId: 'official_registry',
    serverId: 'vercel',
    name: 'Vercel',
    description: 'Manage Vercel deployments, domains, projects, and serverless logs.',
    category: 'developer_tools',
    kind: 'mcp',
    verified: true,
    remote: true,
    brandColor: '#000000',
    defaultSpec: {
      type: 'http',
      url: 'https://mcp.vercel.com',
    },
  },

  // Analytics
  {
    id: 'serpapi',
    providerId: 'official_registry',
    serverId: 'serpapi',
    name: 'SerpApi',
    description:
      'SerpApi provides a real-time API to access Google, Bing, and search engine results.',
    category: 'analytics',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#4f46e5',
    brandGlyph: 'serpapi',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'serpapi-mcp-server'],
    },
    requiresApiKey: {
      key: 'SERPAPI_API_KEY',
      label: 'SerpApi API Key',
      placeholder: 'Enter SerpApi key',
      envKey: 'SERPAPI_API_KEY',
    },
  },
  {
    id: 'exa',
    providerId: 'official_registry',
    serverId: 'exa',
    name: 'Exa',
    description:
      'Exa focuses on data extraction and semantic neural search for AI applications.',
    category: 'analytics',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#2563eb',
    brandGlyph: 'exa',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'exa-mcp-server'],
    },
    requiresApiKey: {
      key: 'EXA_API_KEY',
      label: 'Exa API Key',
      placeholder: 'exa_...',
      envKey: 'EXA_API_KEY',
    },
  },
  {
    id: 'snowflake',
    providerId: 'official_registry',
    serverId: 'snowflake',
    name: 'Snowflake',
    description:
      'Snowflake is a cloud-based data warehousing and analytics platform.',
    category: 'analytics',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#0ea5e9',
    brandGlyph: 'snowflake',
    defaultSpec: {
      type: 'stdio',
      command: 'uvx',
      args: ['mcp-snowflake-server'],
    },
  },
  {
    id: 'people-data-labs',
    providerId: 'official_registry',
    serverId: 'people-data-labs',
    name: 'People Data Labs',
    description:
      'PeopleDataLabs provides B2B data enrichment, person and company insights.',
    category: 'analytics',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#7c3aed',
    brandGlyph: 'pdl',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'pdl-mcp-server'],
    },
    requiresApiKey: {
      key: 'PDL_API_KEY',
      label: 'People Data Labs API Key',
      placeholder: 'Enter PDL API Key',
      envKey: 'PDL_API_KEY',
    },
  },
  {
    id: 'posthog',
    providerId: 'official_registry',
    serverId: 'posthog',
    name: 'PostHog',
    description: 'Query product analytics, feature flags, session replays, and insights.',
    category: 'analytics',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#f54e00',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@posthog/mcp-server'],
    },
  },
  {
    id: 'tavily',
    providerId: 'official_registry',
    serverId: 'tavily',
    name: 'Tavily Search',
    description: 'Real-time web search and research extraction optimized for LLM agents.',
    category: 'analytics',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#0284c7',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'tavily-mcp@latest'],
    },
    requiresApiKey: {
      key: 'TAVILY_API_KEY',
      label: 'Tavily API Key',
      placeholder: 'tvly-...',
      envKey: 'TAVILY_API_KEY',
    },
  },

  // model context protocol
  {
    id: 'adobe-marketing-agent-mcp',
    providerId: 'official_registry',
    serverId: 'adobe-marketing-agent-mcp',
    name: 'Adobe Marketing Agent MCP',
    description:
      'Adobe Marketing Agent MCP provides campaign orchestration and experience analytics.',
    category: 'model_context_protocol',
    kind: 'mcp',
    verified: true,
    remote: true,
    brandColor: '#dc2626',
    brandGlyph: 'adobe',
    defaultSpec: {
      type: 'http',
      url: 'https://mcp.adobe.com/marketing-agent',
    },
  },
  {
    id: 'ahrefs-mcp',
    providerId: 'official_registry',
    serverId: 'ahrefs-mcp',
    name: 'Ahrefs MCP',
    description:
      'Analyze backlinks, organic search traffic, and keyword rankings with Ahrefs.',
    category: 'model_context_protocol',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#2563eb',
    brandGlyph: 'ahrefs',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@ahrefs/mcp-server'],
    },
    requiresApiKey: {
      key: 'AHREFS_API_KEY',
      label: 'Ahrefs API Key',
      placeholder: 'Enter Ahrefs API Key',
      envKey: 'AHREFS_API_KEY',
    },
  },
  {
    id: 'airops-mcp',
    providerId: 'official_registry',
    serverId: 'airops-mcp',
    name: 'AirOps MCP',
    description:
      'AirOps MCP lets agents access content workflows, brand kits, and growth pipelines.',
    category: 'model_context_protocol',
    kind: 'mcp',
    verified: true,
    remote: true,
    brandColor: '#064e3b',
    brandGlyph: 'airops',
    defaultSpec: {
      type: 'http',
      url: 'https://app.airops.com/mcp',
    },
  },
  {
    id: 'aiwyn-tax-mcp',
    providerId: 'builtin',
    serverId: 'aiwyn-tax-mcp',
    name: 'Aiwyn Tax MCP',
    description:
      'Aiwyn Tax (formerly Column Tax) provides automated tax filing and accounting workflows.',
    category: 'model_context_protocol',
    kind: 'builtin',
    verified: true,
    remote: true,
    brandColor: '#1d4ed8',
    brandGlyph: 'aiwyn',
  },
  {
    id: 'filesystem',
    providerId: 'official_registry',
    serverId: 'filesystem',
    name: 'Filesystem MCP',
    description: 'Secure local file system read, write, and directory tree operations.',
    category: 'model_context_protocol',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#0f766e',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
    },
  },
  {
    id: 'memory',
    providerId: 'official_registry',
    serverId: 'memory',
    name: 'Knowledge Graph Memory',
    description: 'Persistent memory using a local knowledge graph of entities and relations.',
    category: 'model_context_protocol',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#4338ca',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    },
  },

  // marketing automation
  {
    id: 'hubspot',
    providerId: 'official_registry',
    serverId: 'hubspot',
    name: 'HubSpot',
    description: 'Manage CRM contacts, deals, marketing campaigns, and sales pipelines.',
    category: 'marketing_automation',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#ff7a59',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@hubspot/mcp-server'],
    },
    requiresApiKey: {
      key: 'HUBSPOT_ACCESS_TOKEN',
      label: 'HubSpot Private App Access Token',
      placeholder: 'pat-...',
      envKey: 'HUBSPOT_ACCESS_TOKEN',
    },
  },
  {
    id: 'mailchimp',
    providerId: 'official_registry',
    serverId: 'mailchimp',
    name: 'Mailchimp',
    description: 'Automate email audiences, newsletter campaigns, and marketing performance.',
    category: 'marketing_automation',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#ffe01b',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'mailchimp-mcp-server'],
    },
    requiresApiKey: {
      key: 'MAILCHIMP_API_KEY',
      label: 'Mailchimp API Key',
      placeholder: 'Enter Mailchimp API Key',
      envKey: 'MAILCHIMP_API_KEY',
    },
  },
  {
    id: 'klaviyo',
    providerId: 'official_registry',
    serverId: 'klaviyo',
    name: 'Klaviyo',
    description: 'Manage e-commerce customer segments, flows, templates, and campaign metrics.',
    category: 'marketing_automation',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#111827',
    defaultSpec: {
      type: 'stdio',
      command: 'uvx',
      args: ['klaviyo-mcp-server'],
    },
    requiresApiKey: {
      key: 'KLAVIYO_API_KEY',
      label: 'Klaviyo Private API Key',
      placeholder: 'pk_...',
      envKey: 'KLAVIYO_API_KEY',
    },
  },
  {
    id: 'stripe',
    providerId: 'official_registry',
    serverId: 'stripe',
    name: 'Stripe',
    description: 'Interact with Stripe payments, subscriptions, invoices, and customers.',
    category: 'marketing_automation',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#635bff',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@stripe/mcp', '--tools=all'],
    },
    requiresApiKey: {
      key: 'STRIPE_SECRET_KEY',
      label: 'Stripe Secret Key',
      placeholder: 'sk_...',
      envKey: 'STRIPE_SECRET_KEY',
    },
  },

  // social
  {
    id: 'x-twitter',
    providerId: 'official_registry',
    serverId: 'x-twitter',
    name: 'X (Twitter)',
    description: 'Post tweets, search timelines, and analyze social engagement on X.',
    category: 'social',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#000000',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'twitter-mcp-server'],
    },
    requiresApiKey: {
      key: 'TWITTER_BEARER_TOKEN',
      label: 'X / Twitter Bearer Token',
      placeholder: 'AAAA...',
      envKey: 'TWITTER_BEARER_TOKEN',
    },
  },
  {
    id: 'reddit',
    providerId: 'official_registry',
    serverId: 'reddit',
    name: 'Reddit',
    description: 'Browse subreddits, threads, comments, and trending community discussions.',
    category: 'social',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#ff4500',
    defaultSpec: {
      type: 'stdio',
      command: 'uvx',
      args: ['mcp-server-reddit'],
    },
  },
  {
    id: 'linkedin',
    providerId: 'official_registry',
    serverId: 'linkedin',
    name: 'LinkedIn',
    description: 'Publish company updates, manage professional posts, and inspect profile insights.',
    category: 'social',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#0a66c2',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'linkedin-mcp-server'],
    },
  },
  {
    id: 'youtube',
    providerId: 'official_registry',
    serverId: 'youtube',
    name: 'YouTube',
    description: 'Fetch video transcripts, channel analytics, playlists, and comment threads.',
    category: 'social',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#ff0000',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-youtube'],
    },
  },

  // productivity
  {
    id: 'notion',
    providerId: 'official_registry',
    serverId: 'notion',
    name: 'Notion',
    description: 'Search, read, and update Notion pages, databases, and workspace docs.',
    category: 'productivity',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#000000',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
    },
    requiresApiKey: {
      key: 'OPENAPI_MCP_HEADERS',
      label: 'Notion Integration Token',
      placeholder: 'ntn_...',
      envKey: 'NOTION_API_KEY',
    },
  },
  {
    id: 'linear',
    providerId: 'official_registry',
    serverId: 'linear',
    name: 'Linear',
    description: 'Create and triage issues, projects, cycles, and roadmaps in Linear.',
    category: 'productivity',
    kind: 'mcp',
    verified: true,
    remote: true,
    brandColor: '#5e6ad2',
    defaultSpec: {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
    },
  },
  {
    id: 'google-drive',
    providerId: 'official_registry',
    serverId: 'google-drive',
    name: 'Google Drive',
    description: 'Search and read Google Docs, Sheets, Slides, and Drive folders.',
    category: 'productivity',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#1a73e8',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-gdrive'],
    },
  },
  {
    id: 'atlassian-jira',
    providerId: 'official_registry',
    serverId: 'atlassian-jira',
    name: 'Jira & Confluence',
    description: 'Manage Jira sprints, issues, and Confluence knowledge base pages.',
    category: 'productivity',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#0052cc',
    defaultSpec: {
      type: 'stdio',
      command: 'uvx',
      args: ['mcp-atlassian'],
    },
  },

  // communication
  {
    id: 'slack',
    providerId: 'official_registry',
    serverId: 'slack',
    name: 'Slack',
    description: 'Send messages, read channel history, and manage workspace threads in Slack.',
    category: 'communication',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#4a154b',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack'],
    },
    requiresApiKey: {
      key: 'SLACK_BOT_TOKEN',
      label: 'Slack Bot Token',
      placeholder: 'xoxb-...',
      envKey: 'SLACK_BOT_TOKEN',
    },
  },
  {
    id: 'discord',
    providerId: 'official_registry',
    serverId: 'discord',
    name: 'Discord',
    description: 'Automate Discord server channels, messages, webhooks, and moderation.',
    category: 'communication',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#5865f2',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-discord'],
    },
    requiresApiKey: {
      key: 'DISCORD_TOKEN',
      label: 'Discord Bot Token',
      placeholder: 'Enter Discord Bot Token',
      envKey: 'DISCORD_TOKEN',
    },
  },
  {
    id: 'gmail',
    providerId: 'official_registry',
    serverId: 'gmail',
    name: 'Gmail',
    description: 'Search threads, draft replies, and organize emails in Gmail.',
    category: 'communication',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#ea4335',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
    },
  },
  {
    id: 'telegram',
    providerId: 'official_registry',
    serverId: 'telegram',
    name: 'Telegram',
    description: 'Send notifications, manage bot chats, and read channel updates.',
    category: 'communication',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#26a5e4',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'telegram-mcp-server'],
    },
  },

  // design
  {
    id: 'figma',
    providerId: 'official_registry',
    serverId: 'figma',
    name: 'Figma',
    description: 'Inspect Figma frames, design tokens, components, and auto-layout specs.',
    category: 'design',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#f24e1e',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'figma-developer-mcp', '--stdio'],
    },
    requiresApiKey: {
      key: 'FIGMA_API_KEY',
      label: 'Figma Personal Access Token',
      placeholder: 'figd_...',
      envKey: 'FIGMA_API_KEY',
    },
  },
  {
    id: 'canva',
    providerId: 'official_registry',
    serverId: 'canva',
    name: 'Canva',
    description: 'Generate social graphics, presentations, and brand templates with Canva.',
    category: 'design',
    kind: 'mcp',
    verified: true,
    remote: true,
    brandColor: '#00c4cc',
    defaultSpec: {
      type: 'http',
      url: 'https://mcp.canva.com/mcp',
    },
  },
  {
    id: 'excalidraw',
    providerId: 'official_registry',
    serverId: 'excalidraw',
    name: 'Excalidraw',
    description: 'Create and edit hand-drawn architecture diagrams and whiteboards.',
    category: 'design',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#6965db',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'mcp-server-excalidraw'],
    },
  },
  {
    id: 'mermaid',
    providerId: 'official_registry',
    serverId: 'mermaid',
    name: 'Mermaid Diagrams',
    description: 'Render sequence diagrams, flowcharts, and architecture visualizations.',
    category: 'design',
    kind: 'mcp',
    verified: true,
    remote: false,
    brandColor: '#ff3670',
    defaultSpec: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@ustccjw/mermaid-mcp-server'],
    },
  },
];

export function normalizeConnectorCategory(
  rawCategory?: string | null,
  item?: Partial<McpMarketplaceItem>
): ConnectorCategoryId {
  const raw = (rawCategory ?? '').trim().toLowerCase();
  if (
    raw === 'developer_tools' ||
    raw === 'developer-tools' ||
    raw === 'devtools' ||
    raw === '开发者工具'
  ) {
    return 'developer_tools';
  }
  if (raw === 'analytics' || raw === 'data' || raw === '分析') {
    return 'analytics';
  }
  if (
    raw === 'model_context_protocol' ||
    raw === 'model context protocol' ||
    raw === 'mcp'
  ) {
    return 'model_context_protocol';
  }
  if (
    raw === 'marketing_automation' ||
    raw === 'marketing automation' ||
    raw === 'marketing'
  ) {
    return 'marketing_automation';
  }
  if (raw === 'social' || raw === '社交') {
    return 'social';
  }
  if (raw === 'productivity' || raw === '生产力') {
    return 'productivity';
  }
  if (raw === 'communication' || raw === '通信') {
    return 'communication';
  }
  if (raw === 'design' || raw === '设计') {
    return 'design';
  }

  const text = `${item?.name ?? ''} ${item?.server_id ?? ''} ${item?.description ?? ''}`.toLowerCase();
  if (
    /\b(Figma|Canva|Excalidraw|Mermaid|design|ui|ux|svg)\b/i.test(text)
  ) {
    return 'design';
  }
  if (
    /\b(Slack|Discord|Gmail|Telegram|WhatsApp|email|chat|message)\b/i.test(text)
  ) {
    return 'communication';
  }
  if (
    /\b(Notion|Linear|Jira|Confluence|Drive|Calendar|Todo|task|docs)\b/i.test(
      text
    )
  ) {
    return 'productivity';
  }
  if (
    /\b(Twitter|Reddit|LinkedIn|YouTube|Instagram|TikTok|social)\b/i.test(text)
  ) {
    return 'social';
  }
  if (
    /\b(HubSpot|Mailchimp|Klaviyo|Stripe|Shopify|Salesforce|crm|marketing)\b/i.test(
      text
    )
  ) {
    return 'marketing_automation';
  }
  if (
    /\b(SerpApi|Exa|Snowflake|BigQuery|PostHog|Datadog|analytics|search|data|sql)\b/i.test(
      text
    )
  ) {
    return 'analytics';
  }
  if (
    /\b(GitHub|GitLab|Supabase|Firecrawl|Sentry|Cloudflare|Vercel|Docker|Kubernetes|git|code|repo|browser|playwright|puppeteer)\b/i.test(
      text
    )
  ) {
    return 'developer_tools';
  }
  return 'model_context_protocol';
}

export function marketplaceItemToConnectorEntry(
  item: McpMarketplaceItem & {
    status?: 'connected' | 'included' | 'available' | string | null;
    default_spec?: Record<string, unknown> | null;
  }
): ConnectorCatalogEntry {
  const normalizedServerId = item.server_id.trim();
  const slug = normalizedServerId
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .toLowerCase();

  const existingBuiltin = BUILTIN_CONNECTOR_CATALOG.find(
    (entry) =>
      entry.serverId.toLowerCase() === normalizedServerId.toLowerCase() ||
      entry.id.toLowerCase() === slug ||
      entry.name.toLowerCase() === item.name.trim().toLowerCase()
  );

  const normalizedKind: 'mcp' | 'connector' | 'builtin' =
    item.kind === 'builtin' || item.kind === 'connector' || item.kind === 'mcp'
      ? item.kind
      : (existingBuiltin?.kind ?? 'mcp');

  const normalizedStatus: 'connected' | 'included' | 'available' | undefined =
    item.status === 'connected' ||
    item.status === 'included' ||
    item.status === 'available'
      ? item.status
      : existingBuiltin?.status;

  return {
    id: existingBuiltin?.id ?? `${item.provider_id}:${normalizedServerId}`,
    providerId: item.provider_id || existingBuiltin?.providerId || 'official_registry',
    serverId: normalizedServerId,
    name: item.name || existingBuiltin?.name || normalizedServerId,
    description: item.description || existingBuiltin?.description || '',
    category: item.category
      ? normalizeConnectorCategory(item.category, item)
      : (existingBuiltin?.category ?? normalizeConnectorCategory(null, item)),
    kind: normalizedKind,
    status: normalizedStatus,
    verified: item.verified ?? existingBuiltin?.verified,
    remote: item.remote ?? existingBuiltin?.remote,
    homepage: item.homepage ?? existingBuiltin?.homepage,
    iconUrl: item.icon_url ?? existingBuiltin?.iconUrl ?? null,
    brandColor: existingBuiltin?.brandColor,
    brandGlyph: existingBuiltin?.brandGlyph,
    defaultSpec:
      (item.default_spec as Record<string, unknown> | undefined) ??
      existingBuiltin?.defaultSpec,
    requiresApiKey: existingBuiltin?.requiresApiKey,
  };
}

export function mergeConnectorCatalog(
  onlineItems: McpMarketplaceItem[]
): ConnectorCatalogEntry[] {
  const merged = new Map<string, ConnectorCatalogEntry>();

  for (const builtin of BUILTIN_CONNECTOR_CATALOG) {
    merged.set(builtin.id.toLowerCase(), builtin);
  }

  for (const rawItem of onlineItems) {
    const converted = marketplaceItemToConnectorEntry(rawItem);
    const key = converted.id.toLowerCase();
    merged.set(key, converted);
  }

  return Array.from(merged.values());
}

