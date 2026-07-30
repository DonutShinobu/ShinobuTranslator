import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

function read(relativePath: string): string {
  return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
}

describe('migrated extension capability seams', () => {
  it('deletes the legacy Chrome-shaped seam without a compatibility rename', () => {
    expect(existsSync(resolve(repositoryRoot, 'src/shared/chrome.ts'))).toBe(false);
    for (const relativePath of [
      'apps/extension/src/background.ts',
      'apps/extension/src/content.ts',
      'src/background/index.ts',
      'src/content/index.ts',
    ]) {
      expect(read(relativePath)).not.toMatch(
        /\b(?:ChromeLike|getChromeApi|requireChromeApi)\b/u,
      );
    }
  });

  it('keeps PipelineHostLifecycle outside the general extension capability contract', () => {
    expect(read('apps/extension/src/capabilities/contracts.ts')).not.toMatch(
      /\bPipelineHostLifecycle\b/u,
    );
    expect(read('apps/extension/src/pipelineHost/contracts.ts')).toMatch(
      /export type PipelineHostLifecycle/u,
    );
  });

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
    ['src/offscreen/pipelineHost.ts', 'PipelineHostConnection'],
    [
      'src/background/localPipeline/offscreenBroker.ts',
      'PipelineHostDocumentLifecycle',
    ],
  ])('%s depends on the narrow %s role', (relativePath, role) => {
    const source = read(relativePath);
    expect(source).toContain(role);
    expect(source).not.toMatch(/\bChromeLike\b/u);
    expect(source).not.toMatch(/\boffscreen\.(?:createDocument|closeDocument)\b/u);
    expect(source).not.toMatch(/\.getContexts\b/u);
  });

  it('keeps shared pipeline protocol independent from the extension app', () => {
    expect(read('src/shared/localPipelineProtocol.ts')).not.toMatch(
      /apps\/extension/u,
    );
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

  it('image downloading uses network capabilities instead of native Chrome network rules', () => {
    const source = read('src/background/images/imageDownloader.ts');
    expect(source).not.toMatch(/\bgetChromeApi\b/u);
    expect(source).not.toMatch(/\bChromeLike\b/u);
    expect(source).not.toMatch(/\bdeclarativeNetRequest\b/u);
    expect(source).not.toMatch(/\bwebRequest\b/u);
    expect(source).not.toMatch(/\bupdate(?:Dynamic|Session)Rules\b/u);
  });

  it('composes image network capabilities with the pipeline host lifecycle', () => {
    const businessSource = read('src/background/index.ts');
    expect(businessSource).toContain(
      'sessionStorage: capabilities.sessionStorage',
    );
    expect(businessSource).toContain(
      'referrerPolicies: capabilities.referrerPolicies',
    );
    expect(businessSource).toContain(
      'requestHeaderOverride: capabilities.requestHeaderOverride',
    );
    expect(businessSource).not.toMatch(/\bglobalThis\.chrome\b/u);

    const compositionRoot = read('apps/extension/src/background.ts');
    expect(compositionRoot).toContain(
      'createChromePipelineHostLifecycle(nativeChrome)',
    );
    expect(compositionRoot).not.toMatch(/\bChromeLike\b/u);
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
