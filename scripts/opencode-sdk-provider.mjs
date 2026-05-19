import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";

const PROBE_OK = "opencode-sdk-provider:ok";

function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function writeEventAsync(event) {
  writeEvent(event);
}

async function readInputJson(inputPath) {
  const raw = await readFile(inputPath, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function applyInputEnv(input) {
  for (const [key, value] of Object.entries(objectOrEmpty(input.env))) {
    if (typeof value === "string") {
      process.env[key] = value;
    }
  }
}

function parseJsonObject(value) {
  if (typeof value !== "string" || !value.trim()) {
    return {};
  }
  try {
    return objectOrEmpty(JSON.parse(value));
  } catch {
    return {};
  }
}

function buildConfig(input) {
  const envConfig = parseJsonObject(process.env.OPENCODE_CONFIG_CONTENT);
  const config = {
    ...envConfig,
    ...objectOrEmpty(input.config),
  };

  if (input.autoCompact !== false) {
    config.compaction = {
      ...objectOrEmpty(config.compaction),
      auto: true,
    };
  }

  if (input.autoApprove === true || input.dangerouslySkipPermissions === true) {
    config.permission ??= "allow";
  }

  return config;
}

function parseModel(model) {
  if (typeof model !== "string") {
    return undefined;
  }
  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  if (!trimmed || slash <= 0 || slash === trimmed.length - 1) {
    return undefined;
  }
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
}

function windowsShellSafeArg(value) {
  const text = String(value);
  if (!/^[A-Za-z0-9._:/=@-]+$/.test(text)) {
    throw new Error(
      `Unsafe Windows shell argument for OpenCode server: ${text}`,
    );
  }
  return text;
}

function spawnHiddenOpencode(args, env) {
  if (process.platform !== "win32") {
    return spawn("opencode", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  const commandLine = ["opencode", ...args.map(windowsShellSafeArg)].join(" ");
  return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/c", commandLine], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function stopHiddenOpencode(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return;
  }
  if (process.platform === "win32" && proc.pid) {
    const out = spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
      windowsHide: true,
    });
    if (!out.error && out.status === 0) {
      return;
    }
  }
  proc.kill();
}

function bindAbort(proc, signal, onAbort) {
  if (!signal) {
    return () => {};
  }
  const abort = () => {
    clear();
    stopHiddenOpencode(proc);
    onAbort?.();
  };
  const clear = () => {
    signal.removeEventListener("abort", abort);
    proc.off("exit", clear);
    proc.off("error", clear);
  };
  signal.addEventListener("abort", abort, { once: true });
  proc.on("exit", clear);
  proc.on("error", clear);
  if (signal.aborted) {
    abort();
  }
  return clear;
}

async function createHiddenOpencodeServer(options = {}) {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;
  const timeout = options.timeout ?? 15000;
  const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
  if (options.config?.logLevel) {
    args.push(`--log-level=${options.config.logLevel}`);
  }

  const proc = spawnHiddenOpencode(args, {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config ?? {}),
  });

  let clear = () => {};
  const url = await new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      clear();
      stopHiddenOpencode(proc);
      reject(
        new Error(`Timeout waiting for server to start after ${timeout}ms`),
      );
    }, timeout);
    let output = "";
    let resolved = false;

    proc.stdout?.on("data", (chunk) => {
      if (resolved) {
        return;
      }
      output += chunk.toString();
      for (const line of output.split("\n")) {
        if (line.startsWith("opencode server listening")) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (!match) {
            clear();
            stopHiddenOpencode(proc);
            clearTimeout(id);
            reject(
              new Error(`Failed to parse server url from output: ${line}`),
            );
            return;
          }
          clearTimeout(id);
          resolved = true;
          resolve(match[1]);
          return;
        }
      }
    });
    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    proc.on("exit", (code) => {
      clearTimeout(id);
      let message = `Server exited with code ${code}`;
      if (output.trim()) {
        message += `\nServer output: ${output}`;
      }
      reject(new Error(message));
    });
    proc.on("error", (error) => {
      clearTimeout(id);
      reject(error);
    });
    clear = bindAbort(proc, options.signal, () => {
      clearTimeout(id);
      reject(options.signal?.reason);
    });
  });

  return {
    url,
    close() {
      clear();
      stopHiddenOpencode(proc);
    },
  };
}

function buildFilePart(image) {
  const path = typeof image === "string" ? image : image?.path;
  if (!path || typeof path !== "string") {
    return undefined;
  }
  const mime =
    typeof image === "object" && typeof image.mime === "string"
      ? image.mime
      : "application/octet-stream";
  const url =
    typeof image === "object" && typeof image.url === "string"
      ? image.url
      : pathToFileURL(path).href;
  return {
    type: "file",
    mime,
    filename: basename(path),
    url,
  };
}

function buildParts(input) {
  const parts = [
    {
      type: "text",
      text: String(input.text ?? ""),
    },
  ];
  for (const image of Array.isArray(input.images) ? input.images : []) {
    const part = buildFilePart(image);
    if (part) {
      parts.push(part);
    }
  }
  return parts;
}

function slashCommand(input) {
  if (Array.isArray(input.images) && input.images.length > 0) {
    return undefined;
  }
  const text = String(input.text ?? "");
  const match = text.match(/^\s*\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?\s*$/);
  if (!match) {
    return undefined;
  }
  return {
    command: match[1],
    arguments: match[2] ?? "",
  };
}

async function unwrap(result, label) {
  if (result?.error) {
    throw new Error(`${label} failed: ${JSON.stringify(result.error)}`);
  }
  return result?.data;
}

