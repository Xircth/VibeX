// I2 — port purity in the Host command layer (ADR-0033 / ADR-0078).
//
// Host product commands must reach the Application Core through ports instead
// of talking to SQLite directly. The current tree still contains a large,
// measured amount of direct SQL, so this rule is a ratchet:
//
//   - every file under crates/server/src/host is scanned for `sqlx::` and for
//     direct pool access (`&self.pool` / `db().pool`);
//   - a file with no whitelist entry may contain zero occurrences;
//   - a whitelisted file may stay at or below its recorded counts, never above;
//     lowering them is reported as a warning so the data file can be tightened.
//
// The second half reads host-bindings.v1.json: any entry with
// reaches_core=true must point at an existing implementation file that
// references `application::`. That keeps the contract's "reaches core" claim
// mechanically true.
//
// Counts and reasons live in check-arch-ratchet.json (i2HostSql), not here, so
// tightening them is a reviewable data diff.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HOST_BINDINGS,
  HOST_DIR,
  RULE_I2,
  loadRatchet,
  matchLines,
  readJson,
  readText,
  walkFiles,
} from "./check-arch-shared.mjs";

export const RULE = RULE_I2;

export const SQLX_PATTERN = /sqlx::/g;
export const POOL_PATTERN = /&self\.pool|db\(\)\.pool/g;

const RATCHET = loadRatchet();

// Values are the measured baseline from check-arch-ratchet.json.
export const HOST_RATCHET = new Map(
  Object.entries(RATCHET.i2HostSql ?? {})
);

export function checkPortPurity({
  rootDir,
  ratchet = HOST_RATCHET,
  bindingsPath = HOST_BINDINGS,
} = {}) {
  const files = walkFiles(rootDir, HOST_DIR, ".rs");
  const violations = [];
  const warnings = [];
  let sqlxTotal = 0;
  let poolTotal = 0;
  let sqlxAllowed = 0;
  let poolAllowed = 0;

  for (const file of files) {
    const source = readText(rootDir, file);
    const sqlx = matchLines(source, SQLX_PATTERN);
    const pool = matchLines(source, POOL_PATTERN);
    sqlxTotal += sqlx.length;
    poolTotal += pool.length;
    const entry = ratchet.get(file);

    if (!entry) {
      for (const match of sqlx) {
        violations.push({
          rule: RULE,
          file,
          line: match.line,
          message:
            "新增 sqlx:: 直连：宿主命令层必须经 Application Core / Deployment，白名单未登记",
        });
      }
      for (const match of pool) {
        violations.push({
          rule: RULE,
          file,
          line: match.line,
          message:
            "新增数据库池直连（&self.pool / db().pool）：白名单未登记",
        });
      }
    } else {
      sqlxAllowed += entry.sqlx;
      poolAllowed += entry.pool;
      if (sqlx.length > entry.sqlx) {
        for (const match of sqlx.slice(entry.sqlx)) {
          violations.push({
            rule: RULE,
            file,
            line: match.line,
            message: `sqlx:: 超出 ratchet 上限（允许 ${entry.sqlx}，当前 ${sqlx.length}）：${entry.reason}`,
          });
        }
      }
      if (pool.length > entry.pool) {
        for (const match of pool.slice(entry.pool)) {
          violations.push({
            rule: RULE,
            file,
            line: match.line,
            message: `池直连超出 ratchet 上限（允许 ${entry.pool}，当前 ${pool.length}）：${entry.reason}`,
          });
        }
      }
      if (sqlx.length < entry.sqlx) {
        warnings.push({
          rule: RULE,
          file,
          line: 0,
          message: `sqlx:: 已降到 ${sqlx.length}（白名单 ${entry.sqlx}），收紧 ratchet`,
        });
      }
      if (pool.length < entry.pool) {
        warnings.push({
          rule: RULE,
          file,
          line: 0,
          message: `池直连已降到 ${pool.length}（白名单 ${entry.pool}），收紧 ratchet`,
        });
      }
    }
  }

  const scanned = new Set(files);
  for (const [file, entry] of ratchet) {
    if (!scanned.has(file)) {
      warnings.push({
        rule: RULE,
        file,
        line: 0,
        message: `白名单条目指向不存在的文件（sqlx ${entry.sqlx} / pool ${entry.pool}），删除条目`,
      });
    }
  }

  let reachesCoreFiles = 0;
  if (existsSync(join(rootDir, bindingsPath))) {
    const bindings = readJson(rootDir, bindingsPath);
    const implementations = new Map();
    for (const entry of bindings.entries ?? []) {
      if (entry.reaches_core !== true) continue;
      const implementation = String(entry.implementation ?? "");
      const file = implementation.split(":")[0];
      if (!file || file.includes("…")) {
        violations.push({
          rule: RULE,
          file: bindingsPath,
          line: 0,
          message: `reaches_core=true 的 '${entry.name}' 没有可解析的 implementation 路径`,
        });
        continue;
      }
      if (!implementations.has(file)) {
        implementations.set(file, entry.name);
      }
    }
    for (const [file, name] of implementations) {
      reachesCoreFiles += 1;
      if (!existsSync(join(rootDir, file))) {
        violations.push({
          rule: RULE,
          file,
          line: 1,
          message: `reaches_core=true（${name}）的实现文件不存在`,
        });
        continue;
      }
      if (!readText(rootDir, file).includes("application::")) {
        violations.push({
          rule: RULE,
          file,
          line: 1,
          message: `reaches_core=true（${name}）但实现文件没有 application:: 引用，核心声明不成立`,
        });
      }
    }
  } else {
    warnings.push({
      rule: RULE,
      file: bindingsPath,
      line: 0,
      message: "host-bindings 不存在，跳过 reaches_core 子检查（I1 已报环境错误）",
    });
  }

  return {
    violations,
    warnings,
    metrics: {
      files: files.length,
      sqlx: `${sqlxTotal}/${sqlxAllowed}`,
      pool: `${poolTotal}/${poolAllowed}`,
      ratchetEntries: ratchet.size,
      reachesCoreFiles,
    },
  };
}
