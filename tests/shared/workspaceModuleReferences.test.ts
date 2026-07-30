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

  it('finds TypeScript import-equals references', () => {
    const source = `
      import escape = require('../../../src/escape');
    `;

    expect(findModuleReferences(source, 'fixture.cts')).toEqual([
      '../../../src/escape',
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
      function shadowed(
        pathResolve: (...parts: string[]) => string,
      ) {
        return pathResolve(
          import.meta.dirname,
          '../../src/shadowed-decoy.ts',
        );
      }
      const worker = new Worker(
        new URL('../../src/worker.ts', import.meta.url),
        { type: 'module' },
      );
      const requestUrl = new URL('../../src/not-a-module.ts', baseUrl);
    `;

    expect(findModuleReferences(
      source,
      'apps/web/vite.config.ts',
    )).toEqual([
      'node:path',
      '../../packages/model-manifest/manifest.json',
      '../../src/worker.ts',
    ]);
  });

  it('combines repo-root anchors with resolve and join build inputs', () => {
    const source = `
      import {
        join as pathJoin,
        resolve as pathResolve,
      } from 'node:path';
      const repoRoot = pathResolve(import.meta.dirname, '../..');
      const thirdInput = pathResolve(repoRoot, 'src/third.ts');
      const fourthInput = pathJoin(repoRoot, 'src/fourth.ts');
      function resolve(...parts: string[]) { return parts.join('/'); }
      const decoy = resolve(repoRoot, 'src/not-a-build-input.ts');
    `;

    expect(findModuleReferences(
      source,
      'apps/extension/vite.config.ts',
    )).toEqual([
      'node:path',
      '../..',
      '../../src/third.ts',
      '../../src/fourth.ts',
    ]);
  });

  it('combines __dirname and import.meta.url file anchors', () => {
    const source = `
      import { resolve as pathResolve } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
      const urlInput = pathResolve(repoRoot, 'src/from-url.ts');
      const dirnameInput = pathResolve(
        __dirname,
        '../../src/from-dirname.ts',
      );
    `;

    expect(findModuleReferences(
      source,
      'apps/extension/vite.config.ts',
    )).toEqual([
      'node:path',
      'node:url',
      '../..',
      '../../src/from-url.ts',
      '../../src/from-dirname.ts',
    ]);
  });

  it('unwraps transparent TypeScript expressions around static paths', () => {
    const source = `
      import { resolve as pathResolve } from 'node:path';
      const repoRoot = pathResolve(import.meta.dirname, '../..');
      const parenthesizedInput = pathResolve(
        (repoRoot),
        'src/parenthesized.ts',
      );
      const asInput = pathResolve(
        repoRoot as string,
        'src/as-expression.ts',
      );
      const satisfiesInput = pathResolve(
        repoRoot satisfies string,
        'src/satisfies-expression.ts',
      );
      const nonNullInput = pathResolve(
        repoRoot!,
        'src/non-null-expression.ts',
      );
      const assertedInput = pathResolve(
        <string>repoRoot,
        'src/type-assertion.ts',
      );
    `;

    expect(findModuleReferences(
      source,
      'apps/extension/vite.config.ts',
    )).toEqual([
      'node:path',
      '../..',
      '../../src/parenthesized.ts',
      '../../src/as-expression.ts',
      '../../src/satisfies-expression.ts',
      '../../src/non-null-expression.ts',
      '../../src/type-assertion.ts',
    ]);
  });

  it('does not treat locally shadowed path bindings or anchors as imports', () => {
    const source = `
      import { resolve as pathResolve } from 'node:path';
      const repoRoot = pathResolve(import.meta.dirname, '../..');
      {
        const pathResolve = (...parts: string[]) => parts.join('/');
        pathResolve(repoRoot, 'src/block-decoy.ts');
      }
      function nestedConst() {
        const pathResolve = (...parts: string[]) => parts.join('/');
        return pathResolve(repoRoot, 'src/nested-const-decoy.ts');
      }
      function nestedFunction() {
        function pathResolve(...parts: string[]) {
          return parts.join('/');
        }
        return pathResolve(repoRoot, 'src/nested-function-decoy.ts');
      }
      function shadowedDirectory(__dirname: string) {
        return pathResolve(__dirname, '../../src/dirname-decoy.ts');
      }
      function shadowedRequire(
        require: (specifier: string) => unknown,
      ) {
        return require('../../src/require-decoy.ts');
      }
      function shadowedUrl(
        URL: new (path: string, base: string) => unknown,
      ) {
        return new URL('../../src/url-decoy.ts', import.meta.url);
      }
      function objectBinding({
        pathResolve,
      }: {
        pathResolve: (...parts: string[]) => string;
      }) {
        return pathResolve(repoRoot, 'src/object-binding-decoy.ts');
      }
      function arrayBinding([
        pathResolve,
      ]: [(...parts: string[]) => string]) {
        return pathResolve(repoRoot, 'src/array-binding-decoy.ts');
      }
      try {
        throw new Error('decoy');
      } catch (pathResolve) {
        pathResolve(repoRoot, 'src/catch-binding-decoy.ts');
      }
    `;

    expect(findModuleReferences(
      source,
      'apps/extension/vite.config.ts',
    )).toEqual([
      'node:path',
      '../..',
    ]);
  });

  it('finds paths built through CommonJS node:path bindings', () => {
    const source = `
      const path = require('node:path');
      const repoRoot = path.resolve(import.meta.dirname, '../..');
      const namespaceInput = path.join(repoRoot, 'src/common-js.ts');
      const {
        resolve: pathResolve,
        join: pathJoin,
      } = require('node:path');
      const destructuredInput = pathResolve(
        repoRoot,
        'src/destructured-resolve.ts',
      );
      const joinedInput = pathJoin(repoRoot, 'src/destructured-join.ts');
      function shadowedNamespace(
        path: { resolve: (...parts: string[]) => string },
      ) {
        return path.resolve(repoRoot, 'src/namespace-decoy.ts');
      }
    `;

    expect(findModuleReferences(
      source,
      'apps/extension/vite.config.ts',
    )).toEqual([
      'node:path',
      '../..',
      '../../src/common-js.ts',
      'node:path',
      '../../src/destructured-resolve.ts',
      '../../src/destructured-join.ts',
    ]);
  });

  it('finds paths built through TypeScript node:path import-equals', () => {
    const source = `
      import path = require('node:path');
      const repoRoot = path.resolve(import.meta.dirname, '../..');
      const input = path.join(repoRoot, 'src/import-equals.ts');
    `;

    expect(findModuleReferences(
      source,
      'apps/extension/vite.config.cts',
    )).toEqual([
      'node:path',
      '../..',
      '../../src/import-equals.ts',
    ]);
  });
});
