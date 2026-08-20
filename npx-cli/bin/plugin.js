#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const HELP = `Usage: vibex plugin pack [dir] [--output file.vxp]
       vibex plugin add <url> [--plugin ID] [--yes]

pack    Validate a plugin directory and write a .vxp.
add     Download a marketplace or GitHub plugin and install it on a running Host.
        --plugin ID     Plugin id when the archive contains more than one package
        --yes, -y       Skip the Host install prompt
`;

async function run(args) {
  const [command = "help", ...rest] = args;
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP.trimEnd()}\n`);
    return;
  }
  if (command === "add") {
    await addPlugin(rest);
    return;
  }
  if (command !== "pack") {
    throw new Error(`Unknown plugin command: ${command}\n${HELP}`);
  }

  const parsed = parseArgs(rest);
  const root = path.resolve(parsed.positional[0] || ".");
  const { validatePlugin } = await load("validation.js");
  const validation = await validatePlugin(root);
  if (!validation.valid) {
    const diagnostics = validation.diagnostics
      .map((item) => `${item.code}: ${item.message}`)
      .join("\n");
    throw new Error(`Plugin validation failed\n${diagnostics}`);
  }
  const { packPlugin } = await load("package.js");
  const result = await packPlugin(root, parsed.flags.output);
  process.stdout.write(`${result.output}\nsha256:${result.lock.packageDigest}\n`);
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

