const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { applyLocalEnvFile, parseLocalEnvFile } = require('./load-local-env');

test('parseLocalEnvFile ignores comments, export prefix, and quoted values', () => {
  const filePath = path.join(os.tmpdir(), `vibex-env-${process.pid}.env`);
  fs.writeFileSync(
    filePath,
    [
      '# comment',
      'APPLE_SIGNING_IDENTITY="Developer ID Application: Xing Mei (TEAMID)"',
      "APPLE_API_KEY='246J8NTMDP'",
      'export APPLE_API_ISSUER=049b85de-a721-4089-a58e-f236da9bc746',
      'NOT A KEY',
      '',
    ].join('\n')
  );

  try {
    assert.deepEqual(parseLocalEnvFile(filePath), {
      APPLE_SIGNING_IDENTITY: 'Developer ID Application: Xing Mei (TEAMID)',
      APPLE_API_KEY: '246J8NTMDP',
      APPLE_API_ISSUER: '049b85de-a721-4089-a58e-f236da9bc746',
    });
    assert.deepEqual(parseLocalEnvFile(`${filePath}.missing`), {});
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test('applyLocalEnvFile fills empty keys and leaves existing values alone', () => {
  const filePath = path.join(os.tmpdir(), `vibex-env-apply-${process.pid}.env`);
  fs.writeFileSync(
    filePath,
    ['APPLE_API_KEY=from-file', 'APPLE_API_ISSUER=from-file'].join('\n')
  );

  try {
    assert.deepEqual(
      applyLocalEnvFile(filePath, {
        APPLE_API_KEY: 'from-process',
        APPLE_API_ISSUER: '',
      }),
      {
        APPLE_API_KEY: 'from-process',
        APPLE_API_ISSUER: 'from-file',
      }
    );
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});
