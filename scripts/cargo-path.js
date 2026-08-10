const fs = require('fs');
const path = require('path');

function getPathKey(env) {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
}

function resolveCargoBin(env) {
  if (env.CARGO_HOME) {
    return path.join(env.CARGO_HOME, 'bin');
  }

  const home = env.USERPROFILE || env.HOME;
  return home ? path.join(home, '.cargo', 'bin') : null;
}

function prependPathEntry(env, entry) {
  if (!entry || !fs.existsSync(entry)) {
    return env;
  }

  const pathKey = getPathKey(env);
  const currentPath = env[pathKey] || '';
  const normalizedEntry = path.resolve(entry).toLowerCase();
  const hasEntry = currentPath
    .split(path.delimiter)
    .filter(Boolean)
    .some((pathEntry) => path.resolve(pathEntry).toLowerCase() === normalizedEntry);

  if (hasEntry) {
    return env;
  }

  return {
    ...env,
    [pathKey]: `${entry}${path.delimiter}${currentPath}`,
  };
}

function withCargoBinOnPath(env = process.env) {
  return prependPathEntry(env, resolveCargoBin(env));
}

function resolveLibclangPath(env) {
  if (env.LIBCLANG_PATH) {
    return null;
  }

  const candidates =
    process.platform === 'win32'
      ? [
          path.join(env.ProgramFiles || 'C:\\Program Files', 'LLVM', 'bin'),
          path.join(
            env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
            'LLVM',
            'bin'
          ),
        ]
      : ['/usr/lib/llvm-18/lib', '/usr/lib/llvm-17/lib', '/usr/lib/llvm-16/lib'];

  return candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, process.platform === 'win32' ? 'libclang.dll' : 'libclang.so'))
  );
}

function resolveWixBin(env) {
  if (process.platform !== 'win32') {
    return null;
  }

  const candidates = [
    path.join(
      env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'WiX Toolset v3.14',
      'bin'
    ),
    path.join(
      env.ProgramFiles || 'C:\\Program Files',
      'WiX Toolset v3.14',
      'bin'
    ),
  ];

  return candidates.find(
    (candidate) =>
      fs.existsSync(path.join(candidate, 'candle.exe')) &&
      fs.existsSync(path.join(candidate, 'light.exe'))
  );
}

function listDirectories(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

function resolveVisualStudioCmakePaths(env) {
  if (process.platform !== 'win32') {
    return [];
  }

  const installationRoots = [];
  if (env.VSINSTALLDIR) {
    installationRoots.push(env.VSINSTALLDIR);
  }

  const programFilesRoots = [env['ProgramFiles(x86)'], env.ProgramFiles].filter(
    Boolean
  );
  for (const programFilesRoot of programFilesRoots) {
    const visualStudioRoot = path.join(
      programFilesRoot,
      'Microsoft Visual Studio'
    );
    const versions = listDirectories(visualStudioRoot).sort().reverse();
    for (const version of versions) {
      installationRoots.push(...listDirectories(version).sort().reverse());
    }
  }

  for (const installationRoot of installationRoots) {
    const cmakeRoot = path.join(
      installationRoot,
      'Common7',
      'IDE',
      'CommonExtensions',
      'Microsoft',
      'CMake'
    );
    const cmakeBin = path.join(cmakeRoot, 'CMake', 'bin');
    const ninjaBin = path.join(cmakeRoot, 'Ninja');
    if (
      fs.existsSync(path.join(cmakeBin, 'cmake.exe')) &&
      fs.existsSync(path.join(ninjaBin, 'ninja.exe'))
    ) {
      return [cmakeBin, ninjaBin];
    }
  }

  return [];
}

function resolveDatabaseUrl(env) {
  if (env.DATABASE_URL) {
    return null;
  }

  const devDatabase = path.join(process.cwd(), 'dev_assets', 'db.sqlite');
  return fs.existsSync(devDatabase) ? `sqlite://${devDatabase}` : null;
}

function withNativeBuildEnv(env = process.env) {
  let nextEnv = withCargoBinOnPath(env);
  const databaseUrl = resolveDatabaseUrl(nextEnv);

  if (databaseUrl) {
    nextEnv = {
      ...nextEnv,
      DATABASE_URL: databaseUrl,
    };
  }

  const libclangPath = resolveLibclangPath(nextEnv);

  if (libclangPath) {
    nextEnv = {
      ...prependPathEntry(nextEnv, libclangPath),
      LIBCLANG_PATH: libclangPath,
    };
  }

  nextEnv = prependPathEntry(nextEnv, resolveWixBin(nextEnv));
  for (const toolPath of resolveVisualStudioCmakePaths(nextEnv)) {
    nextEnv = prependPathEntry(nextEnv, toolPath);
  }

  return nextEnv;
}

module.exports = { withCargoBinOnPath, withNativeBuildEnv };
