const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  applyDesktopDevIdentity,
  createCargoLeanDevEnv,
  DESKTOP_DEV_IDENTITY,
} = require('./run-tauri-dev-desktop');

test('desktop dev compiles SQLx queries from the prepared cache', () => {
  const env = createCargoLeanDevEnv({ frontend: 3000, backend: 3001 }, {});

  assert.equal(env.SQLX_OFFLINE, 'true');
  assert.equal(
    env.SQLX_OFFLINE_DIR,
    path.join(process.cwd(), 'crates', 'db', '.sqlx')
  );
});

test('desktop dev keeps an explicit signing identity from the process environment', () => {
  const env = createCargoLeanDevEnv(
    { frontend: 3000, backend: 3001 },
    {
      APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test (TEAMID)',
    }
  );

  assert.equal(
    env.APPLE_SIGNING_IDENTITY,
    'Developer ID Application: Test (TEAMID)'
  );
});

test('desktop dev uses a distinct app identity from the installed product', () => {
  const productConfigPath = path.join(
    __dirname,
    '..',
    'src-tauri',
    'tauri.conf.json'
  );
  const product = JSON.parse(fs.readFileSync(productConfigPath, 'utf8'));
  const generated = applyDesktopDevIdentity(product);

  assert.equal(product.identifier, 'com.vibex.app');
  assert.equal(product.productName, 'VibeX');
  assert.deepEqual(product.plugins['deep-link'].desktop.schemes, ['vibex']);
  assert.equal(generated.identifier, DESKTOP_DEV_IDENTITY.identifier);
  assert.equal(generated.productName, DESKTOP_DEV_IDENTITY.productName);
  assert.equal(generated.app.windows[0].title, DESKTOP_DEV_IDENTITY.productName);
  assert.deepEqual(generated.plugins['deep-link'].desktop.schemes, [
    DESKTOP_DEV_IDENTITY.deepLinkScheme,
  ]);
  assert.notEqual(generated.identifier, product.identifier);
  assert.equal(product.identifier, 'com.vibex.app');
});
