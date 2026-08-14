#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HELPER_NAMES = [
  'vibex Helper',
  'vibex Helper (Alerts)',
  'vibex Helper (GPU)',
  'vibex Helper (Plugin)',
  'vibex Helper (Renderer)',
];

class DevRunnerTerminated extends Error {}

function parseCargoRunArgs(args) {
  if (args[0] !== 'run') {
    throw new Error(
      `expected a cargo run command, received: ${args.join(' ')}`
    );
  }

  const separator = args.indexOf('--');
  const cargoArgs = args.slice(1, separator === -1 ? args.length : separator);
  const appArgs = separator === -1 ? [] : args.slice(separator + 1);
  const profile = cargoArgs.includes('--release') ? 'release' : 'debug';

  return {
    appArgs,
    buildArgs: [
      'build',
      ...cargoArgs,
      '--bin',
      'vibex',
      '--bin',
      'vibex_cef_helper',
    ],
    profile,
  };
}

function resolveMacosDevPaths(workspaceRoot, sourceAppExecutable, targetRoot) {
  const resolvedTargetRoot = targetRoot || path.join(workspaceRoot, 'target');
  const stageRoot = path.join(resolvedTargetRoot, 'cef-runtime', 'macos');
  const appRoot = path.join(stageRoot, 'app', 'vibex.app');
  const frameworkRoot = path.join(
    appRoot,
    'Contents',
    'Frameworks',
    'Chromium Embedded Framework.framework'
  );
  const helpersRoot = path.join(frameworkRoot, 'Helpers');

  return {
    appExecutable: path.join(appRoot, 'Contents', 'MacOS', 'vibex'),
    appRoot,
    frameworkResources: path.join(frameworkRoot, 'Resources'),
    helperExecutables: HELPER_NAMES.map((name) => ({
      destination: path.join(
        helpersRoot,
        `${name}.app`,
        'Contents',
        'MacOS',
        name
      ),
      name,
    })),
    devCommandPidFile: path.join(stageRoot, 'dev-command.pid.json'),
    manifest: path.join(stageRoot, 'cef-runtime-manifest.json'),
    pidFile: path.join(stageRoot, 'dev-app.pid'),
    sourceAppExecutable,
    sourceHelperExecutable: path.join(
      path.dirname(sourceAppExecutable),
      'vibex_cef_helper'
    ),
    stageRoot,
  };
}

function resolveTargetRoot(workspaceRoot, env) {
  if (!env.CARGO_TARGET_DIR) {
    return path.join(workspaceRoot, 'target');
  }
  return path.resolve(workspaceRoot, env.CARGO_TARGET_DIR);
}

function findTarget(args) {
  const equalsTarget = args.find((arg) => arg.startsWith('--target='));
  if (equalsTarget) {
    return equalsTarget.slice('--target='.length);
  }
  const targetIndex = args.indexOf('--target');
  return targetIndex === -1 ? null : args[targetIndex + 1];
}

function resolveProfileDirectory(targetRoot, buildArgs, profile) {
  const target = findTarget(buildArgs);
  return target
    ? path.join(targetRoot, target, profile)
    : path.join(targetRoot, profile);
}

function isStagedBundleReady(paths) {
  if (
    !fs.existsSync(path.join(paths.frameworkResources, 'icudtl.dat')) ||
    !fs.existsSync(paths.manifest)
  ) {
    return false;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'));
    return (
      manifest.schemaVersion === 1 &&
      paths.helperExecutables.every((helper) =>
        fs.existsSync(helper.destination)
      )
    );
  } catch {
    return false;
  }
}

function findExistingCefRoot(profileDirectory) {
  const buildDirectory = path.join(profileDirectory, 'build');
  if (!fs.existsSync(buildDirectory)) {
    return null;
  }

  for (const buildEntry of fs.readdirSync(buildDirectory)) {
    if (!buildEntry.startsWith('cef-dll-sys-')) {
      continue;
    }
    const outputDirectory = path.join(buildDirectory, buildEntry, 'out');
    if (!fs.existsSync(outputDirectory)) {
      continue;
    }
    for (const outputEntry of fs.readdirSync(outputDirectory)) {
      if (!outputEntry.startsWith('cef_macos_')) {
        continue;
      }
      const cefRoot = path.join(outputDirectory, outputEntry);
      const icuData = path.join(
        cefRoot,
        'Chromium Embedded Framework.framework',
        'Resources',
        'icudtl.dat'
      );
      if (fs.existsSync(icuData)) {
        return cefRoot;
      }
    }
  }
  return null;
}

function terminateProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function readProcessStartTime(pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}

function writeTrackedCommand(pidFile, child, args) {
  const startedAt = readProcessStartTime(child.pid);
  if (!startedAt) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  const temporary = `${pidFile}.next-${process.pid}`;
  try {
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({
        argsSuffix: args.join(' '),
        pid: child.pid,
        startedAt,
      })}\n`
    );
    fs.renameSync(temporary, pidFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function removeTrackedCommand(pidFile, expectedPid) {
  if (!fs.existsSync(pidFile)) {
    return;
  }
  try {
    const tracked = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    if (tracked.pid !== expectedPid) {
      return;
    }
    fs.unlinkSync(pidFile);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function isProcessGroupRunning(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    if (error.code === 'EPERM') {
      try {
        process.kill(pid, 0);
        return true;
      } catch (processError) {
        if (processError.code === 'ESRCH') {
          return false;
        }
        if (processError.code === 'EPERM') {
          return true;
        }
        throw processError;
      }
    }
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupRunning(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isProcessGroupRunning(pid);
}

async function terminateTrackedDevCommand(pidFile) {
  if (!fs.existsSync(pidFile)) {
    return;
  }

  let tracked;
  try {
    tracked = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  } catch {
    fs.rmSync(pidFile, { force: true });
    return;
  }

  try {
    if (
      !Number.isInteger(tracked.pid) ||
      tracked.pid <= 0 ||
      typeof tracked.argsSuffix !== 'string' ||
      tracked.argsSuffix.length === 0
    ) {
      return;
    }
    const currentStartedAt = readProcessStartTime(tracked.pid);
    if (!currentStartedAt || currentStartedAt !== tracked.startedAt) {
      return;
    }
    const currentProcess = spawnSync(
      '/bin/ps',
      ['-p', String(tracked.pid), '-o', 'command='],
      { encoding: 'utf8', windowsHide: true }
    );
    const currentCommand =
      currentProcess.status === 0 ? currentProcess.stdout.trim() : '';
    if (!currentCommand.endsWith(tracked.argsSuffix)) {
      return;
    }

    terminateProcessGroup({ pid: tracked.pid }, 'SIGTERM');
    if (!(await waitForProcessGroupExit(tracked.pid, 1000))) {
      terminateProcessGroup({ pid: tracked.pid }, 'SIGKILL');
      await waitForProcessGroupExit(tracked.pid, 1000);
    }
  } finally {
    removeTrackedCommand(pidFile, tracked.pid);
  }
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const { trackedPidFile, ...spawnOptions } = options;
    const child = spawn(command, args, {
      ...spawnOptions,
      detached: true,
      stdio: 'inherit',
      windowsHide: true,
    });
    let terminationSignal = null;

    if (trackedPidFile) {
      writeTrackedCommand(trackedPidFile, child, args);
    }

    const cleanup = () => {
      process.removeListener('SIGINT', handleSignal);
      process.removeListener('SIGTERM', handleSignal);
      if (trackedPidFile) {
        removeTrackedCommand(trackedPidFile, child.pid);
      }
    };
    const handleSignal = (signal) => {
      terminationSignal = signal;
      terminateProcessGroup(child, signal);
    };

    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      if (terminationSignal) {
        reject(new DevRunnerTerminated());
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `${command} exited with ${signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`}`
          )
        );
        return;
      }
      resolve();
    });
  });
}

async function stageRuntime(
  workspaceRoot,
  profileDirectory,
  profile,
  env,
  trackedPidFile
) {
  const stageEnv = {
    ...env,
    TAURI_ENV_DEBUG: profile === 'debug' ? 'true' : 'false',
  };
  const cefRoot = findExistingCefRoot(profileDirectory);
  if (cefRoot && !stageEnv.CEF_PATH) {
    stageEnv.CEF_PATH = cefRoot;
  }
  await runCommand(
    env.CARGO || 'cargo',
    [
      'run',
      '-p',
      'browser-cef',
      '--features',
      'cef-host',
      '--bin',
      'stage_cef_runtime',
      '--',
      profile,
    ],
    { cwd: workspaceRoot, env: stageEnv, trackedPidFile }
  );
}