async function addPlugin(args) {
  const parsed = parseArgs(args);
  const source = parsed.positional[0];
  if (!source) throw new Error("Usage: vibex plugin add <url> [--plugin ID] [--yes]");
  const yes = Boolean(parsed.flags.yes);
  const wanted = parsed.flags.plugin;
  log("Resolving plugin source...");
  const resolved = await resolveSource(source, wanted);
  log(`Downloading ${resolved.url}...`);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "vibex-plugin-add-"));
  try {
    const archive = await downloadArchive(resolved.url, staging);
    log("Extracting package...");
    const unpacked = path.join(staging, "src");
    extractArchive(archive, unpacked);
    const roots = findPluginRoots(unpacked);
    if (roots.length === 0) {
      throw new Error("No VibeX plugin package found (.vibex-plugin/plugin.json).");
    }
    const picked = pickRoot(roots, wanted || resolved.pluginId);
    log(`Validating ${picked.publisher}/${picked.id} ${picked.version}...`);
    const { validatePlugin } = await load("validation.js");
    const validation = await validatePlugin(picked.root);
    if (!validation.valid) {
      const diagnostics = validation.diagnostics
        .map((item) => `${item.code}: ${item.message}`)
        .join("\n");
      throw new Error(`Plugin validation failed\n${diagnostics}`);
    }
    const importsDir = path.join(os.homedir(), ".vibex", "imports");
    fs.mkdirSync(importsDir, { recursive: true });
    const packedPath = path.join(importsDir, `${picked.id}-${picked.version}.vxp`);
    log("Packing .vxp...");
    const { packPlugin } = await load("package.js");
    const packed = await packPlugin(picked.root, packedPath);
    log(`Packed ${packed.output}`);
    const imported = await importToHost(picked.root, yes);
    if (imported) {
      writeImportedMarker(packed.output, `${picked.publisher}/${picked.id}`);
      log(`Installed ${picked.publisher}/${picked.id} on the Host.`);
      log("Enable it in Settings → Plugins. New sessions pick it up after enable.");
    } else {
      log(
        "No running Host accepted the install. VibeX desktop will import this .vxp on next launch, or import it in Settings → Plugins.",
      );
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function resolveSource(source, wanted) {
  if (fs.existsSync(source)) {
    return { url: path.resolve(source), pluginId: wanted || "" };
  }
  let url;
  try {
    url = new URL(source);
  } catch {
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) {
      url = new URL(`https://github.com/${source}`);
    } else {
      throw new Error(`Unknown plugin source: ${source}`);
    }
  }
  const market = url.pathname.match(/^\/marketplace\/([^/]+)\/([^/]+)\/?$/);
  if (market) {
    const metaRes = await fetch(
      `${url.origin}/api/marketplace/artifact/${market[1]}/${market[2]}`,
    );
    if (!metaRes.ok) throw new Error("Marketplace plugin was not found.");
    const meta = await metaRes.json();
    const download = String(meta.downloadUrl || "");
    const absolute = download.startsWith("http")
      ? download
      : `${url.origin}${download}`;
    return { url: absolute, pluginId: wanted || String(meta.pluginId || "") };
  }
  if (url.hostname === "github.com") {
    const parts = url.pathname.replace(/^\/|\/$/g, "").split("/");
    if (parts.length >= 2) {
      return {
        url: `https://codeload.github.com/${parts[0]}/${parts[1]}/tar.gz/HEAD`,
        pluginId: wanted || "",
      };
    }
  }
  return { url: url.toString(), pluginId: wanted || "" };
}

async function downloadArchive(source, staging) {
  if (fs.existsSync(source)) return source;
  const res = await fetch(source, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const name = archiveName(source, res);
  const file = path.join(staging, name);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

function archiveName(source, res) {
  const type = (res.headers.get("content-type") || "").toLowerCase();
  const url = source.toLowerCase();
  if (url.endsWith(".vxp") || type.includes("vxp")) return "plugin.vxp";
  if (url.endsWith(".zip") || type.includes("zip")) return "plugin.zip";
  if (url.endsWith(".7z")) return "plugin.7z";
  return "plugin.tar.gz";
}

function chmodReadable(dir) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  try {
    fs.chmodSync(dir, stat.isDirectory() ? 0o755 : 0o644);
  } catch {
    /* zip entries can carry modes we cannot chmod */
  }
  if (!stat.isDirectory()) return;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) chmodReadable(path.join(dir, name));
}

function extractArchive(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (/\.7z$/i.test(archive)) {
    const seven = spawnSync("7z", ["x", "-y", `-o${dest}`, archive], {
      encoding: "utf8",
    });
    if (seven.status !== 0) throw new Error("7z extract failed");
    chmodReadable(dest);
    return;
  }
  if (/\.(zip|vxp)$/i.test(archive)) {
    try {
      const Zip = require("adm-zip");
      new Zip(archive).extractAllTo(dest, true);
      chmodReadable(dest);
      return;
    } catch {
      const unzip = spawnSync("unzip", ["-q", "-o", archive, "-d", dest], {
        encoding: "utf8",
      });
      if (unzip.status === 0) {
        chmodReadable(dest);
        return;
      }
    }
  }
  const tar = spawnSync("tar", ["-xf", archive, "-C", dest], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error("archive extract failed");
  chmodReadable(dest);
}

function findPluginRoots(dir, depth = 0, found = []) {
  if (fs.existsSync(path.join(dir, ".vibex-plugin", "plugin.json"))) {
    found.push(dir);
    return found;
  }
  if (depth > 4) return found;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    if (name === "node_modules" || name === ".git") continue;
    const child = path.join(dir, name);
    try {
      if (!fs.statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    findPluginRoots(child, depth + 1, found);
  }
  return found;
}

function pickRoot(roots, wanted) {
  const parsed = roots.map((root) => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, ".vibex-plugin", "plugin.json"), "utf8"),
    );
    return {
      root,
      id: String(manifest.id || ""),
      publisher: String(manifest.publisher || ""),
      version: String(manifest.version || "0.0.0"),
    };
  });
  if (wanted) {
    const match = parsed.find((item) => item.id === wanted);
    if (!match) throw new Error(`Plugin \`${wanted}\` was not in the archive.`);
    return match;
  }
  if (parsed.length === 1) return parsed[0];
  throw new Error(
    `Archive contains multiple plugins (${parsed.map((item) => item.id).join(", ")}). Pass --plugin ID.`,
  );
}

