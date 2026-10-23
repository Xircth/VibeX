/** Public authoring contract for a VibeX v2 product plugin. */
export interface VibeXPluginManifest {
  $schema?: string;
  manifestVersion: 4;
  apiVersion: '2.0';
  id: string;
  publisher: string;
  version: string;
  name: string;
  description?: string;
  /** Always points to the required root README. Its frontmatter owns `summary`. */
  readme?: 'README.md';
  engines?: { vibex?: string; pluginSdk?: string };
  content?: {
    root: 'contents';
    index: '.vibex-plugin/content.index.json';
  };
  /** Values live in root config.json; this schema only describes and validates them. */
  config?: { schema: Record<string, unknown> };
  dependencies?: DependencyManifest[];
  entrypoints?: {
    worker?: WorkerEntrypointManifest;
    app?: AppEntrypointManifest;
  };
  permissions?: PermissionManifest[];
  integrations?: IntegrationManifest[];
  interface?: Record<string, unknown>;
}

export type WorkerRuntime = 'node' | 'python' | 'native';

export interface WorkerEntrypointManifest {
  path: string;
  runtime: WorkerRuntime;
  protocol: '1.1';
}

export interface AppEntrypointManifest {
  entry: string;
  styles?: string;
  protocol: '2.0';
}

export interface PermissionManifest {
  /** @deprecated Full-trust packages do not require capability consent. */
  id: string;
  capability: string;
  scope: Record<string, unknown>;
  reason: string;
  optional?: boolean;
  /** @deprecated Retained only so v4 packages authored before full trust remain valid. */
  trustTier?: 'sandboxed_worker' | 'trusted_native';
}

export type DependencyManifest =
  | {
      kind: 'runtime';
      descriptor: string;
      optional?: boolean;
    }
  | {
      kind?: 'plugin';
      id: string;
      publisher?: string;
      versionRange?: string;
      required?: boolean;
    };

interface IntegrationBase {
  id: string;
  required?: boolean;
}

export interface SkillIntegrationManifest extends IntegrationBase {
  kind: 'content.skill';
  resource: string;
  targets?: string[];
  domain?: string;
}

export interface McpIntegrationManifest extends IntegrationBase {
  kind: 'content.mcp';
  resource: string;
}

/** One tool the Host MCP manager lists before an agent session connects. */
export interface PluginMcpToolDeclaration {
  name: string;
  group?: string;
}

/** Package-relative MCP process supervised and credentialed by the VibeX Host. */
export interface ManagedMcpRuntimeResource {
  managedRuntime: {
    /** Authoring source bundled by the Plugin CLI into `entrypoint`. */
    source?: string;
    /** STDIO entrypoint. Forbidden when `kind` is `workerHttp`. */
    entrypoint?: string;
    kind?: 'hostFamilyBinary' | 'workerHttp';
    /** Worker handler that returns `{ url, headers }` for `kind: workerHttp`. */
    handler?: string;
    binaryId?: string;
    protocolRevision: '2026-07-28';
    defaultBinding?: 'all-compatible-agents';
  };
  /** Required for packaged/static/workerHttp MCP so the status bar can list tools. */
  tools?: Array<string | PluginMcpToolDeclaration>;
}

export interface WorkflowIntegrationManifest extends IntegrationBase {
  kind: 'workflow.binding';
  resource: string;
}

export interface FileOpenerIntegrationManifest extends IntegrationBase {
  kind: 'file.opener';
  label?: string;
  extensions?: string[];
  /** Exact case-insensitive filename suffixes, including the leading dot. */
  fileNameSuffixes?: string[];
  mediaTypes?: string[];
  priority?: number;
  /** Runtime-backed URL preview. Exactly one opener target is required. */
  previewProvider?: string;
  /** App surface mounted as an editable file tab. Exactly one opener target is required. */
  editorSurface?: string;
}

export interface PreviewIntegrationManifest extends IntegrationBase {
  kind: 'artifact.preview';
  mediaTypes: string[];
  runtime?: string;
  maxConcurrentPreviews?: number;
  handler: string;
  process?: {
    argv: string[];
    readyTimeoutSeconds?: number;
    environment?: Record<string, string>;
  };
}

