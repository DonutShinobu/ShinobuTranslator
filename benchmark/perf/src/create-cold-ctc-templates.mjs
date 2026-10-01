// CPU-only: add the original static CTC shader to a separate captured template file.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const inputPath = resolve(process.argv[2] ?? '.tmp/cold-start-experiments/templates-chromium151.json');
const outputPath = resolve(process.argv[3] ?? '.tmp/cold-start-experiments/templates-chromium151-ctc110.json');
assert.notEqual(inputPath.toLowerCase(), outputPath.toLowerCase(), 'preserve the original 109-template file');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const originalBytes = readFileSync(inputPath);
const original = JSON.parse(originalBytes.toString('utf8'));
assert.equal(original.ortVersion, '1.27.0');
assert.equal(original.shaders.length, 109);
assert.equal(JSON.parse(original.key)[0], original.ortVersion);
assert.ok(JSON.parse(original.key)[1].includes('Chrome/151.'));

const sourceUrl = new URL('../../../packages/model-runtime/src/workers/gpuPaddleCtc.ts', import.meta.url);
const sourceBytes = readFileSync(sourceUrl);
const source = sourceBytes.toString('utf8');
const ast = ts.createSourceFile('gpuPaddleCtc.ts', source, ts.ScriptTarget.ES2022, true);
const declaration = ast.statements.filter(ts.isVariableStatement)
  .flatMap(statement => [...statement.declarationList.declarations])
  .find(value => ts.isIdentifier(value.name) && value.name.text === 'PADDLE_CTC_SHADER');
assert.ok(declaration && ts.isNoSubstitutionTemplateLiteral(declaration.initializer), 'CTC must be a static literal');
const runtimeExports = {};
runInNewContext(ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText, { exports: runtimeExports });
const code = runtimeExports.PADDLE_CTC_SHADER;
assert.equal(code, declaration.initializer.text, 'seed must equal the actual exported runtime string');
assert.ok(code.includes('@compute @workgroup_size(128)'));
assert.ok(!code.includes('f16'));
assert.ok(!original.shaders.some(shader => shader.code === code), 'CTC must be new');
const model = 'paddleocr_v6_medium_rec';
assert.ok(Object.hasOwn(JSON.parse(original.modelSignature), model), 'use the exact captured OCR model name');
const seed = { kind: 'shader', code, entryPoint: 'main', constants: {},
  label: 'PaddleCtcMaxima', model, models: [model] };
// Same key as cold-start-worker-probe: label/model metadata never enter this key.
const pipelineKey = JSON.stringify([seed.code, seed.entryPoint,
  Object.entries(seed.constants).sort(([a], [b]) => a.localeCompare(b))]);
const output = { ...original, shaders: [...original.shaders, seed], templateExtension: {
  kind: 'original-source-literal', sourceFile: 'packages/model-runtime/src/workers/gpuPaddleCtc.ts',
  exportName: 'PADDLE_CTC_SHADER', sourceFileSha256: sha256(sourceBytes), wgslSha256: sha256(code),
  pipelineKeySha256: sha256(pipelineKey), layout: 'auto', constants: {}, model,
  baseTemplatesSha256: sha256(originalBytes), baseTemplateCount: 109, addedTemplateCount: 1,
  gpuCaptured: false, deviceFingerprintPreserved: true,
} };
assert.equal(output.shaders.length, 110);
assert.equal(output.key, original.key, 'templateKey is the device/runtime fingerprint, not the seed-list hash');
assert.equal(output.modelSignature, original.modelSignature);
assert.equal(output.ortVersion, original.ortVersion);
assert.equal(JSON.stringify(output.shaders.slice(0, 109)), JSON.stringify(original.shaders));
writeFileSync(outputPath, JSON.stringify(output));
const saved = JSON.parse(readFileSync(outputPath, 'utf8'));
assert.equal(sha256(saved.shaders[109].code), saved.templateExtension.wgslSha256);
assert.equal(saved.shaders.length, 110);
assert.equal(sha256(readFileSync(inputPath)), sha256(originalBytes), 'base file must not change');
console.log(JSON.stringify({ outputPath, count: saved.shaders.length, model,
  wgslSha256: saved.templateExtension.wgslSha256,
  pipelineKeySha256: saved.templateExtension.pipelineKeySha256, fingerprintPreserved: saved.key === original.key }));
