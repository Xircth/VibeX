// Self-checks for the architecture invariant gates.
//
// Each test builds a throwaway fixture tree in the OS temp directory and proves
// that the rule fires on a constructed violation with the expected file:line.
// The real repository is never modified.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkCatalog } from "./check-arch-catalog.mjs";
import { checkContract } from "./check-arch-contract.mjs";
import { checkDbDependencies } from "./check-arch-db-deps.mjs";
import { checkPortPurity } from "./check-arch-port-purity.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "vibex-arch-"));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, "utf8");
  }
  return root;
}

function lineOf(content, needle) {
  return content.split("\n").findIndex((line) => line.includes(needle)) + 1;
}

function messages(entries) {
  return entries.map((entry) => entry.message).join("\n");
}

const HOST_API = "packages/plugin-contract/catalog/host-api.v1.json";
const HOST_BINDINGS =
  "packages/plugin-contract/catalog/host-bindings.v1.json";
const BROKER = "crates/plugins/src/host_capability_broker.rs";

test("I1 hits a missing op and both capability drift directions", () => {
  const api = `{
  "schemaVersion": 1,
  "operations": [
    { "id": "alpha.one" },
    { "id": "alpha.two" }
  ]
}`;
  const bindings = `{
  "schemaVersion": 1,
  "entries": [
    { "name": "alpha.one", "kind": "op", "status": "ready", "implementation": "crates/server/src/host/a.rs:run", "reaches_core": false },
    { "name": "ghost.cap", "kind": "capability", "status": "ready", "implementation": "crates/server/src/host/a.rs:run", "reaches_core": false }
  ]
}`;
  const broker = `impl crate::CapabilityBroker for HostCapabilityBroker {
    fn supports(&self, capability: &str) -> bool {
        matches!(
            capability,
            "alpha.one" | "missing.entry"
        )
    }
}`;
  const root = fixture({
    [HOST_API]: api,
    [HOST_BINDINGS]: bindings,
    [BROKER]: broker,
  });
  try {
    const { violations } = checkContract({ rootDir: root });
    const text = messages(violations);
    assert.match(text, /host-api op 'alpha\.two'.*没有 kind=op 的绑定条目/);
    assert.match(text, /capability 条目 'ghost\.cap' 不在/);
    assert.match(text, /supports\(\) 接受 capability 'missing\.entry'/);
    const missingOp = violations.find((violation) =>
      violation.message.includes("alpha.two")
    );
    assert.equal(missingOp.file, HOST_API);
    assert.equal(missingOp.line, lineOf(api, '"id": "alpha.two"'));
    const ghost = violations.find((violation) =>
      violation.message.includes("ghost.cap")
    );
    assert.equal(ghost.file, HOST_BINDINGS);
    assert.equal(ghost.line, lineOf(bindings, '"name": "ghost.cap"'));
    const unregistered = violations.find((violation) =>
      violation.message.includes("missing.entry")
    );
    assert.equal(unregistered.file, BROKER);
    assert.equal(unregistered.line, lineOf(broker, '"missing.entry"'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I1 reports undeclared entries as warnings, not violations", () => {
  const api = `{ "schemaVersion": 1, "operations": [ { "id": "one" } ] }`;
  const bindings = `{
  "schemaVersion": 1,
  "entries": [
    { "name": "one", "kind": "op", "status": "undeclared", "implementation": "x", "reaches_core": false },
    { "name": "one.cap", "kind": "capability", "status": "undeclared", "implementation": "x", "reaches_core": false }
  ]
}`;
  const broker = `fn supports(&self, capability: &str) -> bool {
    matches!(capability, "one.cap")
}`;
  const root = fixture({
    [HOST_API]: api,
    [HOST_BINDINGS]: bindings,
    [BROKER]: broker,
  });
  try {
    const { violations, warnings } = checkContract({ rootDir: root });
    assert.equal(violations.length, 0, messages(violations));
    assert.equal(warnings.length, 2);
    assert.match(messages(warnings), /\[undeclared\]/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I2 hits new sqlx / pool access and a reaches_core file without application::", () => {
  const dirtyPath = "crates/server/src/host/dirty.rs";
  const dirty = `// fixture
pub fn run() {
    let _ = sqlx::query("select 1");
    let _ = &self.pool;
}`;
  const corePath = "crates/server/src/host/core.rs";
  const core = "// no application reference\npub fn run() {}\n";
  const bindings = `{
  "schemaVersion": 1,
  "entries": [
    { "name": "core.op", "kind": "op", "status": "ready", "implementation": "${corePath}:run", "reaches_core": true }
  ]
}`;
  const root = fixture({
    [dirtyPath]: dirty,
    [corePath]: core,
    [HOST_BINDINGS]: bindings,
  });
  try {
    const { violations } = checkPortPurity({
      rootDir: root,
      ratchet: new Map(),
    });
    const sqlx = violations.find((violation) =>
      violation.message.includes("新增 sqlx:: 直连")
    );
    assert.equal(sqlx.file, dirtyPath);
    assert.equal(sqlx.line, lineOf(dirty, "sqlx::"));
    const pool = violations.find((violation) =>
      violation.message.includes("新增数据库池直连")
    );
    assert.equal(pool.line, lineOf(dirty, "&self.pool"));
    const reach = violations.find((violation) =>
      violation.message.includes("reaches_core=true")
    );
    assert.equal(reach.file, corePath);
    assert.equal(reach.line, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I2 ratchet fails only above the recorded value and warns below it", () => {
  const dirtyPath = "crates/server/src/host/dirty.rs";
  const dirty = `// fixture
pub fn run() {
    let _ = sqlx::query("select 1");
    let _ = &self.pool;
}`;
  const root = fixture({ [dirtyPath]: dirty });
  try {
    const tooHigh = checkPortPurity({
      rootDir: root,
      ratchet: new Map([
        [dirtyPath, { sqlx: 0, pool: 1, reason: "fixture" }],
      ]),
      bindingsPath: "missing.json",
    });
    assert.equal(tooHigh.violations.length, 1);
    assert.equal(tooHigh.violations[0].line, lineOf(dirty, "sqlx::"));
    assert.match(tooHigh.violations[0].message, /允许 0，当前 1/);

    const lowered = checkPortPurity({
      rootDir: root,
      ratchet: new Map([
        [dirtyPath, { sqlx: 2, pool: 1, reason: "fixture" }],
      ]),
      bindingsPath: "missing.json",
    });
    assert.equal(lowered.violations.length, 0);
    assert.match(messages(lowered.warnings), /收紧 ratchet/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I3 hits an unregistered kind and an unimplemented kind", () => {
  const catalogPath =
    "packages/plugin-contract/catalog/contribution-kinds.v1.json";
  const catalog = `{
  "schemaVersion": 1,
  "kinds": [
    { "id": "app.ok", "status": "ready", "handler": true },
    { "id": "content.hook", "status": "unimplemented", "handler": false },
    { "id": "app.unused", "status": "ready", "handler": true }
  ]
}`;
  const manifestPath = "plugins/demo/.vibex-plugin/plugin.json";
  const manifest = `{
  "id": "vibex.demo",
  "integrations": [
    { "id": "one", "kind": "app.ok" },
    { "id": "two", "kind": "app.ghost" },
    { "id": "three", "kind": "content.hook" }
  ]
}`;
  const root = fixture({ [catalogPath]: catalog, [manifestPath]: manifest });
  try {
    const { violations, warnings } = checkCatalog({
      rootDir: root,
      knownGaps: new Map(),
    });
    const ghost = violations.find((violation) =>
      violation.message.includes("app.ghost")
    );
    assert.equal(ghost.file, manifestPath);
    assert.equal(ghost.line, lineOf(manifest, '"kind": "app.ghost"'));
    const hook = violations.find((violation) =>
      violation.message.includes("unimplemented")
    );
    assert.equal(hook.line, lineOf(manifest, '"kind": "content.hook"'));
    assert.match(messages(warnings), /app\.unused.*无官方插件使用/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I3 known gap downgrades a missing kind and fails once it is registered", () => {
  const catalogPath =
    "packages/plugin-contract/catalog/contribution-kinds.v1.json";
  const manifestPath = "plugins/demo/.vibex-plugin/plugin.json";
  const manifest = `{
  "id": "vibex.demo",
  "integrations": [
    { "id": "one", "kind": "app.rail.section" }
  ]
}`;
  const root = fixture({
    [catalogPath]: `{ "schemaVersion": 1, "kinds": [] }`,
    [manifestPath]: manifest,
  });
  try {
    const gaps = new Map([["app.rail.section", "fixture gap"]]);
    const before = checkCatalog({ rootDir: root, knownGaps: gaps });
    assert.equal(before.violations.length, 0);
    assert.match(messages(before.warnings), /\[已知缺口\]/);

    writeFileSync(
      join(root, catalogPath),
      `{ "schemaVersion": 1, "kinds": [ { "id": "app.rail.section", "status": "ready", "handler": true } ] }`,
      "utf8"
    );
    const after = checkCatalog({ rootDir: root, knownGaps: gaps });
    assert.equal(after.violations.length, 1);
    assert.match(after.violations[0].message, /删除白名单条目/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("I4 hits a forbidden dependency and a path alias to an upper crate", () => {
  const cargoPath = "crates/db/Cargo.toml";
  const cargo = `[package]
name = "db"

[dependencies]
utils = { path = "../utils" }
application = { path = "../application" }

[dev-dependencies]
services = { path = "../services" }
core-alias = { path = "../application" }
`;
  const root = fixture({ [cargoPath]: cargo });
  try {
    const { violations } = checkDbDependencies({ rootDir: root });
    assert.equal(violations.length, 3);
    const byLine = violations
      .map((violation) => violation.line)
      .sort((left, right) => left - right);
    const expectedLines = [
      lineOf(cargo, 'application = { path = "../application" }'),
      lineOf(cargo, 'core-alias = { path = "../application" }'),
      lineOf(cargo, 'services = { path = "../services" }'),
    ].sort((left, right) => left - right);
    assert.deepEqual(byLine, expectedLines);
    assert.match(messages(violations), /application/);
    assert.match(messages(violations), /services/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
