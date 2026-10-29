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
// Exit codes: 0 pass (warnings allowed), 1 violations, 2 environment error
// (for example host-bindings.v1.json not merged yet).
//
// Usage: node scripts/check-arch-invariants.mjs [--root <repo>]

import { checkCatalog } from "./check-arch-catalog.mjs";
import { checkContract } from "./check-arch-contract.mjs";
import { checkDbDependencies } from "./check-arch-db-deps.mjs";
import { checkPortPurity } from "./check-arch-port-purity.mjs";
import { formatLocation } from "./check-arch-shared.mjs";

const RULES = [
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

function parseArgs(argv) {
  let rootDir = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--root" && argv[index + 1]) {
      rootDir = argv[index + 1];
      index += 1;
    }
  }
  return { rootDir };
}

function describeMetrics(metrics) {
  return Object.entries(metrics ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("  ");
}

function main() {
  const { rootDir } = parseArgs(process.argv.slice(2));
  let violations = 0;
  let warnings = 0;
  let errors = 0;

  console.log(`架构不变式门禁（ADR-0033 / ADR-0069 / ADR-0078）root=${rootDir}`);

  for (const rule of RULES) {
    console.log(`\n[${rule.id}] ${rule.title}`);
    let result;
    try {
      result = rule.run({ rootDir });
    } catch (error) {
      errors += 1;
      console.log(`  环境错误：${error.message}`);
      continue;
    }
    console.log(`  指标：${describeMetrics(result.metrics)}`);
    for (const warning of result.warnings) {
      warnings += 1;
      console.log(`  ⚠ ${formatLocation(warning)} ${warning.message}`);
    }
    for (const violation of result.violations) {
      violations += 1;
      console.log(`  ✗ ${formatLocation(violation)} ${violation.message}`);
    }
    if (result.violations.length === 0 && result.warnings.length === 0) {
      console.log("  通过");
    }
  }

  console.log(
    `\n结果：${violations} 个违规，${warnings} 个警告，${errors} 个环境错误`
  );
  if (errors > 0) {
    process.exitCode = 2;
  } else if (violations > 0) {
    process.exitCode = 1;
  }
}

main();
