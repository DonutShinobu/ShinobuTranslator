// Exact ORT 1.27.0 source transform for the isolated benchmark bundle only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const ORIGINAL_GPU_DATA_MANAGER_SHA256 = 'e559e7bf7424b2cab2b7c70ba34383bbcece6816c031421b5c4c5c5eb4db45d3';
export const UPLOAD_WRITE_BUFFER_FLAG = '__shinobuColdStartUploadWriteBuffer';
const hash = value => createHash('sha256').update(value).digest('hex');

export function patchJsepUploadWriteBuffer(source) {
  assert.equal(hash(source), ORIGINAL_GPU_DATA_MANAGER_SHA256, 'Unexpected ORT 1.27.0 GPUDataManager source');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const start = '    // create gpu buffer' + newline + '    const gpuBufferForUploading = this.backend.device.createBuffer(';
  const end = '    gpuBufferForUploading.destroy();';
  assert.equal(source.split(start).length, 2, 'Upload staging start must be unique');
  assert.equal(source.split(end).length, 2, 'Upload staging end must be unique');
  const branch = [
    '    const destination = gpuDataCache.gpuData.buffer;',
    '    if ((globalThis as typeof globalThis & { __shinobuColdStartUploadWriteBuffer?: boolean })',
    '      .__shinobuColdStartUploadWriteBuffer === true && srcLength > 0 && srcLength % 16 === 0',
    '      && (destination.usage & GPUBufferUsage.COPY_DST) !== 0) {',
    '      this.backend.device.queue.writeBuffer(destination, 0, data);',
    '    } else {',
  ].join(newline);
  // Keep original size/cache validation, padding path and the one LOG_DEBUG call.
  const contents = source.replace(start, branch + newline + start)
    .replace(end, end + newline + '    }');
  return { contents, metadata: {
    file: 'lib/wasm/jsep/webgpu/gpu-data-manager.ts',
    originalSha256: hash(source), modifiedSha256: hash(contents),
    patch: 'aligned16-upload-write-buffer', runtimeFlag: UPLOAD_WRITE_BUFFER_FLAG,
    defaultEnabled: false, scope: 'isolated-jsep-js-bundle',
  } };
}
