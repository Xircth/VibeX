import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (err) => console.log('PAGE EXCEPTION:', String(err).slice(0, 400)));
page.on('console', (msg) => { if (msg.type() === 'error') console.log('PAGE ERROR:', msg.text().slice(0, 250)); });

await page.goto('http://127.0.0.1:3101/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(1500);
const tokenInput = page.locator('input[type="password"]');
if (await tokenInput.count()) {
  await tokenInput.fill('vibex-production-repro-token-0000000001');
  await page.getByRole('button', { name: /connect/i }).click();
  await page.waitForTimeout(8000);
}
await page.evaluate(() => {
  window.history.pushState({}, '', '/settings/agents');
  window.dispatchEvent(new PopStateEvent('popstate'));
});
await page.waitForTimeout(6000);
console.log('URL:', page.url());
console.log('body:', (await page.evaluate(() => document.body.innerText.slice(0, 250))).replace(/\n+/g, ' | '));
// Look for registry / plus button
const plus = page.getByRole('button', { name: /add|plus|注册表|添加/i }).first();
console.log('plus count:', await page.getByRole('button', { name: /add|plus|registry/i }).count());
const btns = await page.locator('button').allInnerTexts();
console.log('buttons:', btns.filter(Boolean).slice(0, 30).join(' | '));
await page.screenshot({ path: '/tmp/settings-agents2.png', fullPage: false });
await browser.close();
