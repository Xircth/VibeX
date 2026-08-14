const assert = require('node:assert/strict');
const test = require('node:test');

const { parseArgs } = require('./control');

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
