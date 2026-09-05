import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveHostSession, } from "./hostSession.js";
export function discoverProductHost(environment = process.env) {
    return (resolveHostSession({}, environment) ?? {
        url: "http://127.0.0.1:17891",
        token: "",
    });
}
export async function pingProductHost(session = discoverProductHost()) {
    if (!session.token)
        return false;
    try {
        const response = await fetch(`${session.url}/api/v1/call/plugin_control_catalog`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${session.token}`,
                "content-type": "application/json",
                "x-vibex-protocol-version": "1.0",
            },
            body: JSON.stringify({ operation_id: randomUUID(), args: {} }),
            signal: AbortSignal.timeout(2000),
        });
        return response.status !== 404 && response.status < 500;
    }
    catch {
        return false;
    }
}
export async function callProductHost(command, args = {}) {
    const host = discoverProductHost();
    if (!host.token) {
        throw new Error("No Host is bound. Run `vibex plugin run server --http://127.0.0.1:17891 --token <token>`.");
    }
    const response = await fetch(`${host.url}/api/v1/call/${command}`, {
        method: "POST",
        headers: {
            authorization: `Bearer ${host.token}`,
            "content-type": "application/json",
            "x-vibex-protocol-version": "1.0",
        },
        body: JSON.stringify({
            operation_id: randomUUID(),
            args,
        }),
    });
    const body = (await response.json().catch(() => ({})));
    if (!response.ok) {
        throw new Error(body.error?.message || body.message || `Host ${command} failed (${response.status})`);
    }
    return (body.data ?? body);
}
function queueLinkedInstall(sourcePath) {
    const inbox = join(homedir(), ".vibex", "imports");
    mkdirSync(inbox, { recursive: true });
    appendFileSync(join(inbox, "links.jsonl"), `${JSON.stringify({ path: sourcePath, kind: "developer_link" })}\n`);
}
export async function importLinkedOnProductHost(sourcePath, plugin) {
    const host = discoverProductHost();
    if (!host.token) {
        queueLinkedInstall(sourcePath);
        return {
            plugin,
            generation: 0,
            packageDigest: "",
            queued: true,
        };
    }
    const data = await callProductHost("plugin_control_import", {
        path: sourcePath,
        developerLink: true,
        conflictDecision: "replace",
        origin: sourcePath,
        locked: false,
    });
    return {
        plugin,
        generation: Number(data.generation ?? 1),
        packageDigest: String(data.packageDigest ?? ""),
        queued: false,
    };
}
export async function enableOnProductHost(pluginId) {
    return callProductHost("plugin_control_set_enabled", {
        pluginId,
        enabled: true,
    });
}
export async function disableOnProductHost(pluginId) {
    return callProductHost("plugin_control_set_enabled", {
        pluginId,
        enabled: false,
    });
}
export async function contributionCatalogOnProductHost() {
    return callProductHost("plugin_contribution_catalog", {});
}
export async function uninstallOnProductHost(pluginId, retainData = true) {
    return callProductHost("plugin_control_uninstall", {
        pluginId,
        retainData,
    });
}
export async function doctorOnProductHost(pluginId) {
    const catalog = await callProductHost("plugin_control_catalog", {});
    const plugin = (catalog.plugins ?? []).find((item) => item.id === pluginId);
    if (!plugin) {
        return {
            plugin: { id: pluginId },
            diagnostics: [
                { severity: "error", code: "plugin_not_installed", message: "not in Host catalog" },
            ],
            installation: null,
        };
    }
    return {
        plugin,
        diagnostics: (plugin.warnings ?? []).map((item) => ({
            severity: item.severity === "error" ? "error" : "warning",
            code: "host_warning",
            message: item.message ?? "",
        })),
        installation: plugin,
    };
}
