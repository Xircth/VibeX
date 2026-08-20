const assert = require('node:assert/strict');
const test = require('node:test');

const { parseArgs, run } = require('./control');

test('parses a stable resource action and flag contract', () => {
  assert.deepEqual(
    parseArgs([
      'workflow',
      'resume',
      '--run',
      'run-1',
      '--decision',
      'retry',
      '--step',
      'build',
      '--json',
    ]),
    {
      resource: 'workflow',
      action: 'resume',
      flags: {
        run: 'run-1',
        decision: 'retry',
        step: 'build',
        json: true,
      },
    }
  );
});

test('rejects positional ambiguity', () => {
  assert.throws(
    () => parseArgs(['conversation', 'send', 'unexpected']),
    /Unexpected argument/
  );
});

test('parses project and git coding-loop commands', () => {
  assert.deepEqual(
    parseArgs(['project', 'create', '--name', 'demo', '--path', '/repo']),
    {
      resource: 'project',
      action: 'create',
      flags: { name: 'demo', path: '/repo' },
    }
  );
  assert.deepEqual(
    parseArgs([
      'git',
      'commit',
      '--workspace',
      'ws',
      '--repo',
      'repo',
      '--message',
      'save',
    ]),
    {
      resource: 'git',
      action: 'commit',
      flags: { workspace: 'ws', repo: 'repo', message: 'save' },
    }
  );
});

test('conversation help prints usage instead of calling the host', async () => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await run(['conversation', 'help']);
  } finally {
    process.stdout.write = original;
  }
  assert.match(chunks.join(''), /vibex conversation/);
});
