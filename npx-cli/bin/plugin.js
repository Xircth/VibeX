#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const HELP = `Usage: vibex plugin pack [dir] [--output file.vxp]
       vibex plugin add --web <git-or-url[#ref]> [--plugin ID] [--yes]
       vibex plugin add --profile <file.vxp|archive> [--plugin ID] [--yes]
       vibex plugin add --dev <dir> [--yes] [--detach]
       vibex plugin publish [dir|file.vxp] [--owner USER] [--password PASS] [--show-tree]
       vibex plugin publish --web <github-owner/repo[#tag]> [--owner USER] [--password PASS]
       vibex plugin list [--json]
       vibex plugin update <id> [--ref tag] [--yes]
       vibex plugin remove <id> [--yes] [--delete-data]
       vibex plugin gc-runtimes
       vibex plugin test --host [dir]

pack    Validate a plugin directory and write a .vxp.
add     Install a Plugin onto the local Desktop or Server Host.
        --web URL       Git repository, GitHub, marketplace, or archive URL
                        Pin with #tag, #branch, or #commit (also github:owner/repo#tag)
        --profile FILE  Local .vxp, .zip, or other plugin archive
        --dev DIR       Link a development directory and reload it as it changes.
                        Prints worker logs from the running Host until Ctrl+C.
        --plugin ID     Plugin id when the archive contains more than one package
        --yes, -y       Skip the Host install prompt
        --detach        With --dev, link and return; Host keeps watching the directory
publish Submit a packed .vxp or GitHub repository to the official marketplace review queue.
        --web URL       GitHub owner/repo, optionally #tag. Owner must match marketplace user.
        --owner USER    Marketplace username (or VIBEX_MARKET_OWNER)
        --password PASS Marketplace password (or VIBEX_MARKET_PASSWORD)
        --show-tree     Show package structure on the marketplace (uploads only)
        --hide-tree     Hide package structure (default for uploads)
list    Show plugins on the running Host
update  Refresh a snapshot from its locked origin. Linked plugins do not use this.
        --ref tag       Pin a new Git tag, branch, or commit
remove  Uninstall a non-built-in plugin. Default keeps user config.
        --delete-data   Delete Host-managed snapshot and config. Runtimes with no
                        remaining plugin refs are reclaimed. Conversations stay.
gc-runtimes  Delete managed Runtime files that no plugin references
test --host  Install, enable, reload a Skill, uninstall against the running Host
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
  if (command === "list") {
    await listPlugins(rest);
    return;
  }
  if (command === "remove" || command === "rm") {
    await removePlugin(rest);
    return;
  }
  if (command === "update") {
    await updatePlugin(rest);
    return;
  }
  if (command === "gc-runtimes") {
    await gcRuntimes();
    return;
  }
  if (command === "test") {
    await testAgainstHost(rest);
    return;
  }
  if (command === "publish") {
    await publishPlugin(rest);
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
  const parsed = parseAddArgs(args);
  if (parsed.mode === "dev") {
    await addDevPlugin(parsed.source, parsed.flags);
    return;
  }
  if (parsed.mode === "profile") {
    await addSnapshotPlugin(path.resolve(parsed.source), parsed.flags, "profile");
    return;
  }
  await addWebPlugin(parsed.source, parsed.flags);
}

async function listPlugins(args) {
  const parsed = parseArgs(args);
  const host = await requireRunningHost();
  log(`Host ${host.url}`);
  const catalog = await hostCall(host, "plugin_control_catalog", {});
  const plugins = Array.isArray(catalog?.plugins) ? catalog.plugins : [];
  if (parsed.flags.json) {
    process.stdout.write(`${JSON.stringify(plugins, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${formatPluginList(plugins)}\n`);
}

async function removePlugin(args) {
  const parsed = parseArgs(args);
  const pluginId = parsed.positional[0];
  if (!pluginId) {
    throw new Error("Usage: vibex plugin remove <plugin-id> [--yes] [--delete-data]");
  }
  const host = await requireRunningHost();
  const catalog = await hostCall(host, "plugin_control_catalog", {});
  const plugins = Array.isArray(catalog?.plugins) ? catalog.plugins : [];
  const plugin = plugins.find((item) => item.id === pluginId);
  if (!plugin) {
    throw new Error(`Plugin \`${pluginId}\` is not installed.`);
  }
  if (plugin.builtin || plugin.sourceKind === "builtin" || plugin.uninstallSupported === false) {
    throw new Error(`Plugin \`${pluginId}\` is built-in and cannot be uninstalled.`);
  }
  if (!parsed.flags.yes && process.stdin.isTTY) {
    process.stderr.write(`${removeConsequence(plugin, parsed.flags.deleteData)}\nRemove ${pluginId}? [Y/n] `);
    const answer = (await readLine()).trim().toLowerCase();
    if (answer && !["y", "yes"].includes(answer)) return;
  }
  const result = await hostCall(host, "plugin_control_uninstall", {
    pluginId,
    retainData: !parsed.flags.deleteData,
  });
  const retention = result?.dataRetention || (parsed.flags.deleteData ? "deleted" : "retained");
  log(`Removed ${pluginId}. User data ${retention}.`);
  if (Array.isArray(result?.reclaimedRuntimes) && result.reclaimedRuntimes.length) {
    log(`Reclaimed Runtimes: ${result.reclaimedRuntimes.join(", ")}`);
  }
}

function removeConsequence(plugin, deleteData) {
  const linked = plugin.sourceKind === "developer_link";
  const lines = [
    "Removes membership, Agent bindings, and Skill projections.",
    "Conversations, artifacts, and Automation history stay.",
  ];
  if (linked) {
    lines.push("The development directory is not deleted.");
  } else if (deleteData) {
    lines.push("Deletes the Host-managed snapshot and this plugin's config.");
    lines.push("Managed Runtimes with no remaining plugin references are reclaimed.");
  } else {
    lines.push("Keeps this plugin's config snapshot so a reinstall can restore it.");
  }
  return lines.join(" ");
}

function formatPluginList(plugins) {
  if (!plugins.length) return "No plugins installed.";
  const rows = plugins.map((plugin) => [
    plugin.id || "",
    plugin.version || "",
    pluginSourceLabel(plugin),
    plugin.enabled ? "on" : "off",
    plugin.sourceLocked ? plugin.sourceRef || "locked" : plugin.sourceOrigin ? "unlocked" : "-",
  ]);
  const headers = ["ID", "VERSION", "SOURCE", "ENABLED", "LOCK"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index]).length)),
  );
  const line = (cells) =>
    cells.map((cell, index) => String(cell).padEnd(widths[index])).join("  ");
  return [line(headers), ...rows.map(line)].join("\n");
}

