const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../../..");
const core = __dirname;
const kotlinVersion = "2.4.10";
const kotlinArchiveSha256 =
  "473dd66c7a3ef4b182065b3da670466c1bf2773a9dbb0ed8b33a39fe9d4f876d";
const temurinVersion = "21.0.11_10";
const temurinMacArm64Sha256 =
  "4b7a8cd23102c251c8b8be42a9a5f1263fb337cf1037f6f64b25f3070efe4b76";

function commandOnPath(command) {
  const locator = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(locator, [command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed (${result.status})\n${
        result.stderr || result.stdout || ""
      }`,
    );
  }
  return result;
}

function downloadVerified(url, archive, expectedSha256) {
  if (!fs.existsSync(archive)) {
    run("curl", ["--fail", "--location", "--output", archive, url]);
  }
  const digest = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (digest !== expectedSha256) {
    throw new Error(`tool checksum mismatch for ${path.basename(archive)}: ${digest}`);
  }
}

function resolveKotlinCompiler() {
  if (process.env.VIBEX_KOTLINC) {
    return process.env.VIBEX_KOTLINC;
  }
  const existing = commandOnPath("kotlinc");
  if (existing) {
    return existing;
  }
  const tools = path.join(root, "target", "tools");
  const archive = path.join(tools, `kotlin-compiler-${kotlinVersion}.zip`);
  const extracted = path.join(tools, `kotlin-compiler-${kotlinVersion}`);
  const compiler = path.join(
    extracted,
    "kotlinc",
    "bin",
    process.platform === "win32" ? "kotlinc.bat" : "kotlinc",
  );
  if (fs.existsSync(compiler)) {
    return compiler;
  }
  fs.mkdirSync(tools, { recursive: true });
  downloadVerified(
    `https://github.com/JetBrains/kotlin/releases/download/v${kotlinVersion}/kotlin-compiler-${kotlinVersion}.zip`,
    archive,
    kotlinArchiveSha256,
  );
  fs.rmSync(extracted, { recursive: true, force: true });
  fs.mkdirSync(extracted, { recursive: true });
  run("unzip", ["-q", archive, "-d", extracted]);
  return compiler;
}

function resolveJava() {
  if (process.env.JAVA_HOME) {
    return path.join(
      process.env.JAVA_HOME,
      "bin",
      process.platform === "win32" ? "java.exe" : "java",
    );
  }
  const existing = commandOnPath("java");
  if (existing) {
    const probe = spawnSync(existing, ["-version"], { encoding: "utf8" });
    if (probe.status === 0) {
      return existing;
    }
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("a Java 21+ runtime is required to compile companion-core");
  }
  const tools = path.join(root, "target", "tools");
  const archive = path.join(tools, `temurin-jre-${temurinVersion}-mac-arm64.tar.gz`);
  const extracted = path.join(tools, `temurin-jre-${temurinVersion}-mac-arm64`);
  const home = path.join(
    extracted,
    `jdk-${temurinVersion.replace("_", "+")}-jre`,
    "Contents",
    "Home",
  );
  const java = path.join(home, "bin", "java");
  if (fs.existsSync(java)) {
    return java;
  }
  fs.mkdirSync(tools, { recursive: true });
  downloadVerified(
    "https://github.com/adoptium/temurin21-binaries/releases/download/" +
      "jdk-21.0.11%2B10/OpenJDK21U-jre_aarch64_mac_hotspot_21.0.11_10.tar.gz",
    archive,
    temurinMacArm64Sha256,
  );
  fs.rmSync(extracted, { recursive: true, force: true });
  fs.mkdirSync(extracted, { recursive: true });
  run("tar", ["-xzf", archive, "-C", extracted]);
  return java;
}

function collectKotlin(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectKotlin(fullPath));
    } else if (entry.name.endsWith(".kt")) {
      files.push(fullPath);
    }
  }
  return files;
}

test("companion-core pairing client compiles and rejects workstation scopes", () => {
  const kotlinc = resolveKotlinCompiler();
  const java = resolveJava();
  const javaHome = path.resolve(java, "..", "..");
  const sources = [
    path.join(root, "docs/protocol/v1/generated/kotlin/RemoteProtocolModels.kt"),
    ...collectKotlin(path.join(core, "src/main/kotlin")),
    path.join(core, "src/smoke/kotlin/dev/vibex/companion/CompanionCoreSmoke.kt"),
  ];
  const output = path.join(os.tmpdir(), `vibex-companion-core-${process.pid}.jar`);
  const compile = spawnSync(kotlinc, [...sources, "-include-runtime", "-d", output], {
    encoding: "utf8",
    env: { ...process.env, JAVA_HOME: javaHome },
  });
  assert.equal(
    compile.status,
    0,
    compile.stderr || compile.stdout || "kotlinc failed",
  );
  const runResult = spawnSync(java, ["-jar", output], {
    encoding: "utf8",
    env: { ...process.env, JAVA_HOME: javaHome },
  });
  fs.rmSync(output, { force: true });
  assert.equal(
    runResult.status,
    0,
    runResult.stderr || runResult.stdout || "companion-core smoke failed",
  );
});
