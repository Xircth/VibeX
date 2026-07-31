import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ALLOWED_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "apache-2.0",
  "BSD-1-Clause",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "CC0-1.0",
  "CDLA-Permissive-2.0",
  "ISC",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "OFL-1.1",
  "Unicode-3.0",
  "Unlicense",
  "Zlib",
  "bzip2-1.0.6",
]);

// pnpm reports this package as Unknown because its package.json omits the
// field. Version 2.1.0 ships an unmodified MIT license file; the exception is
// exact so an upgrade must be reviewed again.
const REVIEWED_UNKNOWN_PACKAGES = new Set(["khroma@2.1.0"]);

function licenseExpressionIsAllowed(expression) {
  const tokens = expression
    .replace(/\s+WITH\s+[A-Za-z0-9.-]+/g, "")
    .replaceAll("/", " OR ")
    .match(/\(|\)|\bAND\b|\bOR\b|[A-Za-z0-9.+-]+/g);
  if (!tokens?.length) return false;
  let cursor = 0;

  function primary() {
    const token = tokens[cursor++];
    if (token === "(") {
      const value = disjunction();
      if (tokens[cursor++] !== ")")
        throw new Error("unbalanced license expression");
      return value;
    }
    if (!token || token === ")" || token === "AND" || token === "OR") {
      throw new Error(`invalid license expression: ${expression}`);
    }
    return ALLOWED_LICENSES.has(token);
  }

  function conjunction() {
    let value = primary();
    while (tokens[cursor] === "AND") {
      cursor += 1;
      const right = primary();
      value = value && right;
    }
    return value;
  }

  function disjunction() {
    let value = conjunction();
    while (tokens[cursor] === "OR") {
      cursor += 1;
      const right = conjunction();
      value = value || right;
    }
    return value;
  }

  const allowed = disjunction();
  return allowed && cursor === tokens.length;
}

export function auditPnpmLicenses(report) {
  const failures = [];
  for (const [expression, packages] of Object.entries(report)) {
    for (const dependency of packages) {
      for (const version of dependency.versions ?? []) {
        const identity = `${dependency.name}@${version}`;
        if (expression === "Unknown") {
          if (!REVIEWED_UNKNOWN_PACKAGES.has(identity)) failures.push(identity);
        } else if (!licenseExpressionIsAllowed(expression)) {
          failures.push(`${identity} (${expression})`);
        }
      }
    }
  }
  if (failures.length) {
    throw new Error(`unapproved JavaScript licenses:\n${failures.join("\n")}`);
  }
}

export function auditCargoMetadata(metadata) {
  const failures = [];
  for (const dependency of metadata.packages ?? []) {
    if (!dependency.source) continue;
    const identity = `${dependency.name}@${dependency.version}`;
    if (
      typeof dependency.license !== "string" ||
      !licenseExpressionIsAllowed(dependency.license)
    ) {
      failures.push(
        `${identity}${dependency.license ? ` (${dependency.license})` : ""}`,
      );
    }
  }
  if (failures.length) {
    throw new Error(`unapproved Rust licenses:\n${failures.join("\n")}`);
  }
}

function run() {
  const pnpm = JSON.parse(
    execFileSync("pnpm", ["licenses", "list", "--json", "--prod"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  const cargo = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  auditPnpmLicenses(pnpm);
  auditCargoMetadata(cargo);
  process.stdout.write(
    `Dependency license audit passed (${Object.values(pnpm).flat().length} JavaScript groups, ${cargo.packages.length} Rust packages).\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run();
}
