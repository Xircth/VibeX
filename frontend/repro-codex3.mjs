import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (err) => console.log('PAGE EXCEPTION:', String(err).slice(0, 300)));
await page.goto('http://127.0.0.1:3101/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
const ti = page.locator('input[type="password"]');
if (await ti.count()) {
  await ti.fill('vibex-production-repro-token-0000000001');
  await page.getByRole('button', { name: /connect/i }).click();
  await page.waitForTimeout(7000);
}
await page.evaluate(() => { window.history.pushState({}, '', '/settings/agents'); window.dispatchEvent(new PopStateEvent('popstate')); });
await page.waitForTimeout(5000);
console.log('bar items:', await page.locator('.agent-management-bar-item').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')).join(', ')));
await page.locator('.agent-management-bar-item[aria-label="Codex"]').click();
await page.waitForTimeout(6000);
console.log('body:', (await page.evaluate(() => document.body.innerText)).slice(0, 1200));
console.log('astryx triggers:', await page.locator('.astryx-select-trigger').count());
await browser.close();
