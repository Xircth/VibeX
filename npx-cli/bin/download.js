const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const CLI_VERSION = require("../package.json").version;
const DEFAULT_GITHUB_REPO = "Xircth/VibeX";
const CACHE_ROOT = path.join(os.homedir(), ".vibex", "host-family");
const LOCAL_DIST_DIR = path.join(__dirname, "..", "dist");

function githubRepo() {
  return process.env.VIBEX_GITHUB_REPO || DEFAULT_GITHUB_REPO;
}

function familyTag() {
  return process.env.VIBEX_HOST_FAMILY_TAG || `v${CLI_VERSION}`;
}

function familyAssetName(platform) {
  return `vibex-host-family-${platform}.tar.gz`;
}

function familyBaseUrl() {
  if (process.env.VIBEX_HOST_FAMILY_BASE) {
    return process.env.VIBEX_HOST_FAMILY_BASE.replace(/\/+$/, "");
  }
  return `https://github.com/${githubRepo()}/releases/download/${familyTag()}`;
}

function familyAssetUrl(platform, suffix = "") {
  return `${familyBaseUrl()}/${familyAssetName(platform)}${suffix}`;
}

function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})  (.+)$/);
    if (!match) {
      continue;
    }
    sums.set(match[2].replace(/^\.\//, ""), match[1].toLowerCase());
  }
  return sums;
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function verifyFileDigest(filePath, expected) {
  const actual = sha256File(filePath);
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `Checksum mismatch for ${path.basename(filePath)}: expected ${expected}, got ${actual}`,
    );
  }
  return actual;
}

function verifySha256Sums(root, sumsText) {
  const sums = parseSha256Sums(sumsText);
  if (sums.size === 0) {
    throw new Error("SHA256SUMS did not contain any checksums");
  }
  for (const [relative, expected] of sums) {
    if (relative === "SHA256SUMS") {
      continue;
    }
    const filePath = path.join(root, ...relative.split("/"));
    if (!fs.existsSync(filePath)) {
      throw new Error(`Host family file missing after extract: ${relative}`);
    }
    verifyFileDigest(filePath, expected);
  }
  return sums;
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          if (!res.headers.location) {
            return reject(new Error(`Redirect without location from ${url}`));
          }
          return fetchBuffer(res.headers.location).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

function downloadFile(url, destPath, expectedSha256, onProgress) {
  const tempPath = `${destPath}.tmp`;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(tempPath);
    const hash = crypto.createHash("sha256");
    const cleanup = () => {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // ignore
      }
    };

    https
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          file.close();
          cleanup();
          if (!res.headers.location) {
            return reject(new Error(`Redirect without location from ${url}`));
          }
          return downloadFile(res.headers.location, destPath, expectedSha256, onProgress)
            .then(resolve)
            .catch(reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          cleanup();
          return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        }

        const totalSize = parseInt(res.headers["content-length"], 10);
        let downloadedSize = 0;
        res.on("data", (chunk) => {
          downloadedSize += chunk.length;
          hash.update(chunk);
          if (onProgress) {
            onProgress(downloadedSize, totalSize);
          }
        });
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          const actualSha256 = hash.digest("hex");
          if (expectedSha256 && actualSha256 !== expectedSha256.toLowerCase()) {
            cleanup();
            return reject(
              new Error(
                `Checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`,
              ),
            );
          }
          try {
            fs.renameSync(tempPath, destPath);
            resolve(destPath);
          } catch (error) {
            cleanup();
            reject(error);
          }
        });
      })
      .on("error", (error) => {
        file.close();
        cleanup();
        reject(error);
      });
  });
}

function extractTarGz(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", destination], { stdio: "ignore" });
}

function resolveExtractedRoot(extractDir, platform) {
  const nested = path.join(extractDir, platform);
  if (fs.existsSync(path.join(nested, "SHA256SUMS"))) {
    return nested;
  }
  if (fs.existsSync(path.join(extractDir, "SHA256SUMS"))) {
    return extractDir;
  }
  throw new Error(`Extracted Host family is missing SHA256SUMS under ${extractDir}`);
}

function chmodBinaries(root) {
  if (process.platform === "win32") {
    return;
  }
  for (const name of ["vibex-server", "vibex-mcp"]) {
    const binary = path.join(root, name);
    if (fs.existsSync(binary)) {
      fs.chmodSync(binary, 0o755);
    }
  }
}

function localFamilyRoot(platform) {
  if (process.env.VIBEX_HOST_FAMILY_DIR) {
    return path.resolve(process.env.VIBEX_HOST_FAMILY_DIR);
  }
  const extracted = path.join(LOCAL_DIST_DIR, "host-family", platform);
  if (fs.existsSync(path.join(extracted, "SHA256SUMS"))) {
    return extracted;
  }
  return null;
}

function cacheDir(platform) {
  return path.join(CACHE_ROOT, familyTag(), platform);
}

async function ensureHostFamily(platform, onProgress) {
  const localRoot = localFamilyRoot(platform);
  if (localRoot) {
    const sumsPath = path.join(localRoot, "SHA256SUMS");
    verifySha256Sums(localRoot, fs.readFileSync(sumsPath, "utf8"));
    chmodBinaries(localRoot);
    return { root: localRoot, source: "local" };
  }

  const cache = cacheDir(platform);
  const extracted = path.join(cache, "family");
  const readyMarker = path.join(extracted, "SHA256SUMS");
  if (fs.existsSync(readyMarker)) {
    verifySha256Sums(extracted, fs.readFileSync(readyMarker, "utf8"));
    chmodBinaries(extracted);
    return { root: extracted, source: "cache" };
  }

  fs.mkdirSync(cache, { recursive: true });
  const archiveName = familyAssetName(platform);
  const archivePath = path.join(cache, archiveName);
  const checksumUrl = familyAssetUrl(platform, ".sha256");
  const archiveUrl = familyAssetUrl(platform);

  const checksumText = (await fetchBuffer(checksumUrl)).toString("utf8");
  const sums = parseSha256Sums(checksumText);
  const expected =
    sums.get(archiveName) || sums.get(`./${archiveName}`) || [...sums.values()][0];
  if (!expected) {
    throw new Error(`No SHA-256 found for ${archiveName} at ${checksumUrl}`);
  }

  await downloadFile(archiveUrl, archivePath, expected, onProgress);
  const staging = path.join(cache, "extract");
  fs.rmSync(staging, { recursive: true, force: true });
  extractTarGz(archivePath, staging);
  const unpacked = resolveExtractedRoot(staging, platform);
  verifySha256Sums(unpacked, fs.readFileSync(path.join(unpacked, "SHA256SUMS"), "utf8"));
  fs.rmSync(extracted, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(extracted), { recursive: true });
  fs.renameSync(unpacked, extracted);
  fs.rmSync(staging, { recursive: true, force: true });
  chmodBinaries(extracted);
  return { root: extracted, source: "download" };
}

function hostBinary(root, name) {
  const fileName = process.platform === "win32" ? `${name}.exe` : name;
  return path.join(root, fileName);
}

module.exports = {
  CACHE_ROOT,
  CLI_VERSION,
  LOCAL_DIST_DIR,
  DEFAULT_GITHUB_REPO,
  downloadFile,
  ensureHostFamily,
  familyAssetName,
  familyAssetUrl,
  familyBaseUrl,
  familyTag,
  githubRepo,
  hostBinary,
  parseSha256Sums,
  sha256File,
  verifyFileDigest,
  verifySha256Sums,
};
