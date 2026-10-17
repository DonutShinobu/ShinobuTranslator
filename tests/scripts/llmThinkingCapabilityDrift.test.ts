import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { registry } = vi.hoisted(() => ({
  registry: {} as Record<string, { levels: string[]; defaultLevel: string }>,
}));

vi.mock('@shinobu/text-translation', () => ({ llmThinkingCapabilityRegistry: registry }));

const originalExitCode = process.exitCode;
const proKey = 'doubao/doubao-seed-2-1-pro-260915';
const liteKey = 'doubao/doubao-seed-2-1-lite-260915';

beforeEach(() => {
  vi.resetModules();
  process.exitCode = 0;
  for (const key of Object.keys(registry)) delete registry[key];
  for (const key of [proKey, liteKey]) {
    registry[key] = { levels: ['off', 'low', 'medium', 'high'], defaultLevel: 'off' };
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LLM thinking capability drift', () => {
  it('uses the official snapshot only for the two missing Doubao IDs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ volcengine: { models: {} } })));

    await import('../../scripts/check-llm-thinking-capability-drift');

    expect(process.exitCode).toBe(0);
    expect(console.warn).toHaveBeenCalledTimes(2);
    for (const key of [proKey, liteKey]) {
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(key));
    }
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('https://docs.volcengine.com/docs/ark/deep-thinking?lang=en'));
    expect(console.error).not.toHaveBeenCalled();
  });

  it('prefers remote data and fails when it conflicts with the official snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      volcengine: {
        models: {
          'doubao-seed-2-1-pro-260915': {
            reasoning_options: [{ type: 'effort', values: ['low'] }],
          },
        },
      },
    })));

    await import('../../scripts/check-llm-thinking-capability-drift');

    expect(process.exitCode).toBe(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(liteKey));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`${proKey}: reasoning_options 已变化`));
  });

  it('still fails for every other missing model', async () => {
    registry['doubao/doubao-unknown'] = registry[proKey];
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ volcengine: { models: {} } })));

    await import('../../scripts/check-llm-thinking-capability-drift');

    expect(process.exitCode).toBe(1);
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('doubao/doubao-unknown: models.dev 缺少对应模型'));
  });
});
