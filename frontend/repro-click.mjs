import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
// Print the agent bar buttons and find 'Codex'
const barButtons = await page.locator('.agent-bar button, nav button, [class*="agent" i] button').allInnerTexts().catch(() => []);
console.log('agent-ish buttons:', barButtons.filter(b => b.trim()).slice(0, 40).join(' | '));
await page.screenshot({ path: '/tmp/settings-agents3.png' });
await browser.close();
