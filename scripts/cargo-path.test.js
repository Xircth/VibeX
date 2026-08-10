const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { withNativeBuildEnv } = require('./cargo-path');

test(
  'native build env discovers Visual Studio CMake and Ninja on Windows',
  { skip: process.platform !== 'win32' },
  () => {
    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'vibex-native-build-env-')
    );
    const visualStudioRoot = path.join(
      temporaryRoot,
      'Microsoft Visual Studio',
      '18',
      'BuildTools',
      'Common7',
      'IDE',
      'CommonExtensions',
      'Microsoft',
      'CMake'
    );
    const cmakeBin = path.join(visualStudioRoot, 'CMake', 'bin');
    const ninjaBin = path.join(visualStudioRoot, 'Ninja');

    try {
      fs.mkdirSync(cmakeBin, { recursive: true });
      fs.mkdirSync(ninjaBin, { recursive: true });
      fs.writeFileSync(path.join(cmakeBin, 'cmake.exe'), '');
      fs.writeFileSync(path.join(ninjaBin, 'ninja.exe'), '');

      const env = withNativeBuildEnv({
        PATH: 'C:\\existing',
        ProgramFiles: temporaryRoot,
        'ProgramFiles(x86)': temporaryRoot,
      });
      const entries = env.PATH.split(path.delimiter).map((entry) =>
        path.resolve(entry).toLowerCase()
      );

      assert.equal(
        entries.includes(path.resolve(cmakeBin).toLowerCase()),
        true
      );
      assert.equal(
        entries.includes(path.resolve(ninjaBin).toLowerCase()),
        true
      );
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
);
