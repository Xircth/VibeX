const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createCargoLeanDevEnv } = require('./run-tauri-dev-desktop');

test('desktop dev compiles SQLx queries from the prepared cache', () => {
  const env = createCargoLeanDevEnv({ frontend: 3000, backend: 3001 }, {});

  assert.equal(env.SQLX_OFFLINE, 'true');
  assert.equal(
    env.SQLX_OFFLINE_DIR,
    path.join(process.cwd(), 'crates', 'db', '.sqlx')
  );
});
