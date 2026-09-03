// No-privilege check for official plugins (ADR-0069, principle 2).
//
// Enforces two rules:
//
//   Rule A — official plugin packages import only the public SDK surface:
//     `@vibex/plugin-sdk` (and subpaths), `node:` builtins, relative paths
//     that stay inside the package, and third-party packages declared in the
//     plugin's own package.json. Anything else (other `@vibex/*` packages,
//     relative escapes into the Host source tree, undeclared bare imports)
//     is a privilege violation.
//
//   Rule B — Host code contains no official-plugin-ID branches: official
//     plugin ID string literals may not appear in Host source outside the
//     explicit data-plane allowlist below. Rust code after the first
//     `#[cfg(test)]` marker and *.test.* / tests/ files are excluded, since
//     tests may name concrete plugins.
//
// Known limitation: the check detects ID literals, not data flow. Branching
// on an ID imported from an allowlisted module would evade it; that pattern
// is forbidden by ADR-0069 and left to code review.

import { builtinModules } from "node:module";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, dirname, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const PUBLIC_SDK_PACKAGE = "@vibex/plugin-sdk";

// Rule B allowlist: Host files that legitimately hold official plugin IDs as
// data (catalog metadata, display copy). Every entry needs a reason.
export const HOST_ID_ALLOWLIST = new Map([
  [
    "crates/plugins/src/catalog.rs",
    "市场目录元数据：官方分类映射与替换 ID 迁移表（数据面，非行为特判）",
  ],
  [
    "frontend/src/pages/plugins/officialPlugins.ts",
    "官方市场展示文案映射（数据面，非行为特判）",
  ],
]);

// Host source roots scanned by Rule B.
const HOST_SCAN_ROOTS = ["crates", "src-tauri/src", "frontend/src", "shared", "packages"];

const CODE_EXTENSIONS = new Set([".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const PLUGIN_CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIPPED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "target",
  "tests",
  ".git",
  ".vibex-plugin",
]);

const NODE_BUILTINS = new Set(builtinModules);

