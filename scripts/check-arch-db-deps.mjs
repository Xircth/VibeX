// I4 — reversed dependency direction (ADR-0033).
//
// crates/db is the persistence adapter. It must not depend on the layers above
// it (automation / executors / services / conversations / application / server /
// plugins), otherwise the "application core owns ports, db implements them"
// direction collapses back into a tangle.

import {
  DB_CARGO,
  RULE_I4,
  loadRatchet,
  readText,
} from "./check-arch-shared.mjs";

export const RULE = RULE_I4;

export const FORBIDDEN_DB_DEPS = [
  "automation",
  "executors",
  "services",
  "conversations",
  "application",
  "server",
  "plugins",
];

// Baseline ratchet for reversed dependencies that already exist in the tree,
// loaded from check-arch-ratchet.json. Each entry needs a reason and the step
// that removes it; a dependency that disappears is reported as a warning so
// the entry gets deleted. The ratchet only tightens: new forbidden dependencies
// are violations, not entries.
const RATCHET = loadRatchet();

export const DB_DEP_RATCHET = new Map(
  (RATCHET.i4DbDependencies ?? []).map((entry) => [
    entry.name,
    entry.reason,
  ])
);

const DEPENDENCY_SECTION = /(?:^|\.)(?:dev-|build-)?dependencies$/;

export function checkDbDependencies({
  rootDir,
  cargoPath = DB_CARGO,
  ratchet = DB_DEP_RATCHET,
} = {}) {
  const source = readText(rootDir, cargoPath);
  const violations = [];
  const warnings = [];
  const lines = source.split("\n");
  let section = "";
  let dependencies = 0;
  let ratcheted = 0;
  const seenRatchet = new Set();

  lines.forEach((text, index) => {
    const trimmed = text.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      section = trimmed.slice(1, -1).trim();
      return;
    }
    if (!DEPENDENCY_SECTION.test(section)) return;
    const declaration = trimmed.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (!declaration) return;
    dependencies += 1;
    const name = declaration[1];
    const pathMatch = trimmed.match(/path\s*=\s*"([^"]+)"/);
    const pathSegments = pathMatch
      ? pathMatch[1].split(/[\\/]/).filter(Boolean)
      : [];
    const pathCrate = pathSegments.length
      ? pathSegments[pathSegments.length - 1]
      : "";
    const forbidden = FORBIDDEN_DB_DEPS.includes(name)
      ? name
      : pathCrate && FORBIDDEN_DB_DEPS.includes(pathCrate)
        ? pathCrate
        : "";

    if (!forbidden) return;
    if (ratchet.has(forbidden)) {
      ratcheted += 1;
      seenRatchet.add(forbidden);
      warnings.push({
        rule: RULE,
        file: cargoPath,
        line: index + 1,
        message: `[ratchet] db 仍依赖上层 crate '${forbidden}'（既有基线，禁止新增）：${ratchet.get(forbidden)}`,
      });
      return;
    }
    violations.push({
      rule: RULE,
      file: cargoPath,
      line: index + 1,
      message: `db 不得依赖上层 crate '${forbidden}'（反向依赖）`,
    });
  });

  for (const [name, reason] of ratchet) {
    if (!seenRatchet.has(name)) {
      warnings.push({
        rule: RULE,
        file: cargoPath,
        line: 0,
        message: `ratchet 依赖 '${name}' 已移除，删除白名单条目（ratchet 只收紧）：${reason}`,
      });
    }
  }

  return {
    violations,
    warnings,
    metrics: { dependencies, ratcheted },
  };
}
