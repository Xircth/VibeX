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
    engines: {
        vibex: string;
        pluginSdk: string;
    };
    content: {
        root: "contents";
        index: ".vibex-plugin/content.index.json";
    };
    /** Values live in root config.json; this schema only describes and validates them. */
    config: {
        schema: Record<string, unknown>;
    };
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
/**
 * Icon names the Host is willing to render for plugin chrome. Plugins name an
 * icon instead of shipping markup, so no plugin asset reaches Host DOM.
 * Mirrored by `@vibex/plugin-contract/catalog/icons` and the Rust
 * `CONTRIBUTION_ICONS`; all three are asserted equal by tests.
 */
export declare const CONTRIBUTION_ICONS: readonly ["activity", "alert-triangle", "bell", "bookmark", "bot", "calendar", "chart-bar", "check-circle", "clock", "cloud", "code", "database", "file-text", "filter", "flag", "folder", "gauge", "git-branch", "globe", "info", "key", "layers", "link", "list", "message-square", "package", "play", "plug", "puzzle", "refresh-cw", "search", "settings", "shield", "sparkles", "star", "tag", "terminal", "timer", "user", "zap"];
export type ContributionIcon = (typeof CONTRIBUTION_ICONS)[number];
export interface CommandIntegrationManifest extends IntegrationBase {
    kind: "app.command";
    title: string;
    subtitle?: string;
    shortcut?: string;
    icon?: ContributionIcon;
    handler: string;
}
export interface ToolbarIntegrationManifest extends IntegrationBase {
    kind: "app.toolbar";
    slot?: "toolbar.main";
    title: string;
    icon?: ContributionIcon;
    handler: string;
}
export interface StatusIntegrationManifest extends IntegrationBase {
    kind: "app.status";
    slot?: "status.main";
    /** Text shown before the first refresh, and the only text when static. */
    text?: string;
    icon?: ContributionIcon;
    /** Returns `{ text?, tooltip? }` on click and on every refresh tick. */
    handler: string;
    /** 5–3600. Omit for a static item. */
    refreshSeconds?: number;
}
export interface ComposerSlashIntegrationManifest extends IntegrationBase {
    kind: "app.composer.slash";
    /** Typed after `/`; lowercase, digits and dashes. Defaults to `id`. */
    command?: string;
    title: string;
    description?: string;
    /** Inserted into the draft when the author picks the command. */
    prompt: string;
}
export interface TimelineCardIntegrationManifest extends IntegrationBase {
    kind: "app.timeline.card";
    label?: string;
    handler: "surface.createSession";
    allowedMethods?: string[];
    /** 240–900. */
    minHeight?: number;
}
export interface SettingsSectionIntegrationManifest extends IntegrationBase {
    kind: "app.settings.section";
    title: string;
    handler: "surface.createSession";
    allowedMethods?: string[];
    /** 240–900. */
    minHeight?: number;
}
export interface HookIntegrationManifest extends IntegrationBase {
    kind: "content.hook";
    resource: string;
    event: string;
}
export interface HostServiceIntegrationManifest extends IntegrationBase {
    kind: "host.service";
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
export interface ProviderImportSourceIntegrationManifest extends IntegrationBase {
    kind: "provider.model.importSource";
    label: string;
    handler: string;
    icon?: ContributionIcon;
    /** Agent ids this source can import for. Omit for every agent. */
    agents?: string[];
    description?: string;
}
export interface RemoteModuleManifest {
    name: string;
    entry: string;
    module?: string;
}
export interface PanelIntegrationManifest extends IntegrationBase {
    kind: "app.panel";
    title: string;
    icon?: ContributionIcon;
    handler: "surface.createSession";
    defaultPosition?: "left" | "center";
    hidesBottomDock?: boolean;
    remote?: RemoteModuleManifest;
}
export interface TabIntegrationManifest extends IntegrationBase {
    kind: "app.tab";
    title: string;
    icon?: ContributionIcon;
    handler: "surface.createSession";
    hidesBottomDock?: boolean;
    remote?: RemoteModuleManifest;
}
export interface KanbanViewIntegrationManifest extends IntegrationBase {
    kind: "app.kanban.view";
    title: string;
    icon?: ContributionIcon;
    handler: "surface.createSession";
    hidesBottomDock?: boolean;
    remote?: RemoteModuleManifest;
}
export interface SettingsPageIntegrationManifest extends IntegrationBase {
    kind: "app.settings.page";
    title: string;
    icon?: ContributionIcon;
    handler: "surface.createSession";
    remote?: RemoteModuleManifest;
}
export interface ComposerActionIntegrationManifest extends IntegrationBase {
    kind: "app.composer.action";
    title: string;
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
    kind: "provider.remote.provisioner";
    /** Stable source tag written onto saved Hosts, e.g. `ssh`. */
    provisionKind: string;
    label: string;
    handler: string;
    icon?: ContributionIcon;
    /** 5–600. Default 120. Used by the plugin's repair handler. */
    timeoutSeconds?: number;
}
export type IntegrationManifest = SkillIntegrationManifest | McpIntegrationManifest | HookIntegrationManifest | WorkflowIntegrationManifest | FileOpenerIntegrationManifest | PreviewIntegrationManifest | AppSurfaceIntegrationManifest | CommandIntegrationManifest | ToolbarIntegrationManifest | StatusIntegrationManifest | ComposerSlashIntegrationManifest | TimelineCardIntegrationManifest | SettingsSectionIntegrationManifest | HostServiceIntegrationManifest | ProviderImportSourceIntegrationManifest | PanelIntegrationManifest | TabIntegrationManifest | KanbanViewIntegrationManifest | SettingsPageIntegrationManifest | ComposerActionIntegrationManifest | RemoteProvisionerIntegrationManifest;
export declare const pluginManifestSchema: {
    readonly $schema: "https://json-schema.org/draft/2020-12/schema";
    readonly $id: "https://schemas.vibex.dev/plugin/v4/plugin.schema.json";
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["manifestVersion", "apiVersion", "id", "publisher", "version", "name", "readme", "engines", "content", "config", "integrations"];
    readonly properties: {
        readonly $schema: {
            readonly type: "string";
        };
        readonly manifestVersion: {
            readonly const: 4;
        };
        readonly apiVersion: {
            readonly const: "1.0";
        };
        readonly id: {
            readonly type: "string";
            readonly pattern: "^[a-z0-9][a-z0-9._-]{1,62}$";
        };
        readonly publisher: {
            readonly type: "string";
            readonly pattern: "^[a-z0-9][a-z0-9._-]{0,62}$";
        };
        readonly version: {
            readonly type: "string";
            readonly pattern: "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:[-+][0-9A-Za-z.-]+)?$";
        };
        readonly name: {
            readonly type: "string";
            readonly minLength: 1;
        };
        readonly readme: {
            readonly const: "README.md";
        };
        readonly engines: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["vibex", "pluginSdk"];
            readonly properties: {
                readonly vibex: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
                readonly pluginSdk: {
                    readonly type: "string";
                    readonly minLength: 1;
                };
            };
        };
        readonly content: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["root", "index"];
            readonly properties: {
                readonly root: {
                    readonly const: "contents";
                };
                readonly index: {
                    readonly const: ".vibex-plugin/content.index.json";
                };
            };
        };
        readonly config: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly required: readonly ["schema"];
            readonly properties: {
                readonly schema: {
                    readonly type: "object";
                };
            };
        };
        readonly dependencies: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["kind", "descriptor"];
                readonly properties: {
                    readonly kind: {
                        readonly enum: readonly ["runtime", "plugin"];
                    };
                    readonly descriptor: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$";
                    };
                    readonly optional: {
                        readonly type: "boolean";
                    };
                };
            };
        };
        readonly entrypoints: {
            readonly type: "object";
            readonly additionalProperties: false;
            readonly properties: {
                readonly worker: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                    readonly required: readonly ["path", "runtime", "protocol"];
                    readonly properties: {
                        readonly path: {
                            readonly type: "string";
                            readonly minLength: 1;
                            readonly pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$";
                        };
                        readonly runtime: {
                            readonly enum: readonly ["node", "python", "native"];
                        };
                        readonly protocol: {
                            readonly const: "1.1";
                        };
                    };
                };
                readonly app: {
                    readonly type: "object";
                    readonly additionalProperties: false;
                    readonly required: readonly ["root", "document", "protocol"];
                    readonly properties: {
                        readonly root: {
                            readonly type: "string";
                            readonly minLength: 1;
                            readonly pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$";
                        };
                        readonly document: {
                            readonly type: "string";
                            readonly minLength: 1;
                            readonly pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$";
                        };
                        readonly protocol: {
                            readonly const: "1.0";
                        };
                    };
                };
            };
        };
        readonly permissions: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["id", "capability", "scope", "reason"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$";
                    };
                    readonly capability: {
                        readonly enum: readonly ["runtime.execute", "artifact.preview"];
                    };
                    readonly scope: {
                        readonly type: "object";
                    };
                    readonly reason: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly optional: {
                        readonly type: "boolean";
                    };
                    readonly trustTier: {
                        readonly enum: readonly ["sandboxed_worker", "trusted_native"];
                    };
                };
            };
        };
        readonly integrations: {
            readonly type: "array";
            readonly minItems: 1;
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["id", "kind"];
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$";
                    };
                    readonly kind: {
                        readonly enum: readonly ["content.skill", "content.mcp", "content.hook", "workflow.binding", "file.opener", "artifact.preview", "app.surface", "app.command", "app.toolbar", "app.status", "app.composer.slash", "app.timeline.card", "app.settings.section", "host.service", "provider.model.importSource", "app.panel", "app.tab", "app.kanban.view", "app.settings.page", "app.composer.action", "provider.remote.provisioner"];
                    };
                    readonly resource: {
                        readonly type: "string";
                        readonly minLength: 1;
                        readonly pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$";
                    };
                    readonly required: {
                        readonly type: "boolean";
                    };
                };
            };
        };
        readonly interface: {
            readonly type: "object";
        };
    };
};
export {};
