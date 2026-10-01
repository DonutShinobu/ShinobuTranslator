import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const paths = process.argv.slice(2).filter(x => !x.startsWith('--'));
const out = process.argv.find(x => x.startsWith('--out='))?.slice(6);
if (!paths.length) throw new Error('Pass one or more experiment results JSON files');
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
};
const reference = new Map();
const rawReference = new Map();
const groups = paths.map(path => {
  const experiment = JSON.parse(readFileSync(path, 'utf8'));
  const rows = experiment.results.map(row => {
    const report = JSON.parse(readFileSync(row.report, 'utf8'));
    const summary = report.pipelineSummary;
    const paddle = summary.ocrDebug?.paddle;
    const signature = {
      image: summary.image, detectedRegionCount: summary.detectedRegionCount,
      providers: summary.runtimeStages.map(x => [x.model, x.provider, x.webnnDeviceType]),
      model: paddle?.modelName, normalize: paddle?.normalize, channelOrder: paddle?.channelOrder,
      accepted: paddle?.acceptedCount, rejected: paddle?.rejectedCount,
      regions: paddle?.regions.map(({ direction, box, inputDims, decodedText, confidence, accepted }) => (
        { direction, box, inputDims, decodedText, confidence, accepted }
      )),
      inputDims: paddle?.inferenceRuns.map(x => x.inputDims), inputBytes: paddle?.inputBytesTotal,
      pixels: report.resultImage,
    };
    const cacheState = row.cacheState ?? (row.runIndex === 0 ? 'new-profile' : 'same-worker');
    const key = `${report.image}:${cacheState}`;
    if (!reference.has(key)) reference.set(key, signature);
    assert.deepEqual(signature, reference.get(key), `Output/input/provider differs: ${row.variant}, ${row.report}`);
    const rawHashes = report.workerProbeRecords?.flatMap(x => x.kind === 'runtime-phase-batch' ? x.records : [])
      .filter(x => x.sha256 && ['detector-input-sha256', 'detector-output-sha256'].includes(x.phase))
      .map(({ phase, output, dims, bytes, sha256 }) => ({ phase, output, dims, bytes, sha256 }))
      .sort((a, b) => `${a.phase}:${a.output ?? ''}`.localeCompare(`${b.phase}:${b.output ?? ''}`));
    if (rawHashes?.length) {
      assert.equal(rawHashes.length, 4, `Expected detector input and all three outputs: ${row.report}`);
      if (!rawReference.has(key)) rawReference.set(key, rawHashes);
      assert.deepEqual(rawHashes, rawReference.get(key), `Raw detector input/output differs: ${row.report}`);
    }
    const stages = report.jank.stages;
    const last = stages.at(-1);
    assert.ok(Math.abs(last.startMs + last.durationMs - report.jank.totalMs) < 0.8, 'Timing endpoint mismatch');
    const stage = name => stages.filter(x => x.stage === name).reduce((sum, x) => sum + x.durationMs, 0);
    const internal = name => summary.stageTimings.find(x => x.stage === name)?.durationMs ?? 0;
    return { ...row, cacheState, phases: {
      entryPrepareLoad: stages.find(x => x.stage === 'detect')?.startMs ?? 0,
      detect: stage('detect'), bubble: stage('bubble'), ocr: stage('ocr'),
      order: stage('order'), mask: internal('mask_refine'), inpaint: internal('inpaint'),
      typeset: stage('typeset'), delivery: stage('finalize'), display: report.displayTailMs,
      ocrInference: paddle?.inferenceTotalMs, ocrDecode: paddle?.decodeTotalMs,
      ocrOutputBytes: paddle?.outputBytesTotal, png: internal('finalize'),
    }, inpaintProfiles: report.workerProbeRecords?.filter(x => x.kind === 'inpaint-profile') };
  });
  const medians = [];
  for (const cacheState of new Set(rows.map(x => x.cacheState))) {
    for (const variant of new Set(rows.map(x => x.variant))) {
      const selected = rows.filter(x => x.variant === variant && x.cacheState === cacheState);
      if (!selected.length) continue;
      medians.push({ variant, cacheState, n: selected.length,
        visibleMs: median(selected.map(x => x.visibleResultMs)), totalMs: median(selected.map(x => x.totalMs)),
        phases: Object.fromEntries(Object.keys(selected[0].phases).map(name => [name, median(selected.map(x => x.phases[name]))])),
      });
    }
  }
  return { path: resolve(path), checks: 'pixels/OCR confidence/regions/input dimensions/providers/timing passed', medians, rows };
});
const result = { createdAt: new Date().toISOString(), groups };
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(groups.map(({ path, checks, medians }) => ({ path, checks, medians })), null, 2));
