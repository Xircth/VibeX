/** Public authoring contract for a VibeX product plugin. */
export interface VibeXPluginManifest {
  $schema?: string;
  manifestVersion: 4;
  apiVersion: "1.0";
  id: string;
  publisher: string;
  version: string;
  name: string;
  /** Always points to the required root README. Its frontmatter owns `summary`. */
  readme: "README.md";
  engines: { vibex: string; pluginSdk: string };
  content: {
    root: "contents";
    index: ".vibex-plugin/content.index.json";
  };
  /** Values live in root config.json; this schema only describes and validates them. */
  config: { schema: Record<string, unknown> };
  dependencies?: DependencyManifest[];
  entrypoints?: {
    worker?: WorkerEntrypointManifest;
    app?: AppEntrypointManifest;
  };
  permissions?: PermissionManifest[];
  integrations: IntegrationManifest[];
  interface?: Record<string, unknown>;
}

export type WorkerRuntime = "node" | "python" | "native";

export interface WorkerEntrypointManifest {
  path: string;
  runtime: WorkerRuntime;
  protocol: "1.1";
}

export interface AppEntrypointManifest {
  root: string;
  document: string;
  protocol: "1.0";
}

export interface PermissionManifest {
  /** @deprecated Full-trust packages do not require capability consent. */
  id: string;
  capability: string;
  scope: Record<string, unknown>;
  reason: string;
  optional?: boolean;
  /** @deprecated Retained only so v4 packages authored before full trust remain valid. */
  trustTier?: "sandboxed_worker" | "trusted_native";
}

export interface DependencyManifest {
  kind: "runtime" | "plugin";
  descriptor: string;
  optional?: boolean;
}

interface IntegrationBase {
  id: string;
  required?: boolean;
}

export interface SkillIntegrationManifest extends IntegrationBase {
  kind: "content.skill";
  resource: string;
  targets?: string[];
}

export interface McpIntegrationManifest extends IntegrationBase {
  kind: "content.mcp";
  resource: string;
}

/** Package-relative MCP process supervised and credentialed by the VibeX Host. */
export interface ManagedMcpRuntimeResource {
  managedRuntime: {
    /** Authoring source bundled by the Plugin CLI into `entrypoint`. */
    source?: string;
    entrypoint: string;
    protocolRevision: "2026-07-28";
    defaultBinding?: "all-compatible-agents";
  };
}

export interface WorkflowIntegrationManifest extends IntegrationBase {
  kind: "workflow.binding";
  resource: string;
}

export interface FileOpenerIntegrationManifest extends IntegrationBase {
  kind: "file.opener";
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
  kind: "artifact.preview";
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
  kind: "app.surface";
  label?: string;
  slot: "plugin.detail.panel" | "artifact.editor";
  appEntrypoint: "app";
  route?: `/${string}`;
  handler: string;
  allowedMethods?: string[];
  minHeight?: number;
  nativeRenderer?: string;
}

export interface CommandIntegrationManifest extends IntegrationBase {
  kind: "app.command";
  title: string;
  subtitle?: string;
  shortcut?: string;
  handler: string;
}

export interface ToolbarIntegrationManifest extends IntegrationBase {
  kind: "app.toolbar";
  slot: "toolbar.main";
  title: string;
  icon?: { kind: "svg"; resource: string };
  handler: string;
}

export interface StatusIntegrationManifest extends IntegrationBase {
  kind: "app.status";
  slot: "status.main";
  text?: string;
  handler: string;
  refreshSeconds?: number;
}

export interface ComposerSlashIntegrationManifest extends IntegrationBase {
  kind: "app.composer.slash";
  title: string;
  target: string;
}

export interface TimelineCardIntegrationManifest extends IntegrationBase {
  kind: "app.timeline.card";
  handler: string;
  minHeight?: number;
}

export interface SettingsSectionIntegrationManifest extends IntegrationBase {
  kind: "app.settings.section";
  title: string;
  handler?: string;
}

export interface HookIntegrationManifest extends IntegrationBase {
  kind: "content.hook";
  resource: string;
  event: string;
}

export interface HostServiceIntegrationManifest extends IntegrationBase {
  kind: "host.service";
  handler: string;
  intervalSeconds?: number;
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
  | HostServiceIntegrationManifest;

const relativePath = {
  type: "string",
  minLength: 1,
  pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
} as const;

const id = {
  type: "string",
  pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$",
} as const;

export const pluginManifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://schemas.vibex.dev/plugin/v4/plugin.schema.json",
  type: "object",
  additionalProperties: false,
  required: [
    "manifestVersion",
    "apiVersion",
    "id",
    "publisher",
    "version",
    "name",
    "readme",
    "engines",
    "content",
    "config",
    "integrations",
  ],
  properties: {
    $schema: { type: "string" },
    manifestVersion: { const: 4 },
    apiVersion: { const: "1.0" },
    id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{1,62}$" },
    publisher: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,62}$" },
    version: {
      type: "string",
      pattern:
        "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:[-+][0-9A-Za-z.-]+)?$",
    },
    name: { type: "string", minLength: 1 },
    readme: { const: "README.md" },
    engines: {
      type: "object",
      additionalProperties: false,
      required: ["vibex", "pluginSdk"],
      properties: {
        vibex: { type: "string", minLength: 1 },
        pluginSdk: { type: "string", minLength: 1 },
      },
    },
    content: {
      type: "object",
      additionalProperties: false,
      required: ["root", "index"],
      properties: {
        root: { const: "contents" },
        index: { const: ".vibex-plugin/content.index.json" },
      },
    },
    config: {
      type: "object",
      additionalProperties: false,
      required: ["schema"],
      properties: { schema: { type: "object" } },
    },
    dependencies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "descriptor"],
        properties: {
          kind: { enum: ["runtime", "plugin"] },
          descriptor: relativePath,
          optional: { type: "boolean" },
        },
      },
    },
    entrypoints: {
      type: "object",
      additionalProperties: false,
      properties: {
        worker: {
          type: "object",
          additionalProperties: false,
          required: ["path", "runtime", "protocol"],
          properties: {
            path: relativePath,
            runtime: { enum: ["node", "python", "native"] },
            protocol: { const: "1.1" },
          },
        },
        app: {
          type: "object",
          additionalProperties: false,
          required: ["root", "document", "protocol"],
          properties: {
            root: relativePath,
            document: relativePath,
            protocol: { const: "1.0" },
          },
        },
      },
    },
    permissions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "capability", "scope", "reason"],
        properties: {
          id,
          capability: { enum: ["runtime.execute", "artifact.preview"] },
          scope: { type: "object" },
          reason: { type: "string", minLength: 1 },
          optional: { type: "boolean" },
          trustTier: { enum: ["sandboxed_worker", "trusted_native"] },
        },
      },
    },
    integrations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "kind"],
        properties: {
          id,
          kind: {
            enum: [
              "content.skill",
              "content.mcp",
              "content.hook",
              "workflow.binding",
              "file.opener",
              "artifact.preview",
              "app.surface",
              "app.command",
              "app.toolbar",
              "app.status",
              "app.composer.slash",
              "app.timeline.card",
              "app.settings.section",
              "host.service",
            ],
          },
          resource: relativePath,
          required: { type: "boolean" },
        },
      },
    },
    interface: { type: "object" },
  },
} as const;