function replaceExecutable(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`CEF development executable is missing: ${source}`);
  }
  const replacement = `${destination}.next-${process.pid}`;
  try {
    fs.copyFileSync(source, replacement);
    fs.chmodSync(replacement, 0o755);
    fs.renameSync(replacement, destination);
  } finally {
    if (fs.existsSync(replacement)) {
      fs.unlinkSync(replacement);
    }
  }
}

function refreshBundleExecutables(paths) {
  replaceExecutable(paths.sourceAppExecutable, paths.appExecutable);
  for (const helper of paths.helperExecutables) {
    replaceExecutable(paths.sourceHelperExecutable, helper.destination);
  }
}

function signDevBundle(appRoot) {
  for (const args of [
    ['--force', '--deep', '--sign', '-', appRoot],
    ['--verify', '--deep', '--strict', appRoot],
  ]) {
    const result = spawnSync('/usr/bin/codesign', args, {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `failed to prepare the macOS development bundle: ${(
          result.stderr || result.stdout
        ).trim()}`
      );
    }
  }
}

function isTrackedDevAppCommand(command, appExecutable) {
  const normalized = command.trim();
  return (
    normalized === appExecutable || normalized.startsWith(`${appExecutable} `)
  );
}

function removeTrackedPid(pidFile, expectedPid) {
  if (!fs.existsSync(pidFile)) {
    return;
  }
  if (expectedPid !== undefined) {
    const trackedPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    if (trackedPid !== expectedPid) {
      return;
    }
  }
  fs.unlinkSync(pidFile);
}

function terminateTrackedDevApp(paths) {
  if (!fs.existsSync(paths.pidFile)) {
    return;
  }

  const pid = Number.parseInt(fs.readFileSync(paths.pidFile, 'utf8'), 10);
  try {
    if (!Number.isInteger(pid) || pid <= 0) {
      return;
    }
    const processInfo = spawnSync(
      '/bin/ps',
      ['-p', String(pid), '-o', 'command='],
      { encoding: 'utf8', windowsHide: true }
    );
    if (
      processInfo.status === 0 &&
      isTrackedDevAppCommand(processInfo.stdout, paths.appExecutable)
    ) {
      process.kill(pid, 'SIGKILL');
    }
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  } finally {
    removeTrackedPid(paths.pidFile);
  }
}

async function run() {
  if (process.platform !== 'darwin') {
    throw new Error('the CEF app-bundle development runner is macOS-only');
  }

  const workspaceRoot = path.resolve(__dirname, '..');
  const parsed = parseCargoRunArgs(process.argv.slice(2));
  const env = process.env;
  const targetRoot = resolveTargetRoot(workspaceRoot, env);
  const profileDirectory = resolveProfileDirectory(
    targetRoot,
    parsed.buildArgs,
    parsed.profile
  );
  const paths = resolveMacosDevPaths(
    workspaceRoot,
    path.join(profileDirectory, 'vibex'),
    targetRoot
  );
  await terminateTrackedDevCommand(paths.devCommandPidFile);
  await runCommand(env.CARGO || 'cargo', parsed.buildArgs, {
    cwd: workspaceRoot,
    env,
    trackedPidFile: paths.devCommandPidFile,
  });

  if (!isStagedBundleReady(paths)) {
    await stageRuntime(
      workspaceRoot,
      profileDirectory,
      parsed.profile,
      env,
      paths.devCommandPidFile
    );
  }
  terminateTrackedDevApp(paths);
  refreshBundleExecutables(paths);
  signDevBundle(paths.appRoot);

  const child = spawn(paths.appExecutable, parsed.appArgs, {
    cwd: workspaceRoot,
    env,
    stdio: 'inherit',
  });
  fs.writeFileSync(paths.pidFile, `${child.pid}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => child.kill('SIGKILL'));
  }
  child.once('error', (error) => {
    console.error('Failed to launch the macOS CEF development bundle:', error);
    process.exit(1);
  });
  child.once('exit', (code, signal) => {
    removeTrackedPid(paths.pidFile, child.pid);
    process.exit(code ?? (signal ? 0 : 1));
  });
}

module.exports = {
  isStagedBundleReady,
  isTrackedDevAppCommand,
  parseCargoRunArgs,
  replaceExecutable,
  resolveMacosDevPaths,
  signDevBundle,
};

if (require.main === module) {
  run().catch((error) => {
    if (error instanceof DevRunnerTerminated) {
      process.exit(0);
    }
    console.error(error);
    process.exit(1);
  });
}