function hostDataDirs() {
  const home = os.homedir();
  const dirs = [];
  if (process.env.VIBEX_DATA_DIR) dirs.push(process.env.VIBEX_DATA_DIR);
  if (process.platform === "darwin") {
    dirs.push(
      path.join(home, "Library", "Application Support", "com.vibex.app"),
      path.join(home, "Library", "Application Support", "vibex"),
      path.join(home, "Library", "Application Support", "app.vibex.vibex"),
    );
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    dirs.push(path.join(appData, "com.vibex.app"), path.join(appData, "vibex"));
  } else {
    const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
    dirs.push(
      path.join(dataHome, "com.vibex.app"),
      path.join(dataHome, "vibex"),
    );
  }
  dirs.push(path.join(home, ".vibex-data"), path.join(home, ".vibex"));
  return dirs;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function tokenFromSettings(raw) {
  if (!raw || typeof raw !== "object") return { token: "", port: 0 };
  const section =
    raw.web_service && typeof raw.web_service === "object" ? raw.web_service : raw;
  const token = typeof section.token === "string" ? section.token.trim() : "";
  const port = Number(section.port) || 0;
  return { token, port };
}

function discoverHost() {
  const envUrl = (process.env.VIBEX_URL || "").replace(/\/+$/, "");
  const envToken = (process.env.VIBEX_TOKEN || "").trim();
  let token = envToken;
  let port = 17891;
  if (!token) {
    for (const dir of hostDataDirs()) {
      const hostToken = path.join(dir, "host.token");
      if (fs.existsSync(hostToken)) {
        token = fs.readFileSync(hostToken, "utf8").trim();
        if (token) break;
      }
      for (const name of ["settings.json", "web-service-settings.json"]) {
        const parsed = tokenFromSettings(readJson(path.join(dir, name)));
        if (parsed.token) {
          token = parsed.token;
          if (parsed.port) port = parsed.port;
          break;
        }
      }
      if (token) break;
    }
  }
  return {
    url: envUrl || `http://127.0.0.1:${port}`,
    token,
  };
}

async function hostAccepts(url, token) {
  if (!token) return false;
  try {
    const response = await fetch(`${url}/api/v1/call/plugin_control_catalog`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-vibex-protocol-version": "1.0",
      },
      body: JSON.stringify({ operation_id: crypto.randomUUID(), args: {} }),
      signal: AbortSignal.timeout(2000),
    });
    return response.status !== 404 && response.status < 500;
  } catch {
    return false;
  }
}

function importedMarker(packedPath) {
  return `${packedPath}.imported`;
}

function writeImportedMarker(packedPath, identity) {
  try {
    fs.writeFileSync(importedMarker(packedPath), `${identity}\n`);
  } catch {
    /* inbox scan will skip by plugin id if this fails */
  }
}

async function importToHost(pluginRoot, yes) {
  const host = discoverHost();
  if (!host.token) return false;
  log(`Connecting to Host ${host.url}...`);
  if (!(await hostAccepts(host.url, host.token))) return false;
  if (!yes && process.stdin.isTTY) {
    process.stderr.write("Install this plugin on the running Host? [Y/n] ");
    const answer = (await readLine()).trim().toLowerCase();
    if (answer && !["y", "yes"].includes(answer)) return false;
  }
  const response = await fetch(`${host.url}/api/v1/call/plugin_control_import`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${host.token}`,
      "content-type": "application/json",
      "x-vibex-protocol-version": "1.0",
    },
    body: JSON.stringify({
      operation_id: crypto.randomUUID(),
      args: { path: pluginRoot, conflict: "replace" },
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      `${body.code || response.status}: ${body.message || "plugin_control_import failed"}`,
    );
  }
  return true;
}

function readLine() {
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk) => resolve(String(chunk)));
  });
}

async function load(file) {
  const bundled = path.join(__dirname, "..", "plugin-cli", file);
  const local = path.join(
    __dirname,
    "..",
    "..",
    "packages",
    "plugin-cli",
    "dist",
    file,
  );
  const modulePath = fs.existsSync(bundled) ? bundled : local;
  if (!fs.existsSync(modulePath)) {
    throw new Error(
      "VibeX Plugin CLI is unavailable; reinstall or update VibeX.",
    );
  }
  return import(pathToFileURL(modulePath).href);
}

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--yes" || token === "-y") flags.yes = true;
    else if (token === "--plugin") flags.plugin = args[++index];
    else if (token === "--output") flags.output = args[++index];
    else if (token.startsWith("--")) {
      throw new Error(`Unknown argument: ${token}`);
    } else positional.push(token);
  }
  return { flags, positional };
}

module.exports = {
  run,
  resolveSource,
  findPluginRoots,
  pickRoot,
  extractArchive,
  chmodReadable,
  discoverHost,
  hostDataDirs,
};
