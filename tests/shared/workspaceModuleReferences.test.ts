import { describe, expect, it } from 'vitest';
import { findModuleReferences } from '../../scripts/workspace-module-references.mjs';

describe('workspace module references', () => {
  it('ignores decoy strings and comments while finding static imports', () => {
    const source = `
      const decoy = '../../../src/background/index';
      // import '../../../src/background/index';
      /* export { value } from '../../../src/background/index'; */
      import { startBackground } from '../../../src/background/index';
    `;

    expect(findModuleReferences(source, 'fixture.ts')).toEqual([
      '../../../src/background/index',
    ]);
  });

  it('finds side-effect, re-export, dynamic, require, and Vite URL imports', () => {
    const source = `
      import '../../../src/side-effect';
      export { value } from '../../../src/re-export';
      const dynamicModule = import('../../../src/dynamic');
      const commonJsModule = require('../../../src/common-js');
      import workerUrl from '../../../src/worker.ts?worker&url';
    `;

    expect(findModuleReferences(source, 'fixture.ts')).toEqual([
      '../../../src/side-effect',
      '../../../src/re-export',
      '../../../src/dynamic',
      '../../../src/common-js',
      '../../../src/worker.ts?worker&url',
    ]);
  });

  it('finds anchored build paths and Worker URLs without trusting local helpers', () => {
    const source = `
      import { resolve as pathResolve } from 'node:path';
      const manifestPath = pathResolve(
        import.meta.dirname,
        '../../packages/model-manifest/manifest.json',
      );
      function resolve(...parts: string[]) { return parts.join('/'); }
      const decoy = resolve(import.meta.dirname, '../../src/decoy.ts');
      const worker = new Worker(
        new URL('../../src/worker.ts', import.meta.url),
        { type: 'module' },
      );
      const requestUrl = new URL('../../src/not-a-module.ts', baseUrl);
    `;

    expect(findModuleReferences(source, 'fixture.ts')).toEqual([
      'node:path',
      '../../packages/model-manifest/manifest.json',
      '../../src/worker.ts',
    ]);
  });
});
