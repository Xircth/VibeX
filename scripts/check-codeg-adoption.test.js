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

test('Codeg adoption record identifies the pinned remote transport sources', async () => {
  const adoption = await readFile(
    resolve(__dirname, '../docs/third-party/codeg-adoption.md'),
    'utf8'
  );

  assert.match(adoption, new RegExp(PINNED_CODEG_COMMIT));
  for (const source of ADOPTED_REMOTE_FILES) {
    assert.match(adoption, new RegExp(source.replaceAll('.', '\\.')));
  }
});

test('Apache-2.0 notice and license remain present for Codeg adaptations', async () => {
  const [notices, license] = await Promise.all([
    readFile(resolve(__dirname, '../THIRD_PARTY_NOTICES.md'), 'utf8'),
    readFile(
      resolve(__dirname, '../docs/third-party/licenses/Apache-2.0.txt'),
      'utf8'
    ),
  ]);

  assert.match(notices, /Codeg/);
  assert.match(notices, /Apache License 2\.0/);
  assert.match(notices, new RegExp(PINNED_CODEG_COMMIT));
  assert.match(license, /Apache License\s+Version 2\.0/);
});
