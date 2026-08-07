import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('PAGE ERROR:', msg.text().slice(0, 300));
});
await page.goto('http://localhost:3001/settings/agents', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(6000);
console.log('URL:', page.url());
console.log('title:', await page.title());
const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 600) : 'NO BODY');
console.log('BODY:', body);
await browser.close();
