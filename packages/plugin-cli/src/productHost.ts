import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  type HostSession,
  resolveHostSession,
} from "./hostSession.js";

export function discoverProductHost(
  environment: Record<string, string | undefined> = process.env,
): HostSession {
  return (
    resolveHostSession({}, environment) ?? {
      url: "http://127.0.0.1:17891",
      token: "",
    }
  );
}

export async function pingProductHost(
  session: HostSession = discoverProductHost(),
): Promise<boolean> {
  if (!session.token) return false;
  try {
    const response = await fetch(
      `${session.url}/api/v1/call/plugin_control_catalog`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "content-type": "application/json",
          "x-vibex-protocol-version": "1.0",
        },
        body: JSON.stringify({ operation_id: randomUUID(), args: {} }),
        signal: AbortSignal.timeout(2000),
      },
    );
    return response.status !== 404 && response.status < 500;
  } catch {
    return false;
  }
}

export async function callProductHost<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const host = discoverProductHost();
  if (!host.token) {
    throw new Error(
      "No Host is bound. Run `vibex plugin run server --http://127.0.0.1:17891 --token <token>`.",
    );
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
  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
    message?: string;
  };
  if (!response.ok) {
    throw new Error(
      body.error?.message || body.message || `Host ${command} failed (${response.status})`,
    );
  }
  return ((body.data ?? body) as T);
}

function queueLinkedInstall(sourcePath: string) {
  const inbox = join(homedir(), ".vibex", "imports");
  mkdirSync(inbox, { recursive: true });
  appendFileSync(
    join(inbox, "links.jsonl"),
    `${JSON.stringify({ path: sourcePath, kind: "developer_link" })}\n`,
  );
}

export async function importLinkedOnProductHost(
  sourcePath: string,
  plugin: { publisher: string; id: string },
) {
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
  const data = await callProductHost<{
    generation?: number;
    packageDigest?: string;
  }>("plugin_control_import", {
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

export async function enableOnProductHost(pluginId: string) {
  return callProductHost("plugin_control_set_enabled", {
    pluginId,
    enabled: true,
  });
}

export async function disableOnProductHost(pluginId: string) {
  return callProductHost("plugin_control_set_enabled", {
    pluginId,
    enabled: false,
  });
}

export async function contributionCatalogOnProductHost() {
  return callProductHost<{
    items?: Array<{ pluginId?: string; kind?: string }>;
  }>("plugin_contribution_catalog", {});
}

export async function uninstallOnProductHost(
  pluginId: string,
  retainData = true,
) {
  return callProductHost<{
    pluginId?: string;
    dataRetention?: string;
  }>("plugin_control_uninstall", {
    pluginId,
    retainData,
  });
}

export async function doctorOnProductHost(pluginId: string) {
  const catalog = await callProductHost<{
    plugins?: Array<{
      id: string;
      packageDigest?: string;
      enabled?: boolean;
      warnings?: Array<{ severity?: string; message?: string }>;
    }>;
  }>("plugin_control_catalog", {});
  const plugin = (catalog.plugins ?? []).find((item) => item.id === pluginId);
  if (!plugin) {
    return {
      plugin: { id: pluginId },
      diagnostics: [
        { severity: "error" as const, code: "plugin_not_installed", message: "not in Host catalog" },
      ],
      installation: null,
    };
  }
  return {
    plugin,
    diagnostics: (plugin.warnings ?? []).map((item) => ({
      severity: item.severity === "error" ? ("error" as const) : ("warning" as const),
      code: "host_warning",
      message: item.message ?? "",
    })),
    installation: plugin,
  };
}
