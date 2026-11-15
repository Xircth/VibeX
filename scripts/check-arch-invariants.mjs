#!/usr/bin/env node
// Architecture invariant gates for the three-layer repair (J2).
//
//   I1 契约登记   — host-api / host-bindings / supports() must agree (ADR-0069)
//   I2 端口纯净   — host command layer SQL is ratcheted; reaches_core impls
//                   must reference application:: (ADR-0033 / ADR-0078)
//   I3 目录对齐   — official plugin kinds must be registered and usable
//                   (ADR-0069)
//   I4 反向依赖   — crates/db must not depend on upper layers (ADR-0033)
//   I5 执行器收口 — crates/executors is frozen to passive config + ScriptRequest;
//                   coding-agent execution routes exclusively via agents::AgentRuntime
//                   (ADR-0087 / docs/specs/agent-driver-engine.md §2.2.3)
//
// Gate Governance (maiden-skill / Anti-Bloat Rules):
//   1. Exhaustive reporting (No Fail-Fast): every rule and file scan must
//      collect and report all violations in a single pass; never exit on the
//      first violation.
//   2. Check replacement budget: blocking gate checks are capped at <= 6 checks
//      (total <= 65s). Adding a new blocking check requires merging or retiring
//      an existing check.
//   3. Asymmetric apparatus rule: redundant helpers/wrappers may be deleted
//      freely; new governance scripts or wrappers require explicit human approval.
//
// Exit codes: 0 pass (warnings allowed), 1 violations, 2 environment error.
//
// Usage:
//   node scripts/check-arch-invariants.mjs [--root <repo>] [--json]
//
// --json prints one stable JSON document (no timestamps, no absolute paths) so
// a merge can diff the gate before and after: rules[].metrics carries the
// measured values, warnings carry ratchet drift.

import { pathToFileURL } from "node:url";
import { checkCatalog } from "./check-arch-catalog.mjs";
import { checkContract } from "./check-arch-contract.mjs";
import { checkDbDependencies } from "./check-arch-db-deps.mjs";
import { checkPortPurity } from "./check-arch-port-purity.mjs";
import {
  fileExists,
  formatLocation,
  lineOfIndex,
  readText,
  walkFiles,
} from "./check-arch-shared.mjs";

export const RULE_I5 = "I5";
export const EXECUTORS_SUBDIR = "crates/executors/src/executors";
export const EXECUTORS_ACTIONS_MOD = "crates/executors/src/actions/mod.rs";
export const NATIVE_ENGINE_PROFILE_FILES = [
  "crates/agents/src/profiles/built_ins.rs",
  "crates/agents/src/profiles/configs_a.rs",
];
export const FROZEN_EXECUTOR_ALLOWLIST = new Set([
  "claude.rs",
  "codex.rs",
  "mod.rs",
  "opencode.rs",
  "qa_mock.rs",
]);

const FORBIDDEN_EXECUTOR_PATTERNS = [
  { label: "Command::new", regex: /\bCommand::new\b/ },
  { label: "tokio::process", regex: /\btokio::process\b/ },
  { label: "group_spawn", regex: /\bgroup_spawn\w*\b/ },
  { label: "acp::Client", regex: /\bacp::Client\b/ },
  { label: "claude-native-driver", regex: /claude-native-driver/ },
  { label: "app-server", regex: /app-server/ },
];

const FORBIDDEN_LEGACY_NATIVE_ACP_SHIMS = [
  { label: "claude-agent-acp", regex: /claude-agent-acp/ },
  { label: "claude-code-acp", regex: /claude-code-acp/ },
  { label: "claude-acp", regex: /\bclaude-acp\b/ },
  { label: "codex-acp", regex: /\bcodex-acp\b/ },
];

function extractExecutorActionVariants(source) {
  const enumMatch = source.match(
    /\bpub\s+enum\s+ExecutorActionType\s*\{([\s\S]*?)\}/
  );
  if (!enumMatch) return null;
  const body = enumMatch[1];
  const bodyStart = (enumMatch.index ?? 0) + enumMatch[0].indexOf("{") + 1;
  const variants = [];
  let offset = 0;
  for (const rawLine of body.split("\n")) {
    const lineStart = bodyStart + offset;
    offset += rawLine.length + 1;
    const withoutComment = rawLine.replace(/\/\/.*$/, "").trim();
    if (!withoutComment || withoutComment.startsWith("#[")) continue;
    const variantMatch = withoutComment.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (variantMatch) {
      variants.push({
        name: variantMatch[1],
        line: lineOfIndex(source, lineStart),
      });
    }
  }
  return variants;
}

