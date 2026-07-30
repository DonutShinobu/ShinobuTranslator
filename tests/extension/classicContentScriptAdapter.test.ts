import type { OutputBundle } from 'rollup';
import { describe, expect, it } from 'vitest';
import {
  rewriteClassicContentScriptBundle,
} from '../../apps/extension/build/classicContentScriptAdapter';

describe('classic content-script build adapter', () => {
  it('emits direct extension resource URLs without browser-global fallback detection', () => {
    const contentChunk = {
      type: 'chunk',
      code: [
        'const currentUrl=import.meta.url;',
        'const worker=import("./chunks/worker.js");',
        'export{currentUrl as currentUrl,worker as worker};',
      ].join(''),
    };
    const workerChunk = {
      type: 'chunk',
      code: 'const workerUrl=import.meta.url;',
    };
    const bundle = {
      'content.js': contentChunk,
      'chunks/worker.js': workerChunk,
    } as unknown as OutputBundle;

    rewriteClassicContentScriptBundle(bundle);

    const contentCode = contentChunk.code;
    const workerCode = workerChunk.code;
    expect(contentCode).toContain(
      'chrome.runtime.getURL("content.js")',
    );
    expect(contentCode).toContain(
      'import(chrome.runtime.getURL("chunks/worker.js"))',
    );
    expect(workerCode).toContain(
      'chrome.runtime.getURL("chunks/worker.js")',
    );

    const generatedCode = `${contentCode}\n${workerCode}`;
    expect(generatedCode).not.toMatch(/\btypeof\s+(?:chrome|browser)\b/u);
    expect(generatedCode).not.toContain('self.location.href');
    expect(generatedCode).not.toContain('globalThis.browser');
  });
});
