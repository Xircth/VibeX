import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('file:///tmp/astryx-repro/index-real.html');
await page.waitForTimeout(400);

// computed style of the menu before opening
const cs = await page.evaluate(() => {
  const m = document.getElementById('menu');
  const s = getComputedStyle(m);
  return { position: s.position, zIndex: s.zIndex, display: s.display };
});
console.log('menu computed style:', JSON.stringify(cs));

// scroll the content so the trigger is just above the bottom edge
await page.evaluate(() => {
  const box = document.querySelector('.settings-page section');
  const t = document.getElementById('trigger');
  box.scrollTop = t.offsetTop + t.offsetHeight - box.clientHeight - 10;
});
await page.waitForTimeout(150);
const info = await page.evaluate(() => {
  document.getElementById('trigger').click();
  return window.__info;
});
const after = await page.evaluate(() => window.__getInfo());
const tr = await page.evaluate(() => {
  const r = document.getElementById('trigger').getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, width: r.width };
});
console.log('calc:', JSON.stringify(info));
console.log('trigger:', JSON.stringify(tr));
console.log('menu:', JSON.stringify(after));
console.log(`menu.position=${after.position} (should be 'fixed')`);
console.log(`menu bottom vs trigger top: ${(tr.top - after.rectBottom).toFixed(1)}px gap above`);
console.log(`menu top vs viewport top: ${after.rectTop.toFixed(1)}px`);
await browser.close();
