import { expect, test } from '@playwright/test';

test('production Web UI authenticates and exposes only Server capabilities', async ({
  page,
}) => {
  const baseUrl = process.env.VIBEX_E2E_BASE_URL;
  const token = process.env.VIBEX_E2E_TOKEN;
  if (!baseUrl || !token) throw new Error('Web E2E server was not started');

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`${baseUrl}/settings/automations`);
  await expect(
    page.getByRole('form', { name: 'Connect to VibeX Server' })
  ).toBeVisible();
  await page.getByLabel('Server token').fill(token);
  await page.getByRole('button', { name: 'Connect' }).click();

  await expect(
    page.getByRole('heading', { name: /Automations|自动化/ })
  ).toBeVisible();
  await expect(
    page.getByText(/No flight plans yet|还没有运行计划/)
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Plugins|插件/ })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Devices|设备/ })
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Agents|智能体/ })).toHaveCount(
    0
  );
  await expect(
    page.getByRole('button', { name: /Web Service|Web 服务/ })
  ).toHaveCount(0);

  await page.getByRole('button', { name: /Plugins|插件/ }).click();
  await expect(
    page.getByRole('heading', { name: /Plugins|插件/ })
  ).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/plugins$/);

  await page.getByRole('button', { name: /Devices|设备/ }).click();
  await page
    .getByRole('button', { name: /Create device pairing|创建设备配对/ })
    .click();
  await expect(
    page.getByRole('img', { name: /Device pairing QR code|设备配对二维码/ })
  ).toBeVisible();
  await expect(page.getByText(/Shown once|仅显示一次/)).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/devices$/);
  await expect
    .poll(() => pageErrors, {
      message: 'the production UI emitted page errors',
    })
    .toEqual([]);

  expect(
    await page.evaluate(() => Object.values({ ...localStorage }))
  ).not.toContain(token);
  expect(page.url()).not.toContain(token);
});
