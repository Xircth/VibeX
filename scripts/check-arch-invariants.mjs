#!/usr/bin/env node
// Architecture invariant gates for the three-layer repair (J2).
//
//   I1 契约登记   — host-api / host-bindings / supports() must agree (ADR-0069)
//   I2 端口纯净   — host command layer SQL is ratcheted; reaches_core impls
//                   must reference application:: (ADR-0033 / ADR-0078)
//   I3 目录对齐   — official plugin kinds must be registered and usable
//                   (ADR-0069)
//   I4 反向依赖   — crates/db must not depend on upper layers (ADR-0033)
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
import { formatLocation } from "./check-arch-shared.mjs";

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