export function checkExecutorsFreeze({
  rootDir,
  executorsDir = EXECUTORS_SUBDIR,
  actionsPath = EXECUTORS_ACTIONS_MOD,
  profileFiles = NATIVE_ENGINE_PROFILE_FILES,
} = {}) {
  const violations = [];
  const files = walkFiles(rootDir, executorsDir, ".rs");
  const prefix = `${executorsDir}/`;

  for (const file of files) {
    const relName = file.startsWith(prefix) ? file.slice(prefix.length) : file;
    if (!FROZEN_EXECUTOR_ALLOWLIST.has(relName)) {
      violations.push({
        rule: RULE_I5,
        file,
        line: 1,
        message: `crates/executors 已冻结（agent-driver-engine.md §2.2.3），禁止新增执行器文件 '${relName}'；新 Agent 必须接入 crates/agents`,
      });
    }

    const source = readText(rootDir, file);
    const lines = source.split("\n");
    lines.forEach((rawLine, idx) => {
      const trimmed = rawLine.trim();
      if (trimmed.startsWith("//")) return;
      for (const { label, regex } of FORBIDDEN_EXECUTOR_PATTERNS) {
        if (regex.test(rawLine)) {
          violations.push({
            rule: RULE_I5,
            file,
            line: idx + 1,
            message: `crates/executors 禁止启动子进程或挂载 Agent 协议（命中 '${label}'）；请统一路由至 agents::AgentRuntime`,
          });
        }
      }
    });
  }

  let actionVariants = 0;
  if (fileExists(rootDir, actionsPath)) {
    const actionsSource = readText(rootDir, actionsPath);
    const variants = extractExecutorActionVariants(actionsSource);
    if (variants === null) {
      violations.push({
        rule: RULE_I5,
        file: actionsPath,
        line: 1,
        message: "未找到 ExecutorActionType 定义，无法校验旧执行器动作冻结边界",
      });
    } else {
      actionVariants = variants.length;
      for (const variant of variants) {
        if (variant.name !== "ScriptRequest") {
          violations.push({
            rule: RULE_I5,
            file: actionsPath,
            line: variant.line,
            message: `ExecutorActionType 禁止重新引入编码 Agent 动作变体 '${variant.name}'（仅允许保留 ScriptRequest）`,
          });
        }
      }
    }
  }

  let checkedProfileFiles = 0;
  for (const profilePath of profileFiles) {
    if (!fileExists(rootDir, profilePath)) continue;
    checkedProfileFiles += 1;
    const profileSource = readText(rootDir, profilePath);
    profileSource.split("\n").forEach((rawLine, idx) => {
      const withoutComment = rawLine.replace(/\/\/.*$/, "").trim();
      if (!withoutComment) return;
      for (const { label, regex } of FORBIDDEN_LEGACY_NATIVE_ACP_SHIMS) {
        if (regex.test(withoutComment)) {
          violations.push({
            rule: RULE_I5,
            file: profilePath,
            line: idx + 1,
            message: `Claude Code 与 Codex 已收口至 NativeEngine，禁止在内置 Profile 中重新绑定旧 ACP 包装器 '${label}'`,
          });
        }
      }
    });
  }

  return {
    violations,
    warnings: [],
    metrics: {
      executorFiles: files.length,
      actionVariants,
      checkedProfileFiles,
    },
  };
}

export const RULES = [
  {
    id: "I1",
    title: "契约登记（host-api / host-bindings / supports）",
    run: checkContract,
  },
  {
    id: "I2",
    title: "端口纯净（host SQL ratchet / reaches_core）",
    run: checkPortPurity,
  },
  {
    id: "I3",
    title: "目录对齐（官方插件 kind / contribution-kinds）",
    run: checkCatalog,
  },
  {
    id: "I4",
    title: "反向依赖（crates/db 不依赖上层）",
    run: checkDbDependencies,
  },
  {
    id: RULE_I5,
    title: "执行器收口（crates/executors 禁止编码 Agent 执行路径）",
    run: checkExecutorsFreeze,
  },
];

export function parseArgs(argv) {
  const options = { rootDir: process.cwd(), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root" && argv[index + 1]) {
      options.rootDir = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--json") {
      options.json = true;
    }
  }
  return options;
}

// Runs every rule and returns a stable result object used by both the human
// report and --json. A rule that throws becomes an environment error; the other
// rules still run.
export function runAllRules(rootDir, rules = RULES) {
  const result = {
    schemaVersion: 1,
    rules: [],
    summary: { violations: 0, warnings: 0, errors: 0 },
  };
  for (const rule of rules) {
    const report = { id: rule.id, title: rule.title };
    try {
      const outcome = rule.run({ rootDir });
      report.metrics = outcome.metrics ?? {};
      report.violations = outcome.violations ?? [];
      report.warnings = outcome.warnings ?? [];
      result.summary.violations += report.violations.length;
      result.summary.warnings += report.warnings.length;
    } catch (error) {
      report.error = error.message;
      report.metrics = {};
      report.violations = [];
      report.warnings = [];
      result.summary.errors += 1;
    }
    result.rules.push(report);
  }
  return result;
}

function describeMetrics(metrics) {
  return Object.entries(metrics ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("  ");
}

function printHuman(result) {
  console.log("架构不变式门禁（ADR-0033 / ADR-0069 / ADR-0078）");
  for (const report of result.rules) {
    console.log(`\n[${report.id}] ${report.title}`);
    if (report.error) {
      console.log(`  环境错误：${report.error}`);
      continue;
    }
    console.log(`  指标：${describeMetrics(report.metrics)}`);
    for (const warning of report.warnings) {
      console.log(`  ⚠ ${formatLocation(warning)} ${warning.message}`);
    }
    for (const violation of report.violations) {
      console.log(`  ✗ ${formatLocation(violation)} ${violation.message}`);
    }
    if (report.violations.length === 0 && report.warnings.length === 0) {
      console.log("  通过");
    }
  }
  console.log(
    `\n结果：${result.summary.violations} 个违规，${result.summary.warnings} 个警告，${result.summary.errors} 个环境错误`
  );
}

export function exitCodeFor(result) {
  if (result.summary.errors > 0) return 2;
  if (result.summary.violations > 0) return 1;
  return 0;
}

function main() {
  const { rootDir, json } = parseArgs(process.argv.slice(2));
  const result = runAllRules(rootDir);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  process.exitCode = exitCodeFor(result);
}

const invokedDirectly =
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  main();
}
