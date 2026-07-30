import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

describe('migrated extension capability seams', () => {
  it.each([
    'src/shared/messages.ts',
    'src/shared/diagnosticLogClient.ts',
    'src/content/core/translation/localPipelineClient.ts',
    'src/offscreen/pipelineHost.ts',
    'src/background/localPipeline/offscreenBroker.ts',
  ])('%s has no direct native runtime messaging or Port seam', (relativePath) => {
    const source = read(relativePath);
    expect(source).not.toMatch(/\bgetChromeApi\b/u);
    expect(source).not.toMatch(/\bruntime\.(?:sendMessage|onMessage|connect|onConnect)\b/u);
    expect(source).not.toMatch(/\bChromePort\b/u);
  });

  it.each([
    'src/background/settings/settingsStore.ts',
    'src/background/diagnostics/logStore.ts',
  ])('%s uses injected storage instead of the removed Chrome storage seam', (relativePath) => {
    const source = read(relativePath);
    expect(source).not.toMatch(/\bgetChromeApi\b/u);
    expect(source).not.toMatch(/\bstorage(?:Get|Set|Remove)\b/u);
    expect(source).not.toMatch(/chromeStorage/u);
  });

  it.each([
    'src/background/openai/oauthService.ts',
    'src/background/images/imageDownloader.ts',
  ])('%s uses capability storage instead of the removed Chrome storage seam', (relativePath) => {
    const source = read(relativePath);
    expect(source).not.toMatch(/\bchrome(?:Api)?\??\.storage\b/u);
    expect(source).not.toMatch(/\bstorage(?:Get|Set|Remove)\b/u);
    expect(source).not.toMatch(/chromeStorage/u);
  });

  it.each([
    'src/runtime/onnx.ts',
    'src/runtime/onnxWorkerBridge.ts',
    'src/runtime/modelSource.ts',
    'src/pipeline/typeset/fontRuntime.ts',
    'src/content/core/ui/styles.ts',
  ])('%s resolves packaged assets without browser or URL-scheme detection', (relativePath) => {
    const source = read(relativePath);
    expect(source).not.toMatch(/\bgetChromeApi\b/u);
    expect(source).not.toMatch(/\bchrome-extension:/u);
    expect(source).not.toMatch(/\bruntime\.getURL\b/u);
  });
});
