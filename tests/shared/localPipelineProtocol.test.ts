import { describe, expect, it } from 'vitest';
import {
  Base64ChunkAssembler,
  LOCAL_PIPELINE_CHUNK_SIZE,
  LocalPipelineRemoteError,
  isLocalPipelineClientMessage,
  serializePipelineError,
  splitBase64Chunks,
} from '../../src/shared/localPipelineProtocol';

describe('local pipeline Port protocol', () => {
  it('splits Base64 at the 4 MiB boundary', () => {
    const value = 'a'.repeat(LOCAL_PIPELINE_CHUNK_SIZE + 3);
    const chunks = splitBase64Chunks(value);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(LOCAL_PIPELINE_CHUNK_SIZE);
    expect(chunks[1]).toBe('aaa');
    expect(chunks.join('')).toBe(value);
  });

  it('accepts out-of-order chunks and restores their index order', () => {
    const assembler = new Base64ChunkAssembler({ chunkCount: 3, totalChars: 6 });
    assembler.add(2, 'ef');
    assembler.add(0, 'ab');
    assembler.add(1, 'cd');

    expect(assembler.complete()).toBe('abcdef');
  });

  it('rejects duplicate, missing, and length-mismatched chunks', () => {
    const duplicate = new Base64ChunkAssembler({ chunkCount: 1, totalChars: 2 });
    duplicate.add(0, 'ab');
    expect(() => duplicate.add(0, 'ab')).toThrow('重复分块');

    const missing = new Base64ChunkAssembler({ chunkCount: 2, totalChars: 2 });
    missing.add(1, 'b');
    expect(() => missing.complete()).toThrow('分块缺失');

    const wrongLength = new Base64ChunkAssembler({ chunkCount: 1, totalChars: 3 });
    wrongLength.add(0, 'ab');
    expect(() => wrongLength.complete()).toThrow('总长度不符');
  });

  it('validates message shape and chunk size', () => {
    expect(isLocalPipelineClientMessage({ type: 'prepare', jobId: 'job-1' })).toBe(true);
    expect(isLocalPipelineClientMessage({ type: 'prepare', jobId: '' })).toBe(false);
    expect(isLocalPipelineClientMessage({
      type: 'start',
      jobId: 'job-1',
      file: { name: 'source.png', type: 'image/png', size: 1, lastModified: 1 },
      config: {},
      input: { chunkCount: 1, totalChars: 4 },
    })).toBe(false);
    expect(isLocalPipelineClientMessage({
      type: 'input-chunk',
      jobId: 'job-1',
      index: 0,
      data: 'a'.repeat(LOCAL_PIPELINE_CHUNK_SIZE + 1),
    })).toBe(false);
  });

  it('serializes nested and circular causes with stable error codes', () => {
    const root = new Error('root') as Error & { code?: string };
    root.code = 'WORKER_BOOTSTRAP_FAILED';
    const outer = new Error('outer', { cause: root });
    Object.defineProperty(root, 'cause', { value: outer, configurable: true });

    const serialized = serializePipelineError(outer);
    expect(serialized.message).toBe('outer');
    expect(serialized.cause).toMatchObject({
      message: 'root',
      code: 'WORKER_BOOTSTRAP_FAILED',
      cause: '[CIRCULAR_CAUSE]',
    });

    const remote = new LocalPipelineRemoteError(serialized);
    expect(remote.message).toBe('outer');
    expect(remote.code).toBe('PIPELINE_STAGE_FAILED');
  });
});
