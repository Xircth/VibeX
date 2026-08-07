import { chromium } from '@playwright/test';
const browser = await chromium.launch();

// --- Test 1: CSS zoom on <html> ---
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('file:///tmp/astryx-repro/index.html');
  await page.waitForTimeout(200);
  await page.evaluate(() => { document.documentElement.style.zoom = '1.25'; });
  await page.waitForTimeout(200);
  // Scroll trigger-b to viewport bottom
  await page.evaluate(() => {
    const box = document.getElementById('scrollbox');
    const b = document.getElementById('trigger-b');
    const bb = b.getBoundingClientRect();
    box.scrollTop += bb.bottom - (window.innerHeight - 4);
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => document.getElementById('trigger-b').click());
  const info = await page.evaluate(() => window.__info);
  const m = await page.evaluate(() => {
    const r = document.querySelector('.astryx-select-menu').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  const t = await page.evaluate(() => {
    const r = document.getElementById('trigger-b').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  console.log('ZOOM 1.25 calc:', JSON.stringify(info));
  console.log(`ZOOM: trigger ${t.top.toFixed(0)}-${t.bottom.toFixed(0)}, menu ${m.top.toFixed(0)}-${m.bottom.toFixed(0)}, innerHeight=${await page.evaluate(() => window.innerHeight)}`);
  await page.close();
}

// --- Test 2: transform on the portal container ancestor ---
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto('file:///tmp/astryx-repro/index.html');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const scope = document.getElementById('scope');
    scope.style.transform = 'translateY(0)'; // creates containing block for fixed descendants
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const box = document.getElementById('scrollbox');
    const b = document.getElementById('trigger-b');
    box.scrollTop = b.offsetTop + b.offsetHeight - box.clientHeight - 2;
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => document.getElementById('trigger-b').click());
  const info = await page.evaluate(() => window.__info);
  const m = await page.evaluate(() => {
    const r = document.querySelector('.astryx-select-menu').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  const t = await page.evaluate(() => {
    const r = document.getElementById('trigger-b').getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  console.log('TRANSFORM calc:', JSON.stringify(info));
  console.log(`TRANSFORM: trigger ${t.top.toFixed(0)}-${t.bottom.toFixed(0)}, menu ${m.top.toFixed(0)}-${m.bottom.toFixed(0)}`);
  await page.close();
}

await browser.close();
