import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
const TOP_LEVEL = new Set([
    "$schema",
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
    "dependencies",
    "entrypoints",
    "permissions",
    "integrations",
    "interface",
]);
const INTEGRATION_KINDS = new Set([
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
]);
const CAPABILITIES = new Set(["runtime.execute", "artifact.preview"]);
export async function validatePlugin(root) {
    const pluginRoot = resolve(root);
    const diagnostics = [];
    const manifestPath = join(pluginRoot, ".vibex-plugin/plugin.json");
    let manifest;
    try {
        const raw = JSON.parse(await readFile(manifestPath, "utf8"));
        if (!isObject(raw))
            throw new Error("Manifest must be a JSON object");
        manifest = raw;
    }
    catch (error) {
        return invalid("manifest_unreadable", error, manifestPath);
    }
    for (const key of Object.keys(manifest)) {
        if (!TOP_LEVEL.has(key)) {
            diagnostics.push(error("manifest_unknown_field", `Unknown manifest field: ${key}`));
        }
    }
    exact(manifest, "manifestVersion", 4, diagnostics);
    exact(manifest, "apiVersion", "1.0", diagnostics);
    pattern(manifest, "id", /^[a-z0-9][a-z0-9._-]{1,62}$/, diagnostics);
    pattern(manifest, "publisher", /^[a-z0-9][a-z0-9._-]{0,62}$/, diagnostics);
    pattern(manifest, "version", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/, diagnostics);
    string(manifest, "name", diagnostics);
    exact(manifest, "readme", "README.md", diagnostics);
    await validateReadme(pluginRoot, diagnostics);
    await validateConfig(pluginRoot, manifest.config, diagnostics);
    await validateContent(pluginRoot, manifest.content, diagnostics);
    await validateDependencies(pluginRoot, manifest.dependencies, diagnostics);
    await validateEntrypoints(pluginRoot, manifest.entrypoints, diagnostics);
    validatePermissions(manifest.permissions, diagnostics);
    await validateIntegrations(pluginRoot, manifest.integrations, diagnostics);
    if (!isObject(manifest.engines)) {
        diagnostics.push(error("engines_invalid", "engines is required"));
    }
    else if (typeof manifest.engines.vibex !== "string" ||
        typeof manifest.engines.pluginSdk !== "string") {
        diagnostics.push(error("engines_invalid", "engines.vibex and engines.pluginSdk are required"));
    }
    return {
        valid: diagnostics.every((item) => item.severity !== "error"),
        manifest: manifest,
        diagnostics,
    };
}
async function validateReadme(root, diagnostics) {
    const path = join(root, "README.md");
    try {
        const readme = await readFile(path, "utf8");
        const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(readme);
        const summary = match?.[1]
            .split(/\r?\n/u)
            .find((line) => line.startsWith("summary:"))
            ?.slice("summary:".length)
            .trim()
            .replace(/^(['"])(.*)\1$/u, "$2");
        if (!summary || summary.length > 200 || /[\r\n]/u.test(summary)) {
            diagnostics.push(error("readme_summary_invalid", "README.md must start with one non-empty summary tag of at most 200 characters", path));
        }
    }
    catch (cause) {
        diagnostics.push(error("readme_unreadable", message(cause), path));
    }
}
async function validateConfig(root, declaration, diagnostics) {
    const path = join(root, "config.json");
    if (!isObject(declaration) || !isObject(declaration.schema)) {
        diagnostics.push(error("config_schema_invalid", "config.schema is required"));
    }
    try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (!isObject(value))
            throw new Error("config.json must be a JSON object");
        if (isObject(declaration) && isObject(declaration.schema)) {
            validateConfigValue(declaration.schema, value, "config");
        }
    }
    catch (cause) {
        diagnostics.push(error("config_invalid", message(cause), path));
    }
}
function validateConfigValue(schema, value, path) {
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
        throw new Error(`${path} is not one of the allowed values`);
    }
    switch (schema.type) {
        case "object": {
            if (!isObject(value))
                throw new Error(`${path} must be an object`);
            const properties = isObject(schema.properties) ? schema.properties : {};
            if (schema.additionalProperties === false) {
                const unknown = Object.keys(value).find((key) => !(key in properties));
                if (unknown)
                    throw new Error(`${path}.${unknown} is not allowed`);
            }
            if (Array.isArray(schema.required)) {
                const missing = schema.required.find((key) => typeof key === "string" && !(key in value));
                if (missing)
                    throw new Error(`${path}.${String(missing)} is required`);
            }
            for (const [key, child] of Object.entries(properties)) {
                if (key in value && isObject(child)) {
                    validateConfigValue(child, value[key], `${path}.${key}`);
                }
            }
            return;
        }
        case "array":
            if (!Array.isArray(value))
                throw new Error(`${path} must be an array`);
            if (isObject(schema.items)) {
                value.forEach((item, index) => validateConfigValue(schema.items, item, `${path}[${index}]`));
            }
            return;
        case "string":
            if (typeof value !== "string")
                throw new Error(`${path} must be a string`);
            return;
        case "boolean":
            if (typeof value !== "boolean")
                throw new Error(`${path} must be a boolean`);
            return;
        case "number":
            if (typeof value !== "number" || !Number.isFinite(value)) {
                throw new Error(`${path} must be a finite number`);
            }
            return;
        case "integer":
            if (!Number.isInteger(value))
                throw new Error(`${path} must be an integer`);
            if (typeof schema.minimum === "number" &&
                Number(value) < schema.minimum) {
                throw new Error(`${path} is below the minimum`);
            }
            if (typeof schema.maximum === "number" &&
                Number(value) > schema.maximum) {
                throw new Error(`${path} exceeds the maximum`);
            }
            return;
    }
}
async function validateContent(root, declaration, diagnostics) {
    if (!isObject(declaration) ||
        declaration.root !== "contents" ||
        declaration.index !== ".vibex-plugin/content.index.json") {
        diagnostics.push(error("content_contract_invalid", "content root and index must use the public contract"));
        return;
    }
    const path = join(root, ".vibex-plugin/content.index.json");
    try {
        const index = JSON.parse(await readFile(path, "utf8"));
        if (!isObject(index) ||
            index.schemaVersion !== 1 ||
            !Array.isArray(index.items)) {
            throw new Error("content index must use schemaVersion 1 and an items array");
        }
        for (const item of index.items) {
            if (!isObject(item) ||
                typeof item.path !== "string" ||
                !item.path.startsWith("contents/") ||
                typeof item.kind !== "string" ||
                typeof item.title !== "string" ||
                !(await safeFile(root, item.path))) {
                diagnostics.push(error("content_path_invalid", "Content index entries must resolve inside contents", path));
            }
        }
    }
    catch (cause) {
        diagnostics.push(error("content_index_invalid", message(cause), path));
    }
}
async function validateDependencies(root, value, diagnostics) {
    if (value === undefined)
        return;
    if (!Array.isArray(value)) {
        diagnostics.push(error("dependencies_invalid", "dependencies must be an array"));
        return;
    }
    for (const dependency of value) {
        if (!isObject(dependency) ||
            !["runtime", "plugin"].includes(String(dependency.kind)) ||
            typeof dependency.descriptor !== "string" ||
            !(await safeFile(root, dependency.descriptor))) {
            diagnostics.push(error("dependency_invalid", "Dependency descriptor is invalid"));
        }
    }
}
async function validateEntrypoints(root, value, diagnostics) {
    if (value === undefined)
        return;
    if (!isObject(value)) {
        diagnostics.push(error("entrypoints_invalid", "entrypoints must be an object"));
        return;
    }
    if (isObject(value.worker)) {
        if ("format" in value.worker ||
            !["node", "python", "native"].includes(String(value.worker.runtime)) ||
            value.worker.protocol !== "1.1" ||
            typeof value.worker.path !== "string" ||
            !(await safeFile(root, value.worker.path))) {
            diagnostics.push(error("worker_entrypoint_invalid", "Worker entrypoint is invalid"));
        }
    }
    if (isObject(value.app)) {
        if (value.app.protocol !== "1.0" ||
            typeof value.app.root !== "string" ||
            typeof value.app.document !== "string" ||
            !(await safeFile(root, join(value.app.root, value.app.document)))) {
            diagnostics.push(error("app_entrypoint_invalid", "App entrypoint is invalid"));
        }
    }
}
function validatePermissions(value, diagnostics) {
    if (value === undefined)
        return;
    if (!Array.isArray(value)) {
        diagnostics.push(error("permissions_invalid", "permissions must be an array"));
        return;
    }
    for (const permission of value) {
        if (!isObject(permission) ||
            !CAPABILITIES.has(String(permission.capability))) {
            diagnostics.push(error("permission_unknown", "Permission capability is unknown"));
        }
    }
}
async function validateIntegrations(root, value, diagnostics) {
    if (!Array.isArray(value) || value.length === 0) {
        diagnostics.push(error("integration_required", "At least one integration is required"));
        return;
    }
    const integrations = value.filter(isObject);
    const surfaces = new Map(integrations
        .filter((item) => item.kind === "app.surface")
        .map((item) => [String(item.id), item]));
    const previews = new Set(integrations
        .filter((item) => item.kind === "artifact.preview")
        .map((item) => String(item.id)));
    for (const integration of value) {
        if (!isObject(integration) ||
            !INTEGRATION_KINDS.has(String(integration.kind))) {
            diagnostics.push(error("integration_unknown", "Integration kind is unknown"));
            continue;
        }
        if (["content.skill", "content.mcp", "workflow.binding"].includes(String(integration.kind)) &&
            (typeof integration.resource !== "string" ||
                !(await safePath(root, integration.resource)))) {
            diagnostics.push(error("integration_resource_invalid", "Integration resource is invalid"));
        }
        if (integration.kind === "content.mcp" &&
            typeof integration.resource === "string" &&
            (await safePath(root, integration.resource))) {
            try {
                const resource = JSON.parse(await readFile(join(root, integration.resource), "utf8"));
                if (isObject(resource) && "managedRuntime" in resource) {
                    const managed = resource.managedRuntime;
                    const hostFamily = isObject(managed) && managed.kind === "hostFamilyBinary";
                    const packaged = isObject(managed) &&
                        typeof managed.entrypoint === "string" &&
                        (await safePath(root, managed.entrypoint));
                    if (!isObject(managed) ||
                        managed.protocolRevision !== "2026-07-28" ||
                        (managed.defaultBinding !== undefined &&
                            managed.defaultBinding !== "all-compatible-agents") ||
                        (!hostFamily && !packaged) ||
                        (hostFamily && typeof managed.binaryId !== "string") ||
                        (managed.source !== undefined &&
                            (typeof managed.source !== "string" ||
                                !(await safePath(root, managed.source))))) {
                        diagnostics.push(error("managed_mcp_invalid", "Managed MCP requires hostFamilyBinary or a package entrypoint, protocolRevision 2026-07-28, and an optional all-compatible-agents default binding"));
                    }
                }
            }
            catch {
                diagnostics.push(error("mcp_resource_invalid", "MCP resource must be valid JSON"));
            }
        }
        if (integration.kind === "file.opener") {
            const preview = typeof integration.previewProvider === "string"
                ? integration.previewProvider
                : null;
            const editor = typeof integration.editorSurface === "string"
                ? integration.editorSurface
                : null;
            if ((preview === null) === (editor === null) ||
                (preview !== null && !previews.has(preview)) ||
                (editor !== null && surfaces.get(editor)?.slot !== "artifact.editor")) {
                diagnostics.push(error("file_opener_target_invalid", "A file opener requires exactly one published previewProvider or artifact.editor surface"));
            }
            if (!Array.isArray(integration.extensions) &&
                !Array.isArray(integration.fileNameSuffixes) &&
                !Array.isArray(integration.mediaTypes)) {
                diagnostics.push(error("file_opener_match_invalid", "A file opener requires extensions, fileNameSuffixes, or mediaTypes"));
            }
            if (Array.isArray(integration.fileNameSuffixes) &&
                integration.fileNameSuffixes.some((suffix) => typeof suffix !== "string" || !/^\.[A-Za-z0-9._-]+$/.test(suffix))) {
                diagnostics.push(error("file_opener_suffix_invalid", "File opener filename suffixes must start with a dot and contain only letters, digits, dots, dashes, or underscores"));
            }
        }
        if (integration.kind === "app.surface" &&
            (!["plugin.detail.panel", "artifact.editor"].includes(String(integration.slot)) ||
                integration.appEntrypoint !== "app" ||
                integration.handler !== "surface.createSession")) {
            diagnostics.push(error("app_surface_invalid", "App surface declaration is invalid"));
        }
    }
}
async function safeFile(root, path) {
    return (await safePath(root, path, true)) !== null;
}
async function safePath(root, path, fileOnly = false) {
    if (isAbsolute(path))
        return null;
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
        return null;
    try {
        const info = await lstat(absolute);
        if (info.isSymbolicLink() || (fileOnly && !info.isFile()))
            return null;
        return absolute;
    }
    catch {
        return null;
    }
}
function exact(object, key, expected, diagnostics) {
    if (object[key] !== expected)
        diagnostics.push(error(`${key}_invalid`, `${key} is invalid`));
}
function pattern(object, key, expected, diagnostics) {
    if (typeof object[key] !== "string" || !expected.test(object[key])) {
        diagnostics.push(error(`${key}_invalid`, `${key} is invalid`));
    }
}
function string(object, key, diagnostics) {
    if (typeof object[key] !== "string" || !object[key]) {
        diagnostics.push(error(`${key}_invalid`, `${key} is required`));
    }
}
function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function error(code, text, path) {
    return { code, severity: "error", message: text, path };
}
function invalid(code, cause, path) {
    return { valid: false, diagnostics: [error(code, message(cause), path)] };
}
function message(cause) {
    return cause instanceof Error ? cause.message : String(cause);
}
