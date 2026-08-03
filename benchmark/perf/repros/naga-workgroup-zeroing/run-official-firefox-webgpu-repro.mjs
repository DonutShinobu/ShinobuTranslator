import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executable = process.argv
  .find((argument) => argument.startsWith('--executable='))
  ?.slice('--executable='.length);

if (!executable) {
  throw new Error('Pass the Firefox executable with --executable=<path>');
}

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

const page = `<!doctype html>
<meta charset="utf-8">
<title>Official Firefox WebGPU workgroup initialization repro</title>
<pre id="result">Running…</pre>
<script>
const shader = ${JSON.stringify(shader)};
const warmupShader = ${JSON.stringify(warmupShader)};

async function run() {
  const requiredWorkgroupStorageSize = 4 * 18 * 18 * 4 * Float32Array.BYTES_PER_ELEMENT;
  if (!navigator.gpu) throw new Error('navigator.gpu is unavailable');
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter is unavailable');
  const device = await adapter.requestDevice({
    requiredLimits: { maxComputeWorkgroupStorageSize: requiredWorkgroupStorageSize },
  });
  try {
    const warmupModule = device.createShaderModule({ code: warmupShader });
    const warmupStartedAt = performance.now();
    await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: warmupModule, entryPoint: 'main' },
    });
    const warmupMilliseconds = performance.now() - warmupStartedAt;

    const module = device.createShaderModule({ code: shader });
    const compilationInfo = await module.getCompilationInfo();
    const errors = compilationInfo.messages.filter((message) => message.type === 'error');
    if (errors.length > 0) throw new Error(errors.map((error) => error.message).join('\\n'));

    const pipelineStartedAt = performance.now();
    await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
    return {
      ok: true,
      userAgent: navigator.userAgent,
      warmupMilliseconds,
      pipelineMilliseconds: performance.now() - pipelineStartedAt,
    };
  }
  finally {
    device.destroy();
  }
}

(async () => {
  let result;
  try {
    result = await run();
  }
  catch (error) {
    result = { ok: false, error: error instanceof Error ? error.stack : String(error) };
  }
  document.querySelector('#result').textContent = JSON.stringify(result, null, 2);
  await fetch('/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  });
})();
</script>`;

let finishResult;
let failResult;
const resultPromise = new Promise((resolve, reject) => {
  finishResult = resolve;
  failResult = reject;
});

const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/result') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(204);
        response.end();
        finishResult(result);
      }
      catch (error) {
        response.writeHead(400);
        response.end();
        failResult(error);
      }
    });
    return;
  }

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

const profileDirectory = mkdtempSync(join(tmpdir(), 'shinobu-official-firefox-repro-'));
const firefox = spawn(executable, [
  '-no-remote',
  '-new-instance',
  '-profile', profileDirectory,
  `http://127.0.0.1:${address.port}/`,
], { stdio: 'ignore' });

const timeout = setTimeout(() => {
  failResult(new Error('Timed out waiting for Firefox WebGPU result'));
}, 60_000);

async function terminateFirefox() {
  if (process.platform === 'win32') {
    const stopByProfile = spawn(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name = 'firefox.exe'\""
          + " | Where-Object { $_.CommandLine -like ('*' + $env:SHINOBU_FIREFOX_REPRO_PROFILE + '*') }"
          + ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
      ],
      {
        stdio: 'ignore',
        env: {
          ...process.env,
          SHINOBU_FIREFOX_REPRO_PROFILE: profileDirectory,
        },
      },
    );
    await new Promise((resolve) => stopByProfile.once('exit', resolve));
    return;
  }
  if (firefox.exitCode !== null || !firefox.pid) return;
  firefox.kill('SIGTERM');
  await new Promise((resolve) => firefox.once('exit', resolve));
}

async function removeProfileDirectory() {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(profileDirectory, { recursive: true, force: true });
      return;
    }
    catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
}

try {
  const result = await resultPromise;
  console.log(JSON.stringify({ executable, ...result }, null, 2));
}
finally {
  clearTimeout(timeout);
  await terminateFirefox();
  await new Promise((resolve) => server.close(resolve));
  await removeProfileDirectory();
}
