import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  relative as relativePath,
  resolve,
} from "node:path";

const SOURCE_SUFFIX = ".vibex-workflow.json";
const SHARED_PREFIX = "~/.vibex/workflows/";
const LOCK_STALE_MS = 30_000;
const ESCAPE_ERROR = "Workflow source escapes its authoring root";
const SUFFIX_ERROR = "path must end with .vibex-workflow.json";
const LOCATION_ERROR =
  "path must be project-relative or start with ~/.vibex/workflows/";

export function digest(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export async function safeSourcePath(
  relative,
  { cwd = process.cwd(), home = homedir() } = {},
) {
  if (typeof relative !== "string" || !relative.endsWith(SOURCE_SUFFIX)) {
    throw new Error(SUFFIX_ERROR);
  }
  if (
    isAbsolute(relative) ||
    (relative.startsWith("~/") && !relative.startsWith(SHARED_PREFIX))
  ) {
    throw new Error(LOCATION_ERROR);
  }

  const workspaceRoot = await realpath(cwd);
  const shared = relative.startsWith(SHARED_PREFIX);
  const root = await canonicalizeBase(
    shared ? resolve(home, ".vibex/workflows") : workspaceRoot,
  );
  const target = resolve(
    root,
    shared ? relative.slice(SHARED_PREFIX.length) : relative,
  );
  if (escapes(root, target)) throw new Error(ESCAPE_ERROR);
  return { root, target: await resolveInsideRoot(root, target) };
}

export async function withSourceLock(
  target,
  action,
  { now = Date.now, pid = process.pid, staleMs = LOCK_STALE_MS } = {},
) {
  const lockPath = `${target}.lock`;
  const lock = await acquireLock(lockPath, { now, pid, staleMs });
  try {
    return await action();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export async function writeSourceFile({
  root,
  target,
  content,
  expectedRevision,
}) {
  await mkdir(dirname(target), { recursive: true });
  return withSourceLock(target, async () => {
    let current = null;
    try {
      current = await readFile(target, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (current !== null && !expectedRevision) {
      throw new Error("expectedRevision is required for an existing source");
    }
    if (current !== null && digest(current) !== expectedRevision) {
      throw new Error(
        "Workflow source changed outside this Agent; read and reconcile it first",
      );
    }
    if (current === null && expectedRevision) {
      throw new Error("Workflow source was deleted outside this Agent");
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: "wx" });
      await replaceFile(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    if (escapes(await realpath(root), await realpath(target))) {
      throw new Error(ESCAPE_ERROR);
    }
    return digest(content);
  });
}

function escapes(root, target) {
  const relation = relativePath(root, target);
  return relation.startsWith("..") || isAbsolute(relation);
}

async function realpathIfExists(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function canonicalizeBase(path) {
  const existing = await realpathIfExists(path);
  if (existing) return existing;
  const missing = [];
  let current = path;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) return path;
    missing.push(basename(current));
    const resolved = await realpathIfExists(parent);
    if (resolved) return resolve(resolved, ...missing.toReversed());
    current = parent;
  }
}

async function resolveInsideRoot(root, target) {
  const realRoot = (await realpathIfExists(root)) ?? root;
  const missing = [];
  let current = target;
  for (;;) {
    const resolved = await realpathIfExists(current);
    if (resolved) {
      const related =
        !escapes(realRoot, resolved) || !escapes(resolved, realRoot);
      if (!related) throw new Error(ESCAPE_ERROR);
      const reconstructed = resolve(resolved, ...missing.toReversed());
      if (escapes(realRoot, reconstructed)) throw new Error(ESCAPE_ERROR);
      return reconstructed;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(ESCAPE_ERROR);
    missing.push(basename(current));
    current = parent;
  }
}

async function acquireLock(lockPath, { now, pid, staleMs }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const lock = await open(lockPath, "wx");
      await lock.writeFile(JSON.stringify({ pid, createdAt: now() }));
      return lock;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (!(await reclaimStaleLock(lockPath, { now, staleMs }))) {
        throw new Error(
          "Workflow source is already being edited; retry after the active write finishes",
        );
      }
    }
  }
  throw new Error(
    "Workflow source is already being edited; retry after the active write finishes",
  );
}

async function reclaimStaleLock(lockPath, { now, staleMs }) {
  let raw;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    return error?.code === "ENOENT";
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await rm(lockPath, { force: true });
    return true;
  }
  const holder = Number(parsed?.pid);
  const createdAt = Number(parsed?.createdAt);
  const age = Number.isFinite(createdAt)
    ? now() - createdAt
    : Number.POSITIVE_INFINITY;
  if (pidAlive(holder) && age < staleMs) return false;
  await rm(lockPath, { force: true });
  return true;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function replaceFile(temporary, target) {
  let exists = false;
  try {
    await lstat(target);
    exists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!exists) {
    await rename(temporary, target);
    return;
  }
  // POSIX rename replaces; Windows refuses an existing dest. Move the
  // previous file aside first so both platforms share one replace path.
  const backup = `${target}.${randomUUID()}.bak`;
  await rename(target, backup);
  try {
    await rename(temporary, target);
  } catch (error) {
    await rename(backup, target).catch(() => {});
    throw error;
  }
  await rm(backup, { force: true });
}
