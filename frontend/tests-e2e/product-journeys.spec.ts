import { expect, test } from '@playwright/test';

function serverBaseUrl(): string {
  const baseUrl = process.env.VIBEX_E2E_BASE_URL;
  if (!baseUrl) throw new Error('Web E2E server was not started');
  return baseUrl;
}

test('composer keeps native multiline caret flow and clears immediately on submit', async ({
  page,
}) => {
  await page.goto(`${serverBaseUrl()}/e2e/agent-e/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const composer = page.getByRole('combobox', { name: '消息' });
  await composer.click();
  await composer.pressSequentially('first line');
  await composer.press('Shift+Enter');
  await composer.pressSequentially('second line');

  await expect(composer).toHaveText(/first line\s+second line/);

  await composer.press('Enter');
  await expect(composer).toBeEmpty();
});

test('two agent mentions create durable completed and cancelled delegation cards', async ({
  page,
}) => {
  await page.goto(`${serverBaseUrl()}/e2e/agent-e/index.html`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const composer = page.getByRole('textbox');
  await composer.click();
  await composer.pressSequentially('Ask &Co');
  await page.getByRole('option', { name: /Codex/ }).click();
  await composer.pressSequentially(' and &Cl');
  await page.getByRole('option', { name: /Claude Code/ }).click();
  await expect(page.getByText('运行中')).toHaveCount(0);

  await page.getByRole('button', { name: 'Send to parent' }).click();
  await expect(page.getByText('已完成')).toBeVisible();
  await expect(page.getByText('已取消')).toBeVisible();
  await page.getByRole('button', { name: '查看会话' }).nth(1).click();
  await expect(
    page.getByRole('region', { name: 'Child conversation' })
  ).toContainText('fixture-child-2');

  await page.reload();
  await expect(page.getByText('已完成')).toBeVisible();
  await expect(page.getByText('已取消')).toBeVisible();
});

test('Office Automation reaches a real Turn terminal and Artifact evidence', async ({
  page,
}) => {
  await page.goto(`${serverBaseUrl()}/e2e/agent-g/index.html`);
  await page.getByRole('button', { name: '新建自动化' }).click();
  await page.getByRole('textbox', { name: '名称' }).fill('Office 周报');
  const composer = page.getByRole('textbox', { name: '消息' });
  await composer.click();
  await composer.pressSequentially(
    '汇总本周进展，创建一份可编辑的管理层 PPT。'
  );
  await page.getByRole('button', { name: '创建 PPT' }).click();
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByRole('button', { name: '运行 Office 周报' }).click();

  await expect(page.getByText('已完成')).toBeVisible();
  const evidence = page.getByRole('region', {
    name: 'Fake backend scenarios',
  });
  await expect(evidence).toContainText('worktree-run-1');
  await expect(evidence).toContainText('conversation-office-1 / turn-office-1');
  await expect(evidence).toContainText('weekly-review.pptx');

  await page.getByRole('button', { name: 'Dirty shared root' }).click();
  await page.getByRole('button', { name: '运行 Office 周报' }).click();
  await expect(
    page.getByText('Shared root has uncommitted changes')
  ).toBeVisible();
});

test('Web Turn permission, reconnect, and opaque Office preview stay transport-driven', async ({
  page,
}) => {
  await page.goto(`${serverBaseUrl()}/e2e/agent-j/index.html`);
  await page.getByRole('button', { name: 'Start Turn' }).click();
  await expect(
    page.getByText('Agent stream: preparing an editable Office briefing…')
  ).toBeVisible();
  await page.getByRole('button', { name: 'Allow once' }).click();
  await expect(page.getByText('已响应')).toBeVisible();

  await page.getByRole('button', { name: 'Reconnect stream' }).click();
  await expect(page.getByRole('status')).toHaveText('ready at sequence 6');

  await page.getByRole('button', { name: /打开 briefing\.pptx 预览/ }).click();
  const preview = page.getByTitle('briefing.pptx 预览');
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute(
    'sandbox',
    'allow-scripts allow-popups allow-forms'
  );
  await expect(preview).toHaveAttribute(
    'src',
    '/api/v1/previews/lease-web-1/c/short-preview-cap/'
  );
  expect(page.url()).not.toContain('short-preview-cap');
});
