import { resolve } from "node:path";

import { buildPlugin } from "./build.js";
import { watchPluginSources } from "./dev.js";
import {
  type HostFlags,
  type HostSession,
  loadHostSession,
  mergeHostSession,
  parseHostFlags,
  requireHostSession,
  resolveHostSession,
  saveHostSession,
} from "./hostSession.js";
import {
  PluginDevHostClient,
  discoverPluginDevConnection,
} from "./hostClient.js";
import {
  inspectLinkedPackage,
  installLinkedPlugin,
  reloadLinkedPlugin,
} from "./pluginControl.js";
import { testPlugin } from "./pluginTest.js";
import {
  enableOnProductHost,
  importLinkedOnProductHost,
  pingProductHost,
} from "./productHost.js";
import { readPluginRemotes, startPluginRemoteDev } from "./remoteDev.js";

export const RUN_SCRIPTS = ["server", "dev", "build", "test"] as const;

export type RunScript = (typeof RUN_SCRIPTS)[number];

export type RunInvocation = {
  script: RunScript;
  host: HostFlags;
  positional: string[];
  hostJourney: boolean;
};

export function parseRunInvocation(args: readonly string[]): RunInvocation {
  const script = args[0];
  if (!script) {
    throw new Error("Usage: vibex plugin run <server|dev|build|test>");
  }
  if (!isRunScript(script)) {
    throw new Error(
      `Unknown plugin script: ${script}\nUsage: vibex plugin run <server|dev|build|test>`,
    );
  }
  const afterScript = args.slice(1);
  const hostJourney = script === "test" && afterScript.includes("--host");
  const { flags, rest } = parseHostFlags(
    script === "test"
      ? afterScript.filter((item) => item !== "--host")
      : afterScript,
  );
  return { script, host: flags, positional: rest, hostJourney };
}

export async function bindHostServer(options: {
  flags: HostFlags;
  saved?: HostSession | null;
  ping?: (session: HostSession) => Promise<boolean>;
  save?: (session: HostSession) => void;
}): Promise<HostSession> {
  const session = requireHostSession(
    mergeHostSession(
      options.flags,
      options.saved === undefined ? loadHostSession() : options.saved,
    ),
  );
  const ping = options.ping ?? pingProductHost;
  if (!(await ping(session))) {
    throw new Error(`Host ${session.url} did not accept the token.`);
  }
  (options.save ?? saveHostSession)(session);
  return session;
}

export async function runPluginDev(
  root: string,
  options: { log?: (message: string) => void } = {},
): Promise<void> {
  const log = options.log ?? console.log;
  const resolved = resolve(root);
  await buildPlugin(resolved);
  const plugin = await inspectLinkedPackage(resolved);
  const desktop = discoverPluginDevConnection();
  const client = desktop ? new PluginDevHostClient(desktop) : null;
  const publish = async (reload: boolean) => {
    if (client) {
      return reload
        ? reloadLinkedPlugin(resolved, client)
        : installLinkedPlugin(resolved, client);
    }
    requireHostSession(resolveHostSession());
    const installed = await importLinkedOnProductHost(
      plugin.root,
      plugin.identity,
    );
    if (installed.queued) {
      requireHostSession(null);
    }
    if (!reload) await enableOnProductHost(plugin.identity.id);
    return installed;
  };
  const first = await publish(false);
  log(
    `Linked ${plugin.identity.id} as a development plugin (generation ${first.generation}); watching ${resolved}`,
  );
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const remotes = await readPluginRemotes(resolved);
  if (remotes.length > 0) {
    await startPluginRemoteDev({
      root: resolved,
      remotes,
      signal: controller.signal,
      onReady(entry) {
        log(`Remote HMR at ${entry}`);
      },
      onError(error) {
        console.error(error instanceof Error ? error.message : String(error));
      },
    });
    const published = await publish(true);
    log(`Published generation ${published.generation} with live remotes`);
  }
  try {
    await watchPluginSources(resolved, {
      signal: controller.signal,
      ignoreRemoteSources: remotes.length > 0,
      async reload() {
        await buildPlugin(resolved);
        if (controller.signal.aborted) return;
        const candidate = await publish(true);
        log(`Published generation ${candidate.generation}`);
      },
      onError(error) {
        console.error(error instanceof Error ? error.message : String(error));
      },
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

export async function runPluginBuild(root: string): Promise<string> {
  const resolved = resolve(root);
  await buildPlugin(resolved);
  return resolved;
}

export async function runPluginTest(
  root: string,
  options: { host?: boolean } = {},
): Promise<void> {
  await testPlugin(resolve(root), options);
}

function isRunScript(value: string | undefined): value is RunScript {
  return RUN_SCRIPTS.includes(value as RunScript);
}