async function createRuntime(input) {
  applyInputEnv(input);
  const server = await createHiddenOpencodeServer({
    port: 0,
    timeout: input.timeoutMs ?? 15000,
    config: buildConfig(input),
  });
  return {
    client: createOpencodeClient({ baseUrl: server.url }),
    server,
  };
}

async function startEventPump(client, directory, signal) {
  const subscription = await client.event.subscribe({
    query: { directory },
    signal,
    sseMaxRetryAttempts: 0,
  });
  return (async () => {
    try {
      for await (const event of subscription.stream) {
        await writeEventAsync({
          type: "opencode_sdk_event",
          event,
        });
      }
    } catch (error) {
      if (!signal.aborted) {
        await writeEventAsync({
          type: "opencode_sdk_error",
          message: error?.message ?? String(error),
          stack: error?.stack,
        });
      }
    }
  })();
}

async function resolveSession(client, input, directory) {
  if (input.forkSession && input.threadId) {
    const forked = await unwrap(
      await client.session.fork({
        path: { id: input.threadId },
        query: { directory },
        body: input.messageId ? { messageID: input.messageId } : {},
      }),
      "session.fork",
    );
    return forked.id;
  }
  if (input.threadId) {
    return input.threadId;
  }
  const created = await unwrap(
    await client.session.create({
      query: { directory },
      body: input.sessionTitle ? { title: input.sessionTitle } : {},
    }),
    "session.create",
  );
  return created.id;
}

async function writeTurn(inputPath) {
  const input = await readInputJson(inputPath);
  const directory = input.cwd ?? process.cwd();
  const runtime = await createRuntime(input);
  const abort = new AbortController();
  const pump = startEventPump(runtime.client, directory, abort.signal);
  try {
    const sessionID = await resolveSession(runtime.client, input, directory);
    await writeEventAsync({
      type: "opencode_sdk_session",
      sessionID,
    });

    const command = slashCommand(input);
    const response = command
      ? await unwrap(
          await runtime.client.session.command({
            path: { id: sessionID },
            query: { directory },
            body: {
              command: command.command,
              arguments: command.arguments,
              agent: input.agent,
              model: input.model,
            },
          }),
          "session.command",
        )
      : await unwrap(
          await runtime.client.session.prompt({
            path: { id: sessionID },
            query: { directory },
            body: {
              agent: input.agent,
              model: parseModel(input.model),
              parts: buildParts(input),
            },
          }),
          "session.prompt",
        );

    await writeEventAsync({
      type: "opencode_sdk_response",
      sessionID,
      response,
    });
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    abort.abort();
    await pump.catch(() => undefined);
    runtime.server.close();
  }
}

function flattenModels(providerList) {
  const providers = providerList?.all ?? providerList?.providers ?? [];
  const models = [];
  for (const provider of providers) {
    for (const [modelKey, model] of Object.entries(provider.models ?? {})) {
      const modelID = model?.id ?? modelKey;
      models.push({
        id: `${provider.id}/${modelID}`,
        label: `${provider.name ?? provider.id} / ${model?.name ?? modelID}`,
        providerID: provider.id,
        modelID,
        provider: provider.name ?? provider.id,
        name: model?.name ?? modelID,
        source: "sdk",
      });
    }
  }
  return models;
}

async function safeCall(name, call) {
  try {
    return { name, data: await unwrap(await call(), name) };
  } catch (error) {
    return {
      name,
      data: undefined,
      error: error?.message ?? String(error),
    };
  }
}

async function writeMetadata(inputPath) {
  const input = await readInputJson(inputPath);
  const directory = input.cwd ?? process.cwd();
  const runtime = await createRuntime(input);
  try {
    const [commands, agents, configProviders] = await Promise.all([
      safeCall("command.list", () =>
        runtime.client.command.list({ query: { directory } }),
      ),
      safeCall("app.agents", () =>
        runtime.client.app.agents({ query: { directory } }),
      ),
      safeCall("config.providers", () =>
        runtime.client.config.providers({ query: { directory } }),
      ),
    ]);
    const providerData = configProviders.data;

    await writeEventAsync({
      type: "opencode_sdk_metadata",
      commands: commands.data ?? [],
      agents: (agents.data ?? []).map((agent) => ({
        name: agent.name,
        description: agent.description,
        mode: agent.mode,
        model: agent.model,
      })),
      providers: (providerData?.providers ?? []).map((provider) => ({
        id: provider.id,
        name: provider.name,
        source: provider.source,
      })),
      models: flattenModels(providerData),
      errors: [commands, agents, configProviders]
        .filter((item) => item.error)
        .map((item) => ({ source: item.name, message: item.error })),
    });
  } finally {
    runtime.server.close();
  }
}

async function probe() {
  const runtime = await createRuntime({});
  runtime.server.close();
  process.stdout.write(`${PROBE_OK}\n`);
}

async function main() {
  const [arg, inputPath] = process.argv.slice(2);
  if (arg === "--probe") {
    await probe();
    return;
  }
  if (arg === "--metadata") {
    if (!inputPath) {
      throw new Error("Missing OpenCode SDK metadata input path.");
    }
    await writeMetadata(inputPath);
    return;
  }
  if (!arg) {
    throw new Error("Missing OpenCode SDK bridge input path.");
  }
  await writeTurn(arg);
}

main().catch((error) => {
  writeEvent({
    type: "opencode_sdk_error",
    message: error?.message ?? String(error),
    stack: error?.stack,
  });
  process.exit(1);
});
