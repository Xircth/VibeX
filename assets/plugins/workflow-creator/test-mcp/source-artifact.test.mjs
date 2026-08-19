import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  digest,
  safeSourcePath,
  withSourceLock,
  writeSourceFile,
} from "../runtime/source-artifact.mjs";

async function makeRoot(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

test("rejects paths that do not end with the Workflow suffix", async () => {
  const cwd = await makeRoot("wf-suffix-");
  await assert.rejects(
    () => safeSourcePath("notes.json", { cwd }),
    /path must end with \.vibex-workflow\.json/,
  );
  await rm(cwd, { recursive: true, force: true });
});

test("rejects absolute paths with a path-location error, not the suffix error", async () => {
  const cwd = await makeRoot("wf-abs-");
  await assert.rejects(
    () => safeSourcePath("/tmp/escape.vibex-workflow.json", { cwd }),
    (error) => {
      assert.match(
        error.message,
        /project-relative or start with ~\/\.vibex\/workflows\//,
      );
      assert.doesNotMatch(error.message, /must end with/);
      return true;
    },
  );
  await rm(cwd, { recursive: true, force: true });
});

test("rejects parent-directory traversal out of the authoring root", async () => {
  const cwd = await makeRoot("wf-dotdot-");
  await assert.rejects(
    () => safeSourcePath("../escape.vibex-workflow.json", { cwd }),
    /escapes its authoring root/,
  );
  await rm(cwd, { recursive: true, force: true });
});

test("rejects a source whose parent directory is a symlink leaving the root", async () => {
  const cwd = await makeRoot("wf-parent-link-");
  const outside = await makeRoot("wf-parent-out-");
  await symlink(outside, join(cwd, "out"));
  await assert.rejects(
    () => safeSourcePath("out/leak.vibex-workflow.json", { cwd }),
    /escapes its authoring root/,
  );
  await rm(cwd, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("rejects a source file that is itself a symlink leaving the root", async () => {
  const cwd = await makeRoot("wf-file-link-");
  const outside = await makeRoot("wf-file-out-");
  const secret = join(outside, "secret.vibex-workflow.json");
  await writeFile(secret, '{"name":"secret"}\n');
  await symlink(secret, join(cwd, "link.vibex-workflow.json"));
  await assert.rejects(
    () => safeSourcePath("link.vibex-workflow.json", { cwd }),
    /escapes its authoring root/,
  );
  await rm(cwd, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("resolves project-relative and shared ~/.vibex/workflows/ sources", async () => {
  const cwd = await makeRoot("wf-ok-");
  const home = await makeRoot("wf-home-");
  const shared = join(home, ".vibex", "workflows");
  await mkdir(shared, { recursive: true });
  const local = await safeSourcePath("flows/demo.vibex-workflow.json", { cwd });
  assert.equal(local.target, join(cwd, "flows/demo.vibex-workflow.json"));
  const remote = await safeSourcePath(
    "~/.vibex/workflows/shared.vibex-workflow.json",
    { cwd, home },
  );
  assert.equal(remote.target, join(shared, "shared.vibex-workflow.json"));
  await rm(cwd, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

test("creates a shared source when home is reached through a symlink", async () => {
  const cwd = await makeRoot("wf-home-link-cwd-");
  const realHome = await makeRoot("wf-home-link-real-");
  const alias = await makeRoot("wf-home-link-alias-");
  const home = join(alias, "home");
  await symlink(realHome, home);
  const located = await safeSourcePath(
    "~/.vibex/workflows/shared.vibex-workflow.json",
    { cwd, home },
  );
  const content = '{\n  "name": "shared"\n}\n';
  const revision = await writeSourceFile({
    root: located.root,
    target: located.target,
    content,
  });
  const written = join(
    realHome,
    ".vibex",
    "workflows",
    "shared.vibex-workflow.json",
  );
  assert.equal(await readFile(written, "utf8"), content);
  assert.equal(revision, sha256(content));
  await rm(cwd, { recursive: true, force: true });
  await rm(realHome, { recursive: true, force: true });
  await rm(alias, { recursive: true, force: true });
});

test("overwrites an existing source through the portable replace path", async () => {
  const cwd = await makeRoot("wf-replace-");
  const target = join(cwd, "demo.vibex-workflow.json");
  const first = '{\n  "name": "one"\n}\n';
  const second = '{\n  "name": "two"\n}\n';
  const created = await writeSourceFile({
    root: cwd,
    target,
    content: first,
  });
  assert.equal(created, sha256(first));
  assert.equal(await readFile(target, "utf8"), first);
  const replaced = await writeSourceFile({
    root: cwd,
    target,
    content: second,
    expectedRevision: sha256(first),
  });
  assert.equal(replaced, sha256(second));
  assert.equal(await readFile(target, "utf8"), second);
  await rm(cwd, { recursive: true, force: true });
});

test("refuses a stale or missing CAS revision", async () => {
  const cwd = await makeRoot("wf-cas-");
  const target = join(cwd, "demo.vibex-workflow.json");
  const first = '{\n  "name": "one"\n}\n';
  await writeSourceFile({ root: cwd, target, content: first });
  await assert.rejects(
    () => writeSourceFile({ root: cwd, target, content: '{\n  "name": "two"\n}\n' }),
    /expectedRevision is required/,
  );
  await assert.rejects(
    () =>
      writeSourceFile({
        root: cwd,
        target,
        content: '{\n  "name": "two"\n}\n',
        expectedRevision: "sha256:deadbeef",
      }),
    /changed outside this Agent/,
  );
  await assert.rejects(
    () =>
      writeSourceFile({
        root: cwd,
        target: join(cwd, "missing.vibex-workflow.json"),
        content: first,
        expectedRevision: sha256(first),
      }),
    /deleted outside this Agent/,
  );
  await rm(cwd, { recursive: true, force: true });
});

test("rejects a live lock and reclaims a lock left by a dead process", async () => {
  const cwd = await makeRoot("wf-lock-");
  const target = join(cwd, "demo.vibex-workflow.json");
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let acquired;
  const started = new Promise((resolve) => {
    acquired = resolve;
  });
  const first = withSourceLock(target, async () => {
    acquired();
    await held;
    return "held";
  });
  await started;
  await assert.rejects(
    () => withSourceLock(target, () => "second"),
    /already being edited/,
  );
  release();
  assert.equal(await first, "held");

  await writeFile(
    `${target}.lock`,
    JSON.stringify({ pid: 999_999_999, createdAt: Date.now() }),
  );
  assert.equal(await withSourceLock(target, () => "reclaimed"), "reclaimed");
  await assert.rejects(readFile(`${target}.lock`), { code: "ENOENT" });

  await writeFile(
    `${target}.lock`,
    JSON.stringify({ pid: process.pid, createdAt: Date.now() - 60_000 }),
  );
  assert.equal(
    await withSourceLock(target, () => "expired", { staleMs: 30_000 }),
    "expired",
  );
  await rm(cwd, { recursive: true, force: true });
});

test("digest matches the published sha256 revision format", () => {
  assert.equal(digest("hello\n"), sha256("hello\n"));
});
