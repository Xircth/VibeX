// Shared helpers for the architecture invariant gates (ADR-0033 / 0069 / 0078).
//
// Each rule module exports a pure `check*(...)` function that returns
// `{ violations, warnings, metrics }`. The CLI entry aggregates the four rules.
// A violation fails CI; a warning is reported but does not fail.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Rule ids follow the J2 brief.
export const RULE_I1 = "I1";
export const RULE_I2 = "I2";
export const RULE_I3 = "I3";
export const RULE_I4 = "I4";

// Host product commands live in crates/server/src/host (ADR-0078 §1).
export const HOST_DIR = "crates/server/src/host";
// Contract products owned by the plugin-contract workstream (ADR-0069).
export const HOST_BINDINGS =
  "packages/plugin-contract/catalog/host-bindings.v1.json";
export const HOST_API = "packages/plugin-contract/catalog/host-api.v1.json";
export const CONTRIBUTION_KINDS =
  "packages/plugin-contract/catalog/contribution-kinds.v1.json";
// The capability seam that host.call reaches (ADR-0069 / ADR-0078).
export const CAPABILITY_BROKER = "crates/plugins/src/host_capability_broker.rs";
// Data-layer crate whose dependency direction I4 pins.
export const DB_CARGO = "crates/db/Cargo.toml";
// Official plugin packages ship a manifest under .vibex-plugin/plugin.json.
export const OFFICIAL_PLUGIN_ROOTS = ["plugins", "assets/plugins"];

export function toPosix(path) {
  return path.split("\\").join("/");
}

export function readText(rootDir, relativePath) {
  return readFileSync(join(rootDir, relativePath), "utf8").replace(/^\uFEFF/, "");
}

export function readJson(rootDir, relativePath) {
  return JSON.parse(readText(rootDir, relativePath));
}

export function fileExists(rootDir, relativePath) {
  return existsSync(join(rootDir, relativePath));
}

// Ratchet baselines live in a data file next to the scripts, so tightening an
// entry is a one-line diff: <scripts>/check-arch-ratchet.json. It is resolved
// relative to this module, not to the scanned --root, so fixtures keep working.
export const RATCHET_FILE = new URL(
  "./check-arch-ratchet.json",
  import.meta.url
);

function requireCount(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`ratchet ${label} 必须是非负整数，实际是 ${value}`);
  }
}

function requireReason(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`ratchet ${label} 必须写明理由`);
  }
}

export function loadRatchet() {
  let data;
  try {
    data = JSON.parse(
      readFileSync(RATCHET_FILE, "utf8").replace(/^\uFEFF/, "")
    );
  } catch (error) {
    throw new Error(`ratchet 文件不可读或不是合法 JSON：${error.message}`);
  }
  if (data.schemaVersion !== 1) {
    throw new Error("ratchet 文件 schemaVersion 必须是 1");
  }
  for (const [file, entry] of Object.entries(data.i2HostSql ?? {})) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`ratchet i2HostSql['${file}'] 必须是对象`);
    }
    requireCount(entry.sqlx, `i2HostSql['${file}'].sqlx`);
    requireCount(entry.pool, `i2HostSql['${file}'].pool`);
    requireReason(entry.reason, `i2HostSql['${file}'].reason`);
  }
  for (const [index, entry] of (data.i3KnownUnregisteredKinds ?? []).entries()) {
    if (!entry || typeof entry.kind !== "string" || entry.kind === "") {
      throw new Error(
        `ratchet i3KnownUnregisteredKinds[${index}] 缺少 kind`
      );
    }
    requireReason(entry.reason, `i3KnownUnregisteredKinds[${index}].reason`);
  }
  for (const [index, entry] of (data.i4DbDependencies ?? []).entries()) {
    if (!entry || typeof entry.name !== "string" || entry.name === "") {
      throw new Error(`ratchet i4DbDependencies[${index}] 缺少 name`);
    }
    requireReason(entry.reason, `i4DbDependencies[${index}].reason`);
  }
  return data;
}

// Every *.rs (or other extension) file under relativeDir, as sorted POSIX paths
// relative to rootDir, so messages are stable across platforms.
export function walkFiles(rootDir, relativeDir, extension) {
  const absoluteRoot = join(rootDir, relativeDir);
  if (!existsSync(absoluteRoot)) return [];
  const files = [];
  const visit = (absoluteDir) => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        files.push(toPosix(absolutePath.slice(rootDir.length + 1)));
      }
    }
  };
  visit(absoluteRoot);
  return files.sort();
}

export function lineOfIndex(source, index) {
  return source.slice(0, index).split("\n").length;
}

export function lineOfNeedle(source, needle) {
  const index = source.indexOf(needle);
  return index === -1 ? 0 : lineOfIndex(source, index);
}

// 1-based line numbers of every match of a global pattern.
export function matchLines(source, pattern) {
  const matches = [];
  for (const match of source.matchAll(new RegExp(pattern.source, "g"))) {
    matches.push({
      line: lineOfIndex(source, match.index ?? 0),
      text: match[0],
    });
  }
  return matches;
}

export function formatLocation({ file, line }) {
  return line > 0 ? `${file}:${line}` : file;
}
