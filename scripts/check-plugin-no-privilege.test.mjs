import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyImport,
  checkHostIdBranches,
  collectOfficialPlugins,
  extractImports,
  findIdReferences,
  packageNameOf,
  runChecks,
  stripRustTests,
} from "./check-plugin-no-privilege.mjs";

test("extractImports 覆盖 import/export/require/动态 import 与副作用导入", () => {
  const source = `
import { definePluginApp } from '@vibex/plugin-sdk/app';
import type { Foo } from "@vibex/plugin-sdk";
import 'polyfill-pkg';
export { helper } from './helper.mjs';
export * from "node:path";
const lazy = await import('lazy-pkg');
const legacy = require("legacy-pkg");
`;
  assert.deepEqual(new Set(extractImports(source)), new Set([
    "@vibex/plugin-sdk/app",
    "@vibex/plugin-sdk",
    "polyfill-pkg",
    "./helper.mjs",
    "node:path",
    "lazy-pkg",
    "legacy-pkg",
  ]));
});

test("packageNameOf 正确处理 scoped 包与子路径", () => {
  assert.equal(packageNameOf("@vibex/plugin-sdk/worker"), "@vibex/plugin-sdk");
  assert.equal(packageNameOf("lodash/merge"), "lodash");
  assert.equal(packageNameOf("lodash"), "lodash");
});

test("classifyImport 只放行公开 SDK、node 内建、包内相对路径与已声明依赖", () => {
  const context = {
    filePath: "/repo/assets/plugins/demo/runtime/worker.mjs",
    pluginRoot: "/repo/assets/plugins/demo",
    declaredDeps: new Set(["declared-pkg"]),
  };
  assert.equal(classifyImport("@vibex/plugin-sdk", context), null);
  assert.equal(classifyImport("@vibex/plugin-sdk/testing", context), null);
  assert.equal(classifyImport("node:fs/promises", context), null);
  assert.equal(classifyImport("path", context), null);
  assert.equal(classifyImport("./local.mjs", context), null);
  assert.equal(classifyImport("../contents/data.mjs", context), null);
  assert.equal(classifyImport("declared-pkg/sub", context), null);

  assert.match(classifyImport("@vibex/plugin-contract", context), /公开 SDK 之外/);
  assert.match(classifyImport("undeclared-pkg", context), /未在插件 package\.json 声明/);
  assert.match(
    classifyImport("../../../frontend/src/lib/api.ts", context),
    /越出插件包根目录/
  );
});

test("stripRustTests 精确剔除测试模块并保留前后生产代码与行号", () => {
  const source = [
    'fn before() { "keep" }',
    "#[cfg(test)]",
    "mod tests {",
    '    const T: &str = "vibex.demo";',
    "    fn nested() { if true { } }",
    "}",
    'fn after() { "vibex.demo-in-production" }',
  ].join("\n");
  const stripped = stripRustTests(source);
  assert.ok(stripped.includes("fn before"));
  assert.ok(!stripped.includes("mod tests"));
  assert.ok(!stripped.includes('const T'));
  assert.ok(stripped.includes("fn after"), "测试模块之后的生产代码必须保留");
  assert.equal(
    stripped.split("\n").length,
    source.split("\n").length,
    "剔除后行号必须保持稳定"
  );
  // 测试模块后的生产代码中的 ID 引用仍可被发现，且行号正确。
  const refs = findIdReferences(stripped, ["vibex.demo"]);
  assert.deepEqual(refs, [{ id: "vibex.demo", line: 7 }]);

  const declaration = 'fn a() {}\n#[cfg(test)]\nmod tests;\nfn b() { "vibex.demo" }';
  const strippedDeclaration = stripRustTests(declaration);
  assert.ok(!strippedDeclaration.includes("mod tests;"));
  assert.ok(strippedDeclaration.includes("fn b"));

  assert.equal(stripRustTests("no tests here"), "no tests here");
});

test("findIdReferences 返回 ID 与行号", () => {
  const refs = findIdReferences('a\nlet x = "vibex.demo";\n', ["vibex.demo", "vibex.other"]);
  assert.deepEqual(refs, [{ id: "vibex.demo", line: 2 }]);
});

function buildFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "no-privilege-"));
  const pluginDir = join(root, "assets", "plugins", "demo");
  mkdirSync(join(pluginDir, ".vibex-plugin"), { recursive: true });
  mkdirSync(join(pluginDir, "runtime"), { recursive: true });
  writeFileSync(
    join(pluginDir, ".vibex-plugin", "plugin.json"),
    JSON.stringify({ id: "vibex.demo", publisher: "vibex" })
  );
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({ dependencies: { "declared-pkg": "^1.0.0" } })
  );
  mkdirSync(join(root, "crates", "demo", "src"), { recursive: true });
  mkdirSync(join(root, "frontend", "src"), { recursive: true });
  return { root, pluginDir };
}

test("runChecks：干净的仓库通过", () => {
  const { root, pluginDir } = buildFixtureRepo();
  try {
    writeFileSync(
      join(pluginDir, "runtime", "worker.mjs"),
      "import { defineWorker } from '@vibex/plugin-sdk/worker';\nimport 'node:fs';\nimport 'declared-pkg';\n"
    );
    writeFileSync(
      join(root, "crates", "demo", "src", "lib.rs"),
      'fn ok() {}\n#[cfg(test)]\nmod tests { const T: &str = "vibex.demo"; }\n'
    );
    const { violations } = runChecks(root);
    assert.deepEqual(violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runChecks：越权导入与宿主 ID 分支都被报告", () => {
  const { root, pluginDir } = buildFixtureRepo();
  try {
    writeFileSync(
      join(pluginDir, "runtime", "worker.mjs"),
      "import { internal } from '@vibex/plugin-contract';\nimport 'undeclared-pkg';\n"
    );
    writeFileSync(
      join(root, "crates", "demo", "src", "lib.rs"),
      'fn gate(id: &str) -> bool { id == "vibex.demo" }\n'
    );
    writeFileSync(
      join(root, "frontend", "src", "gate.ts"),
      "export const special = pluginId === 'vibex.demo';\n"
    );
    const { violations } = runChecks(root);
    const rules = violations.map((violation) => violation.rule).sort();
    assert.deepEqual(rules, ["A", "A", "B", "B"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runChecks：测试文件与 tests 目录中的 ID 引用不计违规", () => {
  const { root, pluginDir } = buildFixtureRepo();
  try {
    writeFileSync(
      join(pluginDir, "runtime", "worker.mjs"),
      "import '@vibex/plugin-sdk';\n"
    );
    mkdirSync(join(root, "crates", "demo", "tests"), { recursive: true });
    writeFileSync(
      join(root, "crates", "demo", "tests", "it.rs"),
      'const T: &str = "vibex.demo";\n'
    );
    writeFileSync(
      join(root, "frontend", "src", "gate.test.ts"),
      "expect(id).toBe('vibex.demo');\n"
    );
    mkdirSync(join(root, "frontend", "src", "e2e"), { recursive: true });
    writeFileSync(
      join(root, "frontend", "src", "e2e", "JourneyFixture.tsx"),
      "export const fixturePlugin = 'vibex.demo';\n"
    );
    mkdirSync(join(root, "packages", "demo-mcp", "test-mcp"), { recursive: true });
    writeFileSync(
      join(root, "packages", "demo-mcp", "test-mcp", "live-host.mjs"),
      "const plugin = 'vibex.demo';\n"
    );
    const { violations } = runChecks(root);
    assert.deepEqual(violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectOfficialPlugins 缺子模块时 runChecks 报环境错误", () => {
  const root = mkdtempSync(join(tmpdir(), "no-privilege-empty-"));
  try {
    assert.deepEqual(collectOfficialPlugins(root), []);
    assert.throws(() => runChecks(root), /未发现任何官方插件包/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkHostIdBranches 白名单外的数据面引用仍被报告", () => {
  const { root } = buildFixtureRepo();
  try {
    writeFileSync(
      join(root, "frontend", "src", "randomList.ts"),
      "export const ids = ['vibex.demo'];\n"
    );
    const violations = checkHostIdBranches(root, ["vibex.demo"]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, "frontend/src/randomList.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
