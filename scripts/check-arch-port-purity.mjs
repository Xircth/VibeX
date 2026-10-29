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
//     lowering them is reported as a warning so the allowlist can be tightened.
//
// The second half reads host-bindings.v1.json: any entry with
// reaches_core=true must point at an existing implementation file that
// references `application::`. That keeps the contract's "reaches core" claim
// mechanically true.
//
// Each whitelist entry carries its measured values and the reason it still
// exists; the reason names the follow-up step that should remove it.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HOST_BINDINGS,
  HOST_DIR,
  RULE_I2,
  matchLines,
  readJson,
  readText,
  walkFiles,
} from "./check-arch-shared.mjs";

export const RULE = RULE_I2;

export const SQLX_PATTERN = /sqlx::/g;
export const POOL_PATTERN = /&self\.pool|db\(\)\.pool/g;

// Measured on 2026-10-29 in the current tree: 62 files, sqlx:: 148, pool 310.
export const HOST_RATCHET = new Map([
  [
    "crates/server/src/host/catalog.rs",
    {
      sqlx: 3,
      pool: 0,
      reason: "目录查询仍用 sqlx::query_as! 直读表，待 J3 目录端口化后清零",
    },
  ],
  [
    "crates/server/src/host/catalog/config.rs",
    {
      sqlx: 3,
      pool: 0,
      reason: "配置目录查询直读表，待 J3 目录端口化后清零",
    },
  ],
  [
    "crates/server/src/host/collaboration.rs",
    {
      sqlx: 26,
      pool: 92,
      reason:
        "协作域 role/team/space 直接读写库；J4 协作收核时随 CollaborationHost 一起迁出",
    },
  ],
  [
    "crates/server/src/host/conversation.rs",
    {
      sqlx: 2,
      pool: 17,
      reason: "会话标题/归档/行操作等辅助查询直连池，待 J4 收核",
    },
  ],
  [
    "crates/server/src/host/local_history.rs",
    {
      sqlx: 14,
      pool: 0,
      reason: "本地历史导入的批量写入 SQL，属于 J6 历史迁移范围",
    },
  ],
  [
    "crates/server/src/host/management.rs",
    {
      sqlx: 23,
      pool: 0,
      reason: "Agent/进程管理等目录 SQL，待 J3 目录端口化",
    },
  ],
  [
    "crates/server/src/host/native/model_provider_import.rs",
    {
      sqlx: 3,
      pool: 0,
      reason: "原生供应商导入读取现有配置表，待 J3 端口化",
    },
  ],
  [
    "crates/server/src/host/native/pi_configuration.rs",
    {
      sqlx: 11,
      pool: 0,
      reason: "Pi 配置读写直连表，待 J3 端口化",
    },
  ],
  [
    "crates/server/src/host/native/pi_plugins.rs",
    {
      sqlx: 4,
      pool: 0,
      reason: "Pi 插件清单读写直连表，待 J3 端口化",
    },
  ],
  [
    "crates/server/src/host/native/pi_trust.rs",
    {
      sqlx: 4,
      pool: 0,
      reason: "Pi 信任记录读写直连表，待 J3 端口化",
    },
  ],
  [
    "crates/server/src/host/native_commands.rs",
    {
      sqlx: 4,
      pool: 0,
      reason: "原生命令面查询直连表，待 J3 端口化",
    },
  ],
  [
    "crates/server/src/host/plugin_conversation.rs",
    {
      sqlx: 6,
      pool: 17,
      reason:
        "插件会话投影读写；reaches_core=true 且已带 application:: 引用，待投影下沉 db",
    },
  ],
  [
    "crates/server/src/host/plugin_projections.rs",
    {
      sqlx: 10,
      pool: 7,
      reason: "插件投影查询直连池，待投影仓储下沉 db",
    },
  ],
  [
    "crates/server/src/host/product.rs",
    {
      sqlx: 1,
      pool: 42,
      reason: "产品目录/安装状态查询直连池，待 J3 端口化",
    },
  ],
  [
    "crates/server/src/host/provider_bind.rs",
    {
      sqlx: 1,
      pool: 3,
      reason: "供应商预设绑定写库；reaches_core=true 且已带 application:: 引用",
    },
  ],
  [
    "crates/server/src/host/row_ops.rs",
    {
      sqlx: 6,
      pool: 6,
      reason: "会话行操作（事件溯源写入）直连池，待 J4 收核",
    },
  ],
  [
    "crates/server/src/host/streams.rs",
    {
      sqlx: 0,
      pool: 1,
      reason: "订阅流的 workspace 预检直连 &self.pool，待 J4 收核后改端口",
    },
  ],
  [
    "crates/server/src/host/surface.rs",
    {
      sqlx: 26,
      pool: 85,
      reason: "artifact / app.surface 界面表面读写直连池，待 J4 后收紧",
    },
  ],
  [
    "crates/server/src/host/workspace_parity.rs",
    {
      sqlx: 1,
      pool: 40,
      reason: "工作区对等命令查询直连池，待 J4 后收紧",
    },
  ],
]);

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
