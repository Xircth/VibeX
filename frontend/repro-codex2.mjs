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
await page.locator('.agent-management-bar-item[aria-label="Codex"]').click();
await page.waitForTimeout(4000);
console.log('FULL BODY:');
console.log((await page.evaluate(() => document.body.innerText)).slice(0, 1500));
// Try clicking Install Runtime and ACP
const installBtns = page.getByRole('button', { name: /Install Runtime and ACP|安装/i });
console.log('install buttons:', await installBtns.count());
await browser.close();
