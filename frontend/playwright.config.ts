import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests-e2e',
  outputDir: './test-results/web-production',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  globalSetup: './tests-e2e/webServer.setup.ts',
  reporter: [
    ['line'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    browserName: 'chromium',
    headless: true,
    screenshot: 'on',
    trace: 'retain-on-failure',
    video: 'on',
  },
});
