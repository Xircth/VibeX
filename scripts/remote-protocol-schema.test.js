const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('remote protocol schema and generated language fixtures are current', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/remote-protocol-schema.js', '--check', '--skip-compile'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('generated client object fields conform to the versioned schema', () => {
  const protocolRoot = path.join(process.cwd(), 'docs', 'protocol', 'v1');
  const schema = JSON.parse(fs.readFileSync(path.join(protocolRoot, 'schema.json')));
  const generated = [
    fs.readFileSync(
      path.join(protocolRoot, 'generated', 'typescript', 'RemoteProtocolModels.ts'),
      'utf8',
    ),
    fs.readFileSync(
      path.join(protocolRoot, 'generated', 'swift', 'RemoteProtocolModels.swift'),
      'utf8',
    ),
    fs.readFileSync(
      path.join(protocolRoot, 'generated', 'kotlin', 'RemoteProtocolModels.kt'),
      'utf8',
    ),
  ];

  for (const [name, definition] of Object.entries(schema.$defs)) {
    for (const output of generated) {
      assert.match(output, new RegExp(`\\b${name}\\b`), `${name} is missing`);
    }
    if (
      definition.type === 'object' &&
      definition.properties &&
      !definition.oneOf &&
      !definition.anyOf
    ) {
      for (const field of Object.keys(definition.properties)) {
        for (const output of generated) {
          assert.match(
            output,
            new RegExp(`\\b${field}\\b`),
            `${name}.${field} is missing`,
          );
        }
      }
    }
  }
});
