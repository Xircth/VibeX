import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export function discoverProductHost(environment = process.env) {
    const envUrl = (environment.VIBEX_URL || "").replace(/\/+$/, "");
    const envToken = (environment.VIBEX_TOKEN || "").trim();
    let token = envToken;
    const port = 17891;
    if (!token) {
        for (const dir of [
            join(homedir(), ".vibex"),
            join(homedir(), "Library", "Application Support", "com.xircth.vibex"),
        ]) {
            try {
                const hostToken = join(dir, "host.token");
                token = readFileSync(hostToken, "utf8").trim();
                if (token)
                    break;
            }
            catch {
                /* continue */
            }
        }
    }
    return {
        url: envUrl || `http://127.0.0.1:${port}`,
        token,
    };
}
export async function callProductHost(command, args = {}) {
    const host = discoverProductHost();
    if (!host.token) {
        throw new Error("No running VibeX Host. Start Desktop or `vibex serve`.");
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
