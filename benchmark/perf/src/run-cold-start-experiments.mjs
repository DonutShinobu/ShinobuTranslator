// Throwaway A/B experiments against the built extension; always restores its Worker.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '../../..');
const out = resolve(root, '.tmp/cold-start-experiments');
mkdirSync(out, { recursive: true });
const arg = (name, fallback) => process.argv.find(x => x.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;
const variants = arg('variants', 'baseline,dispatch1,threads1,async4,async16').split(',');
const rounds = Number(arg('rounds', '1'));
if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds must be a positive integer');
const workerPath = resolve(root, 'apps/extension/dist-chromium/onnxWorker.js');
const original = readFileSync(workerPath, 'utf8');
const probe = readFileSync(resolve(import.meta.dirname, 'cold-start-worker-probe.js'), 'utf8');
const results = [];
let expectedImageHash;
const stamp = Date.now();
const replaceOnce = (source, old, replacement) => {
  if (source.split(old).length !== 2) throw new Error(`Expected one occurrence: ${old}`);
  return source.replace(old, replacement);
};
try {
  for (let round = 0; round < rounds; round++) {
    for (const variant of round % 2 ? [...variants].reverse() : variants) {
      let source = original;
      const probePort = 19000 + Math.floor(Math.random() * 10000);
      const config = { capture: variant === 'capture', probeUrl: `http://127.0.0.1:${probePort}/worker-probe` };
      if (variant.startsWith('dispatch')) {
        const count = Number(variant.slice(8));
        if (!Number.isInteger(count) || count < 1) throw new Error(`Invalid dispatch count: ${variant}`);
        source = replaceOnce(source, 'maxDispatchNumber=16', `maxDispatchNumber=${count}`);
      }
      else if (variant === 'threads1') source = replaceOnce(source, '.wasm.numThreads=s,', '.wasm.numThreads=1,');
      else if (variant.startsWith('async')) {
        config.shaders = JSON.parse(readFileSync(resolve(out, 'shaders.json'), 'utf8'));
        const mode = /^async(\d+)(overlap)?$/.exec(variant);
        if (!mode) throw new Error(`Invalid async variant: ${variant}`);
        config.concurrency = Number(mode[1]);
        if (config.concurrency < 1) throw new Error('Concurrency must be positive');
        config.overlap = Boolean(mode[2]);
      } else if (!['baseline', 'capture'].includes(variant)) throw new Error(`Unknown variant ${variant}`);
      if (variant === 'capture' || variant.startsWith('async')) source = `globalThis.__coldStartExperiment=${JSON.stringify(config)};\n${probe}\n${source}`;
      writeFileSync(workerPath, source);
      console.log(`Starting ${variant}, round ${round + 1}`);
      const run = spawnSync(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'),
        'benchmark/perf/src/run-browser-ui-jank-smoke.ts', '--runs=2', `--probe-port=${probePort}`,
        ...(arg('image', '') ? [`--image=${arg('image', '')}`] : []),
        ...(process.argv.includes('--trace') ? ['--trace'] : [])], {
        cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024,
      });
      const log = (run.stdout ?? '') + (run.stderr ?? '');
      writeFileSync(resolve(out, `${stamp}-${variant}-${round}.log`), log);
      if (run.status !== 0) throw new Error(`${variant} failed: ${run.error ?? log.slice(-2000)}`);
      const reports = [...log.matchAll(/^report=(.+)$/gm)].map(match => match[1].trim());
      for (const [runIndex, path] of reports.entries()) {
        const report = JSON.parse(readFileSync(path, 'utf8'));
        if (report.workerProbeRecords.some(x=>x.kind === 'precompile-error')) throw new Error('Asynchronous precompile failed');
        expectedImageHash ??= report.resultImage.sha256;
        if (report.resultImage.sha256 !== expectedImageHash) throw new Error(`Result pixels changed: ${variant}, ${path}`);
        if (variant === 'capture' && runIndex === 0) {
          const shaders = [...new Map(report.workerProbeRecords.filter(x=>x.kind === 'shader')
            .map(x=>[JSON.stringify([x.code,x.entryPoint,x.constants]),x])).values()];
          if (!shaders.length || shaders.some(x=>!x.code)) throw new Error('No valid shaders captured');
          writeFileSync(resolve(out, 'shaders.json'), JSON.stringify(shaders));
        }
        const row = { variant, round, runIndex, image:report.image, totalMs:report.jank.totalMs,
          frame:report.jank.frame, worker:report.jank.workerHeartbeat,
          stages:report.jank.stages, system:report.system,
          precompile: report.workerProbeRecords?.filter(x=>x.kind === 'precompile'), report:path,
          resultImage:report.resultImage,
          trace:log.match(/^trace=(.+)$/m)?.[1].trim() };
        results.push(row);
        console.log(JSON.stringify({ variant, round, runIndex, ms:row.totalMs,
          workerMax:row.worker.maxDeltaMs, workerOver50:row.worker.over50Count, precompile:row.precompile }));
      }
      writeFileSync(resolve(out, `${stamp}-results.json`), JSON.stringify({
        workerSha256:createHash('sha256').update(original).digest('hex'), results,
      }, null, 2));
    }
  }
} finally {
  writeFileSync(workerPath, original);
}
console.log(`results=${resolve(out, `${stamp}-results.json`)}`);
