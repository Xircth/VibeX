export const PLUGIN_DEV_PROTOCOL_VERSION = "1.0";
export function resolvePluginDevConnection(args, environment = process.env) {
    const endpoint = option(args, "--host") ?? environment.VIBEX_PLUGIN_DEV_HOST;
    const token = option(args, "--token") ?? environment.VIBEX_PLUGIN_DEV_TOKEN;
    if (!endpoint)
        throw new Error("plugin_dev_host_missing");
    if (!token)
        throw new Error("plugin_dev_token_missing");
    return { endpoint, token };
}
export class PluginDevHostError extends Error {
    code;
    retryable;
    diagnosticId;
    publishedGeneration;
    constructor(code, message, retryable, diagnosticId, publishedGeneration) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        this.diagnosticId = diagnosticId;
        this.publishedGeneration = publishedGeneration;
        this.name = "PluginDevHostError";
    }
}
export class PluginDevHostClient {
    #endpoint;
    #token;
    constructor(options) {
        this.#endpoint = validateEndpoint(options.endpoint);
        if (!options.token.trim())
            throw new Error("plugin_dev_token_missing");
        this.#token = options.token;
    }
    installLinked(request) {
        return this.#request("POST", "/api/plugin-dev/v1/linked-installations", request);
    }
    reloadCandidate(plugin, request) {
        return this.#request("POST", pluginPath(plugin, "candidates"), request);
    }
    uninstallLinked(plugin, retainData) {
        return this.#request("DELETE", pluginPath(plugin, "linked-installation"), { retainData });
    }
    async doctor(plugin) {
        const report = await this.#request("GET", pluginPath(plugin, "doctor"));
        if (!isObject(report.plugin) ||
            typeof report.plugin.publisher !== "string" ||
            typeof report.plugin.id !== "string" ||
            !Array.isArray(report.grants) ||
            !Array.isArray(report.runtimes) ||
            !Array.isArray(report.surfaces) ||
            !Array.isArray(report.agentBindings) ||
            !Array.isArray(report.recentCrashes) ||
            !Array.isArray(report.diagnostics) ||
            report.diagnostics.some((diagnostic) => !isObject(diagnostic) ||
                typeof diagnostic.code !== "string" ||
                !["error", "warning"].includes(String(diagnostic.severity)) ||
                typeof diagnostic.message !== "string")) {
            throw new PluginDevHostError("plugin_dev_response_invalid", "Host returned an invalid Plugin doctor response", false);
        }
        return report;
    }
    async #request(method, path, body) {
        const response = await fetch(new URL(path, this.#endpoint), {
            method,
            headers: {
                accept: "application/json",
                ...(body === undefined ? {} : { "content-type": "application/json" }),
                "x-vibex-plugin-dev-token": this.#token,
                "x-vibex-plugin-dev-protocol": PLUGIN_DEV_PROTOCOL_VERSION,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const payload = (await response.json());
        if (!response.ok)
            throw hostError(payload, response.status);
        if (!isObject(payload) ||
            payload.protocolVersion !== PLUGIN_DEV_PROTOCOL_VERSION) {
            throw new PluginDevHostError("plugin_dev_protocol_mismatch", "Host returned an incompatible Plugin Dev protocol version", false);
        }
        return payload;
    }
}
function validateEndpoint(value) {
    const endpoint = new URL(value);
    const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
    if (endpoint.protocol !== "http:" ||
        !["localhost", "127.0.0.1", "::1"].includes(hostname) ||
        endpoint.username ||
        endpoint.password ||
        endpoint.pathname !== "/" ||
        endpoint.search ||
        endpoint.hash) {
        throw new Error("plugin_dev_host_must_be_loopback_http_origin");
    }
    return endpoint;
}
function pluginPath(plugin, operation) {
    return `/api/plugin-dev/v1/plugins/${encodeURIComponent(plugin.publisher)}/${encodeURIComponent(plugin.id)}/${operation}`;
}
function hostError(payload, status) {
    const error = isObject(payload) && isObject(payload.error) ? payload.error : {};
    return new PluginDevHostError(typeof error.code === "string" ? error.code : `plugin_dev_http_${status}`, typeof error.message === "string"
        ? error.message
        : `Plugin Dev Host request failed with HTTP ${status}`, error.retryable === true, typeof error.diagnosticId === "string" ? error.diagnosticId : undefined, typeof error.publishedGeneration === "number"
        ? error.publishedGeneration
        : undefined);
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function option(args, name) {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}