function pluginSourceLabel(plugin) {
  if (plugin.builtin || plugin.sourceKind === "builtin") return "builtin";
  if (plugin.sourceKind === "developer_link") return "linked";
  return "installed";
}

async function requireRunningHost() {
  const host = discoverHost();
  if (!host.token || !(await hostAccepts(host.url, host.token))) {
    throw new Error("No running VibeX Host. Start Desktop or `vibex serve`.");
  }
  return host;
}

async function addWebPlugin(source, flags) {
  log("Resolving plugin source...");
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "vibex-plugin-add-"));
  try {
    const release = await resolveGithubRelease(source);
    if (release) {
      log(`Downloading ${release.url}...`);
      const archive = await downloadArchive(release.url, staging);
      if (release.sha256) verifySha256(archive, release.sha256);
      const unpacked = path.join(staging, "src");
      log("Extracting package...");
      extractArchive(archive, unpacked);
      flags.plugin = flags.plugin || release.pluginId;
      await installUnpackedSnapshot(unpacked, flags, {
        origin: release.origin,
        gitRef: release.tag,
        gitSha: release.sha256 ? `sha256:${release.sha256}` : "",
        locked: true,
      });
      return;
    }
    const git = parseGitSource(source);
    let unpacked = path.join(staging, "src");
    let lock = { origin: source, gitRef: "", gitSha: "", locked: false };
    if (git) {
      log(
        git.ref
          ? `Cloning ${git.url} at ${git.ref}...`
          : `Cloning ${git.url}...`,
      );
      unpacked = await cloneGit(git, unpacked);
      lock = {
        origin: git.url,
        gitRef: git.ref || "",
        gitSha: gitRevParse(unpacked),
        locked: Boolean(git.ref),
      };
    } else {
      const resolved = await resolveSource(source, flags.plugin);
      log(`Downloading ${resolved.url}...`);
      const archive = await downloadArchive(resolved.url, staging);
      if (flags.sha256) verifySha256(archive, flags.sha256);
      log("Extracting package...");
      extractArchive(archive, unpacked);
      flags.plugin = flags.plugin || resolved.pluginId;
      lock = {
        origin: resolved.url,
        gitRef: "",
        gitSha: flags.sha256 ? `sha256:${flags.sha256}` : "",
        locked: Boolean(flags.sha256),
      };
    }
    await installUnpackedSnapshot(unpacked, flags, lock);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function addSnapshotPlugin(source, flags) {
  if (!fs.existsSync(source)) {
    throw new Error(`Plugin package not found: ${source}`);
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "vibex-plugin-add-"));
  try {
    let unpacked = source;
    if (fs.statSync(source).isFile()) {
      unpacked = path.join(staging, "src");
      log(`Extracting ${source}...`);
      extractArchive(source, unpacked);
    }
    await installUnpackedSnapshot(unpacked, flags, {
      origin: path.resolve(source),
      gitRef: "",
      gitSha: "",
      locked: true,
    });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function installUnpackedSnapshot(unpacked, flags, lock = {}) {
  const roots = findPluginRoots(unpacked);
  if (roots.length === 0) {
    throw new Error("No VibeX plugin package found (.vibex-plugin/plugin.json).");
  }
  const picked = pickRoot(roots, flags.plugin);
  log(`Validating ${picked.publisher}/${picked.id} ${picked.version}...`);
  await ensureValidPlugin(picked.root);
  const importsDir = importsDirectory();
  fs.mkdirSync(importsDir, { recursive: true });
  const packedPath = path.join(importsDir, `${picked.id}-${picked.version}.vxp`);
  log("Packing .vxp...");
  const { packPlugin } = await load("package.js");
  const packed = await packPlugin(picked.root, packedPath);
  log(`Packed ${packed.output}`);
  writeOriginSidecar(packed.output, lock);
  const imported = await importToHost(picked.root, flags.yes, {
    developerLink: false,
    ...lock,
  });
  if (imported) {
    writeImportedMarker(packed.output, `${picked.publisher}/${picked.id}`);
    log(`Installed ${picked.publisher}/${picked.id} on the Host.`);
    if (lock.locked && (lock.gitRef || lock.gitSha)) {
      log(`Locked ${lock.gitRef || "archive"} ${lock.gitSha || ""}`.trim());
    } else if (!lock.locked) {
      log("Source is unlocked (no #tag). Reinstall with #tag to pin.");
    }
    log("Enable it in Settings → Plugins. New sessions pick it up after enable.");
    return;
  }
  log(
    "No running Host accepted the install. VibeX desktop or server will import this .vxp on next launch.",
  );
}

async function addDevPlugin(source, flags) {
  const root = path.resolve(source);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Development directory not found: ${root}`);
  }
  if (!fs.existsSync(path.join(root, ".vibex-plugin", "plugin.json"))) {
    throw new Error("No VibeX plugin package found (.vibex-plugin/plugin.json).");
  }
  log(`Linking development directory ${root}...`);
  try {
    const { buildPlugin } = await load("build.js");
    await buildPlugin(root);
    log("Built package.");
  } catch (error) {
    log(`Build skipped (${error instanceof Error ? error.message : error}).`);
  }
  await ensureValidPlugin(root);
  const identity = readPluginIdentity(root);
  const imported = await importToHost(root, flags.yes, {
    developerLink: true,
    origin: root,
    locked: false,
  });
  if (!imported) {
    queueLinkedInstall(root);
    log(
      `No running Host accepted the link. Queued ${identity.publisher}/${identity.id} for the next Desktop or Server launch.`,
    );
    return;
  }
  const enabled = await enableOnHost(identity.id);
  log(`Linked ${identity.publisher}/${identity.id} as a development plugin.`);
  if (enabled) {
    log("Enabled on the Host. Edits reload into the running generation.");
  } else {
    log("Enable it in Settings → Plugins to load it into sessions.");
  }
  if (flags.detach) {
    log("Host will keep watching this directory.");
    return;
  }
  log("Watching for changes. Ctrl+C stops the watcher; the link stays.");
  await watchDevPlugin(root, identity.id);
}

async function watchDevPlugin(root, pluginId) {
  const { watchPluginSources } = await load("dev.js");
  const { buildPlugin } = await load("build.js");
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const logs = pluginId ? streamPluginLogs(pluginId, controller.signal) : Promise.resolve();
  try {
    await watchPluginSources(root, {
      signal: controller.signal,
      async reload() {
        try {
          await buildPlugin(root);
        } catch (error) {
          log(`Build failed (${error instanceof Error ? error.message : error}).`);
        }
        log("Rebuilt package. Host reloads when the digest changes.");
      },
      onError(error) {
        log(`Reload failed (${error instanceof Error ? error.message : error}).`);
      },
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    controller.abort();
    await logs.catch(() => {});
  }
}

async function streamPluginLogs(pluginId, signal) {
  const host = discoverHost();
  if (!host.token) return;
  let after = 0;
  log("Streaming plugin worker logs from the Host.");
  while (!signal.aborted) {
    try {
      const page = await hostCall(host, "plugin_control_logs", { pluginId, after });
      const lines = Array.isArray(page?.lines) ? page.lines : [];
      for (const line of lines) {
        const seq = Number(line.seq) || 0;
        if (seq > after) after = seq;
        const text = String(line.text || "");
        if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
      }
    } catch {
      /* older Hosts omit the log command */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function marketplaceOrigin(flag) {
  return String(flag || process.env.VIBEX_MARKETPLACE_URL || "https://vibex.xforever.xin").replace(
    /\/+$/,
    "",
  );
}

async function packDirectory(root, output) {
  await ensureValidPlugin(root);
  const { packPlugin } = await load("package.js");
  return packPlugin(root, output);
}

async function resolvePublishFile(source) {
  const root = path.resolve(expandHome(source || "."));
  if (!fs.existsSync(root)) {
    throw new Error(`Nothing to publish at ${root}`);
  }
  if (fs.statSync(root).isFile()) {
    return { filePath: root, name: path.basename(root) };
  }
  log(`Packing ${root}...`);
  const packed = await packDirectory(root);
  return { filePath: packed.output, name: path.basename(packed.output) };
}

async function publishPlugin(args) {
  const parsed = parseArgs(args);
  const owner = parsed.flags.owner || process.env.VIBEX_MARKET_OWNER || "";
  const password = parsed.flags.password || process.env.VIBEX_MARKET_PASSWORD || "";
  if (!owner || !password) {
    throw new Error(
      "publish requires --owner and --password, or VIBEX_MARKET_OWNER and VIBEX_MARKET_PASSWORD.",
    );
  }
  const origin = marketplaceOrigin(parsed.flags.market);
  const form = new FormData();
  if (parsed.flags.web) {
    form.set("repo", parsed.flags.web);
    form.set("name", parsed.flags.web);
  } else {
    const packed = await resolvePublishFile(parsed.positional[0]);
    const bytes = fs.readFileSync(packed.filePath);
    form.append("file", new Blob([bytes]), packed.name);
    form.set("name", packed.name.replace(/\.(vxp|zip|tgz|tar\.gz)$/i, ""));
    if (parsed.flags.showTree) form.set("showTree", "1");
  }
  const auth = Buffer.from(`${owner}:${password}`).toString("base64");
  log(`Submitting to ${origin}/marketplace as ${owner}...`);
  const response = await fetch(`${origin}/api/marketplace/submit`, {
    method: "POST",
    headers: { authorization: `Basic ${auth}` },
    body: form,
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    throw new Error("Marketplace credentials were rejected.");
  }
  if (!response.ok) {
    const code = body.error || response.status;
    throw new Error(`Marketplace submit failed (${code}).`);
  }
  log(
    `Submitted ${body.authorId || owner}/${body.pluginId || "plugin"} ${body.version || ""} for review.`
      .replace(/\s+/g, " ")
      .trim(),
  );
}

async function ensureValidPlugin(root) {
  const { validatePlugin } = await load("validation.js");
  const validation = await validatePlugin(root);
  if (validation.valid) return;
  const diagnostics = validation.diagnostics
    .map((item) => `${item.code}: ${item.message}`)
    .join("\n");
  throw new Error(`Plugin validation failed\n${diagnostics}`);
}

function readPluginIdentity(root) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, ".vibex-plugin", "plugin.json"), "utf8"),
  );
  return {
    id: String(manifest.id || ""),
    publisher: String(manifest.publisher || ""),
    version: String(manifest.version || "0.0.0"),
  };
}

function importsDirectory() {
  return path.join(os.homedir(), ".vibex", "imports");
}

function queueLinkedInstall(dir) {
  const inbox = importsDirectory();
  fs.mkdirSync(inbox, { recursive: true });
  fs.appendFileSync(
    path.join(inbox, "links.jsonl"),
    `${JSON.stringify({ path: dir, kind: "developer_link" })}\n`,
  );
}

function inferAddMode(source) {
  try {
    if (fs.existsSync(source)) {
      const stat = fs.statSync(source);
      if (stat.isDirectory()) return "dev";
      if (stat.isFile()) return "profile";
    }
  } catch {
    /* fall through to web */
  }
  return "web";
}

function parseAddArgs(args) {
  const { flags, positional } = parseArgs(args);
  const selected = [
    flags.web && "web",
    flags.profile && "profile",
    flags.dev && "dev",
  ].filter(Boolean);
  if (selected.length > 1) {
    throw new Error("Use only one of --web, --profile, or --dev.");
  }
  if (flags.web) return { mode: "web", source: flags.web, flags, positional };
  if (flags.profile) {
    return { mode: "profile", source: expandHome(flags.profile), flags, positional };
  }
  if (flags.dev) return { mode: "dev", source: expandHome(flags.dev), flags, positional };
  const source = positional[0];
  if (!source) {
    throw new Error(
      "Usage: vibex plugin add --web <url> | --profile <file> | --dev <dir> [--yes]",
    );
  }
  const resolved = expandHome(source);
  return { mode: inferAddMode(resolved), source: resolved, flags, positional };
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseGitSource(source) {
  const raw = String(source || "").trim();
  const githubSpec = raw.match(/^github:([^/#]+)\/([^#]+)(?:#(.+))?$/i);
  if (githubSpec) {
    return {
      url: `https://github.com/${githubSpec[1]}/${stripGitSuffix(githubSpec[2])}.git`,
      ref: githubSpec[3] || undefined,
    };
  }
  const ssh = raw.match(/^git@([^:]+):(.+?)(?:\.git)?(?:#(.+))?$/);
  if (ssh) {
    return {
      url: `git@${ssh[1]}:${stripGitSuffix(ssh[2])}.git`,
      ref: ssh[3] || undefined,
    };
  }
  const shorthand = raw.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#(.+))?$/);
  if (shorthand && !raw.includes("://")) {
    return {
      url: `https://github.com/${shorthand[1]}/${shorthand[2]}.git`,
      ref: shorthand[3] || undefined,
    };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === "git:") {
    return { url: raw.replace(/#.*$/, ""), ref: fragment(url) };
  }
  if (url.hostname === "github.com" || url.hostname === "www.github.com") {
    const parts = url.pathname.replace(/^\/|\/$/g, "").replace(/\.git$/, "").split("/");
    if (parts.length >= 2) {
      return {
        url: `https://github.com/${parts[0]}/${parts[1]}.git`,
        ref: githubPathRef(parts) || fragment(url),
      };
    }
  }
  if (url.pathname.endsWith(".git") || url.protocol === "ssh:") {
    return { url: `${url.origin}${url.pathname}`, ref: fragment(url) };
  }
  return null;
}

function stripGitSuffix(value) {
  return String(value).replace(/\.git$/i, "");
}

function fragment(url) {
  const value = url.hash ? url.hash.replace(/^#/, "") : "";
  return value || undefined;
}

function githubPathRef(parts) {
  if (parts[2] === "tree" && parts[3]) return parts.slice(3).join("/");
  if (parts[2] === "commit" && parts[3]) return parts[3];
  if (parts[2] === "releases" && parts[3] === "tag" && parts[4]) return parts[4];
  return undefined;
}

async function cloneGit(git, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const github = githubRepo(git.url);
  if (git.ref && isGitCommit(git.ref) && github) {
    await downloadGithubTarball(github, git.ref, dest);
  } else {
    const args = ["clone", "--depth", "1"];
    if (git.ref) args.push("--branch", git.ref);
    args.push(git.url, dest);
    const cloned = spawnSync("git", args, { encoding: "utf8" });
    if (cloned.status !== 0) {
      if (!github) {
        throw new Error(cloned.stderr?.trim() || "git clone failed");
      }
      log("git clone failed; downloading the GitHub archive...");
      await downloadGithubTarball(github, git.ref || "HEAD", dest);
    }
  }
  const sha = gitRevParse(dest);
  if (git.ref) {
    log(`Locked to ${git.ref}${sha ? ` (${sha})` : ""}`);
  }
  return dest;
}

function githubRepo(url) {
  const match = String(url).match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!match) return null;
  return { owner: match[1], repo: stripGitSuffix(match[2]) };
}

function isGitCommit(ref) {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

function gitRevParse(dir) {
  const result = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function writeOriginSidecar(packedPath, lock) {
  try {
    fs.writeFileSync(
      `${packedPath}.origin.json`,
      `${JSON.stringify({
        origin: lock.origin || "",
        gitRef: lock.gitRef || "",
        gitSha: lock.gitSha || "",
        locked: Boolean(lock.locked),
      })}\n`,
    );
  } catch {
    /* inbox import still succeeds without lock evidence */
  }
}

function verifySha256(file, expected) {
  const crypto = require("node:crypto");
  const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const want = String(expected).replace(/^sha256:/i, "").trim().toLowerCase();
  if (actual !== want) {
    throw new Error(`SHA-256 mismatch: expected ${want}, got ${actual}`);
  }
  log(`Verified sha256:${actual}`);
}

function parseGithubReleaseSpec(source) {
  const raw = String(source || "").trim();
  const api = raw.match(/^github:([^/]+)\/([^/#]+)\/releases\/([^/]+)$/i);
  if (api) {
    return { owner: api[1], repo: api[2], tag: api[3] };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const parts = url.pathname.replace(/^\/|\/$/g, "").split("/");
  if (parts[2] === "releases" && parts[3] === "download" && parts[4] && parts[5]) {
    return {
      owner: parts[0],
      repo: parts[1],
      tag: parts[4],
      assetUrl: raw,
    };
  }
  if (parts[2] === "releases" && parts[3] === "latest") {
    return { owner: parts[0], repo: parts[1], tag: "latest" };
  }
  if (parts[2] === "releases" && parts[3] === "tag" && parts[4]) {
    return { owner: parts[0], repo: parts[1], tag: parts[4] };
  }
  return null;
}

async function resolveGithubRelease(source) {
  const spec = parseGithubReleaseSpec(source);
  if (!spec) return null;
  if (spec.assetUrl && spec.assetUrl.toLowerCase().endsWith(".vxp")) {
    let sha256 = "";
    try {
      const meta = await githubReleaseJson(spec.owner, spec.repo, spec.tag);
      const asset = (meta.assets || []).find(
        (item) => item.browser_download_url === spec.assetUrl || item.name === spec.assetUrl.split("/").pop(),
      );
      sha256 = githubAssetSha(asset);
    } catch {
      /* direct asset URL still installs; SHA is verified when GitHub sends digest */
    }
    return {
      url: spec.assetUrl,
      origin: spec.assetUrl,
      tag: spec.tag,
      sha256,
      pluginId: "",
    };
  }
  const meta = await githubReleaseJson(spec.owner, spec.repo, spec.tag);
  const assets = Array.isArray(meta.assets) ? meta.assets : [];
  const vxp = assets.find((item) => String(item.name || "").toLowerCase().endsWith(".vxp"));
  if (!vxp || !vxp.browser_download_url) {
    throw new Error("GitHub release has no .vxp asset");
  }
  const shaAsset = assets.find((item) =>
    String(item.name || "").toLowerCase().endsWith(".sha256"),
  );
  let sha256 = githubAssetSha(vxp);
  if (!sha256 && shaAsset?.browser_download_url) {
    const body = await fetch(shaAsset.browser_download_url, { redirect: "follow" });
    if (body.ok) {
      sha256 = (await body.text()).trim().split(/\s+/)[0].replace(/^sha256:/i, "");
    }
  }
  return {
    url: vxp.browser_download_url,
    origin: vxp.browser_download_url,
    tag: meta.tag_name || spec.tag,
    sha256,
    pluginId: "",
  };
}

async function githubReleaseJson(owner, repo, tag) {
  const endpoint =
    tag === "latest"
      ? `https://api.github.com/repos/${owner}/${repo}/releases/latest`
      : `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const response = await fetch(endpoint, {
    headers: { accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub release ${owner}/${repo}@${tag} was not found`);
  }
  return response.json();
}

function githubAssetSha(asset) {
  const digest = String(asset?.digest || "");
  const match = digest.match(/sha256:([a-f0-9]{64})/i);
  return match ? match[1].toLowerCase() : "";
}

async function updatePlugin(args) {
  const parsed = parseArgs(args);
  const pluginId = parsed.positional[0];
  if (!pluginId) {
    throw new Error("Usage: vibex plugin update <plugin-id> [--ref tag] [--yes]");
  }
  const host = await requireRunningHost();
  const catalog = await hostCall(host, "plugin_control_catalog", {});
  const plugin = (catalog?.plugins || []).find((item) => item.id === pluginId);
  if (!plugin) throw new Error(`Plugin \`${pluginId}\` is not installed.`);
  if (plugin.builtin || plugin.sourceKind === "builtin") {
    throw new Error(`Plugin \`${pluginId}\` is built-in and cannot be updated this way.`);
  }
  if (plugin.sourceKind === "developer_link") {
    throw new Error(
      `Plugin \`${pluginId}\` is linked. Edit the development directory; the Host reloads on digest change.`,
    );
  }
  if (!plugin.sourceOrigin) {
    throw new Error(
      `Plugin \`${pluginId}\` has no locked origin. Reinstall with --web <url>#tag.`,
    );
  }
  const ref = parsed.flags.ref || plugin.sourceRef || "";
  let source = plugin.sourceOrigin;
  if (parseGitSource(source) || parseGitSource(`${source}#${ref}`)) {
    source = ref ? `${plugin.sourceOrigin.replace(/\.git$/, "")}#${ref}` : plugin.sourceOrigin;
  } else if (parseGithubReleaseSpec(source) && ref) {
    const spec = parseGithubReleaseSpec(source);
    source = spec
      ? `https://github.com/${spec.owner}/${spec.repo}/releases/tag/${ref}`
      : source;
  }
  log(`Updating ${pluginId} from ${source}...`);
  await addWebPlugin(source, { ...parsed.flags, plugin: pluginId, yes: parsed.flags.yes });
}

async function gcRuntimes() {
  const host = await requireRunningHost();
  const result = await hostCall(host, "plugin_control_gc_runtimes", {});
  const reclaimed = Array.isArray(result?.reclaimed) ? result.reclaimed : [];
  if (!reclaimed.length) {
    log("No unreferenced managed Runtimes to reclaim.");
    return;
  }
  log(`Reclaimed ${reclaimed.length} Runtime(s):`);
  for (const item of reclaimed) log(`  ${item}`);
}

async function testAgainstHost(args) {
  const parsed = parseArgs(args);
  if (!parsed.flags.host) {
    throw new Error("Usage: vibex plugin test --host [dir]");
  }
  const root = path.resolve(parsed.positional[0] || ".");
  await ensureValidPlugin(root);
  const identity = readPluginIdentity(root);
  const host = await requireRunningHost();
  log(`Host journey for ${identity.publisher}/${identity.id}`);
  await importToHost(root, true, {
    developerLink: true,
    origin: root,
    locked: false,
  });
  await enableOnHost(identity.id);
  const afterInstall = await hostCall(host, "plugin_control_catalog", {});
  const installed = (afterInstall?.plugins || []).find((item) => item.id === identity.id);
  if (!installed) throw new Error("Host catalog did not contain the plugin after install");
  const skillFiles = findSkillFiles(root);
  if (skillFiles.length) {
    const skillPath = skillFiles[0];
    const original = fs.readFileSync(skillPath, "utf8");
    fs.writeFileSync(skillPath, `${original}\n<!-- host-test ${Date.now()} -->\n`);
    log("Changed Skill; waiting for Host digest reload...");
    const deadline = Date.now() + 8000;
    let sawChange = false;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const catalog = await hostCall(host, "plugin_control_catalog", {});
      const current = (catalog?.plugins || []).find((item) => item.id === identity.id);
      if (current && current.packageDigest && current.packageDigest !== installed.packageDigest) {
        sawChange = true;
        break;
      }
    }
    fs.writeFileSync(skillPath, original);
    if (!sawChange) {
      throw new Error("Host did not publish a new digest after the Skill change");
    }
    log("Host published a new linked generation.");
  }
  await hostCall(host, "plugin_control_uninstall", {
    pluginId: identity.id,
    retainData: true,
  });
  if (!fs.existsSync(root)) {
    throw new Error("Host deleted the development directory");
  }
  const afterRemove = await hostCall(host, "plugin_control_catalog", {});
  if ((afterRemove?.plugins || []).some((item) => item.id === identity.id)) {
    throw new Error("Host catalog still lists the plugin after uninstall");
  }
  log("Host journey passed.");
}

function findSkillFiles(root) {
  const found = [];
  function visit(dir) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "node_modules" || name === ".git") continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) visit(full);
      else if (name === "SKILL.md") found.push(full);
    }
  }
  visit(root);
  return found;
}

async function downloadGithubTarball(github, ref, dest) {
  const tarball = `https://codeload.github.com/${github.owner}/${github.repo}/tar.gz/${encodeURIComponent(ref)}`;
  const staging = path.dirname(dest);
  const archive = await downloadArchive(tarball, staging);
  extractArchive(archive, dest);
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

async function importToHost(pluginRoot, yes, options = {}) {
  const host = discoverHost();
  if (!host.token) return false;
  log(`Connecting to Host ${host.url}...`);
  if (!(await hostAccepts(host.url, host.token))) return false;
  if (!yes && process.stdin.isTTY) {
    process.stderr.write(
      options.developerLink
        ? "Link this development directory to the running Host? [Y/n] "
        : "Install this plugin on the running Host? [Y/n] ",
    );
    const answer = (await readLine()).trim().toLowerCase();
    if (answer && !["y", "yes"].includes(answer)) return false;
  }
  await hostCall(host, "plugin_control_import", {
    path: pluginRoot,
    conflict: "replace",
    developerLink: Boolean(options.developerLink),
    origin: options.origin || undefined,
    gitRef: options.gitRef || undefined,
    gitSha: options.gitSha || undefined,
    locked: Boolean(options.locked),
  });
  return true;
}

async function enableOnHost(pluginId) {
  const host = discoverHost();
  if (!host.token || !(await hostAccepts(host.url, host.token))) return false;
  try {
    await hostCall(host, "plugin_control_set_enabled", {
      pluginId,
      enabled: true,
    });
    return true;
  } catch (error) {
    log(`Could not enable automatically (${error instanceof Error ? error.message : error}).`);
    return false;
  }
}

async function hostCall(host, command, args) {
  const response = await fetch(`${host.url}/api/v1/call/${command}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${host.token}`,
      "content-type": "application/json",
      "x-vibex-protocol-version": "1.0",
    },
    body: JSON.stringify({
      operation_id: crypto.randomUUID(),
      args,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `${body.code || response.status}: ${body.message || `${command} failed`}`,
    );
  }
  if (body && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "data")) {
    return body.data;
  }
  return body;
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
    else if (token === "--detach") flags.detach = true;
    else if (token === "--json") flags.json = true;
    else if (token === "--delete-data") flags.deleteData = true;
    else if (token === "--host") flags.host = true;
    else if (token === "--ref") flags.ref = requireValue(args, ++index, "--ref");
    else if (token === "--sha256") flags.sha256 = requireValue(args, ++index, "--sha256");
    else if (token === "--plugin") flags.plugin = requireValue(args, ++index, "--plugin");
    else if (token === "--web") flags.web = requireValue(args, ++index, "--web");
    else if (token === "--profile") flags.profile = requireValue(args, ++index, "--profile");
    else if (token === "--dev") flags.dev = requireValue(args, ++index, "--dev");
    else if (token === "--output") flags.output = requireValue(args, ++index, "--output");
    else if (token === "--owner") flags.owner = requireValue(args, ++index, "--owner");
    else if (token === "--password") flags.password = requireValue(args, ++index, "--password");
    else if (token === "--market") flags.market = requireValue(args, ++index, "--market");
    else if (token === "--show-tree") flags.showTree = true;
    else if (token === "--hide-tree") flags.showTree = false;
    else if (token.startsWith("--")) {
      throw new Error(`Unknown argument: ${token}`);
    } else positional.push(token);
  }
  return { flags, positional };
}

module.exports = {
  run,
  resolveSource,
  parseGitSource,
  parseGithubReleaseSpec,
  parseAddArgs,
  inferAddMode,
  formatPluginList,
  pluginSourceLabel,
  findPluginRoots,
  pickRoot,
  extractArchive,
  chmodReadable,
  discoverHost,
  hostDataDirs,
  marketplaceOrigin,
  parseArgs,
};