export interface AppSurfaceIntegrationManifest extends IntegrationBase {
  kind: 'app.surface';
  label?: string;
  slot: 'plugin.detail.panel' | 'artifact.editor';
  appEntrypoint: 'app';
  route?: `/${string}`;
  handler: string;
  allowedMethods?: string[];
  minHeight?: number;
  nativeRenderer?: string;
}

/**
 * Icon names the Host is willing to render for plugin chrome. Plugins name an
 * icon instead of shipping markup, so no plugin asset reaches Host DOM.
 * Mirrored by `@vibex/plugin-contract/catalog/icons` and the Rust
 * `CONTRIBUTION_ICONS`; all three are asserted equal by tests.
 */
export const CONTRIBUTION_ICONS = [
  'activity',
  'alert-triangle',
  'bell',
  'bookmark',
  'bot',
  'calendar',
  'chart-bar',
  'check-circle',
  'clock',
  'cloud',
  'code',
  'database',
  'file-text',
  'filter',
  'flag',
  'folder',
  'gauge',
  'git-branch',
  'globe',
  'info',
  'key',
  'layers',
  'link',
  'list',
  'message-square',
  'monitor',
  'package',
  'play',
  'plug',
  'puzzle',
  'refresh-cw',
  'search',
  'settings',
  'shield',
  'sparkles',
  'star',
  'tag',
  'terminal',
  'timer',
  'user',
  'zap',
] as const;

export type ContributionIcon = (typeof CONTRIBUTION_ICONS)[number];

export interface CommandIntegrationManifest extends IntegrationBase {
  kind: 'app.command';
  title?: string;
  label?: string;
  subtitle?: string;
  shortcut?: string;
  icon?: ContributionIcon;
  handler?: string;
}

export interface ToolbarIntegrationManifest extends IntegrationBase {
  kind: 'app.toolbar';
  slot?: 'toolbar.main';
  title?: string;
  label?: string;
  icon?: ContributionIcon;
  handler?: string;
}

export interface StatusIntegrationManifest extends IntegrationBase {
  kind: 'app.status';
  /**
   * `status.main` (default) sits left of the MCP status icon and shows
   * icon plus text. `status.after-mcp` is an icon button immediately to the
   * right of that MCP icon; `text` is its tooltip.
   */
  slot?: 'status.main' | 'status.after-mcp';
  /** Text shown before the first refresh, and the only text when static. */
  text?: string;
  label?: string;
  icon?: ContributionIcon;
  /** Returns `{ text?, tooltip? }` on click and on every refresh tick. */
  handler?: string;
  /** 5–3600. Omit for a static item. */
  refreshSeconds?: number;
}

export interface ComposerSlashIntegrationManifest extends IntegrationBase {
  kind: 'app.composer.slash';
  /** Typed after `/`; lowercase, digits and dashes. Defaults to `id`. */
  command?: string;
  title?: string;
  label?: string;
  description?: string;
  /** Inserted into the draft when the author picks the command. */
  prompt?: string;
}

export interface TimelineCardIntegrationManifest extends IntegrationBase {
  kind: 'app.timeline.card';
  label?: string;
  handler: 'surface.createSession';
  allowedMethods?: string[];
  /** 240–900. */
  minHeight?: number;
}

export interface SettingsSectionIntegrationManifest extends IntegrationBase {
  kind: 'app.settings.section';
  title: string;
  handler: 'surface.createSession';
  allowedMethods?: string[];
  /** 240–900. */
  minHeight?: number;
}

export interface HookIntegrationManifest extends IntegrationBase {
  kind: 'content.hook';
  resource: string;
  event: string;
}

export interface HostServiceIntegrationManifest extends IntegrationBase {
  kind: 'host.service';
  handler: string;
  /** 5–86400, default 30. At most eight services tick per plugin. */
  intervalSeconds?: number;
}

/**
 * Adds an entry to the "import from…" menu in model provider settings.
 *
 * The handler returns the presets it discovered; the Host renders the picker
 * and writes them through `provider.presets.save`. Importing never binds — the
 * user still chooses which preset an agent uses.
 */
export interface ProviderImportSourceIntegrationManifest
  extends IntegrationBase {
  kind: 'provider.model.importSource';
  label: string;
  handler: string;
  icon?: ContributionIcon;
  /** Agent ids this source can import for. Omit for every agent. */
  agents?: string[];
  description?: string;
}

