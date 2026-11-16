const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOST_SIDECAR_PACKAGES = ['dimo-mcp', 'dimo-workflow-mcp'];
const HOST_SIDECAR_WATCH_DIRS = [
  'crates/dimo-mcp',
  'crates/dimo-workflow-mcp',
  'crates/delegation-proto',
];

function sidecarFileName(name, platform = process.platform) {
  return platform === 'win32' ? `${name}.exe` : name;
}

function sidecarDebugBinary(
  name,
  { repo, env = {}, platform = process.platform } = {}
) {
  const targetDir = env.CARGO_TARGET_DIR || path.join(repo, 'target');
  return path.join(targetDir, 'debug', sidecarFileName(name, platform));
}

function applySidecarDevEnv(env = {}, { repo, platform = process.platform } = {}) {
  const next = { ...env };
  if (!next.DIMO_MCP_BIN) {
    next.DIMO_MCP_BIN = sidecarDebugBinary('dimo-mcp', {
      repo,
      env: next,
      platform,
    });
  }
  if (!next.DIMO_WORKFLOW_MCP_BIN) {
    next.DIMO_WORKFLOW_MCP_BIN = sidecarDebugBinary('dimo-workflow-mcp', {
      repo,
      env: next,
      platform,
    });
  }
  return next;
}

function isHostSidecarSourcePath(filePath, repo) {
  const rel = path.relative(repo, filePath).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return false;
  }
  if (rel === 'target' || rel.startsWith('target/')) {
    return false;
  }
  return HOST_SIDECAR_WATCH_DIRS.some(
    (dir) => rel === dir || rel.startsWith(`${dir}/`)
  );
}

function sweepRetiredSidecarArtifacts(dir) {
  if (!fs.existsSync(dir)) {
    return;
  }
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.includes('.old-') || entry.includes('.running')) {
      try {
        fs.unlinkSync(path.join(dir, entry));
      } catch {
        // Still mapped by a running process; leave for a later sweep.
      }
    }
  }
}

function vacateSidecarOutput(file) {
  if (!fs.existsSync(file)) {
    return;
  }
  try {
    fs.unlinkSync(file);
  } catch {
    try {
      fs.renameSync(file, `${file}.old-${process.pid}-${Date.now()}`);
    } catch {
      // If neither unlink nor rename succeeded, Cargo will surface the OS error.
    }
  }
}

function freeLockedSidecarOutputs({
  repo,
  env = {},
  platform = process.platform,
} = {}) {
  const targetDir = env.CARGO_TARGET_DIR || path.join(repo, 'target');
  const debugDir = path.join(targetDir, 'debug');
  const depsDir = path.join(debugDir, 'deps');
  const ext = platform === 'win32' ? '.exe' : '';
  const escapedExt = ext.replace('.', '\\.');

  sweepRetiredSidecarArtifacts(debugDir);
  sweepRetiredSidecarArtifacts(depsDir);

  let depEntries = [];
  if (fs.existsSync(depsDir)) {
    try {
      depEntries = fs.readdirSync(depsDir);
    } catch {
      depEntries = [];
    }
  }

  for (const name of HOST_SIDECAR_PACKAGES) {
    const stem = name.replace(/-/g, '_');
    // Vacate `deps/<stem>.exe` (and hashed `deps/<stem>-<hash>.exe`) BEFORE the
    // outer hardlink `debug/<name>.exe`. On Windows NTFS, unlinking only the
    // outer hardlink drops link-count 2 -> 1 without freeing `deps/<stem>.exe`,
    // causing `link.exe` to fail with LNK1104 while leaving the outer binary gone.
    vacateSidecarOutput(path.join(depsDir, `${stem}${ext}`));
    const hashedPattern = new RegExp(`^${stem}-[0-9a-f]+${escapedExt}$`, 'i');
    for (const entry of depEntries) {
      if (hashedPattern.test(entry)) {
        vacateSidecarOutput(path.join(depsDir, entry));
      }
    }
    vacateSidecarOutput(sidecarDebugBinary(name, { repo, env, platform }));
  }
}

function withDevSidecarStageEnv(env = {}) {
  return {
    ...env,
    CARGO_PROFILE: env.CARGO_PROFILE || 'debug',
    TAURI_ENV_DEBUG: env.TAURI_ENV_DEBUG || 'true',
  };
}

function rebuildHostSidecars({
  repo,
  env = process.env,
  spawnSyncFn = spawnSync,
  stageFn,
  platform = process.platform,
} = {}) {
  const cargoEnv = withDevSidecarStageEnv(env);
  freeLockedSidecarOutputs({ repo, env: cargoEnv, platform });
  const cargo = cargoEnv.CARGO || 'cargo';
  console.log('Rebuilding official product MCP sidecars...');
  const result = spawnSyncFn(
    cargo,
    ['build', '-p', 'dimo-mcp', '-p', 'dimo-workflow-mcp'],
    {
      cwd: repo,
      env: cargoEnv,
      stdio: 'inherit',
      windowsHide: true,
    }
  );
  if (result.status !== 0) {
    console.warn('Warning: cargo build -p dimo-mcp returned non-zero status.');
    return false;
  }
  if (stageFn) {
    stageFn(cargoEnv);
  } else {
    require('./stage-host-sidecars').main(cargoEnv);
  }
  return true;
}

function watchHostSidecars({
  repo,
  debounceMs = 400,
  rebuild,
  watchFn = fs.watch,
} = {}) {
  let timer = null;
  let building = false;
  let pending = false;
  const watchers = [];

  const schedule = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(run, debounceMs);
  };

  const run = () => {
    if (building) {
      pending = true;
      return;
    }
    building = true;
    try {
      rebuild();
    } finally {
      building = false;
      if (pending) {
        pending = false;
        schedule();
      }
    }
  };

  for (const dir of HOST_SIDECAR_WATCH_DIRS) {
    const abs = path.join(repo, dir);
    if (!fs.existsSync(abs)) {
      continue;
    }
    watchers.push(
      watchFn(abs, { recursive: true }, (_event, filename) => {
        if (!filename) {
          schedule();
          return;
        }
        if (isHostSidecarSourcePath(path.join(abs, filename), repo)) {
          schedule();
        }
      })
    );
  }

  return {
    close() {
      if (timer) {
        clearTimeout(timer);
      }
      for (const watcher of watchers) {
        watcher.close();
      }
    },
  };
}

module.exports = {
  HOST_SIDECAR_WATCH_DIRS,
  applySidecarDevEnv,
  isHostSidecarSourcePath,
  rebuildHostSidecars,
  sidecarDebugBinary,
  watchHostSidecars,
};
