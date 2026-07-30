#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { rollup } from 'rollup';

const root = resolve(import.meta.dirname, '../../..');
const upstreamPackageDirectory = resolve(
  root,
  'node_modules/onnxruntime-web',
);
const outputDirectory = resolve(
  root,
  'apps/extension/src/ort',
);
const expectedOnnxRuntimeVersion = '1.24.1';
const expectedRollupVersion = '4.62.3';
const moduleSpecifications = [
  {
    name: 'ort-wasm-simd-threaded.asyncify.mjs',
    sha256:
      '9fc4e4ecbaaaf38b49e1a98f9a7b5e681ab372ebc79668f905715259d38761da',
  },
  {
    name: 'ort-wasm-simd-threaded.jsep.mjs',
    sha256:
      '9b7e9dbe87f1cb3df68660418492e8c6b0cae6fe83ce46ef1a51dbc95580e690',
  },
  {
    name: 'ort-wasm-simd-threaded.mjs',
    sha256:
      '3101568d9c131ea89d4c693fbff3e0d0c3dcbcf1baa09fd871b86662a071bd1a',
  },
];
const licenseBanner = `/*!
 * Derived from ONNX Runtime Web 1.24.1.
 * Copyright (c) Microsoft Corporation.
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
`;

function readPackageVersion(packageDirectory) {
  return JSON.parse(
    readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'),
  ).version;
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

async function generateBrowserModule(specification) {
  const sourcePath = resolve(
    upstreamPackageDirectory,
    'dist',
    specification.name,
  );
  const source = readFileSync(sourcePath, 'utf8');
  const actualHash = sha256(source);
  if (actualHash !== specification.sha256) {
    throw new Error(
      `Pinned ONNX Runtime source hash changed for ${specification.name}: expected ${specification.sha256}, received ${actualHash}`,
    );
  }

  const bundle = await rollup({
    input: sourcePath,
    external: ['module', 'worker_threads'],
    plugins: [
      {
        name: 'shinobu-browser-only-ort-source',
        transform(code, id) {
          if (id !== sourcePath) return null;
          return {
            code: code.replaceAll('globalThis.process', 'undefined'),
            map: null,
          };
        },
      },
    ],
  });
  try {
    const generated = await bundle.generate({
      format: 'es',
      preserveModules: false,
    });
    const chunks = generated.output.filter(
      (output) => output.type === 'chunk',
    );
    if (
      chunks.length !== 1
      || !chunks[0].exports.includes('default')
    ) {
      throw new Error(
        `Browser ONNX Runtime generation lost the default factory: ${specification.name}`,
      );
    }
    const code = chunks[0].code.replace(/\r\n?/gu, '\n');
    for (const forbiddenToken of [
      'globalThis.process',
      'worker_threads',
      'import("module")',
    ]) {
      if (code.includes(forbiddenToken)) {
        throw new Error(
          `Browser ONNX Runtime generation retained ${forbiddenToken}: ${specification.name}`,
        );
      }
    }
    return `${licenseBanner}${code.endsWith('\n') ? code : `${code}\n`}`;
  } finally {
    await bundle.close();
  }
}

async function run(mode) {
  const actualOnnxRuntimeVersion = readPackageVersion(
    upstreamPackageDirectory,
  );
  if (actualOnnxRuntimeVersion !== expectedOnnxRuntimeVersion) {
    throw new Error(
      `Expected onnxruntime-web ${expectedOnnxRuntimeVersion}, received ${actualOnnxRuntimeVersion}`,
    );
  }
  const actualRollupVersion = readPackageVersion(
    resolve(root, 'node_modules/rollup'),
  );
  if (actualRollupVersion !== expectedRollupVersion) {
    throw new Error(
      `Expected Rollup ${expectedRollupVersion}, received ${actualRollupVersion}`,
    );
  }

  for (const specification of moduleSpecifications) {
    const expected = await generateBrowserModule(specification);
    const outputPath = resolve(outputDirectory, specification.name);
    if (mode === '--write') {
      writeFileSync(outputPath, expected, 'utf8');
      continue;
    }
    const actual = readFileSync(outputPath, 'utf8');
    if (actual !== expected) {
      throw new Error(
        `Browser ONNX Runtime entry is stale; regenerate ${specification.name}`,
      );
    }
  }
}

const mode = process.argv[2] ?? '--check';
if (
  !['--check', '--write'].includes(mode)
  || process.argv.length > 3
) {
  throw new Error(
    'Usage: node generate-browser-ort-entries.mjs [--check|--write]',
  );
}
await run(mode);
console.log(
  mode === '--write'
    ? 'Browser ONNX Runtime entries regenerated.'
    : 'Browser ONNX Runtime entries match pinned upstream sources.',
);
