import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 3199);
const baseURL = `http://127.0.0.1:${port}`;

// Paths are relative to this file; reports live at the repository root, outside test/.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '../../test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list'], ['html', { outputFolder: '../../playwright-report', open: 'never' }]],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'node test/e2e/server.ts',
    cwd: '../..',
    url: `${baseURL}/health`,
    env: { E2E_PORT: String(port) },
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
