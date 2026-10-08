import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { directReadTransform, patchFirefoxProgramManager } from '../../scripts/build-jsep.mjs';

const manager = readFileSync('node_modules/onnxruntime-web/lib/wasm/jsep/webgpu/program-manager.ts', 'utf8');
const samples = ['original-vec4', 'packed-vec3', 'packed-scalar', 'sequential-scalar'].map(name => ({
  name, code: readFileSync(`tests/workers/fixtures/firefox-matmul-${name}.wgsl`, 'utf8'),
}));

it.each(samples)('removes shared tiles without changing arithmetic or geometry: $name', ({ name, code }) => {
  const result = directReadTransform(code);
  expect(result.changed, result.reason).toBe(true);
  expect(result.kind).toBe(name === 'original-vec4' ? 'packed-vec4' : name);
  expect(result.code).not.toMatch(/var\s*<\s*workgroup\s*>|\bmm_[AB]sub\b|workgroupBarrier\s*\(/);
  expect(result.code.match(/@(?:group|binding|workgroup_size)\([^)]*\)|const (?:tileInner|rowPerThread|colPerThread)\s*=\s*\d+;/g))
    .toEqual(code.match(/@(?:group|binding|workgroup_size)\([^)]*\)|const (?:tileInner|rowPerThread|colPerThread)\s*=\s*\d+;/g));
  expect(result.code.split('\n').filter(line => /\bacc\[.*=/.test(line)))
    .toEqual(code.split('\n').filter(line => /\bacc\[.*=/.test(line)));
  expect(result.code).toContain('kStart = kStart + tileInner;');
  expect(result.code).toContain('i32(min(u32(');
  expect(runInNewContext(`(${directReadTransform.toString()})`)(code).code).toBe(result.code);
  expect(directReadTransform(result.code)).toMatchObject({ changed: false, code: result.code });
});

it.each(samples)('reads the original tile cells across K tiles and clamped edges: $name', ({ code }) => {
  const transformed = directReadTransform(code).code;
  const accesses = [...code.matchAll(/\bmm_([AB])sub\[([^\]]+)\]\[([^\]]+)\](?!\s*=)/g)];
  const calls = [...transformed.matchAll(/\bmm_read[AB]\(batch,/g)].map(match => {
    let end = transformed.indexOf('(', match.index) + 1, depth = 1;
    while (depth) {
      if (transformed[end] === '(') depth++;
      if (transformed[end] === ')') depth--;
      end++;
    }
    return transformed.slice(match.index, end).replace(/\b(\d+)u\b/g, '$1');
  });
  expect(calls).toHaveLength(accesses.length);
  const shapes = ['A', 'B'].map(tile => {
    const declaration = code.replace(/\s/g, '').match(new RegExp(`mm_${tile}sub:array<array<(.+?),(\\d+)>,(\\d+)>;`))!;
    return { rows: Number(declaration[3]), cols: Number(declaration[2]),
      components: Number(declaration[1].match(/vec(\d)/)?.[1] ?? 1) };
  });
  const [a, b] = shapes;
  const tileInner = Number(code.match(/const tileInner = (\d+);/)![1]);
  const clamp = (value: number, limit: number) => Math.min(value >>> 0, limit - 1);
  for (const kBase of [0, tileInner * 2]) for (const k of [-1, 0, tileInner / a.components - 1, tileInner]) {
    for (const inner of [-1, 0, 3, 32]) {
      const context = {
        batch: 5, batchIndices: 23, globalRowStart: 2 * a.rows, workgroupId: { x: 1, y: 2 },
        localRow: 7, localCol: 7, tileRow: 28, tileCol: a.components === 1 ? 28 : 7,
        i: inner, innerRow: inner, inner, k, kStart: kBase + tileInner,
        innerElementSize: a.components, tileInner,
        i32: (value: number) => value | 0, u32: (value: number) => value >>> 0, min: Math.min,
        mm_readA: (...args: number[]) => args, mm_readB: (...args: number[]) => args,
      };
      for (let index = 0; index < accesses.length; index++) {
        const [, tile, rowExpr, colExpr] = accesses[index];
        const shape = tile === 'A' ? a : b;
        const row = clamp(runInNewContext(rowExpr, context), shape.rows);
        const col = clamp(runInNewContext(colExpr, context), shape.cols);
        const expected = tile === 'A'
          ? [5, 2 * a.rows + row, kBase / a.components + col]
          : [5, kBase + row, b.cols + col];
        if (calls[index].includes(', batchIndices)')) expected.push(23);
        expect(runInNewContext(calls[index], context)).toEqual(expected);
      }
    }
  }
});

