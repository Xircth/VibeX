const relativePath = {
    type: "string",
    minLength: 1,
    pattern: "^(?!/)(?![A-Za-z]:)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
};
const id = {
    type: "string",
    pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$",
};
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
            pattern: "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:[-+][0-9A-Za-z.-]+)?$",
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
};
