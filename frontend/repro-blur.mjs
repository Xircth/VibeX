import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const TOKEN = 'vibex-production-repro-token-0000000001';
const PORT = 3131;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(resolve(tmpdir(), 'vibex-blur-'));
const server = spawn(resolve('../target/debug/vibex-server'), [], {
  cwd: resolve('..'),
  env: { ...process.env, RUST_LOG: 'warn', VIBEX_DATA_DIR: dataDir, VIBEX_SERVER_LISTEN: `127.0.0.1:${PORT}`, VIBEX_SERVER_TOKEN: TOKEN, VIBEX_STATIC_ROOT: resolve('dist') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  if (server.exitCode !== null) throw new Error('server exited early');
  try { const r = await fetch(`${BASE}/api/v1/capabilities`, { headers: { authorization: `Bearer ${TOKEN}` } }); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 200));
}
try {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  const tokenInput = page.locator('input[type="password"]');
  if (await tokenInput.count()) {
    await tokenInput.fill(TOKEN);
    await page.getByRole('button', { name: /connect/i }).click();
    await page.waitForTimeout(7000);
  }
  await page.evaluate(() => { window.history.pushState({}, '', '/settings/general'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await page.waitForTimeout(5000);
  const sw = page.locator('.settings-page button[role="switch"]').first();
  await sw.click();
  await page.waitForTimeout(1200);

  // 基准(当前 Git 同款,弱 blur 5.28px)
  await page.locator('.settings-action-bar').screenshot({ path: '/tmp/blur-0.png' });

  // 实验:在 stage 上加强 backdrop-filter
  for (const [label, blur] of [['blur-12', 'blur(12px) saturate(1.4)'], ['blur-24', 'blur(24px) saturate(1.4)']]) {
    await page.evaluate((b) => {
      const stage = document.querySelector('.settings-action-bar__stage');
      stage.style.backdropFilter = b;
      stage.style.webkitBackdropFilter = b;
    }, blur);
    await page.waitForTimeout(300);
    await page.locator('.settings-action-bar').screenshot({ path: `/tmp/${label}.png` });
  }

  await browser.close();
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dataDir, { recursive: true, force: true });
}
