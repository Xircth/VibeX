const { test } = require('@playwright/test');

test('capture blank page diagnostics', async ({ page }) => {
  const logs = [];

  page.on('console', (msg) => {
    logs.push({ type: msg.type(), text: msg.text() });
  });

  page.on('pageerror', (err) => {
    logs.push({ type: 'pageerror', text: err.stack || err.message });
  });

  page.on('requestfailed', (req) => {
    logs.push({
      type: 'requestfailed',
      text: `${req.method()} ${req.url()} -> ${req.failure()?.errorText ?? ''}`,
    });
  });

  await page.goto('http://127.0.0.1:3000/', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });

  const payload = {
    title: await page.title(),
    url: page.url(),
    bodyText: await page.locator('body').innerText(),
    rootHtml: await page.locator('#root').innerHTML(),
    logs,
  };

  console.log(JSON.stringify(payload, null, 2));
});
