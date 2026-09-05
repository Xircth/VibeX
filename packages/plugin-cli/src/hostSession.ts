import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PLUGIN_RC_NAME = "pluginrc";

export type HostSession = {
  url: string;
  token: string;
};

export type HostFlags = {
  url?: string;
  token?: string;
};

export function parseHostFlags(args: readonly string[]): {
  flags: HostFlags;
  rest: string[];
} {
  const flags: HostFlags = {};
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const httpFlag = argument.match(/^--(https?:\/\/.+)$/u);
    if (httpFlag) {
      flags.url = normalizeHostUrl(httpFlag[1]);
      continue;
    }
    const hostEquals = argument.match(/^--(?:host|http)=(.+)$/u);
    if (hostEquals) {
      flags.url = normalizeHostUrl(hostEquals[1]);
      continue;
    }
    const tokenEquals = argument.match(/^--token=(.+)$/u);
    if (tokenEquals) {
      flags.token = tokenEquals[1];
      continue;
    }
    if (argument === "--host" || argument === "--http") {
      flags.url = normalizeHostUrl(requireFlagValue(args, ++index, argument));
      continue;
    }
    if (argument === "--token") {
      flags.token = requireFlagValue(args, ++index, argument);
      continue;
    }
    rest.push(argument);
  }
  return { flags, rest };
}

export function normalizeHostUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  if (!/^https?:\/\//u.test(trimmed)) {
    throw new Error(`Host URL must be http(s): ${value}`);
  }
  return trimmed;
}

export function hostSessionPath(home = homedir()): string {
  return join(home, ".vibex", PLUGIN_RC_NAME);
}

export function saveHostSession(
  session: HostSession,
  file = hostSessionPath(),
): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ url: session.url, token: session.token }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best-effort on filesystems without unix modes */
  }
}

export function loadHostSession(file = hostSessionPath()): HostSession | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as {
      url?: unknown;
      host?: unknown;
      token?: unknown;
    };
    const urlValue = raw.url ?? raw.host;
    const url = typeof urlValue === "string" ? normalizeHostUrl(urlValue) : "";
    const token = typeof raw.token === "string" ? raw.token.trim() : "";
    if (!url || !token) return null;
    return { url, token };
  } catch {
    return null;
  }
}

export function clearHostSession(file = hostSessionPath()): void {
  rmSync(file, { force: true });
}

export function mergeHostSession(
  flags: HostFlags,
  saved: HostSession | null,
  discovered: HostFlags = {},
): HostSession | null {
  const url = flags.url || saved?.url || discovered.url || "";
  const token = flags.token || saved?.token || discovered.token || "";
  if (!url || !token) return null;
  return { url, token };
}

export function requireHostSession(session: HostSession | null): HostSession {
  if (session) return session;
  throw new Error(
    "No Host is bound. Run `vibex plugin run server --http://127.0.0.1:17891 --token <token>`.",
  );
}

export function hostDataDirs(
  home = homedir(),
  environment: Record<string, string | undefined> = process.env,
): string[] {
  const dirs: string[] = [];
  if (environment.VIBEX_DATA_DIR) dirs.push(environment.VIBEX_DATA_DIR);
  if (process.platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    dirs.push(
      join(support, "com.vibex.app.dev"),
      join(support, "com.vibex.app"),
      join(support, "com.xircth.vibex"),
      join(support, "vibex"),
      join(support, "app.vibex.vibex"),
    );
  } else if (process.platform === "win32") {
    const appData =
      environment.APPDATA || join(home, "AppData", "Roaming");
    dirs.push(
      join(appData, "com.vibex.app.dev"),
      join(appData, "com.vibex.app"),
      join(appData, "vibex"),
    );
  } else {
    const dataHome =
      environment.XDG_DATA_HOME || join(home, ".local", "share");
    dirs.push(
      join(dataHome, "com.vibex.app.dev"),
      join(dataHome, "com.vibex.app"),
      join(dataHome, "vibex"),
    );
  }
  dirs.push(join(home, ".vibex-data"), join(home, ".vibex"));
  return dirs;
}

export function discoverHostFiles(
  home = homedir(),
  environment: Record<string, string | undefined> = process.env,
): HostFlags {
  for (const dir of hostDataDirs(home, environment)) {
    try {
      const token = readFileSync(join(dir, "host.token"), "utf8").trim();
      if (token) return { token };
    } catch {
      /* try settings next */
    }
    for (const name of ["settings.json", "web-service-settings.json"]) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
          web_service?: { token?: unknown; port?: unknown };
          token?: unknown;
          port?: unknown;
        };
        const section =
          raw.web_service && typeof raw.web_service === "object"
            ? raw.web_service
            : raw;
        const token =
          typeof section.token === "string" ? section.token.trim() : "";
        const port = Number(section.port) || 0;
        if (token) {
          return {
            token,
            url: port ? `http://127.0.0.1:${port}` : undefined,
          };
        }
      } catch {
        /* continue */
      }
    }
  }
  return {};
}

export function resolveHostSession(
  flags: HostFlags = {},
  environment: Record<string, string | undefined> = process.env,
  options: { home?: string; sessionFile?: string } = {},
): HostSession | null {
  const envUrl = (environment.VIBEX_URL || "").trim();
  const envToken = (environment.VIBEX_TOKEN || "").trim();
  const files = discoverHostFiles(options.home, environment);
  return mergeHostSession(flags, loadHostSession(options.sessionFile), {
    url: envUrl ? normalizeHostUrl(envUrl) : files.url,
    token: envToken || files.token,
  });
}

function requireFlagValue(
  args: readonly string[],
  index: number,
  flag: string,
): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
