import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import chokidar from 'chokidar';

const root = resolve(import.meta.dirname, '..');
const extensionRoot = resolve(root, 'apps/extension');
const targetFlagIndex = process.argv.indexOf('--target');
const target = targetFlagIndex >= 0 ? process.argv[targetFlagIndex + 1] : undefined;
if (target !== 'chromium' && target !== 'firefox') {
  throw new Error('--target must be chromium or firefox');
}

const distName = `dist-${target}`;
const distDir = resolve(extensionRoot, distName);
const npmCli = process.env.npm_execpath;
const webExtCli = resolve(root, 'node_modules/web-ext/bin/web-ext.js');
if (!npmCli || !existsSync(npmCli)) throw new Error('Unable to locate the npm CLI');
if (!existsSync(webExtCli)) throw new Error('web-ext is not installed; run npm install first');

let stopped = false;
let building = false;
let rebuildPending = false;
let webExtProcess;

function run(command, args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${args.join(' ')} exited with ${code ?? signal}`));
    });
  });
}

async function buildTarget(failOnError = false) {
  if (building) {
    rebuildPending = true;
    return;
  }
  building = true;
  try {
    do {
      rebuildPending = false;
      await run(
        process.execPath,
        [npmCli, 'run', `build:${target}:bundle`],
        extensionRoot,
      );
    } while (rebuildPending && !stopped);
  } catch (error) {
    console.error(`[extension:${target}] build failed`, error);
    if (failOnError) throw error;
  } finally {
    building = false;
  }
}

await buildTarget(true);
if (!existsSync(resolve(distDir, 'manifest.json'))) {
  throw new Error(`Initial ${target} extension build did not produce ${distDir}`);
}

const watchInputs = [
  resolve(root, 'src'),
  resolve(extensionRoot, 'src'),
  resolve(extensionRoot, 'manifest.ts'),
  resolve(extensionRoot, 'vite.config.ts'),
  resolve(extensionRoot, '*.html'),
  resolve(root, 'public'),
];
const watcher = chokidar.watch(watchInputs, {
  ignoreInitial: true,
  ignored: [
    resolve(extensionRoot, 'dist-*'),
  ],
});
let debounceTimer;
watcher.on('all', (_eventName, changedPath) => {
  console.log(`[extension:${target}] changed ${changedPath}`);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void buildTarget(), 150);
});

webExtProcess = spawn(
  process.execPath,
  [
    webExtCli,
    'run',
    '--source-dir',
    distDir,
    '--target',
    target === 'firefox' ? 'firefox-desktop' : 'chromium',
    '--watch-files',
    'manifest.json',
    'content.js',
    'popup.js',
    'onnxWorker.js',
    target === 'firefox' ? 'background-firefox.js' : 'background-chromium.js',
  ],
  { cwd: root, stdio: 'inherit' },
);

async function shutdown(exitCode = 0) {
  if (stopped) return;
  stopped = true;
  clearTimeout(debounceTimer);
  await watcher.close();
  if (webExtProcess && !webExtProcess.killed) webExtProcess.kill();
  process.exitCode = exitCode;
}

webExtProcess.once('error', async (error) => {
  console.error(error);
  await shutdown(1);
});
webExtProcess.once('exit', async (code) => {
  await shutdown(code ?? 1);
});
process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));
