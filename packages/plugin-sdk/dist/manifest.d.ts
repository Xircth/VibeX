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
export interface WorkerEntrypointManifest {
    path: string;
    format: "javascript-esm";
    protocol: "1.0";
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
    /** Optional Host-native renderer. The plugin still owns file registration. */
    nativeRenderer?: "workflow.studio";
}
export type IntegrationManifest = SkillIntegrationManifest | McpIntegrationManifest | WorkflowIntegrationManifest | FileOpenerIntegrationManifest | PreviewIntegrationManifest | AppSurfaceIntegrationManifest;
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
                    readonly required: readonly ["path", "format", "protocol"];
                    readonly properties: {
                        readonly path: {
                            readonly type: "string";
                            readonly minLength: 1;
                            readonly pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$";
                        };
                        readonly format: {
                            readonly const: "javascript-esm";
                        };
                        readonly protocol: {
                            readonly const: "1.0";
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
                        readonly enum: readonly ["content.skill", "content.mcp", "workflow.binding", "file.opener", "artifact.preview", "app.surface"];
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
