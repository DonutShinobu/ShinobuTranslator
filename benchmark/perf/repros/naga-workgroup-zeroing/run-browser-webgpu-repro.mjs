import { createServer } from 'node:http';
import { chromium, firefox } from '@playwright/test';

const page = `<!doctype html>
<meta charset="utf-8">
<title>WebGPU workgroup initialization repro</title>`;

const shader = `
var<workgroup> inp: array<array<array<vec4<f32>, 18>, 18>, 4>;

@compute @workgroup_size(16, 16)
fn main() {
  _ = inp[0][0][0];
}
`;

const warmupShader = `
@compute @workgroup_size(1)
fn main() {}
`;

const requestedBrowser = process.argv
  .find((argument) => argument.startsWith('--browser='))
  ?.slice('--browser='.length) ?? 'both';

if (!['both', 'chromium', 'firefox'].includes(requestedBrowser)) {
  throw new Error(`Unsupported browser: ${requestedBrowser}`);
}

const server = createServer((_request, response) => {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(page);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Could not resolve benchmark server address');
}

const targets = requestedBrowser === 'both'
  ? [
      { name: 'chromium', type: chromium },
      { name: 'firefox', type: firefox },
    ]
  : [{ name: requestedBrowser, type: requestedBrowser === 'firefox' ? firefox : chromium }];

const results = [];

try {
  for (const target of targets) {
    const browser = await target.type.launch({
      executablePath: target.type.executablePath(),
      headless: false,
      args: target.name === 'chromium' ? ['--enable-unsafe-webgpu'] : [],
    });

    try {
      const browserPage = await browser.newPage();
      await browserPage.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
      const result = await browserPage.evaluate(async ({ shaderSource, warmupShaderSource }) => {
        if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('WebGPU adapter is unavailable');
        const requiredWorkgroupStorageSize = 4 * 18 * 18 * 4 * Float32Array.BYTES_PER_ELEMENT;
        if (adapter.limits.maxComputeWorkgroupStorageSize < requiredWorkgroupStorageSize) {
          throw new Error(
            `Adapter workgroup storage limit ${adapter.limits.maxComputeWorkgroupStorageSize}`
              + ` is below the required ${requiredWorkgroupStorageSize}`,
          );
        }
        const device = await adapter.requestDevice({
          requiredLimits: {
            maxComputeWorkgroupStorageSize: requiredWorkgroupStorageSize,
          },
        });
        try {
          const warmupModule = device.createShaderModule({ code: warmupShaderSource });
          const warmupStartedAt = performance.now();
          await device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module: warmupModule, entryPoint: 'main' },
          });
          const warmupMilliseconds = performance.now() - warmupStartedAt;

          const moduleStartedAt = performance.now();
          const module = device.createShaderModule({ code: shaderSource });
          const moduleMilliseconds = performance.now() - moduleStartedAt;
          const compilationInfo = await module.getCompilationInfo();
          const errors = compilationInfo.messages.filter((message) => message.type === 'error');
          if (errors.length > 0) {
            throw new Error(errors.map((error) => error.message).join('\n'));
          }

          const pipelineStartedAt = performance.now();
          await device.createComputePipelineAsync({
            layout: 'auto',
            compute: { module, entryPoint: 'main' },
          });
          const pipelineMilliseconds = performance.now() - pipelineStartedAt;

          return {
            adapter: {
              vendor: adapter.info?.vendor ?? null,
              architecture: adapter.info?.architecture ?? null,
              device: adapter.info?.device ?? null,
              description: adapter.info?.description ?? null,
            },
            warmupMilliseconds,
            moduleMilliseconds,
            pipelineMilliseconds,
          };
        }
        finally {
          device.destroy();
        }
      }, { shaderSource: shader, warmupShaderSource: warmupShader });

      results.push({
        browser: target.name,
        executable: target.type.executablePath(),
        ...result,
      });
    }
    finally {
      await browser.close();
    }
  }
}
finally {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

console.log(JSON.stringify(results, null, 2));
