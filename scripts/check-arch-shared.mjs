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
