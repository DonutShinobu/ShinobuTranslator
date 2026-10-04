import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.', testMatch: 'layerEditor.spec.ts', timeout: 30000, workers: 1,
  outputDir: '../../.tmp/layer-editor-results', reporter: 'line',
  use: { baseURL: 'http://127.0.0.1:4178', viewport: { width: 1200, height: 800 } },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'firefox', use: { browserName: 'firefox' } }],
  webServer: { command: 'node layerEditorServer.mjs', url: 'http://127.0.0.1:4178', reuseExistingServer: false },
});
