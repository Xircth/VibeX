const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOST_SIDECAR_PACKAGES = ['vibex-mcp', 'vibex-workflow-mcp'];
const HOST_SIDECAR_WATCH_DIRS = [
  'crates/vibex-mcp',
  'crates/vibex-workflow-mcp',
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
  if (!next.VIBEX_MCP_BIN) {
    next.VIBEX_MCP_BIN = sidecarDebugBinary('vibex-mcp', {
      repo,
      env: next,
      platform,
    });
  }
  if (!next.VIBEX_WORKFLOW_MCP_BIN) {
    next.VIBEX_WORKFLOW_MCP_BIN = sidecarDebugBinary('vibex-workflow-mcp', {
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

function freeLockedSidecarOutputs({
  repo,
  env = {},
  platform = process.platform,
} = {}) {
  for (const name of HOST_SIDECAR_PACKAGES) {
    const file = sidecarDebugBinary(name, { repo, env, platform });
    if (!fs.existsSync(file)) {
      continue;
    }
    try {
      fs.unlinkSync(file);
    } catch {
      try {
        fs.renameSync(file, `${file}.old-${Date.now()}`);
      } catch {
        // The previous sidecar image can stay mapped; cargo then writes beside it.
      }
    }
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
    ['build', '-p', 'vibex-mcp', '-p', 'vibex-workflow-mcp'],
    {
      cwd: repo,
      env: cargoEnv,
      stdio: 'inherit',
      windowsHide: true,
    }
  );
  if (result.status !== 0) {
    console.warn('Warning: cargo build -p vibex-mcp returned non-zero status.');
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