export function extractImports(source) {
  const specifiers = [];
  const patterns = [
    // import ... from 'x' / export ... from 'x'
    /\b(?:import|export)\s+[^'"()]*?\bfrom\s*['"]([^'"]+)['"]/g,
    // side-effect import 'x'
    /\bimport\s*['"]([^'"]+)['"]/g,
    // dynamic import('x') and require('x')
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return [...new Set(specifiers)];
}

export function packageNameOf(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

export function classifyImport(specifier, { filePath, pluginRoot, declaredDeps }) {
  if (specifier.startsWith(".")) {
    const target = resolve(dirname(filePath), specifier);
    const rel = relative(resolve(pluginRoot), target);
    if (rel === ".." || rel.startsWith(`..${sep}`)) {
      return `相对导入越出插件包根目录：'${specifier}'`;
    }
    return null;
  }
  if (specifier.startsWith("node:")) return null;
  const packageName = packageNameOf(specifier);
  if (NODE_BUILTINS.has(packageName)) return null;
  if (packageName === PUBLIC_SDK_PACKAGE) return null;
  if (packageName.startsWith("@vibex/")) {
    return `导入了公开 SDK 之外的 @vibex 包：'${specifier}'（只允许 ${PUBLIC_SDK_PACKAGE}）`;
  }
  if (!declaredDeps.has(packageName)) {
    return `导入了未在插件 package.json 声明的包：'${specifier}'`;
  }
  return null;
}

// Removes every `#[cfg(test)]`-annotated item (inline `mod tests { … }` blocks
// and `mod tests;` declarations) while preserving line numbers, so production
// code before *and after* a test module stays visible to the scan. Brace
// matching is lexical; a Rust string literal with unbalanced braces inside a
// test module could skew it — accepted limitation of a grep-level gate.
export function stripRustTests(source) {
  let result = source;
  let searchFrom = 0;
  for (;;) {
    const attrIndex = result.indexOf("#[cfg(test)]", searchFrom);
    if (attrIndex === -1) break;
    const braceIndex = result.indexOf("{", attrIndex);
    const semicolonIndex = result.indexOf(";", attrIndex);
    let end;
    if (braceIndex !== -1 && (semicolonIndex === -1 || braceIndex < semicolonIndex)) {
      let depth = 0;
      end = -1;
      for (let i = braceIndex; i < result.length; i += 1) {
        if (result[i] === "{") depth += 1;
        else if (result[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) end = result.length - 1;
    } else if (semicolonIndex !== -1) {
      end = semicolonIndex;
    } else {
      end = result.length - 1;
    }
    const removed = result.slice(attrIndex, end + 1);
    const newlines = "\n".repeat(removed.split("\n").length - 1);
    result = result.slice(0, attrIndex) + newlines + result.slice(end + 1);
    searchFrom = attrIndex + newlines.length;
  }
  return result;
}

export function findIdReferences(source, ids) {
  const references = [];
  const lines = source.split("\n");
  for (const id of ids) {
    lines.forEach((line, lineIndex) => {
      if (line.includes(id)) {
        references.push({ id, line: lineIndex + 1 });
      }
    });
  }
  return references;
}

function isTestFile(relativePath) {
  const normalized = relativePath.split(sep).join("/");
  return (
    /\.(test|spec)\.[a-z]+$/.test(normalized) ||
    /(^|\/)tests?\.rs$/.test(normalized) ||
    normalized
      .split("/")
      .some(
        (segment) =>
          segment === "tests" ||
          segment === "test" ||
          segment === "__tests__" ||
          segment === "e2e" ||
          segment.startsWith("test-")
      )
  );
}

function* walkFiles(root, extensions) {
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
      yield* walkFiles(path, extensions);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      if (dot !== -1 && extensions.has(entry.name.slice(dot))) {
        yield path;
      }
    }
  }
}

export function collectOfficialPlugins(rootDir) {
  const pluginsRoot = join(rootDir, "assets", "plugins");
  if (!existsSync(pluginsRoot)) return [];
  const plugins = [];
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(pluginsRoot, entry.name);
    const manifestPath = join(dir, ".vibex-plugin", "plugin.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.id !== "string" || manifest.id.length === 0) {
      throw new Error(`插件 manifest 缺少 id：${manifestPath}`);
    }
    plugins.push({ id: manifest.id, dir });
  }
  return plugins;
}

function declaredDependencies(pluginDir) {
  const packageJsonPath = join(pluginDir, "package.json");
  if (!existsSync(packageJsonPath)) return new Set();
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return new Set(
    ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap(
      (field) => Object.keys(manifest[field] ?? {})
    )
  );
}

export function checkOfficialPluginImports(plugin) {
  const violations = [];
  const declaredDeps = declaredDependencies(plugin.dir);
  for (const filePath of walkFiles(plugin.dir, PLUGIN_CODE_EXTENSIONS)) {
    const source = readFileSync(filePath, "utf8");
    for (const specifier of extractImports(source)) {
      const reason = classifyImport(specifier, {
        filePath,
        pluginRoot: plugin.dir,
        declaredDeps,
      });
      if (reason) {
        violations.push({ rule: "A", plugin: plugin.id, file: filePath, reason });
      }
    }
  }
  return violations;
}

export function checkHostIdBranches(rootDir, ids) {
  if (ids.length === 0) return [];
  const violations = [];
  for (const scanRoot of HOST_SCAN_ROOTS) {
    const absoluteRoot = join(rootDir, scanRoot);
    if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) continue;
    for (const filePath of walkFiles(absoluteRoot, CODE_EXTENSIONS)) {
      const relativePath = relative(rootDir, filePath).split(sep).join("/");
      if (relativePath.startsWith("assets/")) continue;
      if (isTestFile(relativePath)) continue;
      if (HOST_ID_ALLOWLIST.has(relativePath)) continue;
      let source = readFileSync(filePath, "utf8");
      if (filePath.endsWith(".rs")) {
        source = stripRustTests(source);
      }
      for (const reference of findIdReferences(source, ids)) {
        violations.push({
          rule: "B",
          file: relativePath,
          reason: `宿主代码引用官方插件 ID '${reference.id}'（第 ${reference.line} 行）；行为不得按插件 ID 特判，数据面引用需进入白名单并说明理由`,
        });
      }
    }
  }
  return violations;
}

export function runChecks(rootDir) {
  const plugins = collectOfficialPlugins(rootDir);
  if (plugins.length === 0) {
    throw new Error(
      "未发现任何官方插件包（assets/plugins/*/.vibex-plugin/plugin.json）。" +
        "请先初始化子模块：git submodule update --init"
    );
  }
  const violations = [
    ...plugins.flatMap((plugin) => checkOfficialPluginImports(plugin)),
    ...checkHostIdBranches(
      rootDir,
      plugins.map((plugin) => plugin.id)
    ),
  ];
  return { plugins, violations };
}

function main() {
  const rootDir = process.cwd();
  let result;
  try {
    result = runChecks(rootDir);
  } catch (error) {
    console.error(`plugin:no-privilege 环境错误：${error.message}`);
    process.exit(2);
  }
  const { plugins, violations } = result;
  if (violations.length > 0) {
    console.error(`发现 ${violations.length} 处无特权违规：\n`);
    for (const violation of violations) {
      console.error(`  [规则 ${violation.rule}] ${violation.file}`);
      console.error(`    ${violation.reason}\n`);
    }
    console.error(
      "规则来源：ADR-0069 原则 2（官方插件无特权）。官方包只能 import 公开 SDK；" +
        "宿主代码不得按官方插件 ID 特判。"
    );
    process.exit(1);
  }
  console.log(
    `plugin:no-privilege 通过：${plugins.length} 个官方插件包只使用公开 SDK；` +
      "宿主代码无官方插件 ID 条件分支。"
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
