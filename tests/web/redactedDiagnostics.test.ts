import { describe, expect, it } from 'vitest';
import { createRedactedDiagnostics } from '../../apps/web/src/features/diagnostics/redactedDiagnostics';

describe('redacted Web diagnostics', () => {
  it('keeps only provider host, stage and error code fields', () => {
    const diagnostics = createRedactedDiagnostics({
      generatedAt: '2026-07-28T00:00:00.000Z',
      locale: 'zh-CN',
      userAgent: 'Browser/1',
      versions: {
        app: '0.1.0',
        core: '0.8.1',
        model: 'models-v1',
        configSchema: 1,
      },
      device: {
        platform: 'desktop-chromium',
        supportLevel: 'desktop',
        mobile: false,
        initialWorkPixelBudget: 8_000_000,
        maxFileBytes: 32 * 1024 * 1024,
      },
      capability: {
        ok: true,
        supportLevel: 'desktop',
        backend: 'webgpu',
        workPixelBudget: 8_000_000,
        storagePersistent: true,
        wasmThreads: true,
        webgpu: true,
      },
      modelPackage: {
        status: 'installed',
        storedBytes: 1,
        totalBytes: 1,
      },
      jobs: [{
        status: 'failed',
        progress: { stage: 'translate' },
        errorCode: 'PIPELINE_STAGE_FAILED',
      }],
      provider: {
        id: 'custom',
        baseUrl: 'https://user:secret@provider.example/v1/chat?api_key=leak',
        configurationValid: false,
      },
      lifecycle: {
        online: true,
        offlineReady: true,
        updateReady: false,
        visibilityState: 'visible',
      },
      storage: { usage: 12, quota: 34 },
    });

    const serialized = JSON.stringify(diagnostics);
    expect(diagnostics).toMatchObject({
      provider: {
        id: 'custom',
        host: 'provider.example',
        configurationValid: false,
      },
      taskSummary: {
        statuses: { failed: 1 },
        activeStages: { translate: 1 },
      errorCodes: { PIPELINE_STAGE_FAILED: 1 },
      },
    });
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('/v1/chat');
  });

  it('does not copy raw errors that are not stable diagnostic codes', () => {
    const base = {
      generatedAt: '2026-07-28T00:00:00.000Z',
      locale: 'zh-CN' as const,
      userAgent: 'Browser/1',
      versions: { app: '1', core: '1', model: '1', configSchema: 1 },
      device: {
        platform: 'desktop-chromium' as const,
        supportLevel: 'desktop' as const,
        mobile: false,
        initialWorkPixelBudget: 1,
        maxFileBytes: 1,
      },
      capability: null,
      modelPackage: { status: 'missing' as const, storedBytes: 0, totalBytes: 1 },
      provider: {
        id: 'openai' as const,
        baseUrl: 'https://api.openai.com',
        configurationValid: true,
      },
      lifecycle: {
        online: true,
        offlineReady: false,
        updateReady: false,
        visibilityState: 'visible' as const,
      },
    };
    const diagnostics = createRedactedDiagnostics({
      ...base,
      jobs: [{ status: 'failed', errorCode: 'sk-secret raw provider response' }],
    });
    expect(diagnostics).toMatchObject({
      taskSummary: { errorCodes: { UNCLASSIFIED: 1 } },
    });
    expect(JSON.stringify(diagnostics)).not.toContain('sk-secret');
  });
});
