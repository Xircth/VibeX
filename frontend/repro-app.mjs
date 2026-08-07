import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (err) => console.log('PAGE EXCEPTION:', String(err).slice(0, 300)));

await page.goto('http://127.0.0.1:3101/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(1500);
const tokenInput = page.locator('input[type="password"]');
if (await tokenInput.count()) {
  await tokenInput.fill('vibex-production-repro-token-0000000001');
  await page.getByRole('button', { name: /connect/i }).click();
  await page.waitForTimeout(8000);
}
// Client-side navigate to settings/agents
await page.evaluate(() => {
  window.history.pushState({}, '', '/settings/agents');
  window.dispatchEvent(new PopStateEvent('popstate'));
});
await page.waitForTimeout(8000);
console.log('settings URL:', page.url());
console.log('settings body:', (await page.evaluate(() => document.body.innerText.slice(0, 300))).replace(/\n+/g, ' | '));
console.log('astryx triggers:', await page.locator('.astryx-select-trigger').count());
console.log('selects:', await page.locator('select').count());
await page.screenshot({ path: '/tmp/settings-agents.png' });
await browser.close();