/**
 * Contributes a static no-secret template catalog for the new-provider form.
 *
 * Host reads `resource` at inspect time and renders templates. Selecting a
 * template fills the Host form; it is not a saved preset until the user saves.
 */
export interface ProviderCatalogIntegrationManifest extends IntegrationBase {
  kind: 'provider.model.catalog';
  label: string;
  /** Static catalog JSON, relative to the plugin root. Host reads it at inspect. */
  resource: string;
  icon?: ContributionIcon;
  /** Omit = the file's agentId. Non-empty further intersects with file contents. */
  agents?: string[];
  description?: string;
}

export type ProviderCatalogCategory =
  | 'official'
  | 'prime'
  | 'partner'
  | 'community';

export type ProviderCatalogSurface = 'reusable' | 'opencode' | 'dsh';

export interface ProviderCatalogChrome {
  id: string;
  name: string;
  websiteUrl?: string;
  apiKeyUrl?: string;
  endpointCandidates?: string[];
  apiKeyField?: string;
  category?: ProviderCatalogCategory;
}

export type ProviderCatalogTemplate = ProviderCatalogChrome &
  (
    | {
        surface: 'reusable';
        apiUrl: string;
        model: string;
      }
    | {
        surface: 'opencode';
        providerId: string;
        npm?: string;
        api?: string;
        baseUrl: string;
        models: Array<{ id: string; name?: string }>;
      }
    | {
        surface: 'dsh';
        displayName: string;
        baseUrl: string;
        notes?: string;
        api?: string;
        defaultModel?: string;
        models: Array<{ id: string; name?: string }>;
      }
  );

export interface ProviderCatalogFile {
  schemaVersion: 1;
  agentId: string;
  templates: ProviderCatalogTemplate[];
}

export interface PanelIntegrationManifest extends IntegrationBase {
  kind: 'app.panel';
  title: string;
  icon?: ContributionIcon;
  handler: 'surface.createSession';
  defaultPosition?: 'left' | 'center';
  hidesBottomDock?: boolean;
  /** Each open request creates a new Dockview tab. */
  multiInstance?: boolean;
  /** Host-owned native chrome, e.g. host-browser. */
  engine?: string;
  allowedMethods?: string[];
}

export interface RailSectionIntegrationManifest extends IntegrationBase {
  kind: 'app.rail.section';
  title: string;
  icon?: ContributionIcon;
  opens: {
    kind: 'app.panel';
    id: string;
    instance?: 'focus' | 'new';
  };
}

export interface TabIntegrationManifest extends IntegrationBase {
  kind: 'app.tab';
  title: string;
  icon?: ContributionIcon;
  handler: 'surface.createSession';
  hidesBottomDock?: boolean;
  allowedMethods?: string[];
}

export interface KanbanViewIntegrationManifest extends IntegrationBase {
  kind: 'app.kanban.view';
  title: string;
  icon?: ContributionIcon;
  handler: 'surface.createSession';
  hidesBottomDock?: boolean;
}

export interface SettingsPageIntegrationManifest extends IntegrationBase {
  kind: 'app.settings.page';
  title: string;
  icon?: ContributionIcon;
  handler: 'surface.createSession';
  engine?: string;
  allowedMethods?: string[];
}

export interface ComposerActionIntegrationManifest extends IntegrationBase {
  kind: 'app.composer.action';
  title?: string;
  label?: string;
  icon?: ContributionIcon;
  handler?: string;
  prompt?: string;
}

/**
 * Registers a Host-side provisioner that can install, start, and pair a remote
 * Host, then save it to the client list. Later connects use the saved origin
 * and token. The Host never branches on plugin identity.
 */
export interface RemoteProvisionerIntegrationManifest extends IntegrationBase {
  kind: 'provider.remote.provisioner';
  /** Stable source tag written onto saved Hosts, e.g. `ssh`. */
  provisionKind: string;
  label: string;
  handler: string;
  icon?: ContributionIcon;
  /** 5–600. Default 120. Used by the plugin's repair handler. */
  timeoutSeconds?: number;
}

