import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '../../..');
const arg = (name, fallback) => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const variants = arg('variants', 'baseline,overlap,pixels,ctc,combined').split(',');
const rounds = Number(arg('rounds', '1'));
if (!Number.isInteger(rounds) || rounds < 1) throw new Error('Invalid rounds');
const dist = resolve(root, 'apps/extension/dist-chromium');
const scripts = [dist, join(dist, 'chunks')].flatMap(dir => readdirSync(dir)
  .filter(name => name.endsWith('.js')).map(name => join(dir, name)));
const originals = new Map(scripts.map(path => [path, readFileSync(path, 'utf8')]));
const manifestPath = join(dist, 'manifest.json');
const originalManifest = readFileSync(manifestPath, 'utf8');
const probe = readFileSync(resolve(import.meta.dirname, 'cold-start-worker-probe.js'), 'utf8');
const out = resolve(root, '.tmp/cold-budget');
mkdirSync(out, { recursive: true });
const stamp = Date.now();
const results = [];
const expectedHashes = new Map();
const candidateHashes = {};
const templateMetadata = {};
try {
  for (let round = 0; round < rounds; round++) {
    for (const variant of round % 2 ? [...variants].reverse() : variants) {
      const variantKey = createHash('sha256').update(variant).digest('hex').slice(0, 12);
      let flags = variant === 'combined' ? ['overlap', 'pixels', 'ctc']
        : variant.split('-').flatMap(x => x === 'all' ? ['overlap', 'pixels', 'ctc', 'shader', 'sessions', 'inpaint'] : [x]);
      if (flags.includes('nosessions')) flags = flags.filter(x => x !== 'sessions');
      if (flags.includes('fence')) flags = flags.filter(x => x !== 'nofence');
      if (flags.some(x => !['production', 'baseline', 'overlap', 'pixels', 'ctc', 'shader', 'sessions', 'inpaint', 'verify', 'direct', 'latefonts', 'binary', 'prefetch', 'nofence', 'reuse', 'directprep', 'verifydet', 'verifyinput', 'selectedfonts', 'offscreenpng', 'jsepjs', 'basic', 'deviceprobe', 'async8', 'dispatch64', 'nosessions', 'aftersubmit', 'adapteroverlap', 'workerpng', 'pngrgba', 'history4', 'fence', 'autolayout', 'hist', 'ctcseed', 'paneloverlap', 'fontblob', 'imgblob', 'maskpack', 'writeupload', 'threshold', 'preread', 'lateinpaint', 'downloadblob', 'displayinstant', 'readparallel', 'thresholdgpu'].includes(x))) throw new Error(`Unknown variant: ${variant}`);
      if (flags.includes('thresholdgpu') && !flags.includes('threshold')) throw new Error('thresholdgpu requires threshold');
      if (flags.includes('writeupload') && !flags.includes('jsepjs')) throw new Error('writeupload requires the isolated JSEP JS build');
      const production = flags.includes('production');
      const runtimePrefix = production ? '' : `globalThis.__shinobuColdStartModelPrefetch=${flags.includes('prefetch')};globalThis.__shinobuColdStartShaderTemplates=false;globalThis.__shinobuColdStartReuseShaderPipelines=false;\n`;
      const workerPath = join(dist, 'onnxWorker.js');
      let workerSource = originals.get(workerPath);
      if (flags.includes('jsepjs')) {
        const metadata = JSON.parse(readFileSync(resolve(root, '.tmp/cold-budget-jsepjs/metadata.json'), 'utf8'));
        if (flags.includes('writeupload') && !metadata.sourcePatches?.some(x => x.runtimeFlag === '__shinobuColdStartUploadWriteBuffer' && x.defaultEnabled === false)) throw new Error('Regenerate the guarded upload-write JSEP build');
        if (metadata.baselineWorker.sha256 !== createHash('sha256').update(workerSource).digest('hex')) throw new Error('Regenerate JS-only worker for current build');
        workerSource = readFileSync(metadata.candidateWorker.path, 'utf8');
        candidateHashes.jsepjs = createHash('sha256').update(workerSource).digest('hex');
        if (candidateHashes.jsepjs !== metadata.candidateWorker.sha256) throw new Error('JS-only candidate hash mismatch');
      }
      if (flags.includes('dispatch64')) {
        const declarations = ['maxDispatchNumber=16', '"maxDispatchNumber",16'];
        if (declarations.reduce((n, token) => n + workerSource.split(token).length - 1, 0) !== 1) throw new Error('Dispatch setting must occur exactly once');
        const token = declarations.find(token => workerSource.includes(token));
        workerSource = workerSource.replace(token, token.slice(0, -2) + '64');
      }
      candidateHashes[variant] = createHash('sha256').update(workerSource).digest('hex');
      const prefix = production ? '' : `globalThis.__shinobuColdStartOverlap=${flags.includes('overlap')};globalThis.__shinobuColdStartPixelFastPath=${flags.includes('pixels')};globalThis.__shinobuColdStartGpuCtc=${flags.includes('ctc')};globalThis.__shinobuColdStartEarlySessions=${flags.includes('sessions')};globalThis.__shinobuColdStartInpaintPixels=${flags.includes('inpaint')};globalThis.__shinobuColdStartGpuCtcVerify=${flags.includes('verify')};globalThis.__shinobuColdStartInpaintDirectPixels=${flags.includes('direct')};globalThis.__shinobuColdStartFontsAfterDetect=${flags.includes('latefonts')};globalThis.__shinobuColdStartStructuredClone=${flags.includes('binary')};globalThis.__shinobuColdStartGpuPreprocessNoFence=${flags.includes('nofence')};globalThis.__shinobuColdStartGpuPreprocessDirect=${flags.includes('directprep')};globalThis.__shinobuColdStartSelectedFonts=${flags.includes('selectedfonts')};globalThis.__shinobuColdStartOffscreenPng=${flags.includes('offscreenpng')};globalThis.__shinobuColdStartDetectorBasicOptimization=${flags.includes('basic')};globalThis.__shinobuColdStartSessionsAfterSubmit=${flags.includes('aftersubmit')};\n`;
      const hostPrefix = production ? '' : `globalThis.__shinobuColdStartWorkerPng=${flags.includes('workerpng')};globalThis.__shinobuColdStartWorkerPngRgba=${flags.includes('pngrgba')};globalThis.__shinobuColdStartMaskHistogram=${flags.includes('hist')};globalThis.__shinobuColdStartPanelOverlap=${flags.includes('paneloverlap')};globalThis.__shinobuColdStartFontBlobUrl=${flags.includes('fontblob')};globalThis.__shinobuColdStartImageBlobUrl=${flags.includes('imgblob')};globalThis.__shinobuColdStartMaskPacked=${flags.includes('maskpack')};globalThis.__shinobuColdStartMaskNativeThreshold=${flags.includes('threshold')};globalThis.__shinobuColdStartSourcePreRead=${flags.includes('preread')};globalThis.__shinobuColdStartEarlyInpaintAfterBubble=${flags.includes('lateinpaint')};globalThis.__shinobuColdStartDownloadBlob=${flags.includes('downloadblob')};globalThis.__shinobuColdStartMaskProfile=${process.argv.includes('--mask-profile')};\n`;
      const displayPrefix = production ? '' : `globalThis.__shinobuColdStartResultDisplayInstant=${flags.includes('displayinstant')};globalThis.__shinobuColdStartMaskNativeThresholdGpu=${flags.includes('thresholdgpu')};\n`;
      for (const [path, source] of originals) writeFileSync(path, displayPrefix + hostPrefix + runtimePrefix + prefix + source);
      writeFileSync(workerPath, runtimePrefix + prefix + workerSource);
      const manifest = JSON.parse(originalManifest);
      if (flags.includes('binary')) manifest.message_serialization = 'structured_clone';
      if (!production && !flags.includes('binary')) delete manifest.message_serialization;
      writeFileSync(manifestPath, production ? originalManifest : JSON.stringify(manifest, null, 2));
      const probePort = 19000 + Math.floor(Math.random() * 10000);
      if (process.argv.includes('--init-profile')) {
        const realmProbe = readFileSync(resolve(import.meta.dirname, 'cold-start-host-init-probe.js'), 'utf8');
        for (const entry of ['content.js', 'offscreen.js', 'background-chromium.js']) {
          const path = join(dist, entry);
          writeFileSync(path, `globalThis.__shinobuColdStartInitProbe={probeUrl:'http://127.0.0.1:${probePort}/worker-probe'};\n${realmProbe}\n${readFileSync(path, 'utf8')}`);
        }
      }
      if (process.argv.includes('--inpaint-profile')) {
        const offscreenPath = join(dist, 'offscreen.js');
        const hook = `globalThis.__shinobuColdStartInpaintProfile=true;const budgetLog=console.log.bind(console);console.log=(...args)=>{if(args[0]==='[shinobu:inpaint-profile]')fetch('http://127.0.0.1:${probePort}/worker-probe',{method:'POST',body:JSON.stringify({kind:'inpaint-profile',...JSON.parse(args[1])})}).catch(()=>{});budgetLog(...args)};\n`;
        writeFileSync(offscreenPath, hook + readFileSync(offscreenPath, 'utf8'));
      }
      if (flags.includes('shader')) {
        const templatePath = resolve(root, flags.includes('ctcseed')
          ? arg('ctc-templates', '.tmp/cold-start-experiments/templates-chromium151-ctc110.json')
          : arg('templates', '.tmp/cold-start-experiments/templates.json'));
        const templateSource = readFileSync(templatePath, 'utf8');
        const templates = JSON.parse(templateSource);
        templateMetadata[variant] = { path: templatePath, sha256: createHash('sha256').update(templateSource).digest('hex'), key: templates.key, count: templates.shaders.length };
        const ortVersion = JSON.parse(readFileSync(resolve(root, 'node_modules/onnxruntime-web/package.json'), 'utf8')).version;
        const manifest = JSON.parse(readFileSync(join(dist, 'models/models.json'), 'utf8'));
        const modelSignature = JSON.stringify(Object.fromEntries(Object.entries(manifest.models).map(([name, model]) => [name,
          createHash('sha256').update(readFileSync(join(dist, 'models', model.url.split('/').at(-1)))).digest('hex')])));
        if (templates.ortVersion !== ortVersion || templates.modelSignature !== modelSignature) throw new Error('Shader templates differ from runtime/models');
        const config = { capture: false, ortVersion, probeUrl: `http://127.0.0.1:${probePort}/worker-probe`,
          shaders: templates.shaders, templateKey: templates.key, concurrency: flags.includes('async8') ? 8 : 4, overlap: true, reusePipelines: flags.includes('reuse') };
        writeFileSync(workerPath, `globalThis.__coldStartExperiment=${JSON.stringify(config)};\n${probe}\n${runtimePrefix}${prefix}${workerSource}`);
      }
      const workerVerify = production ? `globalThis.__shinobuColdStartDetectorOutputVerify=${flags.includes('verifydet')};globalThis.__shinobuColdStartGpuPreprocessVerify=${flags.includes('verifyinput')};\n` : `globalThis.__shinobuColdStartDetectorOutputVerify=${flags.includes('verifydet')};globalThis.__shinobuColdStartGpuPreprocessVerify=${flags.includes('verifyinput')};globalThis.__shinobuColdStartReuseGpuAvailability=${flags.includes('deviceprobe')};globalThis.__shinobuColdStartShaderAsync8=${flags.includes('async8') && !flags.includes('history4')};globalThis.__shinobuColdStartAdapterOverlap=${flags.includes('adapteroverlap')};globalThis.__shinobuColdStartGpuPreprocessAutoLayout=${flags.includes('autolayout')};globalThis.__shinobuColdStartUploadWriteBuffer=${flags.includes('writeupload')};\n`;
      const workerExtras = `${production ? '' : `globalThis.__shinobuColdStartDetectorReadbackParallel=${flags.includes('readparallel')};\n`}${workerVerify}\n${process.argv.includes('--init-profile') ? `globalThis.__coldRuntimeProbeUrl='http://127.0.0.1:${probePort}/worker-probe';\n${readFileSync(resolve(import.meta.dirname, 'cold-runtime-phase-probe.js'), 'utf8')}` : ''}\n`;
      const memoryProbe = process.argv.includes('--gpu-memory-profile') ? `globalThis.__coldGpuApiTiming=${process.argv.includes('--gpu-api-timing')};globalThis.__coldGpuBufferSubmitProbeUrl='http://127.0.0.1:${probePort}/worker-probe';\n${readFileSync(resolve(import.meta.dirname, 'cold-gpu-buffer-submit-probe.js'), 'utf8')}\n` : '';
      writeFileSync(workerPath, memoryProbe + workerExtras + readFileSync(workerPath, 'utf8'));
      console.log(`Starting ${variant}, round ${round + 1}`);
      for (const state of process.argv.includes('--restart') ? ['new', 'restart'] : ['new']) {
      // Retained profiles use the production shader history, avoiding duplicate precompilation.
      if (state === 'restart' && !production) {
        const historyReuse = flags.includes('reuse') ? `globalThis.__coldStartExperiment=${JSON.stringify({ capture: false, reusePipelines: true,
          ortVersion: JSON.parse(readFileSync(resolve(root, 'node_modules/onnxruntime-web/package.json'), 'utf8')).version,
          probeUrl: `http://127.0.0.1:${probePort}/worker-probe` })};\n${probe}\n` : '';
        writeFileSync(workerPath, memoryProbe + workerExtras + historyReuse + runtimePrefix + prefix + workerSource);
      }
      const run = spawnSync(process.execPath, [resolve(root, 'node_modules/tsx/dist/cli.mjs'),
        'benchmark/perf/src/run-browser-ui-jank-smoke.ts', `--runs=${state === 'restart' ? 1 : arg('runs', '2')}`, '--process-mode=original',
        `--profile-key=budget-${stamp}-${variantKey}-${round}`,
        `--probe-port=${probePort}`,
        ...(arg('image', '') ? [`--image=${arg('image', '')}`] : []),
        ...(arg('browser-executable', '') ? [`--browser-executable=${arg('browser-executable', '')}`] : []),
        ...['--display-profile', '--blob-lifetime-check'].filter(flag => process.argv.includes(flag)),
      ], { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
      const log = (run.stdout ?? '') + (run.stderr ?? '');
      writeFileSync(join(out, `${stamp}-${variantKey}-${round}-${state}.log`), log);
      if (run.status !== 0) throw new Error(`${variant} failed: ${run.error ?? log.slice(-2000)}`);
      for (const [runIndex, match] of [...log.matchAll(/^report=(.+)$/gm)].entries()) {
        const path = match[1].trim();
        const report = JSON.parse(readFileSync(path, 'utf8'));
        if (report.workerProbeRecords?.some(x => ['precompile-error', 'precompile-skipped'].includes(x.kind))) throw new Error('Shader precompile failed or fingerprint mismatched');
        const cacheState = state === 'restart' ? 'retained-cache-new-process' : runIndex === 0 ? 'new-profile' : 'same-worker';
        if (!expectedHashes.has(cacheState)) expectedHashes.set(cacheState, report.resultImage.sha256);
        if (expectedHashes.get(cacheState) !== report.resultImage.sha256) throw new Error(`Pixels changed for ${variant}: ${path}`);
        const row = { variant, round, runIndex, cacheState, totalMs: report.jank.totalMs,
          visibleResultMs: report.visibleResultMs, displayTailMs: report.displayTailMs,
          system: report.system, resultImage: report.resultImage, report: path };
        results.push(row);
        console.log(JSON.stringify(row));
      }
      writeFileSync(join(out, `${stamp}-results.json`), JSON.stringify({
        sourceHashes: Object.fromEntries([...originals].map(([path, source]) => [path, createHash('sha256').update(source).digest('hex')])), candidateHashes, templateMetadata, results,
      }, null, 2));
      }
    }
  }
} finally { for (const [path, source] of originals) writeFileSync(path, source); writeFileSync(manifestPath, originalManifest); }
console.log(`results=${join(out, `${stamp}-results.json`)}`);
