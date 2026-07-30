const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const test = require('node:test');
const { resolve } = require('node:path');

const PINNED_CODEG_COMMIT = '549add8d3ba07f31464c9cddde8ba7a7478eed14';
const ADOPTED_REMOTE_FILES = [
  'src/lib/transport/types.ts',
  'src/lib/transport/tauri-transport.ts',
  'src/lib/transport/remote-desktop-transport.ts',
  'src/lib/transport/web-event-stream.ts',
  'src/lib/transport/web-transport.ts',
  'src-tauri/src/web/router.rs',
  'src-tauri/src/web/event_bridge.rs',
];

function validateCodegAdoption({ adoption, notices, license }) {
  const missing = [];
  if (!adoption.includes(PINNED_CODEG_COMMIT)) {
    missing.push('pinned commit');
  }
  for (const source of ADOPTED_REMOTE_FILES) {
    if (!adoption.includes(source)) {
      missing.push(`source ${source}`);
    }
  }
  if (!/Codeg/.test(notices) || !/Apache License 2\.0/.test(notices)) {
    missing.push('Codeg Apache-2.0 notice');
  }
  if (!notices.includes(PINNED_CODEG_COMMIT)) {
    missing.push('notice pinned commit');
  }
  if (!/Apache License\s+Version 2\.0/.test(license)) {
    missing.push('Apache-2.0 license text');
  }
  assert.deepEqual(missing, []);
}

async function readAdoptionEvidence() {
  const [adoption, notices, license] = await Promise.all([
    readFile(
      resolve(__dirname, '../docs/third-party/codeg-adoption.md'),
      'utf8'
    ),
    readFile(resolve(__dirname, '../THIRD_PARTY_NOTICES.md'), 'utf8'),
    readFile(
      resolve(__dirname, '../docs/third-party/licenses/Apache-2.0.txt'),
      'utf8'
    ),
  ]);
  return { adoption, notices, license };
}

test('Codeg adoption record identifies the pinned remote transport sources', async () => {
  const evidence = await readAdoptionEvidence();

  validateCodegAdoption(evidence);
});

test('missing commit, source, notice, or license evidence fails the gate', async (t) => {
  const evidence = await readAdoptionEvidence();
  const cases = [
    ['commit', { ...evidence, adoption: evidence.adoption.replaceAll(PINNED_CODEG_COMMIT, '') }],
    [
      'source',
      {
        ...evidence,
        adoption: evidence.adoption.replace(ADOPTED_REMOTE_FILES[0], ''),
      },
    ],
    ['notice', { ...evidence, notices: '' }],
    ['license', { ...evidence, license: '' }],
  ];

  for (const [name, invalidEvidence] of cases) {
    await t.test(name, () => {
      assert.throws(() => validateCodegAdoption(invalidEvidence));
    });
  }
});