export type IntegrationManifest =
  | SkillIntegrationManifest
  | McpIntegrationManifest
  | HookIntegrationManifest
  | WorkflowIntegrationManifest
  | FileOpenerIntegrationManifest
  | PreviewIntegrationManifest
  | AppSurfaceIntegrationManifest
  | CommandIntegrationManifest
  | ToolbarIntegrationManifest
  | StatusIntegrationManifest
  | ComposerSlashIntegrationManifest
  | TimelineCardIntegrationManifest
  | SettingsSectionIntegrationManifest
  | HostServiceIntegrationManifest
  | ProviderImportSourceIntegrationManifest
  | ProviderCatalogIntegrationManifest
  | PanelIntegrationManifest
  | TabIntegrationManifest
  | KanbanViewIntegrationManifest
  | SettingsPageIntegrationManifest
  | ComposerActionIntegrationManifest
  | RemoteProvisionerIntegrationManifest
  | RailSectionIntegrationManifest;

const relativePath = {
  type: 'string',
  minLength: 1,
  pattern: '^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$',
} as const;

const id = {
  type: 'string',
  pattern: '^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$',
} as const;

export const pluginManifestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://schemas.vibex.dev/plugin/v4/plugin.schema.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'manifestVersion',
    'apiVersion',
    'id',
    'publisher',
    'version',
    'name',
  ],
  properties: {
    $schema: { type: 'string' },
    manifestVersion: { const: 4 },
    apiVersion: { const: '2.0' },
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{1,62}$' },
    publisher: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,62}$' },
    version: {
      type: 'string',
      pattern:
        '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:[-+][0-9A-Za-z.-]+)?$',
    },
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    readme: { const: 'README.md' },
    engines: {
      type: 'object',
      additionalProperties: false,
      properties: {
        vibex: { type: 'string', minLength: 1 },
        pluginSdk: { type: 'string', minLength: 1 },
      },
    },
    content: {
      type: 'object',
      additionalProperties: false,
      required: ['root', 'index'],
      properties: {
        root: { const: 'contents' },
        index: { const: '.vibex-plugin/content.index.json' },
      },
    },
    config: {
      type: 'object',
      additionalProperties: false,
      required: ['schema'],
      properties: { schema: { type: 'object' } },
    },
    dependencies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { enum: ['runtime', 'plugin'] },
          descriptor: relativePath,
          optional: { type: 'boolean' },
          id: { type: 'string', minLength: 1 },
          publisher: { type: 'string' },
          versionRange: { type: 'string' },
          required: { type: 'boolean' },
        },
      },
    },
    entrypoints: {
      type: 'object',
      additionalProperties: false,
      properties: {
        worker: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'runtime', 'protocol'],
          properties: {
            path: relativePath,
            runtime: { enum: ['node', 'python', 'native'] },
            protocol: { const: '1.1' },
          },
        },
        app: {
          type: 'object',
          additionalProperties: false,
          required: ['entry', 'protocol'],
          properties: {
            entry: relativePath,
            styles: relativePath,
            protocol: { const: '2.0' },
          },
        },
      },
    },
    permissions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'capability', 'scope', 'reason'],
        properties: {
          id,
          capability: { enum: ['runtime.execute', 'artifact.preview'] },
          scope: { type: 'object' },
          reason: { type: 'string', minLength: 1 },
          optional: { type: 'boolean' },
          trustTier: { enum: ['sandboxed_worker', 'trusted_native'] },
        },
      },
    },
    integrations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind'],
        properties: {
          id,
          kind: {
            enum: [
              'content.skill',
              'content.mcp',
              'content.hook',
              'workflow.binding',
              'file.opener',
              'artifact.preview',
              'app.surface',
              'app.command',
              'app.toolbar',
              'app.status',
              'app.composer.slash',
              'app.timeline.card',
              'app.settings.section',
              'host.service',
              'provider.model.importSource',
              'provider.model.catalog',
              'app.panel',
              'app.tab',
              'app.kanban.view',
              'app.settings.page',
              'app.composer.action',
              'app.rail.section',
              'provider.remote.provisioner',
            ],
          },
          resource: relativePath,
          required: { type: 'boolean' },
        },
      },
    },
    interface: { type: 'object' },
  },
} as const;
