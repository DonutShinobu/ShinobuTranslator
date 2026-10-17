import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'geminiCookieLoop.spec.ts',
  globalSetup: './geminiCookieLoop.setup.ts',
  timeout: 30_000,
  workers: 1,
  retries: 0,
  outputDir: '../../.tmp/gemini-cookie-loop-results',
  reporter: 'line',
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