it('preserves original code when the pinned topology or read safety cannot be verified', () => {
  const code = samples[0].code;
  const mutations = [
    code.replace('globalRow + innerRow', 'kStart + inputRow'),
    code.replace(/let globalRowStart\s*=\s*i32\(workgroupId.y\)\s*\*\s*32;/, 'let globalRowStart = i32(workgroupId.y) * 33;'),
    code.replace('workgroupBarrier();', 'workgroupBarrier(); workgroupBarrier();'),
    code.replace('mm_Bsub[inputRow][inputCol] = mm_readB', 'mm_Bsub[inputRow][inputCol] += mm_readB'),
    `var<workgroup> other: f32;\n${code}`,
    code.replace('let col = colIn * 4;', 'let col = colIn * 4 + i32(result[0].x);'),
    code.replace('let col = colIn * 4;', 'let col = colIn * 4 + consultOutput();')
      + '\nfn consultOutput() -> i32 { return i32(result[0].x); }',
    code.replace('kStart = kStart + tileInner;', 'kStart = kStart + 1;'),
    code.replace('let batch =', 'var batch =').replace('kStart = kStart + tileInner;', 'kStart = kStart + tileInner; batch = batch + 1;'),
    code.replace('let globalRowStart =', 'var globalRowStart =').replace('kStart = kStart + tileInner;', 'kStart = kStart + tileInner; globalRowStart = globalRowStart + 1;'),
    code.replace('kStart = kStart + tileInner;', 'kStart = kStart + tileInner; kStart++;'),
  ];
  for (const mutation of mutations) {
    expect(mutation).not.toBe(code);
    expect(directReadTransform(mutation)).toMatchObject({ changed: false, code: mutation });
  }
});

it('applies only to Windows Firefox after the complete WGSL is assembled', () => {
  const patched = patchFirefoxProgramManager(manager);
  const header = patched.slice(0, patched.indexOf(manager.slice(0, 80)));
  const creation = patched.match(/let code = `\$\{enableDirectives[\s\S]*?const shaderModule = device.createShaderModule\(\{ code, label: programInfo.name \}\);/)![0];
  expect(header).toContain('shinobuFirefoxDirectRead');
  for (const { code } of samples) {
    for (const ua of ['Windows Firefox/157.0', 'Windows Chrome/151.0',
      'Linux Firefox/157.0', 'Macintosh Firefox/157.0', undefined]) {
      const assembled = `\n\n${code}`;
      const descriptor = runInNewContext(`${header}\n${creation}\nshaderModule`, {
        ...(ua === undefined ? {} : { navigator: { userAgent: ua } }),
        enableDirectives: [], shaderHelper: { additionalImplementations: '' }, userCode: code,
        device: { createShaderModule: (value: { code: string; label: string }) => value },
        programInfo: { name: 'Conv' },
      });
      expect(descriptor).toEqual({ code: ua === 'Windows Firefox/157.0'
        ? directReadTransform(assembled).code : assembled, label: 'Conv' });
    }
  }
});

it('requires revalidation if either ORT shader creation anchor is missing or duplicated', () => {
  const anchors = [
    "const code = `${enableDirectives.join('\\n')}\\n${shaderHelper.additionalImplementations}\\n${userCode}`;",
    'const shaderModule = device.createShaderModule({ code, label: programInfo.name });',
  ];
  for (const anchor of anchors) {
    expect(() => patchFirefoxProgramManager(manager.replace(anchor, ''))).toThrow(/Revalidate/);
    expect(() => patchFirefoxProgramManager(`${manager}\n${anchor}`)).toThrow(/Revalidate/);
  }
});
