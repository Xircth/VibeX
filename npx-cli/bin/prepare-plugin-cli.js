const fs = require("node:fs");
const path = require("node:path");

const target = path.join(__dirname, "..", "plugin-cli");

if (process.argv.includes("--clean")) {
  fs.rmSync(target, { recursive: true, force: true });
} else {
  const source = path.join(
    __dirname,
    "..",
    "..",
    "packages",
    "plugin-cli",
    "dist",
  );
  fs.mkdirSync(target, { recursive: true });
  for (const file of ["package.js", "validation.js"]) {
    fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
  fs.writeFileSync(path.join(target, "package.json"), '{"type":"module"}\n');
}
